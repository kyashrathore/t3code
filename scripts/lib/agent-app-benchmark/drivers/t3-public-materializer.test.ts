// @effect-diagnostics nodeBuiltinImport:off - Public benchmark adapter tests isolated SQLite projection materialization.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { buildWorkspaceFixtureManifest } from "agent-app-benchmark/workspace-fixture";

import {
  materializeT3PublicCorpus,
  rebaseT3BenchmarkWorkspaces,
} from "./t3-public-materializer.ts";

it("translates pinned OpenCode events into T3's canonical projection fixture and reads it back", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-public-materializer-"));
  try {
    const stateRoot = NodePath.join(root, "state");
    const workspaceRoot = NodePath.join(stateRoot, "workspaces");
    const dbPath = NodePath.join(stateRoot, "userdata", "state.sqlite");
    await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    const corpus = await writeCorpusFixture(root);
    const result = await materializeT3PublicCorpus({
      corpusDirectory: corpus.directory,
      corpusManifestPath: corpus.manifestPath,
      expectedCorpusDigestSha256: corpus.corpusDigestSha256,
      expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
      dbPath,
      disposableRoot: root,
      workspaceRoot,
    });
    assert.equal(result.messageCount, 2);
    assert.equal(result.transcriptBytes, 10);
    assert.equal(result.sessionMapping.control, "ses_bench_control");
    assert.deepStrictEqual(result.readinessTargets.get("control")?.expectedMessageIds, [
      "msg_assistant",
    ]);
    assert.equal(result.readinessTargets.get("control")?.title, "1. Control");
    assert.match(result.mappingDigestSha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.mappingDigestSha256, digest('{"control":"ses_bench_control"}'));
    assert.equal(
      (await NodeFSP.stat(NodePath.join(workspaceRoot, "workspace-a"))).isDirectory(),
      true,
    );

    const read = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    assert.deepStrictEqual(
      (
        read.prepare("SELECT title FROM projection_threads").all() as Array<{
          readonly title: string;
        }>
      ).map((row) => row.title),
      ["1. Control"],
    );
    const rows = read
      .prepare("SELECT role, text FROM projection_thread_messages ORDER BY created_at")
      .all() as Array<{ readonly role: string; readonly text: string }>;
    read.close();
    assert.deepStrictEqual(rows, [
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);

    const clonedStateRoot = NodePath.join(root, "cloned-state");
    await NodeFSP.cp(stateRoot, clonedStateRoot, { recursive: true });
    const clonedDbPath = NodePath.join(clonedStateRoot, "userdata", "state.sqlite");
    await rebaseT3BenchmarkWorkspaces({
      dbPath: clonedDbPath,
      sourceStateRoot: stateRoot,
      targetStateRoot: clonedStateRoot,
    });
    const cloned = new NodeSqlite.DatabaseSync(clonedDbPath, { readOnly: true });
    assert.deepStrictEqual(cloned.prepare("SELECT workspace_root FROM projection_projects").all(), [
      { workspace_root: NodePath.join(clonedStateRoot, "workspaces", "workspace-a") },
    ]);
    cloned.close();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects reordered OpenCode durable events before writing T3 state", async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-public-materializer-invalid-"),
  );
  try {
    const dbPath = NodePath.join(root, "state.sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    const corpus = await writeCorpusFixture(root, true);
    let rejection: unknown;
    try {
      await materializeT3PublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dbPath,
        disposableRoot: root,
        workspaceRoot: root,
      });
    } catch (error) {
      rejection = error;
    }
    assert.match(String(rejection), /invalid event order/u);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("materializes a deterministic substantial git workspace and preserves it when rebased", async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-public-materializer-workspace-"),
  );
  try {
    const stateRoot = NodePath.join(root, "state");
    const workspaceRoot = NodePath.join(stateRoot, "workspaces");
    const dbPath = NodePath.join(stateRoot, "userdata", "state.sqlite");
    await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    const corpus = await writeCorpusFixture(root);
    const workspaceFixtureManifest = buildWorkspaceFixtureManifest(
      {
        generator: "agent-app-workspace-v1",
        directoryCount: 16,
        sourceFileCount: 160,
        sourceFileBytes: 32_768,
        changedFileCount: 24,
        diffHunksPerFile: 8,
        diffLinesPerHunk: 24,
        openFileTabCount: 4,
      },
      "fixture-seed",
    );
    const result = await materializeT3PublicCorpus({
      corpusDirectory: corpus.directory,
      corpusManifestPath: corpus.manifestPath,
      expectedCorpusDigestSha256: corpus.corpusDigestSha256,
      expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
      dbPath,
      disposableRoot: root,
      workspaceRoot,
      workspaceFixtureManifest,
      expectedWorkspaceFixtureDigestSha256: workspaceFixtureManifest.manifestDigestSha256,
    });
    assert.equal(
      result.workspaceFixtureDigestSha256,
      workspaceFixtureManifest.manifestDigestSha256,
    );
    assert.equal(
      result.mappingDigestSha256,
      digest(
        `{"sessionMapping":{"control":"ses_bench_control"},"workspaceFixtureDigestSha256":${JSON.stringify(result.workspaceFixtureDigestSha256)}}`,
      ),
    );
    const attestation = result.workspaceFixtureAttestation;
    assert(attestation);
    assert.equal(attestation.workspaces.length, 1);
    const materialized = attestation.workspaces[0]!;
    assert.equal(materialized.workspaceId, "workspace-a");
    assert.equal(materialized.files.length, 160);
    assert.equal(materialized.diffs.length, 24);
    assert.equal(materialized.openFilePaths.length, 4);
    assert.equal(materialized.baselineCommit.length, 40);
    assert.deepStrictEqual(
      materialized.files.map((file) => file.path),
      workspaceFixtureManifest.files.map((file) => file.path),
    );
    assert.deepStrictEqual(
      materialized.diffs.map((diff) => diff.path),
      workspaceFixtureManifest.changedFilePaths,
    );
    assert.deepStrictEqual(materialized.openFilePaths, workspaceFixtureManifest.openFilePaths);
    assert.deepStrictEqual(
      materialized.diffs.map((diff) => diff.hunks),
      workspaceFixtureManifest.files.filter((file) => file.changed).map((file) => file.hunks),
    );
    assert.deepStrictEqual(
      materialized.diffs.map((diff) => ({
        status: diff.status,
        hunkCount: diff.hunkCount,
        changedLineCount: diff.changedLineCount,
      })),
      Array.from({ length: 24 }, () => ({
        status: "modified",
        hunkCount: 8,
        changedLineCount: 192,
      })),
    );
    const repository = NodePath.join(workspaceRoot, "workspace-a");
    assert.equal((await NodeFSP.stat(NodePath.join(repository, ".git"))).isDirectory(), true);
    assert.equal((await NodeFSP.stat(materialized.files[0]!.absolutePath)).size, 32_768);
    for (const file of workspaceFixtureManifest.files) {
      assert.equal(
        digestBytes(gitBytes(repository, ["show", `HEAD:${file.path}`])),
        file.initialDigestSha256,
      );
      assert.equal(
        digestBytes(await NodeFSP.readFile(NodePath.join(repository, file.path))),
        file.currentDigestSha256,
      );
    }
    assert.equal(
      git(repository, ["status", "--porcelain=v1"]).trim().split("\n").filter(Boolean).length,
      24,
    );
    assert.equal(
      git(repository, ["diff", "--unified=3", "--no-ext-diff", "--no-renames"])
        .split("\n")
        .filter((line) => line.startsWith("@@ ")).length,
      192,
    );

    const repeatedStateRoot = NodePath.join(root, "repeated-state");
    const repeatedDbPath = NodePath.join(repeatedStateRoot, "userdata", "state.sqlite");
    await NodeFSP.mkdir(NodePath.dirname(repeatedDbPath), { recursive: true });
    const repeatedDatabase = new NodeSqlite.DatabaseSync(repeatedDbPath);
    createSchema(repeatedDatabase);
    repeatedDatabase.close();
    const poisonedGitEnvironment = {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_DEFAULT_HASH: process.env.GIT_DEFAULT_HASH,
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_AUTHOR_NAME = "ambient-author-must-not-leak";
    process.env.GIT_COMMITTER_NAME = "ambient-committer-must-not-leak";
    process.env.GIT_DEFAULT_HASH = "sha256";
    process.env.GIT_DIR = NodePath.join(root, "ambient-git-dir");
    process.env.GIT_WORK_TREE = NodePath.join(root, "ambient-work-tree");
    let repeated: Awaited<ReturnType<typeof materializeT3PublicCorpus>>;
    try {
      repeated = await materializeT3PublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dbPath: repeatedDbPath,
        disposableRoot: root,
        workspaceRoot: NodePath.join(repeatedStateRoot, "workspaces"),
        workspaceFixtureManifest,
        expectedWorkspaceFixtureDigestSha256: workspaceFixtureManifest.manifestDigestSha256,
      });
    } finally {
      restoreEnvironment(poisonedGitEnvironment);
    }
    assert.equal(repeated.workspaceFixtureDigestSha256, result.workspaceFixtureDigestSha256);
    assert.equal(
      repeated.workspaceFixtureAttestation?.workspaces[0]?.baselineCommit,
      materialized.baselineCommit,
    );

    const clonedStateRoot = NodePath.join(root, "cloned-state");
    await NodeFSP.cp(stateRoot, clonedStateRoot, { recursive: true });
    const clonedDbPath = NodePath.join(clonedStateRoot, "userdata", "state.sqlite");
    const rebasedFixture = await rebaseT3BenchmarkWorkspaces({
      dbPath: clonedDbPath,
      sourceStateRoot: stateRoot,
      targetStateRoot: clonedStateRoot,
      workspaceFixtureSeal: {
        digestSha256: result.workspaceFixtureDigestSha256!,
        manifest: workspaceFixtureManifest,
        attestation,
      },
    });
    const clonedRepository = NodePath.join(clonedStateRoot, "workspaces", "workspace-a");
    assert.equal(git(clonedRepository, ["rev-parse", "HEAD"]).trim(), materialized.baselineCommit);
    assert.equal(
      git(clonedRepository, ["status", "--porcelain=v1"]),
      git(repository, ["status", "--porcelain=v1"]),
    );
    assert.equal(rebasedFixture?.digestSha256, result.workspaceFixtureDigestSha256);
    assert.equal(rebasedFixture?.attestation.workspaces[0]?.workspaceRoot, clonedRepository);
    assert.equal(
      rebasedFixture?.attestation.workspaces[0]?.files[0]?.absolutePath,
      NodePath.join(clonedRepository, materialized.files[0]!.path),
    );

    const corruptedStateRoot = NodePath.join(root, "corrupted-state");
    await NodeFSP.cp(stateRoot, corruptedStateRoot, { recursive: true });
    const corruptedDbPath = NodePath.join(corruptedStateRoot, "userdata", "state.sqlite");
    await NodeFSP.writeFile(
      NodePath.join(corruptedStateRoot, "workspaces", "workspace-a", materialized.files[0]!.path),
      "corrupted fixture\n",
    );
    let corruptedRebase: unknown;
    try {
      await rebaseT3BenchmarkWorkspaces({
        dbPath: corruptedDbPath,
        sourceStateRoot: stateRoot,
        targetStateRoot: corruptedStateRoot,
        workspaceFixtureSeal: {
          digestSha256: result.workspaceFixtureDigestSha256!,
          manifest: workspaceFixtureManifest,
          attestation,
        },
      });
    } catch (error) {
      corruptedRebase = error;
    }
    assert.match(String(corruptedRebase), /file digest does not match/u);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects a workspace manifest whose public digest is not the supplied seal identity", async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-public-materializer-workspace-invalid-"),
  );
  try {
    const dbPath = NodePath.join(root, "state.sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    const corpus = await writeCorpusFixture(root);
    let rejection: unknown;
    try {
      await materializeT3PublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dbPath,
        disposableRoot: root,
        workspaceRoot: NodePath.join(root, "workspaces"),
        workspaceFixtureManifest: buildWorkspaceFixtureManifest(
          {
            generator: "agent-app-workspace-v1",
            directoryCount: 1,
            sourceFileCount: 1,
            sourceFileBytes: 2_048,
            changedFileCount: 1,
            diffHunksPerFile: 1,
            diffLinesPerHunk: 4,
            openFileTabCount: 1,
          },
          "fixture-seed",
        ),
        expectedWorkspaceFixtureDigestSha256: "0".repeat(64),
      });
    } catch (error) {
      rejection = error;
    }
    assert.match(String(rejection), /public fixture digest/u);
    let gitDirectory: unknown;
    try {
      await NodeFSP.access(NodePath.join(root, "workspaces", "workspace-a", ".git"));
    } catch (error) {
      gitDirectory = error;
    }
    assert(gitDirectory);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

async function writeCorpusFixture(
  root: string,
  reorder = false,
): Promise<{
  readonly directory: string;
  readonly manifestPath: string;
  readonly corpusDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
}> {
  const directory = NodePath.join(root, "corpus");
  await NodeFSP.mkdir(NodePath.join(directory, "sessions"), { recursive: true });
  const sessionID = "ses_bench_control";
  const events = [
    {
      id: "evt_0",
      type: "session.created.1",
      seq: 0,
      aggregateID: sessionID,
      data: {
        sessionID,
        info: {
          id: sessionID,
          title: "Control",
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_100 },
        },
      },
    },
    {
      id: "evt_1",
      type: "message.updated.1",
      seq: reorder ? 9 : 1,
      aggregateID: sessionID,
      data: {
        sessionID,
        info: { id: "msg_user", sessionID, role: "user", time: { created: 1_700_000_000_001 } },
      },
    },
    {
      id: "evt_2",
      type: "message.part.updated.1",
      seq: 2,
      aggregateID: sessionID,
      data: {
        sessionID,
        part: { id: "prt_user", sessionID, messageID: "msg_user", type: "text", text: "hello" },
        time: 1_700_000_000_002,
      },
    },
    {
      id: "evt_3",
      type: "message.updated.1",
      seq: 3,
      aggregateID: sessionID,
      data: {
        sessionID,
        info: {
          id: "msg_assistant",
          sessionID,
          role: "assistant",
          time: { created: 1_700_000_000_003, completed: 1_700_000_000_004 },
        },
      },
    },
    {
      id: "evt_4",
      type: "message.part.updated.1",
      seq: 4,
      aggregateID: sessionID,
      data: {
        sessionID,
        part: {
          id: "prt_assistant",
          sessionID,
          messageID: "msg_assistant",
          type: "text",
          text: "world",
        },
        time: 1_700_000_000_004,
      },
    },
  ];
  const bytes = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const relativeFile = "sessions/control.ndjson";
  await NodeFSP.writeFile(NodePath.join(directory, relativeFile), bytes);
  const corpusDigestSha256 = "a".repeat(64);
  const eventSchemaDigestSha256 = "b".repeat(64);
  const manifest = {
    schemaVersion: 1,
    corpusId: "fixture-v1",
    corpusDigestSha256,
    sourceEventFormat: { schemaDigestSha256: eventSchemaDigestSha256 },
    sessions: [
      {
        logicalSessionId: "control",
        nativeSessionId: sessionID,
        workspaceId: "workspace-a",
        role: "control",
        transcriptBytes: 10,
        eventCount: 5,
        file: relativeFile,
        fileDigestSha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const manifestPath = NodePath.join(directory, "manifest.json");
  await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifestPath, corpusDigestSha256, eventSchemaDigestSha256 };
}

function createSchema(database: NodeSqlite.DatabaseSync): void {
  database.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT NOT NULL,default_model_selection_json TEXT NOT NULL,scripts_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,model_selection_json TEXT NOT NULL,runtime_mode TEXT NOT NULL,interaction_mode TEXT NOT NULL,branch TEXT,worktree_path TEXT,latest_turn_id TEXT,latest_user_message_at TEXT,pending_approval_count INTEGER NOT NULL,pending_user_input_count INTEGER NOT NULL,has_actionable_proposed_plan INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,deleted_at TEXT,settled_override TEXT,settled_at TEXT,snoozed_until TEXT,snoozed_at TEXT);
    CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT NOT NULL,turn_id TEXT,pending_message_id TEXT,assistant_message_id TEXT,state TEXT NOT NULL,requested_at TEXT NOT NULL,started_at TEXT,completed_at TEXT,checkpoint_turn_count INTEGER,checkpoint_ref TEXT,checkpoint_status TEXT,checkpoint_files_json TEXT NOT NULL,source_proposed_plan_thread_id TEXT,source_proposed_plan_id TEXT,UNIQUE(thread_id,turn_id));
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,role TEXT NOT NULL,text TEXT NOT NULL,is_streaming INTEGER NOT NULL,attachments_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,tone TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,payload_json TEXT NOT NULL,sequence INTEGER,created_at TEXT NOT NULL);
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY,status TEXT NOT NULL,provider_name TEXT,provider_instance_id TEXT,provider_session_id TEXT,provider_thread_id TEXT,runtime_mode TEXT NOT NULL,active_turn_id TEXT,last_error TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,status TEXT NOT NULL,decision TEXT,created_at TEXT NOT NULL,resolved_at TEXT);
    CREATE TABLE projection_thread_proposed_plans (plan_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,plan_markdown TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,implemented_at TEXT,implementation_thread_id TEXT);
    CREATE TABLE projection_state (projector TEXT PRIMARY KEY,last_applied_sequence INTEGER NOT NULL,updated_at TEXT NOT NULL);
  `);
}

function git(repository: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 8 * 1_024 * 1_024,
  });
}

function gitBytes(repository: string, args: ReadonlyArray<string>): Buffer {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: repository,
    encoding: "buffer",
    maxBuffer: 8 * 1_024 * 1_024,
  });
}

function digest(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function restoreEnvironment(values: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
