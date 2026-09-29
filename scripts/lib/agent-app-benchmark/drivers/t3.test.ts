// @effect-diagnostics nodeBuiltinImport:off - Public benchmark tests construct isolated filesystem identities.
import { assert, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { settleExpression, type PageSettle } from "agent-app-benchmark/driver-sdk";
import ts from "typescript-legacy";

import {
  appStartMeasurement,
  assertPackagedT3PackageRevision,
  closeOwnedApplication,
  createT3PublicDriver,
  descendantsOf,
  ensureWorkItemsRendered,
  parseProcessStartTime,
  parseProcessTable,
  packagedT3ApplicationAsar,
  packagedT3BuildDigestFiles,
  resolveT3BenchmarkLaunchCommand,
  runPrearmedReadiness,
  shutdownAfterLaunchFailure,
  switchMeasurement,
  t3BenchmarkLaunchEnvironment,
  t3BenchmarkWorkspaceRoot,
  t3SessionFacts,
  waitForSessionList,
  waitForDescendantExit,
} from "./t3.ts";

const ALL_GATES = {
  displayedDestination: true,
  latestTurnPainted: true,
  noPlaceholder: true,
  firstFoldComplete: true,
  composerEditable: true,
  windowVisibleFocused: true,
};

const NOT_PAINTED = { ...ALL_GATES, latestTurnPainted: false };

const SETTLE: PageSettle = {
  startAt: 100,
  settledAt: 116,
  timeOrigin: 5_000,
  frames: [
    { at: 108, gates: NOT_PAINTED, signature: null, mutated: true },
    { at: 116, gates: ALL_GATES, signature: "a", mutated: false },
    { at: 124, gates: ALL_GATES, signature: "a", mutated: false },
  ],
};

/** Names the source reads without declaring, resolved by TypeScript with no lib so every global is undeclared. */
function undeclaredNames(source: string): ReadonlyArray<string> {
  const fileName = "/facts.js";
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noLib: true,
    noEmit: true,
    strict: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName ? ts.createSourceFile(name, source, languageVersion) : undefined;
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? source : undefined);
  const program = ts.createProgram([fileName], options, host);
  const message = (diagnostic: ts.Diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const syntax = program.getSyntacticDiagnostics().map(message);
  if (syntax.length > 0) throw new Error(`The facts source is not plain JavaScript: ${syntax[0]}`);
  const names = program
    .getSemanticDiagnostics()
    .map((diagnostic) => /^Cannot find name '([^']+)'/u.exec(message(diagnostic))?.[1])
    .filter((name) => name !== undefined);
  return [...new Set(names)].sort();
}

it("serializes the page facts with only browser globals and the target", () => {
  assert.deepStrictEqual(undeclaredNames(`const facts = (${t3SessionFacts.toString()});`), [
    "Array",
    "HTMLElement",
    "Number",
    "Set",
    "document",
    "getComputedStyle",
  ]);
  assert.deepStrictEqual(undeclaredNames("const facts = (target) => target + TIMEOUT_MS;"), [
    "TIMEOUT_MS",
  ]);
  const expression = settleExpression({
    facts: t3SessionFacts,
    target: { sessionId: "native-warm", expectedMessageIds: ["warm-message"] },
    timeoutMs: 1_000,
    start: "trusted-pointerdown",
  });
  assert.doesNotThrow(() => new Function(`return ${expression};`));
});

it("measures a switch on the renderer clock from the trusted pointerdown to the settle", () => {
  assert.deepStrictEqual(switchMeasurement(SETTLE), {
    clock: {
      kind: "single-monotonic-clock",
      clock: "t3-renderer-performance",
      start: 100,
      end: 116,
    },
    frameLog: { startAt: 100, offsetMs: 0, frames: SETTLE.frames },
  });
});

it("measures app start on the driver clock from the process spawn, mapping renderer frames by the offset", () => {
  assert.deepStrictEqual(appStartMeasurement(SETTLE, 30, 40), {
    clock: { kind: "single-monotonic-clock", clock: "node-perf-hooks", start: 30, end: 156 },
    frameLog: { startAt: -10, offsetMs: 40, frames: SETTLE.frames },
  });
});

it("launches a packaged app directly with only benchmark flags", () => {
  const executable = "/build/T3 Code.app/Contents/MacOS/T3 Code";
  assert.deepStrictEqual(
    resolveT3BenchmarkLaunchCommand({
      mode: "packaged",
      platform: "darwin",
      executablePath: executable,
      electronProfile: "/state/electron-profile",
    }),
    {
      executablePath: executable,
      args: ["--use-mock-keychain", "--user-data-dir=/state/electron-profile"],
    },
  );
});

it("keeps the loose Electron entrypoint behind the development launch resolver", () => {
  const received: string[][] = [];
  assert.deepStrictEqual(
    resolveT3BenchmarkLaunchCommand({
      mode: "loose",
      platform: "linux",
      desktopEntry: "/repo/apps/desktop/dist-electron/main.cjs",
      electronProfile: "/state/electron-profile",
      resolveLooseCommand: (args) => {
        received.push([...args]);
        return { electronPath: "/repo/electron", args: ["--no-sandbox", ...args] };
      },
    }),
    {
      executablePath: "/repo/electron",
      args: [
        "--no-sandbox",
        "--user-data-dir=/state/electron-profile",
        "/repo/apps/desktop/dist-electron/main.cjs",
      ],
    },
  );
  assert.deepStrictEqual(received, [
    ["--user-data-dir=/state/electron-profile", "/repo/apps/desktop/dist-electron/main.cjs"],
  ]);
});

it("isolates packaged benchmark state and disables auto-update", () => {
  const ambientHome = NodePath.resolve("/attempt/ambient");
  const stateHome = NodePath.resolve("/attempt");
  const environment = t3BenchmarkLaunchEnvironment({
    baseEnv: {
      PATH: "/bin",
      HOME: "/live-home",
      T3CODE_HOME: "/live-t3",
      T3CODE_DISABLE_AUTO_UPDATE: "false",
    },
    ambientHome,
    stateHome,
  });
  assert.deepStrictEqual(environment, {
    PATH: "/bin",
    HOME: ambientHome,
    APPDATA: NodePath.join(ambientHome, "app-data"),
    XDG_CONFIG_HOME: NodePath.join(ambientHome, "config"),
    XDG_CACHE_HOME: NodePath.join(ambientHome, "cache"),
    XDG_DATA_HOME: NodePath.join(ambientHome, "data"),
    T3CODE_HOME: stateHome,
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    VITE_DEV_SERVER_URL: "",
  });
});

it("digests the packaged macOS executable and its app.asar", () => {
  const executable = "/build/T3 Code.app/Contents/MacOS/T3 Code";
  const appAsar = "/build/T3 Code.app/Contents/Resources/app.asar";
  assert.strictEqual(packagedT3ApplicationAsar(executable, "darwin"), appAsar);
  assert.deepStrictEqual(packagedT3BuildDigestFiles(executable, "darwin"), [executable, appAsar]);
  assert.deepStrictEqual(packagedT3BuildDigestFiles("/build/t3code", "linux"), ["/build/t3code"]);
});

it("requires canonical packaged revision metadata to match source HEAD", () => {
  const sourceCommit = "a".repeat(40);
  const appAsar = "/build/T3 Code.app/Contents/Resources/app.asar";
  assert.doesNotThrow(() =>
    assertPackagedT3PackageRevision(
      JSON.stringify({ t3codeCommitHash: sourceCommit }),
      sourceCommit,
      appAsar,
    ),
  );
  assert.doesNotThrow(() =>
    assertPackagedT3PackageRevision(
      JSON.stringify({ name: "legacy-t3code" }),
      sourceCommit,
      appAsar,
    ),
  );
  assert.throws(
    () =>
      assertPackagedT3PackageRevision(
        JSON.stringify({ t3codeCommitHash: "b".repeat(40) }),
        sourceCommit,
        appAsar,
      ),
    /packaged revision .* does not match source HEAD/u,
  );
  assert.throws(
    () =>
      assertPackagedT3PackageRevision(
        JSON.stringify({ t3codeCommitHash: "not-a-commit" }),
        sourceCommit,
        appAsar,
      ),
    /t3codeCommitHash is invalid/u,
  );
});

it("places benchmark workspaces inside each state clone", () => {
  assert.strictEqual(
    t3BenchmarkWorkspaceRoot("/sealed/P0"),
    NodePath.join("/sealed/P0", "worktrees", "benchmark-fixtures"),
  );
  assert.strictEqual(
    t3BenchmarkWorkspaceRoot("/sealed/attempts/3"),
    NodePath.join("/sealed/attempts/3", "worktrees", "benchmark-fixtures"),
  );
});

it("arms readiness before input and waits for it to end when the action fails", async () => {
  const order: string[] = [];
  let rejectReadiness: ((error: Error) => void) | undefined;
  const readiness = new Promise<number>((_resolve, reject) => {
    rejectReadiness = reject;
  });
  let rejection: unknown;
  try {
    await runPrearmedReadiness(
      () => {
        order.push("arm");
        return readiness.finally(() => order.push("readiness-ended"));
      },
      async () => {
        order.push("pointerdown");
        void NodeTimersPromises.setTimeout(10).then(() =>
          rejectReadiness?.(new Error("no settle")),
        );
        throw new Error("input failed");
      },
    );
  } catch (error) {
    order.push("rejected");
    rejection = error;
  }
  assert.match(String(rejection), /input failed/u);
  assert.deepStrictEqual(order, ["arm", "pointerdown", "readiness-ended", "rejected"]);

  const earlyOrder: string[] = [];
  let earlyRejection: unknown;
  try {
    await runPrearmedReadiness(
      () => {
        earlyOrder.push("arm-rejected-readiness");
        return Promise.reject(new Error("readiness failed before input completed"));
      },
      async () => {
        earlyOrder.push("pointerdown-start");
        await Promise.resolve();
        earlyOrder.push("pointerdown-end");
      },
    );
  } catch (error) {
    earlyRejection = error;
  }
  assert.match(String(earlyRejection), /readiness failed before input completed/u);
  assert.deepStrictEqual(earlyOrder, [
    "arm-rejected-readiness",
    "pointerdown-start",
    "pointerdown-end",
  ]);
});

const receipt = {
  endpoint: "correct-content-painted-and-input-ready" as const,
  checks: [
    { id: "content-identity", passed: true },
    { id: "first-fold-painted", passed: true },
    { id: "two-presentations", passed: true },
    { id: "trusted-input", passed: true },
  ],
};

function makeHarness() {
  const activations: string[] = [];
  const activationTimeouts: Array<number | undefined> = [];
  const launches: Array<{ stateHandle: string; initialSessionId: string }> = [];
  const shutdownFailures: Error[] = [];
  let clock = 10;
  const listed = { ids: ["native-cold", "native-warm", "native-control"] };
  const targets = new Map([
    [
      "control",
      {
        logicalSessionId: "control",
        sessionId: "native-control",
        title: "Control",
        expectedMessageIds: ["control-message"],
      },
    ],
    [
      "within-workspace-warm-1048576",
      {
        logicalSessionId: "within-workspace-warm-1048576",
        sessionId: "native-warm",
        title: "Warm",
        expectedMessageIds: ["warm-message"],
      },
    ],
    [
      "within-workspace-cold-1048576",
      {
        logicalSessionId: "within-workspace-cold-1048576",
        sessionId: "native-cold",
        title: "Cold",
        expectedMessageIds: ["cold-message"],
      },
    ],
  ]);
  const driver = createT3PublicDriver({
    hello: { protocolVersion: 1 },
    prepare: async () => ({
      materialization: {
        corpusDigestSha256: "a".repeat(64),
        eventSchemaDigestSha256: "b".repeat(64),
        mappingDigestSha256: "c".repeat(64),
        sessionMapping: { control: "native-control" },
        readinessTargets: targets,
        messageCount: 6,
        transcriptBytes: 12,
      },
      stateHandles: { P0: "sealed-p0", P1: "sealed-p1" },
    }),
    launch: async (stateHandle, initialSessionId) => {
      launches.push({ stateHandle, initialSessionId });
      return {
        processes: [
          {
            pid: 12,
            startTimeMs: 1_000,
            owner: "application",
            category: "electron-main",
          },
        ],
        readiness: receipt,
        clock: {
          kind: "single-monotonic-clock",
          clock: "test",
          start: 1,
          end: 5,
        },
        frameLog: { startAt: 1, offsetMs: 0, frames: [] },
      };
    },
    activate: async (target, readinessTimeoutMs) => {
      activations.push(target.logicalSessionId);
      activationTimeouts.push(readinessTimeoutMs);
      const start = clock;
      clock += 2;
      return {
        clock: { kind: "single-monotonic-clock", clock: "test-renderer", start, end: clock },
        frameLog: { startAt: start, offsetMs: 0, frames: [] },
      };
    },
    listedSessionIds: async () => listed.ids,
    shutdown: async () => {
      const failure = shutdownFailures.shift();
      if (failure) throw failure;
      return { terminated: [], survivors: [] };
    },
  });
  return {
    driver,
    listed,
    activations,
    activationTimeouts,
    launches,
    shutdownFailures,
  };
}

async function prepare(driver: ReturnType<typeof createT3PublicDriver>) {
  return driver.prepare({
    scenarioId: "session-switch-walk",
    scenarioDigestSha256: "1".repeat(64),
    corpusDirectory: "/tmp/corpus",
    corpusManifestPath: "/tmp/corpus/manifest.json",
    corpusDigestSha256: "a".repeat(64),
    corpusDefinitionDigestSha256: "2".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    runDirectory: "/tmp/run",
  });
}

it("attests to translated corpus identity and returns sealed P0/P1 handles", async () => {
  const { driver } = makeHarness();
  const result = await prepare(driver);
  assert.equal(result.materializationMode, "translated");
  assert.deepStrictEqual(result.stateHandles, {
    P0: "sealed-p0",
    P1: "sealed-p1",
  });
  assert.equal(result.corpusDigestSha256, "a".repeat(64));
});

it("measures a progressive resource step from control to the destination's first activation", async () => {
  const { driver, activations } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-walk",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "progressive-resource",
  });
  const result = await driver.execute({
    scenarioId: "session-switch-walk",
    case: {
      caseId: "progressive-resource-0-within-workspace-cold-1048576",
      workload: "progressive-resource",
      sessionState: "cold",
      sourceSessionId: "control",
      destinationSessionId: "within-workspace-cold-1048576",
    },
  });
  assert.deepStrictEqual(activations, ["control", "within-workspace-cold-1048576"]);
  assert.equal(result.durationMs, 2);
});

it("rejects scenarios and switch workloads it does not serve", async () => {
  const { driver, activations } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-walk",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "walk",
  });
  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return String(error);
    }
    return "resolved";
  };
  const coldCase = {
    caseId: "cold",
    workload: "list-walk" as const,
    sessionState: "cold" as const,
    walkPosition: 0,
    sourceSessionId: "control",
    destinationSessionId: "within-workspace-cold-1048576",
  };
  for (const scenarioId of ["session-switch", "session-navigation", "workspace-panel"])
    assert.match(
      await rejection(driver.execute({ scenarioId, case: coldCase })),
      /does not support scenario/u,
    );
  assert.match(
    await rejection(
      driver.execute({
        scenarioId: "session-switch-walk",
        case: { ...coldCase, workload: "isolated-latency" } as never,
      }),
    ),
    /session-switch request is incomplete/u,
  );
  assert.deepStrictEqual(activations, []);
});

function walkCase(
  sessionState: "cold" | "warm",
  walkPosition: number,
  sourceSessionId: string,
  destinationSessionId: string,
) {
  return {
    caseId: `walk-${sessionState}-${destinationSessionId}`,
    workload: "list-walk" as const,
    sessionState,
    walkPosition,
    sourceSessionId,
    destinationSessionId,
  };
}

it("walks the list with one activation per step and no control bounce", async () => {
  const { driver, activations } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-walk",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "walk",
  });
  const cold = "within-workspace-cold-1048576";
  const warm = "within-workspace-warm-1048576";
  for (const benchmarkCase of [
    walkCase("cold", 0, "control", cold),
    walkCase("cold", 1, cold, warm),
    walkCase("warm", 0, warm, cold),
    walkCase("warm", 1, cold, warm),
  ])
    await driver.execute({ scenarioId: "session-switch-walk", case: benchmarkCase });
  assert.deepStrictEqual(activations, [cold, warm, cold, warm]);
});

it("rejects a walk step whose destination is not the next row or whose visit state is wrong", async () => {
  const { driver, listed } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-walk",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "walk",
  });
  const cold = "within-workspace-cold-1048576";
  const warm = "within-workspace-warm-1048576";
  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return String(error);
    }
    return "resolved";
  };
  assert.match(
    await rejection(
      driver.execute({
        scenarioId: "session-switch-walk",
        case: walkCase("warm", 0, "control", cold),
      }),
    ),
    /does not match this process's visits/u,
  );
  await driver.execute({
    scenarioId: "session-switch-walk",
    case: walkCase("cold", 0, "control", cold),
  });
  listed.ids = ["native-warm", "native-cold", "native-control"];
  assert.match(
    await rejection(
      driver.execute({
        scenarioId: "session-switch-walk",
        case: walkCase("cold", 1, cold, warm),
      }),
    ),
    /not directly below/u,
  );
});

it("bounds the control return after the progressive resource workload by the shared ceiling", async () => {
  const { driver, activations, activationTimeouts } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-walk",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "progressive-resource",
  });
  await driver.execute({
    scenarioId: "session-switch-walk",
    case: {
      caseId: "progressive-resource-return-control",
      workload: "resource-control",
      destinationSessionId: "control",
    },
  });
  assert.equal(activations.at(-1), "control");
  assert.equal(activationTimeouts.at(-1), 5_000);
});

it("measures app start from the exact requested sealed state", async () => {
  const { driver, launches } = makeHarness();
  await prepare(driver);
  const result = await driver.execute({
    scenarioId: "app-start",
    stateHandle: "sealed-p0",
    case: { caseId: "new-start", startMode: "new-application-state" },
  });
  assert.deepStrictEqual(launches, [{ stateHandle: "sealed-p0", initialSessionId: "control" }]);
  assert.equal(result.durationMs, 4);
});

it("starts the app again after a shutdown whose cleanup failed", async () => {
  const { driver, launches, shutdownFailures } = makeHarness();
  await prepare(driver);
  const start = (caseId: string) =>
    driver.execute({
      scenarioId: "app-start",
      stateHandle: "sealed-p1",
      case: { caseId, startMode: "initialized-application-state" },
    });
  await start("first");
  shutdownFailures.push(new Error("ENOTEMPTY: directory not empty"));
  const cleanup = await driver.shutdown().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.match(String(cleanup), /ENOTEMPTY/u);
  await start("second");
  assert.equal(launches.length, 2);
});

it("normalizes the OS process start time to the monitor second bucket", () => {
  assert.equal(
    parseProcessStartTime("Sun Aug  9 13:35:41 2026\n", 200),
    Date.parse("Sun Aug  9 13:35:41 2026"),
  );
  assert.throws(() => parseProcessStartTime("not-a-process-time", 200), /Invalid start time/u);
});

it("waits for an asynchronously populated session list without requiring Show More", async () => {
  const rowCounts = [1, 1, 3];
  const rows = {
    count: async () => rowCounts.shift() ?? 3,
    first() {
      return this;
    },
    filter() {
      return this;
    },
    click: async () => undefined,
  };
  const buttons = { ...rows, count: async () => 0 };
  const page = {
    waitForLoadState: async () => undefined,
    waitForSelector: async () => undefined,
    locator: (selector: string) => (selector === "[data-thread-item]" ? rows : buttons),
    bringToFront: async () => undefined,
    emulateMedia: async () => undefined,
    evaluate: async <A>() => undefined as A,
  };
  await ensureWorkItemsRendered(page, 3, 1_000);
});

it("includes bounded renderer state when session-list readiness fails", async () => {
  const locator = {
    count: async () => 0,
    first() {
      return this;
    },
    filter() {
      return this;
    },
    click: async () => undefined,
  };
  const page = {
    waitForLoadState: async () => undefined,
    waitForSelector: async () => Promise.reject(new Error("timeout")),
    locator: () => locator,
    bringToFront: async () => undefined,
    emulateMedia: async () => undefined,
    evaluate: async <A>() =>
      JSON.stringify({
        url: "t3code://app/",
        title: "T3 Code",
        text: "Connecting",
      }) as A,
  };
  let rejection: unknown;
  try {
    await waitForSessionList(page, 1);
  } catch (error) {
    rejection = error;
  }
  assert.match(String(rejection), /session list readiness failed.*Connecting/u);
});

it("escalates to SIGTERM when Electron close resolves before the root exits", async () => {
  const signals: NodeJS.Signals[] = [];
  let exitListener: (() => void) | undefined;
  let signalCode: NodeJS.Signals | null = null;
  const process = {
    pid: 42,
    exitCode: null,
    get signalCode() {
      return signalCode;
    },
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      signals.push(signal);
      signalCode = signal;
      exitListener?.();
      return true;
    },
    once: (_event: "exit", listener: () => void) => {
      exitListener = listener;
    },
  };
  const closed = await closeOwnedApplication(
    {
      process: () => process,
      firstWindow: async () => Promise.reject(),
      close: async () => undefined,
    },
    process,
    { closeMs: 1, gracefulExitMs: 1, terminateMs: 1, killMs: 1 },
  );
  assert.equal(closed, true);
  assert.deepStrictEqual(signals, ["SIGTERM"]);
});

it("preserves the launch failure when cleanup also fails", async () => {
  const launchError = new Error("readiness failed");
  let rejection: unknown;
  try {
    await shutdownAfterLaunchFailure(
      async () => Promise.reject(new Error("shutdown failed")),
      launchError,
    );
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection, launchError);
  assert.match(
    String((rejection as Error & { readonly cleanupError?: unknown }).cleanupError),
    /shutdown failed/u,
  );
});

it("reads the process table and finds every descendant of a root, however deep", () => {
  const table = parseProcessTable(
    [
      "  100     1 Mon Sep 28 10:25:04 2026",
      "  101   100 Mon Sep 28 10:25:05 2026",
      "  102   101 Mon Sep 28 10:25:06 2026",
      "  200     1 Mon Sep 28 10:25:07 2026",
      "",
    ].join("\n"),
  );
  assert.equal(table.length, 4);
  assert.deepStrictEqual(
    descendantsOf(table, 100).map((item) => item.pid),
    [101, 102],
  );
  assert.equal(
    descendantsOf(table, 100)[1]?.startTimeMs,
    parseProcessStartTime("Mon Sep 28 10:25:06 2026", 102),
  );
});

it("waits for descendants that exit on their own and signals none of them", async () => {
  const child = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const identity = { pid: child.pid!, startTimeMs: 1_000 };
    let reads = 0;
    const survivors = await waitForDescendantExit(
      [identity],
      async () => (++reads < 3 ? [{ ...identity, parentPid: 1 }] : []),
      { graceMs: 5_000, killMs: 100 },
    );
    assert.deepStrictEqual(survivors, []);
    assert.equal(reads, 3);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.kill("SIGKILL");
  }
});

it("kills a descendant that outlives the grace period, matched by pid and start time", async () => {
  const child = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const identity = { pid: child.pid!, startTimeMs: 1_000 };
    const survivors = await waitForDescendantExit(
      [identity],
      async () =>
        child.exitCode === null && child.signalCode === null ? [{ ...identity, parentPid: 1 }] : [],
      { graceMs: 100, killMs: 2_000 },
    );
    await exited;
    assert.deepStrictEqual(survivors, []);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    child.kill("SIGKILL");
  }
});
