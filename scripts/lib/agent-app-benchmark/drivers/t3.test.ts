// @effect-diagnostics nodeBuiltinImport:off - Public benchmark tests construct isolated filesystem identities.
import { assert, it } from "vite-plus/test";
import * as NodePath from "node:path";

import {
  assertPackagedT3PackageRevision,
  assertFileSurfaceCold,
  assertSessionNavigationReviewLoadSupported,
  canonicalReviewModelFailure,
  canPreserveReviewLoadAcrossSessionNavigation,
  canonicalReviewExpansionPaths,
  closeOwnedApplication,
  createT3PublicDriver,
  ensureWorkItemsRendered,
  isStrictReviewReady,
  isVirtualizedReviewViewportReady,
  parseProcessStartTime,
  packagedT3ApplicationAsar,
  packagedT3BuildDigestFiles,
  remainingReadinessTimeout,
  resolveT3BenchmarkLaunchCommand,
  rendererCountersFromTraceEvents,
  runPrearmedReadiness,
  seedExpandedDirectories,
  shutdownAfterLaunchFailure,
  t3BenchmarkLaunchEnvironment,
  t3BenchmarkWorkspaceRoot,
  waitForSessionList,
} from "./t3.ts";

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

it("places fixture repositories under each state clone's managed worktrees root", () => {
  assert.strictEqual(
    t3BenchmarkWorkspaceRoot("/sealed/P0"),
    NodePath.join("/sealed/P0", "worktrees", "benchmark-fixtures"),
  );
  assert.strictEqual(
    t3BenchmarkWorkspaceRoot("/sealed/attempts/3"),
    NodePath.join("/sealed/attempts/3", "worktrees", "benchmark-fixtures"),
  );
});

it("shares one readiness deadline across serial Review phases", () => {
  const deadline = 30_000;
  assert.strictEqual(remainingReadinessTimeout(deadline, 20_000), 10_000);
  assert.strictEqual(remainingReadinessTimeout(deadline, 29_250), 750);
  assert.strictEqual(remainingReadinessTimeout(deadline, 30_001), 0);
});

it("requires open-file setup to keep both the target tab and preview DOM cold", async () => {
  const page = (tabCount: number, previewCount: number) =>
    ({
      locator: (selector: string) => ({
        count: async () =>
          selector.includes("data-right-panel-tab-list") ? tabCount : previewCount,
      }),
    }) as never;

  await assertFileSurfaceCold(page(0, 0), "src/target.ts");
  for (const counts of [
    [1, 0],
    [0, 1],
  ] as const) {
    let rejection: unknown;
    try {
      await assertFileSurfaceCold(page(counts[0], counts[1]), "src/target.ts");
    } catch (error) {
      rejection = error;
    }
    assert.match(String(rejection), /mounted its target surface before measured pointerdown/u);
  }
});

it("fails resolved incomplete Review models with explicit product evidence", () => {
  assert.strictEqual(
    canonicalReviewModelFailure(
      {
        dataState: "ready",
        renderedFileCount: 5,
        truncated: true,
        ownerThreadKey: "environment:target",
      },
      24,
      "target",
    ),
    "T3 product Review preview limit cannot represent the canonical 24-file workspace fixture: the resolved preview is truncated at 5 files.",
  );
  assert.strictEqual(
    canonicalReviewModelFailure(
      {
        dataState: "ready",
        renderedFileCount: 23,
        truncated: false,
        ownerThreadKey: "environment:target",
      },
      24,
      "target",
    ),
    "T3 product Review preview resolved 23/24 canonical workspace files.",
  );
  assert.isUndefined(
    canonicalReviewModelFailure(
      {
        dataState: "loading",
        renderedFileCount: 0,
        truncated: false,
        ownerThreadKey: "environment:target",
      },
      24,
      "target",
    ),
  );
  assert.isUndefined(
    canonicalReviewModelFailure(
      {
        dataState: "ready",
        renderedFileCount: 24,
        truncated: false,
        ownerThreadKey: "environment:target",
      },
      24,
      "target",
    ),
  );
});

it("ignores a ready source Review model before reporting target truncation", () => {
  assert.isUndefined(
    canonicalReviewModelFailure(
      {
        dataState: "ready",
        renderedFileCount: 24,
        truncated: false,
        ownerThreadKey: "environment:source",
      },
      24,
      "target",
    ),
  );
  assert.strictEqual(
    canonicalReviewModelFailure(
      {
        dataState: "ready",
        renderedFileCount: 5,
        truncated: true,
        ownerThreadKey: "environment:target",
      },
      24,
      "target",
    ),
    "T3 product Review preview limit cannot represent the canonical 24-file workspace fixture: the resolved preview is truncated at 5 files.",
  );
});

it("derives renderer counters only from the exact marked action interval", () => {
  const counters = rendererCountersFromTraceEvents([
    { name: "t3-benchmark-counter-start", ph: "R", ts: 1_000, pid: 1, tid: 2 },
    { name: "ThreadControllerImpl::RunTask", ph: "X", ts: 900, dur: 600, pid: 1, tid: 2 },
    { name: "EventDispatch", ph: "X", ts: 1_000, dur: 200, pid: 1, tid: 2 },
    { name: "FunctionCall", ph: "X", ts: 1_050, dur: 100, pid: 1, tid: 2 },
    { name: "UpdateLayoutTree", ph: "X", ts: 1_200, dur: 100, pid: 1, tid: 2 },
    { name: "Layout", ph: "X", ts: 1_250, dur: 200, pid: 1, tid: 2 },
    { name: "FunctionCall", ph: "X", ts: 1_000, dur: 400, pid: 9, tid: 9 },
    { name: "t3-benchmark-counter-end", ph: "R", ts: 1_400, pid: 1, tid: 2 },
  ]);
  assert.deepStrictEqual(counters, {
    scriptDurationMs: 0.2,
    styleRecalcDurationMs: 0.1,
    layoutDurationMs: 0.15,
    taskDurationMs: 0.4,
  });
});

it("arms readiness before input and settles it through cancellation on action failure", async () => {
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
        return readiness;
      },
      async () => {
        order.push("pointerdown");
        throw new Error("input failed");
      },
      async () => {
        order.push("cancel");
        rejectReadiness?.(new Error("cancelled"));
      },
    );
  } catch (error) {
    rejection = error;
  }
  assert.match(String(rejection), /input failed/u);
  assert.deepStrictEqual(order, ["arm", "pointerdown", "cancel"]);

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
      async () => {
        earlyOrder.push("cancel-rejected-readiness");
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
    "cancel-rejected-readiness",
  ]);
});

it("seeds virtualized directories through the canonical Files search before clicking", async () => {
  const interactions: string[] = [];
  const locator = (selector: string) => {
    const directoryPath = selector.match(/data-item-path="([^"]+)"/u)?.[1];
    const isSearch = selector.includes('input[name="project-files-search"]');
    const self = {
      count: async () => 1,
      first: () => self,
      filter: () => self,
      click: async () => {
        interactions.push(`click:${directoryPath}`);
      },
      fill: async (value: string) => {
        if (!isSearch) throw new Error("Only the canonical Files search may be filled.");
        interactions.push(`search:${value}`);
      },
      getAttribute: async (name: string) => (name === "aria-expanded" ? "false" : null),
      isVisible: async () => true,
      waitFor: async () => {
        interactions.push(`visible:${directoryPath}`);
      },
    };
    return self;
  };

  await seedExpandedDirectories(
    {
      locator,
      evaluate: async () => {
        interactions.push("expanded-painted");
        return 1;
      },
    } as never,
    {
      filePaths: [],
      allFilePaths: [],
      directoryPaths: ["src/section-000", "src/section-001"],
      diffPaths: [],
      fileCount: 0,
      diffCount: 0,
    },
    2,
  );

  assert.deepStrictEqual(interactions, [
    "search:section-000",
    "visible:src/section-000/",
    "click:src/section-000/",
    "expanded-painted",
    "search:section-001",
    "visible:src/section-001/",
    "click:src/section-001/",
    "expanded-painted",
    "search:",
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
  const activationAttempts: number[] = [];
  const launches: Array<{ stateHandle: string; initialSessionId: string }> = [];
  let clock = 10;
  const panelActions: string[] = [];
  const panelActionLoads: string[] = [];
  const panelSwitches: string[] = [];
  const sessionNavigations: Array<{
    readonly navigationType: string;
    readonly loadProfile?: string;
  }> = [];
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
        workspaceFixtureDigestSha256: null,
        workspaceFixtureAttestation: null,
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
      };
    },
    activate: async (target, readinessAttempts = 1) => {
      activations.push(target.logicalSessionId);
      activationAttempts.push(readinessAttempts);
      const start = clock;
      clock += 2;
      return {
        kind: "single-monotonic-clock",
        clock: "test-renderer",
        start,
        end: clock,
      };
    },
    executeWorkspacePanelAction: async (benchmarkCase, _target, loadProfile) => {
      panelActions.push(benchmarkCase.action);
      if (loadProfile) panelActionLoads.push(loadProfile.id);
      return panelResult(clock);
    },
    executeWorkspacePanelSwitch: async (benchmarkCase) => {
      panelSwitches.push(benchmarkCase.panelProfile);
      return panelResult(clock);
    },
    executeSessionNavigation: async (benchmarkCase, _source, _destination, loadProfile) => {
      sessionNavigations.push({
        navigationType: benchmarkCase.navigationType,
        ...(loadProfile ? { loadProfile: loadProfile.id } : {}),
      });
      return benchmarkCase.navigationType === "return-visited-panel-open"
        ? panelResult(clock)
        : { clock: panelResult(clock).clock };
    },
    shutdown: async () => ({ terminated: [], survivors: [] }),
  });
  return {
    driver,
    activations,
    activationAttempts,
    launches,
    panelActions,
    panelActionLoads,
    panelSwitches,
    sessionNavigations,
  };
}

const panelLoads = [
  {
    id: "light",
    expandedDirectoryCount: 2,
    retainedFileTabCount: 2,
    expandedReviewFileCount: 24,
  },
  {
    id: "moderate",
    expandedDirectoryCount: 8,
    retainedFileTabCount: 3,
    expandedReviewFileCount: 24,
  },
  {
    id: "heavy",
    expandedDirectoryCount: 16,
    retainedFileTabCount: 4,
    expandedReviewFileCount: 24,
  },
] as const;

function panelResult(start: number) {
  const end = start + 4;
  return {
    clock: {
      kind: "single-monotonic-clock" as const,
      clock: "performance.now",
      start,
      end,
    },
    rendererTrace: {
      clock: "performance.now" as const,
      transitionMode: "none" as const,
      milestones: [
        { id: "trusted-input", at: start },
        { id: "action-painted", at: end - 1 },
        { id: "interactive", at: end },
        { id: "complete", at: end },
      ],
      frameTimestampsMs: [start + 1, start + 2],
      longAnimationFrames: [],
      counterInterval: { start, end },
      counters: {
        scriptDurationMs: 1,
        styleRecalcDurationMs: 1,
        layoutDurationMs: 1,
        taskDurationMs: 1,
      },
    },
  };
}

async function prepare(driver: ReturnType<typeof createT3PublicDriver>) {
  return driver.prepare({
    scenarioId: "session-switch-v1",
    scenarioDigestSha256: "1".repeat(64),
    corpusDirectory: "/tmp/corpus",
    corpusManifestPath: "/tmp/corpus/manifest.json",
    corpusDigestSha256: "a".repeat(64),
    corpusDefinitionDigestSha256: "2".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    runDirectory: "/tmp/run",
  });
}

async function prepareFlowScenario(
  driver: ReturnType<typeof createT3PublicDriver>,
  scenarioId: "session-navigation-v1" | "workspace-panel-v2",
) {
  return driver.prepare({
    scenarioId,
    scenarioDigestSha256: "1".repeat(64),
    corpusDirectory: "/tmp/corpus",
    corpusManifestPath: "/tmp/corpus/manifest.json",
    corpusDigestSha256: "a".repeat(64),
    corpusDefinitionDigestSha256: "2".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    runDirectory: "/tmp/run",
    scenarioDefinition: { cases: { panelLoads } },
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

it("enforces cold and warm session-switch preparation around one measured activation", async () => {
  const { driver, activations } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-v1",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "group",
  });
  const cold = await driver.execute({
    scenarioId: "session-switch-v1",
    case: {
      caseId: "cold",
      workload: "isolated-latency",
      sessionState: "cold",
      sourceSessionId: "control",
      destinationSessionId: "within-workspace-cold-1048576",
    },
  });
  const warm = await driver.execute({
    scenarioId: "session-switch-v1",
    case: {
      caseId: "warm",
      workload: "isolated-latency",
      sessionState: "warm",
      sourceSessionId: "control",
      destinationSessionId: "within-workspace-warm-1048576",
    },
  });
  assert.deepStrictEqual(activations, [
    "control",
    "within-workspace-cold-1048576",
    "within-workspace-warm-1048576",
    "control",
    "within-workspace-warm-1048576",
  ]);
  assert.equal(cold.durationMs, 2);
  assert.equal(warm.durationMs, 2);
});

it("retries the real control activation after the progressive resource workload", async () => {
  const { driver, activations, activationAttempts } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-v1",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "progressive-resource",
  });
  await driver.execute({
    scenarioId: "session-switch-v1",
    case: {
      caseId: "progressive-resource-return-control",
      workload: "resource-control",
      destinationSessionId: "control",
    },
  });
  assert.equal(activations.at(-1), "control");
  assert.equal(activationAttempts.at(-1), 6);
});

it("measures app start from the exact requested sealed state", async () => {
  const { driver, launches } = makeHarness();
  await prepare(driver);
  const result = await driver.execute({
    scenarioId: "app-start-v1",
    stateHandle: "sealed-p0",
    case: { caseId: "new-start", startMode: "new-application-state" },
  });
  assert.deepStrictEqual(launches, [{ stateHandle: "sealed-p0", initialSessionId: "control" }]);
  assert.equal(result.durationMs, 4);
});

it("routes every workspace-panel action through one noncumulative renderer trace", async () => {
  const { driver, panelActions } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "workspace-panel-v1",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "workspace-panel",
  });
  const actions = [
    "open-cold",
    "toggle-open-close",
    "toggle-close-open",
    "open-warm-data",
    "switch-surface",
    "open-file",
    "switch-file-tab",
    "toggle-diff-view",
    "collapse-all",
    "expand-all",
  ] as const;
  for (const action of actions) {
    const result = await driver.execute({
      scenarioId: "workspace-panel-v1",
      case: { caseId: action, action },
    });
    assert.equal(result.durationMs, 4);
    assert.equal(result.timingEvidence, undefined);
    assert.equal((result.rendererTrace as { readonly clock: string }).clock, "performance.now");
    const trace = result.rendererTrace as {
      readonly milestones: ReadonlyArray<{ readonly id: string; readonly at: number }>;
    };
    assert.equal(
      trace.milestones.find((milestone) => milestone.id === "interactive")?.at,
      (result.clock as { readonly end: number }).end,
    );
  }
  assert.deepStrictEqual(panelActions, [...actions]);
});

it("routes panel-profile switches with exact source and destination identities", async () => {
  const { driver, panelSwitches } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-workspace-panel-v1",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "panel-switch",
  });
  const result = await driver.execute({
    scenarioId: "session-switch-workspace-panel-v1",
    case: {
      caseId: "files-within-warm",
      panelProfile: "files",
      workspaceRelation: "within-workspace",
      sessionState: "warm",
      sourceSessionId: "control",
      destinationSessionId: "within-workspace-warm-1048576",
    },
  });
  assert.equal(result.durationMs, 4);
  assert.equal(result.timingEvidence, undefined);
  assert.deepStrictEqual(panelSwitches, ["files"]);
});

it("routes the three session-navigation user flows without exposing cold/warm cases", async () => {
  const { driver, sessionNavigations } = makeHarness();
  await prepareFlowScenario(driver, "session-navigation-v1");
  await driver.launch({
    scenarioId: "session-navigation-v1",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "session-navigation",
  });
  const common = {
    workload: "session-navigation" as const,
    transcriptBytes: 1_048_576,
    sourceSessionId: "control",
    destinationSessionId: "within-workspace-warm-1048576",
  };
  let unpairedReturn: unknown;
  try {
    await driver.execute({
      scenarioId: "session-navigation-v1",
      case: {
        ...common,
        caseId: "unpaired-return",
        trend: "history-size",
        navigationType: "return-visited-panel-closed",
      },
    });
  } catch (error) {
    unpairedReturn = error;
  }
  assert.match(String(unpairedReturn), /prior first-visit of the destination in this process/u);
  const firstVisit = await driver.execute({
    scenarioId: "session-navigation-v1",
    case: {
      ...common,
      caseId: "first-visit",
      trend: "history-size",
      navigationType: "first-visit",
    },
  });
  let mismatchedReturn: unknown;
  try {
    await driver.execute({
      scenarioId: "session-navigation-v1",
      case: {
        ...common,
        caseId: "mismatched-return",
        trend: "history-size",
        navigationType: "return-visited-panel-closed",
        destinationSessionId: "within-workspace-cold-1048576",
      },
    });
  } catch (error) {
    mismatchedReturn = error;
  }
  assert.match(String(mismatchedReturn), /prior first-visit of the destination in this process/u);
  const interveningFirst = await driver.execute({
    scenarioId: "session-navigation-v1",
    case: {
      ...common,
      caseId: "first-visit-cold",
      trend: "history-size",
      navigationType: "first-visit",
      destinationSessionId: "within-workspace-cold-1048576",
    },
  });
  const returnClosed = await driver.execute({
    scenarioId: "session-navigation-v1",
    case: {
      ...common,
      caseId: "return-panel-closed",
      trend: "history-size",
      navigationType: "return-visited-panel-closed",
    },
  });
  let duplicateFirst: unknown;
  try {
    await driver.execute({
      scenarioId: "session-navigation-v1",
      case: {
        ...common,
        caseId: "duplicate-first",
        trend: "history-size",
        navigationType: "first-visit",
      },
    });
  } catch (error) {
    duplicateFirst = error;
  }
  assert.match(String(duplicateFirst), /already displayed in this process/u);
  const panelOpen = await driver.execute({
    scenarioId: "session-navigation-v1",
    case: {
      ...common,
      caseId: "return-panel-open",
      trend: "panel-load",
      navigationType: "return-visited-panel-open",
      loadProfile: "moderate",
    },
  });
  assert.deepStrictEqual(sessionNavigations, [
    { navigationType: "first-visit" },
    { navigationType: "first-visit" },
    { navigationType: "return-visited-panel-closed" },
    { navigationType: "return-visited-panel-open", loadProfile: "moderate" },
  ]);
  assert.equal(interveningFirst.durationMs, 4);
  assert.equal(panelOpen.durationMs, 4);
  assert.equal((panelOpen.rendererTrace as { readonly clock: string }).clock, "performance.now");
  assert.deepStrictEqual(panelOpen.timingEvidence, {
    trustedInputAt: (panelOpen.clock as { readonly start: number }).start,
    trustedInputEvent: "pointerdown",
  });
  assert.equal(
    (firstVisit.timingEvidence as { readonly trustedInputEvent: string }).trustedInputEvent,
    "pointerdown",
  );
  assert.equal(
    (returnClosed.timingEvidence as { readonly trustedInputEvent: string }).trustedInputEvent,
    "pointerdown",
  );
});

it("routes ordinary workspace-panel-v2 actions at their authoritative load profile", async () => {
  const { driver, panelActions, panelActionLoads } = makeHarness();
  await prepareFlowScenario(driver, "workspace-panel-v2");
  await driver.launch({
    scenarioId: "workspace-panel-v2",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "workspace-panel-v2",
  });
  const actions = [
    "open-panel",
    "close-panel",
    "files-to-review",
    "review-to-files",
    "open-file",
    "switch-file-tab",
    "expand-all",
    "collapse-all",
  ] as const;
  for (const action of actions) {
    const result = await driver.execute({
      scenarioId: "workspace-panel-v2",
      case: {
        caseId: `${action}-moderate`,
        workload: "workspace-panel-interaction",
        action,
        loadProfile: "moderate",
      },
    });
    assert.equal(result.durationMs, 4);
    assert.equal(
      (result.timingEvidence as { readonly trustedInputEvent: string }).trustedInputEvent,
      "pointerdown",
    );
  }
  assert.deepStrictEqual(panelActions, [...actions]);
  assert.deepStrictEqual(
    panelActionLoads,
    actions.map(() => "moderate"),
  );

  const canonicalPaths = Array.from({ length: 24 }, (_, index) => `src/file-${index}.ts`);
  const expandedPaths = canonicalPaths.slice(0, 6);
  const exact = {
    dataState: "ready",
    renderedFileCount: 24,
    truncated: false,
    headerPaths: canonicalPaths,
    expandedPaths,
    paintedBodyCount: 6,
    loading: false,
  };
  assert.equal(isStrictReviewReady(exact, canonicalPaths, expandedPaths), true);
  assert.equal(
    isStrictReviewReady({ ...exact, truncated: true }, canonicalPaths, expandedPaths),
    false,
  );
  assert.equal(
    isStrictReviewReady(
      { ...exact, headerPaths: canonicalPaths.slice(0, 23) },
      canonicalPaths,
      expandedPaths,
    ),
    false,
  );
  assert.equal(
    isStrictReviewReady({ ...exact, paintedBodyCount: 1 }, canonicalPaths, expandedPaths),
    false,
  );

  const materializedViewport = {
    ...exact,
    headerPaths: canonicalPaths.slice(0, 2),
    expandedPaths: expandedPaths.slice(0, 2),
    paintedBodyCount: 2,
  };
  assert.equal(
    isVirtualizedReviewViewportReady(materializedViewport, canonicalPaths, expandedPaths),
    true,
  );
  assert.equal(
    isVirtualizedReviewViewportReady(
      { ...materializedViewport, headerPaths: ["src/not-in-canonical-review.ts"] },
      canonicalPaths,
      expandedPaths,
    ),
    false,
  );
  assert.equal(
    isVirtualizedReviewViewportReady(
      { ...materializedViewport, expandedPaths: expandedPaths.slice(0, 1), paintedBodyCount: 1 },
      canonicalPaths,
      expandedPaths,
    ),
    false,
  );

  assert.equal(
    canPreserveReviewLoadAcrossSessionNavigation({ expandedReviewFileCount: 24 }, 24),
    true,
  );
  assert.equal(
    canPreserveReviewLoadAcrossSessionNavigation({ expandedReviewFileCount: 6 }, 24),
    false,
  );
  assert.throws(
    () => assertSessionNavigationReviewLoadSupported({ expandedReviewFileCount: 6 }, 24),
    /cannot preserve 6\/24 expanded Review files.*component-local collapse scope/u,
  );
  assert.deepStrictEqual(
    canonicalReviewExpansionPaths(
      ["src/file-10.ts", "src/file-02.ts", "src/file-01.ts", "src/file-20.ts"],
      3,
    ),
    ["src/file-01.ts", "src/file-02.ts", "src/file-10.ts"],
  );
});

it("rejects flow scenarios whose authoritative panel load definitions are incomplete", async () => {
  const { driver } = makeHarness();
  let rejection: unknown;
  try {
    await driver.prepare({
      scenarioId: "workspace-panel-v2",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: { cases: { panelLoads: panelLoads.slice(0, 2) } },
    });
  } catch (error) {
    rejection = error;
  }
  assert.match(String(rejection), /exactly light, moderate, and heavy/u);

  const { driver: mismatchedDriver } = makeHarness();
  let mismatch: unknown;
  try {
    await mismatchedDriver.prepare({
      scenarioId: "workspace-panel-v2",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: {
        cases: {
          panelLoads: panelLoads.map((profile) =>
            profile.id === "moderate" ? { ...profile, expandedReviewFileCount: 5 } : profile,
          ),
        },
      },
    });
  } catch (error) {
    mismatch = error;
  }
  assert.match(String(mismatch), /ordered scenario contract/u);
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
    fill: async () => undefined,
    getAttribute: async () => null,
    isVisible: async () => true,
    waitFor: async () => undefined,
  };
  const buttons = { ...rows, count: async () => 0 };
  const page = {
    waitForLoadState: async () => undefined,
    waitForSelector: async () => undefined,
    locator: (selector: string) => (selector === "[data-thread-item]" ? rows : buttons),
    bringToFront: async () => undefined,
    reload: async () => undefined,
    setViewportSize: async () => undefined,
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
    fill: async () => undefined,
    getAttribute: async () => null,
    isVisible: async () => true,
    waitFor: async () => undefined,
  };
  const page = {
    waitForLoadState: async () => undefined,
    waitForSelector: async () => Promise.reject(new Error("timeout")),
    locator: () => locator,
    bringToFront: async () => undefined,
    reload: async () => undefined,
    setViewportSize: async () => undefined,
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
      context: () => ({
        newCDPSession: async () => ({
          send: async <A>() => ({}) as A,
          on: () => undefined,
          detach: async () => undefined,
        }),
      }),
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
