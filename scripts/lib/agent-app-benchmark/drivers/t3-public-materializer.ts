// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Public benchmark adapter materializes isolated deterministic fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";

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
}

export async function materializeT3PublicCorpus(input: {
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly expectedCorpusDigestSha256: string;
  readonly expectedEventSchemaDigestSha256: string;
  readonly dbPath: string;
  readonly disposableRoot: string;
  readonly workspaceRoot: string;
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
  const readinessTargets = new Map(
    parsed.map((session) => {
      const latest = session.messages.at(-1);
      if (!latest)
        throw new Error(
          `T3 benchmark session ${session.manifest.logicalSessionId} has no messages.`,
        );
      return [
        session.manifest.logicalSessionId,
        {
          logicalSessionId: session.manifest.logicalSessionId,
          sessionId: session.info.id,
          title: session.info.title,
          expectedMessageIds: [latest.info.id],
        },
      ] as const;
    }),
  );
  return {
    corpusDigestSha256: manifest.corpusDigestSha256,
    eventSchemaDigestSha256: manifest.sourceEventFormat.schemaDigestSha256,
    mappingDigestSha256: sha256(canonicalJson(sessionMapping)),
    sessionMapping,
    readinessTargets,
    messageCount: readback.messageCount,
    transcriptBytes: readback.transcriptBytes,
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
}): Promise<void> {
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
        workspaceRoot: NodePath.join(
          input.targetStateRoot,
          NodePath.relative(input.sourceStateRoot, row.workspace_root),
        ),
      };
    });
    await Promise.all(rebased.map((row) => NodeFSP.access(row.workspaceRoot)));
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
  } finally {
    database.close();
  }
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
    const createdAt = distinctSyntheticSessionCreatedAt(session.info.time.created, listIndex);
    const updatedAt = distinctSyntheticSessionUpdatedAt(session.info.time.updated, listIndex);
    threads.push({
      threadId: session.info.id,
      projectId: projectByWorkspace.get(session.manifest.workspaceId)!,
      title: session.info.title,
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

/** Distinct created times so created_desc lists one workspace's sessions in corpus order. */
export function distinctSyntheticSessionCreatedAt(createdAt: number, sessionIndex: number) {
  return createdAt + (sessionIndex + 1) * 60_000;
}

/** Guarantee updated_desc order even when corpus stamps identical updated times. */
export function distinctSyntheticSessionUpdatedAt(updatedAt: number, sessionIndex: number) {
  return updatedAt + (sessionIndex + 1) * 60_000;
}

/** Contiguous per-workspace ranks in corpus order; the newest session has the highest rank. */
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
