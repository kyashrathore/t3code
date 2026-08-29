// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Public benchmark adapter materializes isolated deterministic fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk";
import {
  attestWorkspaceFixture,
  generateWorkspaceFileBytes,
  verifyWorkspaceFixtureManifest,
} from "agent-app-benchmark/workspace-fixture";

import { writeProjectionFixture, type ProjectionFixture } from "../../projection-fixture.ts";

const MODEL_SELECTION = JSON.stringify({ instanceId: "opencode", model: "benchmark" });

interface CorpusManifestSession {
  readonly logicalSessionId: string;
  readonly nativeSessionId: string;
  readonly workspaceId: string;
  readonly role: string;
  readonly transcriptBytes: number;
  readonly eventCount: number;
  readonly file: string;
  readonly fileDigestSha256: string;
}

interface CorpusManifest {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly corpusDigestSha256: string;
  readonly sourceEventFormat: { readonly schemaDigestSha256: string };
  readonly sessions: ReadonlyArray<CorpusManifestSession>;
}

interface SessionInfo {
  readonly id: string;
  readonly title: string;
  readonly time: { readonly created: number; readonly updated: number };
}

interface MessageInfo {
  readonly id: string;
  readonly sessionID: string;
  readonly role: "user" | "assistant";
  readonly time: { readonly created: number; readonly completed?: number };
}

interface TextPart {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly type: "text";
  readonly text: string;
}

interface CanonicalPart {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly type: "text" | "reasoning" | "tool" | "patch" | "step-start" | "step-finish";
  readonly text?: string;
  readonly state?: { readonly input?: unknown; readonly output?: string };
}

interface SerializedEvent {
  readonly id: string;
  readonly type: "session.created.1" | "message.updated.1" | "message.part.updated.1";
  readonly seq: number;
  readonly aggregateID: string;
  readonly data: Record<string, unknown>;
}

interface ParsedSession {
  readonly manifest: CorpusManifestSession;
  readonly info: SessionInfo;
  readonly messages: ReadonlyArray<{ readonly info: MessageInfo; readonly part: TextPart }>;
}

export interface T3WorkspaceFixtureAttestation {
  readonly generator: WorkspaceFixtureManifest["generator"];
  readonly seed: string;
  readonly manifestDigestSha256: string;
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly baselineCommit: string;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly absolutePath: string;
      readonly digestSha256: string;
      readonly initialDigestSha256: string;
      readonly currentDigestSha256: string;
      readonly byteLength: number;
      readonly state: "tracked" | "modified";
    }>;
    readonly diffs: ReadonlyArray<{
      readonly path: string;
      readonly status: "modified";
      readonly baselineDigestSha256: string;
      readonly workingTreeDigestSha256: string;
      readonly hunkCount: number;
      readonly changedLineCount: number;
      readonly hunks: ReadonlyArray<{ readonly startLine: number; readonly lineCount: number }>;
    }>;
    readonly openFilePaths: ReadonlyArray<string>;
  }>;
}

export interface T3WorkspaceFixtureSeal {
  readonly digestSha256: string;
  readonly manifest: WorkspaceFixtureManifest;
  readonly attestation: T3WorkspaceFixtureAttestation;
}

export interface T3PublicMaterializationResult {
  readonly corpusDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
  readonly mappingDigestSha256: string;
  readonly sessionMapping: Readonly<Record<string, string>>;
  readonly readinessTargets: ReadonlyMap<
    string,
    {
      readonly logicalSessionId: string;
      readonly sessionId: string;
      readonly title: string;
      readonly expectedMessageIds: ReadonlyArray<string>;
    }
  >;
  readonly messageCount: number;
  readonly transcriptBytes: number;
  readonly workspaceFixtureDigestSha256: string | null;
  readonly workspaceFixtureAttestation: T3WorkspaceFixtureAttestation | null;
}

export async function materializeT3PublicCorpus(input: {
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly expectedCorpusDigestSha256: string;
  readonly expectedEventSchemaDigestSha256: string;
  readonly dbPath: string;
  readonly disposableRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceFixtureManifest?: WorkspaceFixtureManifest;
  readonly expectedWorkspaceFixtureDigestSha256?: string;
}): Promise<T3PublicMaterializationResult> {
  const manifest = JSON.parse(
    await NodeFSP.readFile(input.corpusManifestPath, "utf8"),
  ) as CorpusManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.corpusDigestSha256 !== input.expectedCorpusDigestSha256
  ) {
    throw new Error("T3 received a corpus manifest with the wrong digest.");
  }
  if (manifest.sourceEventFormat.schemaDigestSha256 !== input.expectedEventSchemaDigestSha256) {
    throw new Error("T3 received an OpenCode event schema with the wrong digest.");
  }
  if (
    (input.workspaceFixtureManifest === undefined) !==
    (input.expectedWorkspaceFixtureDigestSha256 === undefined)
  )
    throw new Error("T3 workspace fixture manifest and public digest must be supplied together.");
  if (input.workspaceFixtureManifest) {
    verifyWorkspaceFixtureManifest(input.workspaceFixtureManifest);
    if (
      input.workspaceFixtureManifest.manifestDigestSha256 !==
      input.expectedWorkspaceFixtureDigestSha256
    )
      throw new Error("T3 workspace manifest does not match the supplied public fixture digest.");
  }
  const parsed: Array<ParsedSession> = [];
  for (const session of manifest.sessions)
    parsed.push(await parseSession(input.corpusDirectory, session));
  const fixture = buildFixture(parsed, input.workspaceRoot);
  await Promise.all(
    fixture.projects.map(async (project) => {
      if (!isWithin(input.workspaceRoot, project.workspaceRoot))
        throw new Error(`T3 rejected workspace outside ${input.workspaceRoot}.`);
      await NodeFSP.mkdir(project.workspaceRoot, { recursive: true, mode: 0o700 });
    }),
  );
  const workspaceFixtureAttestation = input.workspaceFixtureManifest
    ? await materializeWorkspaceFixture({
        manifest: input.workspaceFixtureManifest,
        expectedDigestSha256: input.expectedWorkspaceFixtureDigestSha256!,
        projects: fixture.projects.map((project) => ({
          workspaceId: project.projectId.slice("benchmark-".length),
          workspaceRoot: project.workspaceRoot,
        })),
      })
    : null;
  const workspaceFixtureDigestSha256 = workspaceFixtureAttestation
    ? input.expectedWorkspaceFixtureDigestSha256!
    : null;
  writeProjectionFixture({ dbPath: input.dbPath, disposableRoot: input.disposableRoot, fixture });
  const readback = readbackProjection(input.dbPath);
  const expectedTranscriptBytes = manifest.sessions.reduce(
    (total, session) => total + session.transcriptBytes,
    0,
  );
  if (
    readback.messageCount !== fixture.messages.length ||
    readback.transcriptBytes !== expectedTranscriptBytes
  ) {
    throw new Error("T3 projection readback does not match the canonical OpenCode corpus.");
  }
  const sessionMapping = Object.fromEntries(
    parsed.map((session) => [session.manifest.logicalSessionId, session.info.id]),
  );
  const listRanks = workspaceListRanks(
    parsed.map((session) => ({
      workspaceId: session.manifest.workspaceId,
      logicalSessionId: session.manifest.logicalSessionId,
    })),
  );
  const readinessTargets = new Map(
    parsed.map((session) => {
      const latest = session.messages.at(-1);
      if (!latest)
        throw new Error(
          `T3 benchmark session ${session.manifest.logicalSessionId} has no messages.`,
        );
      const listIndex = listRanks.get(session.manifest.logicalSessionId) ?? 0;
      return [
        session.manifest.logicalSessionId,
        {
          logicalSessionId: session.manifest.logicalSessionId,
          sessionId: session.info.id,
          title: distinctSyntheticSessionTitle(
            session.info.title,
            listIndex,
            session.manifest.logicalSessionId,
          ),
          expectedMessageIds: [latest.info.id],
        },
      ] as const;
    }),
  );
  return {
    corpusDigestSha256: manifest.corpusDigestSha256,
    eventSchemaDigestSha256: manifest.sourceEventFormat.schemaDigestSha256,
    mappingDigestSha256: sha256(
      canonicalJson(
        workspaceFixtureDigestSha256
          ? { sessionMapping, workspaceFixtureDigestSha256 }
          : sessionMapping,
      ),
    ),
    sessionMapping,
    readinessTargets,
    messageCount: readback.messageCount,
    transcriptBytes: readback.transcriptBytes,
    workspaceFixtureDigestSha256,
    workspaceFixtureAttestation,
  };
}

async function materializeWorkspaceFixture(input: {
  readonly manifest: WorkspaceFixtureManifest;
  readonly expectedDigestSha256: string;
  readonly projects: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workspaceRoot: string;
  }>;
}): Promise<T3WorkspaceFixtureAttestation> {
  const workspaces: T3WorkspaceFixtureAttestation["workspaces"][number][] = [];
  for (const project of input.projects) {
    for (const file of input.manifest.files) {
      const absolutePath = safeWorkspacePath(project.workspaceRoot, file.path);
      await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(
        absolutePath,
        generateWorkspaceFileBytes(input.manifest.seed, file, "initial"),
        { mode: 0o600 },
      );
    }
    await initializeGitRepository(project.workspaceRoot);
    const baselineCommit = await git(project.workspaceRoot, ["rev-parse", "HEAD"]);
    for (const file of input.manifest.files) {
      if (!file.changed) continue;
      await NodeFSP.writeFile(
        safeWorkspacePath(project.workspaceRoot, file.path),
        generateWorkspaceFileBytes(input.manifest.seed, file, "current"),
        { mode: 0o600 },
      );
    }
    const files = await Promise.all(
      input.manifest.files.map(async (file) => {
        const absolutePath = safeWorkspacePath(project.workspaceRoot, file.path);
        return {
          path: file.path,
          absolutePath,
          digestSha256: sha256Bytes(await NodeFSP.readFile(absolutePath)),
          initialDigestSha256: file.initialDigestSha256,
          currentDigestSha256: file.currentDigestSha256,
          byteLength: file.byteLength,
          state: file.changed ? ("modified" as const) : ("tracked" as const),
        };
      }),
    );
    const diffs = input.manifest.files
      .filter((file) => file.changed)
      .map((file) => ({
        path: file.path,
        status: "modified" as const,
        baselineDigestSha256: file.initialDigestSha256,
        workingTreeDigestSha256: file.currentDigestSha256,
        hunkCount: file.hunks.length,
        changedLineCount: file.hunks.reduce((total, hunk) => total + hunk.lineCount, 0),
        hunks: file.hunks,
      }));
    await attestGitWorkspace(project.workspaceRoot, diffs);
    const attestedDigest = await attestManifestWorkspace(project.workspaceRoot, input.manifest);
    if (attestedDigest !== input.expectedDigestSha256)
      throw new Error("T3 workspace bytes do not match the supplied public fixture digest.");
    workspaces.push({
      workspaceId: project.workspaceId,
      workspaceRoot: project.workspaceRoot,
      baselineCommit,
      files,
      diffs,
      openFilePaths: input.manifest.openFilePaths,
    });
  }
  return {
    generator: input.manifest.generator,
    seed: input.manifest.seed,
    manifestDigestSha256: input.expectedDigestSha256,
    workspaces,
  };
}

async function attestManifestWorkspace(
  repository: string,
  manifest: WorkspaceFixtureManifest,
): Promise<string> {
  return attestWorkspaceFixture(manifest, async (path, revision) =>
    revision === "initial"
      ? gitBytes(repository, ["show", `HEAD:${path}`])
      : NodeFSP.readFile(safeWorkspacePath(repository, path)),
  );
}

function validateFixtureAttestation(
  attestation: T3WorkspaceFixtureAttestation,
  manifest: WorkspaceFixtureManifest,
): void {
  if (
    attestation.generator !== manifest.generator ||
    attestation.seed !== manifest.seed ||
    attestation.manifestDigestSha256 !== manifest.manifestDigestSha256
  )
    throw new Error("T3 workspace fixture attestation does not identify its public manifest.");
  const expectedFiles = manifest.files.map((file) => ({
    path: file.path,
    digestSha256: file.currentDigestSha256,
    initialDigestSha256: file.initialDigestSha256,
    currentDigestSha256: file.currentDigestSha256,
    byteLength: file.byteLength,
    state: file.changed ? "modified" : "tracked",
  }));
  const expectedDiffs = manifest.files
    .filter((file) => file.changed)
    .map((file) => ({
      path: file.path,
      status: "modified",
      baselineDigestSha256: file.initialDigestSha256,
      workingTreeDigestSha256: file.currentDigestSha256,
      hunkCount: file.hunks.length,
      changedLineCount: file.hunks.reduce((total, hunk) => total + hunk.lineCount, 0),
      hunks: file.hunks,
    }));
  for (const workspace of attestation.workspaces) {
    const files = workspace.files.map(({ absolutePath: _, ...file }) => file);
    if (
      canonicalJson(files) !== canonicalJson(expectedFiles) ||
      canonicalJson(workspace.diffs) !== canonicalJson(expectedDiffs) ||
      canonicalJson(workspace.openFilePaths) !== canonicalJson(manifest.openFilePaths)
    )
      throw new Error("T3 workspace fixture attestation identities differ from its manifest.");
  }
}

async function initializeGitRepository(repository: string): Promise<void> {
  await git(repository, [
    "init",
    "--quiet",
    "--object-format=sha1",
    "--initial-branch",
    "benchmark",
  ]);
  await git(repository, ["config", "core.autocrlf", "false"]);
  await git(repository, ["config", "core.filemode", "false"]);
  await git(repository, ["add", "--all"]);
  await git(
    repository,
    [
      "-c",
      "user.name=Agent App Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "benchmark baseline",
    ],
    {
      GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
      GIT_AUTHOR_NAME: "Agent App Benchmark",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
      GIT_COMMITTER_NAME: "Agent App Benchmark",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  );
}

async function attestGitWorkspace(
  repository: string,
  expectedDiffs: T3WorkspaceFixtureAttestation["workspaces"][number]["diffs"],
): Promise<void> {
  const expectedByPath = new Map(expectedDiffs.map((diff) => [diff.path, diff]));
  const status = (await git(repository, ["status", "--porcelain=v1", "-z"]))
    .split("\0")
    .filter(Boolean);
  if (
    status.length !== expectedDiffs.length ||
    status.some((entry) => !entry.startsWith(" M ") || !expectedByPath.has(entry.slice(3)))
  )
    throw new Error("T3 materialized workspace status does not match its public manifest.");
  const numstat = (await git(repository, ["diff", "--numstat", "--no-ext-diff", "--no-renames"]))
    .split("\n")
    .filter(Boolean);
  for (const entry of numstat) {
    const [added, deleted, path] = entry.split("\t");
    const expected = path ? expectedByPath.get(path) : undefined;
    if (
      !expected ||
      Number(added) !== expected.changedLineCount ||
      Number(deleted) !== expected.changedLineCount
    )
      throw new Error("T3 materialized workspace line changes do not match its public manifest.");
  }
  if (numstat.length !== expectedDiffs.length)
    throw new Error("T3 materialized workspace diff count does not match its public manifest.");
  const diff = await git(repository, ["diff", "--unified=0", "--no-ext-diff", "--no-renames"]);
  const actualHunks = new Map<
    string,
    Array<{ readonly startLine: number; readonly lineCount: number }>
  >();
  let currentPath: string | undefined;
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (match && match[1] === match[2]) {
      currentPath = match[1]!;
      actualHunks.set(currentPath, []);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!currentPath || !hunk) continue;
    const oldStart = Number(hunk[1]);
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newStart = Number(hunk[3]);
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
    if (oldStart !== newStart || oldCount !== newCount)
      throw new Error("T3 materialized workspace changed the canonical diff line structure.");
    actualHunks.get(currentPath)!.push({
      startLine: oldStart - 1,
      lineCount: oldCount,
    });
  }
  if (
    expectedDiffs.some(
      (expected) => canonicalJson(actualHunks.get(expected.path)) !== canonicalJson(expected.hunks),
    )
  )
    throw new Error("T3 materialized workspace hunks do not match its public manifest.");
}

function safeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const target = NodePath.resolve(workspaceRoot, relativePath);
  if (!isWithin(workspaceRoot, target) || target === NodePath.resolve(workspaceRoot))
    throw new Error("T3 workspace fixture path escapes its root.");
  return target;
}

async function git(
  repository: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      {
        cwd: repository,
        encoding: "utf8",
        env: isolatedGitEnvironment(repository, environment),
        maxBuffer: 64 * 1_024 * 1_024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`T3 workspace git command failed: ${stderr.trim() || error.message}`));
        else resolve(stdout.trimEnd());
      },
    );
  });
}

async function gitBytes(repository: string, args: ReadonlyArray<string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      {
        cwd: repository,
        encoding: "buffer",
        env: isolatedGitEnvironment(repository),
        maxBuffer: 64 * 1_024 * 1_024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `T3 workspace git command failed: ${stderr.toString("utf8").trim() || error.message}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

function isolatedGitEnvironment(
  repository: string,
  environment: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...inheritedEnvironment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(repository, ".git", "benchmark-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
    ...environment,
  };
}

function isWithin(root: string, target: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export async function rebaseT3BenchmarkWorkspaces(input: {
  readonly dbPath: string;
  readonly sourceStateRoot: string;
  readonly targetStateRoot: string;
  readonly workspaceFixtureSeal?: T3WorkspaceFixtureSeal;
}): Promise<T3WorkspaceFixtureSeal | null> {
  const database = new NodeSqlite.DatabaseSync(input.dbPath, { timeout: 30_000 });
  try {
    const rows = database
      .prepare("SELECT project_id, workspace_root FROM projection_projects")
      .all() as unknown as ReadonlyArray<{
      readonly project_id: string;
      readonly workspace_root: string;
    }>;
    const rebased = rows.map((row) => {
      if (!isWithin(input.sourceStateRoot, row.workspace_root))
        throw new Error(
          `T3 benchmark workspace ${row.workspace_root} is outside its sealed source state.`,
        );
      return {
        projectId: row.project_id,
        workspaceId: row.project_id.startsWith("benchmark-")
          ? row.project_id.slice("benchmark-".length)
          : row.project_id,
        workspaceRoot: NodePath.join(
          input.targetStateRoot,
          NodePath.relative(input.sourceStateRoot, row.workspace_root),
        ),
      };
    });
    await Promise.all(rebased.map((row) => NodeFSP.access(row.workspaceRoot)));
    const rebasedFixtureSeal = input.workspaceFixtureSeal
      ? await reattestRebasedWorkspaceFixture({
          canonical: input.workspaceFixtureSeal,
          sourceStateRoot: input.sourceStateRoot,
          projects: rebased,
        })
      : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      const update = database.prepare(
        "UPDATE projection_projects SET workspace_root = ? WHERE project_id = ?",
      );
      for (const row of rebased) update.run(row.workspaceRoot, row.projectId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return rebasedFixtureSeal;
  } finally {
    database.close();
  }
}

async function reattestRebasedWorkspaceFixture(input: {
  readonly canonical: T3WorkspaceFixtureSeal;
  readonly sourceStateRoot: string;
  readonly projects: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workspaceRoot: string;
  }>;
}): Promise<T3WorkspaceFixtureSeal> {
  verifyWorkspaceFixtureManifest(input.canonical.manifest);
  if (
    input.canonical.manifest.manifestDigestSha256 !== input.canonical.digestSha256 ||
    input.canonical.attestation.manifestDigestSha256 !== input.canonical.digestSha256
  )
    throw new Error("T3 rejected a workspace fixture seal with a mismatched canonical digest.");
  validateFixtureAttestation(input.canonical.attestation, input.canonical.manifest);
  const projectByWorkspace = new Map(
    input.projects.map((project) => [project.workspaceId, project] as const),
  );
  if (
    projectByWorkspace.size !== input.projects.length ||
    input.canonical.attestation.workspaces.length !== input.projects.length
  )
    throw new Error("T3 rebased workspace count does not match its fixture attestation.");
  const workspaces: T3WorkspaceFixtureAttestation["workspaces"][number][] = [];
  for (const expected of input.canonical.attestation.workspaces) {
    if (!isWithin(input.sourceStateRoot, expected.workspaceRoot))
      throw new Error("T3 canonical workspace fixture is outside its sealed source state.");
    const project = projectByWorkspace.get(expected.workspaceId);
    if (!project) throw new Error(`T3 rebased workspace ${expected.workspaceId} is missing.`);
    const baselineCommit = await git(project.workspaceRoot, ["rev-parse", "HEAD"]);
    if (baselineCommit !== expected.baselineCommit)
      throw new Error(
        `T3 rebased workspace ${expected.workspaceId} baseline commit does not match.`,
      );
    const files = await Promise.all(
      expected.files.map(async (file) => {
        const absolutePath = safeWorkspacePath(project.workspaceRoot, file.path);
        const digestSha256 = sha256Bytes(await NodeFSP.readFile(absolutePath));
        if (digestSha256 !== file.digestSha256)
          throw new Error(
            `T3 rebased workspace ${expected.workspaceId} file digest does not match for ${file.path}.`,
          );
        return { ...file, absolutePath };
      }),
    );
    const filePaths = new Set(files.map((file) => file.path));
    if (
      expected.openFilePaths.some((path) => !filePaths.has(path)) ||
      expected.diffs.some((diff) => !filePaths.has(diff.path))
    )
      throw new Error("T3 workspace fixture identities refer to unattested files.");
    await attestGitWorkspace(project.workspaceRoot, expected.diffs);
    const attestedDigest = await attestManifestWorkspace(
      project.workspaceRoot,
      input.canonical.manifest,
    );
    if (attestedDigest !== input.canonical.digestSha256)
      throw new Error("T3 rebased workspace fixture does not match the public manifest.");
    workspaces.push({ ...expected, workspaceRoot: project.workspaceRoot, files });
  }
  const attestation: T3WorkspaceFixtureAttestation = {
    ...input.canonical.attestation,
    workspaces,
  };
  return {
    digestSha256: input.canonical.digestSha256,
    manifest: input.canonical.manifest,
    attestation,
  };
}

async function parseSession(
  corpusDirectory: string,
  session: CorpusManifestSession,
): Promise<ParsedSession> {
  const root = NodePath.resolve(corpusDirectory);
  const file = NodePath.resolve(root, session.file);
  if (!file.startsWith(`${root}${NodePath.sep}`))
    throw new Error("T3 corpus session path escapes its root.");
  const fileHash = NodeCrypto.createHash("sha256");
  let info: SessionInfo | undefined;
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, Array<CanonicalPart>>();
  let expectedSequence = 0;
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    fileHash.update(`${line}\n`);
    const event = JSON.parse(line) as SerializedEvent;
    if (event.seq !== expectedSequence || event.aggregateID !== session.nativeSessionId)
      throw new Error(`T3 rejected invalid event order for ${session.logicalSessionId}.`);
    if (event.type === "session.created.1") info = event.data.info as SessionInfo;
    else if (event.type === "message.updated.1") {
      const message = event.data.info as MessageInfo;
      messages.set(message.id, message);
    } else if (event.type === "message.part.updated.1") {
      const part = event.data.part as CanonicalPart;
      if (!["text", "reasoning", "tool", "patch", "step-start", "step-finish"].includes(part.type))
        throw new Error(`T3 rejected unsupported completed part ${part.type}.`);
      const messageParts = parts.get(part.messageID) ?? [];
      messageParts.push(part);
      parts.set(part.messageID, messageParts);
    } else
      throw new Error(
        `T3 rejected unknown OpenCode event type ${(event as SerializedEvent).type}.`,
      );
    expectedSequence += 1;
  }
  if (
    fileHash.digest("hex") !== session.fileDigestSha256 ||
    expectedSequence !== session.eventCount
  )
    throw new Error(`T3 corpus file integrity failed for ${session.logicalSessionId}.`);
  if (!info || info.id !== session.nativeSessionId)
    throw new Error(`T3 corpus session metadata is missing for ${session.logicalSessionId}.`);
  const ordered = [...messages.values()].map((message) => {
    const messageParts = parts.get(message.id);
    if (!messageParts) throw new Error(`T3 corpus message ${message.id} has no completed parts.`);
    const text = messageParts.map(partPayload).join("");
    return {
      info: message,
      part: {
        id: `translated-${message.id}`,
        sessionID: message.sessionID,
        messageID: message.id,
        type: "text" as const,
        text,
      },
    };
  });
  const bytes = ordered.reduce(
    (total, message) => total + Buffer.byteLength(message.part.text, "utf8"),
    0,
  );
  if (bytes !== session.transcriptBytes)
    throw new Error(`T3 transcript byte count failed for ${session.logicalSessionId}.`);
  return { manifest: session, info, messages: ordered };
}

function partPayload(part: CanonicalPart): string {
  if (part.type === "text" || part.type === "reasoning") return part.text ?? "";
  if (part.type === "tool")
    return `${JSON.stringify(part.state?.input ?? null)}${part.state?.output ?? ""}`;
  return "";
}

function buildFixture(
  sessions: ReadonlyArray<ParsedSession>,
  workspaceRoot: string,
): ProjectionFixture {
  const workspaceIds = [...new Set(sessions.map((session) => session.manifest.workspaceId))].sort();
  const projects = workspaceIds.map((workspaceId) => ({
    projectId: `benchmark-${workspaceId}`,
    title: `Benchmark ${workspaceId}`,
    workspaceRoot: NodePath.join(workspaceRoot, workspaceId),
    defaultModelSelectionJson: MODEL_SELECTION,
    scriptsJson: "[]",
    createdAt: timestamp(0),
    updatedAt: timestamp(1),
  }));
  const projectByWorkspace = new Map(
    projects.map((project, index) => [workspaceIds[index]!, project.projectId]),
  );
  const listRanks = workspaceListRanks(
    sessions.map((session) => ({
      workspaceId: session.manifest.workspaceId,
      logicalSessionId: session.manifest.logicalSessionId,
    })),
  );
  const turns: Array<ProjectionFixture["turns"][number]> = [];
  const messages: Array<ProjectionFixture["messages"][number]> = [];
  const threads: Array<ProjectionFixture["threads"][number]> = [];
  for (const session of sessions) {
    let latestTurnId: string | null = null;
    let latestUserMessageAt: string | null = null;
    const groups: Array<Array<(typeof session.messages)[number]>> = [];
    for (const message of session.messages) {
      if (message.info.role === "user") groups.push([message]);
      else {
        const group = groups.at(-1);
        if (!group)
          throw new Error(
            `T3 corpus session ${session.manifest.logicalSessionId} starts with an assistant message.`,
          );
        group.push(message);
      }
    }
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const turnId = `turn-${session.info.id}-${index}`;
      latestTurnId = turnId;
      const user = group[0];
      const assistants = group.slice(1);
      const assistant = assistants.at(-1);
      if (user?.info.role !== "user" || !assistant)
        throw new Error(
          `T3 corpus session ${session.manifest.logicalSessionId} has an incomplete user/assistant turn.`,
        );
      latestUserMessageAt = timestamp(user.info.time.created);
      turns.push({
        threadId: session.info.id,
        turnId,
        assistantMessageId: assistant.info.id,
        state: "completed",
        requestedAt: timestamp(user.info.time.created),
        startedAt: timestamp(user.info.time.created),
        completedAt: timestamp(assistant.info.time.completed ?? assistant.info.time.created),
      });
      for (const message of group)
        messages.push({
          messageId: message.info.id,
          threadId: session.info.id,
          turnId,
          role: message.info.role,
          text: message.part.text,
          attachmentsJson: null,
          createdAt: timestamp(message.info.time.created),
          updatedAt: timestamp(message.info.time.completed ?? message.info.time.created),
        });
    }
    const listIndex = listRanks.get(session.manifest.logicalSessionId) ?? 0;
    const displayTitle = distinctSyntheticSessionTitle(
      session.info.title,
      listIndex,
      session.manifest.logicalSessionId,
    );
    const createdAt = distinctSyntheticSessionCreatedAt(session.info.time.created, listIndex);
    const updatedAt = distinctSyntheticSessionUpdatedAt(session.info.time.updated, listIndex);
    threads.push({
      threadId: session.info.id,
      projectId: projectByWorkspace.get(session.manifest.workspaceId)!,
      title: displayTitle,
      modelSelectionJson: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      latestTurnId,
      latestUserMessageAt,
      createdAt: timestamp(createdAt),
      updatedAt: timestamp(updatedAt),
      settledOverride: "active",
    });
  }
  return {
    projects,
    threads,
    turns,
    messages,
    activities: [],
    sessions: sessions.map((session) => {
      const listIndex = listRanks.get(session.manifest.logicalSessionId) ?? 0;
      return {
        threadId: session.info.id,
        status: "ready",
        providerName: "OpenCode",
        providerInstanceId: "opencode",
        runtimeMode: "full-access",
        updatedAt: timestamp(
          distinctSyntheticSessionUpdatedAt(session.info.time.updated, listIndex),
        ),
      };
    }),
  };
}

/** Strip any prior serial and prefix the per-workspace 1-based list rank. */
export function distinctSyntheticSessionTitle(
  title: string,
  sessionIndex: number,
  logicalSessionId: string,
) {
  const stripped = title.trim().replace(/^\d+\.\s+/u, "");
  const stem = stripped || `Synthetic benchmark ${logicalSessionId}`;
  return `${sessionIndex + 1}. ${stem}`;
}

/** Distinct created times so created_desc order matches serial titles top→bottom. */
export function distinctSyntheticSessionCreatedAt(createdAt: number, sessionIndex: number) {
  return createdAt + (sessionIndex + 1) * 60_000;
}

/** Guarantee updated_desc order even when corpus stamps identical updated times. */
export function distinctSyntheticSessionUpdatedAt(updatedAt: number, sessionIndex: number) {
  return updatedAt + (sessionIndex + 1) * 60_000;
}

/** Contiguous per-workspace ranks for created_desc: newest/top = highest serial. */
export function workspaceListRanks(
  sessions: readonly { workspaceId: string; logicalSessionId: string }[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  const ordinal = new Map<string, number>();
  for (const session of sessions) {
    const listIndex = ordinal.get(session.workspaceId) ?? 0;
    ordinal.set(session.workspaceId, listIndex + 1);
    ranks.set(session.logicalSessionId, listIndex);
  }
  return ranks;
}

function readbackProjection(dbPath: string): {
  readonly messageCount: number;
  readonly transcriptBytes: number;
} {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS bytes FROM projection_thread_messages",
      )
      .get() as { readonly count: number; readonly bytes: number };
    return { messageCount: row.count, transcriptBytes: row.bytes };
  } finally {
    database.close();
  }
}

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}
