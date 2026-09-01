// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Public benchmark adapter owns isolated state and child lifecycle.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { extractFile } from "@electron/asar";
import { serveDriver, type DriverHandlers } from "agent-app-benchmark/driver-sdk";
import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { _electron } from "playwright-core";

import {
  materializeT3PublicCorpus,
  rebaseT3BenchmarkWorkspaces,
  type T3PublicMaterializationResult,
  type T3WorkspaceFixtureSeal,
} from "./t3-public-materializer.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const NODE_PROCESS = (NodeProcess as unknown as { readonly default: NodeJS.Process }).default;
const READINESS_TIMEOUT_MS = 30_000;

interface OwnedProcess {
  readonly pid: number;
  readonly startTimeMs: number;
  readonly owner: "application";
  readonly category: string;
  readonly role?: "main";
}

interface ReadinessTarget {
  readonly logicalSessionId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly expectedMessageIds: ReadonlyArray<string>;
}

interface ReadinessReceipt {
  readonly endpoint: "correct-content-painted-and-input-ready";
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly passed: boolean;
    readonly observedAt?: number;
  }>;
}

interface MonotonicClock {
  readonly kind: "single-monotonic-clock";
  readonly clock: string;
  readonly start: number;
  readonly end: number;
}

interface PreparedDriverState {
  readonly materialization: T3PublicMaterializationResult;
  readonly stateHandles: { readonly P0: string; readonly P1: string };
}

type PanelProfile = "closed" | "files" | "diff";

type PanelLoadProfileId = "light" | "moderate" | "heavy";

interface PanelLoadProfile {
  readonly id: PanelLoadProfileId;
  readonly expandedDirectoryCount: number;
  readonly retainedFileTabCount: number;
  readonly expandedReviewFileCount: number;
}

export function canPreserveReviewLoadAcrossSessionNavigation(
  load: Pick<PanelLoadProfile, "expandedReviewFileCount">,
  canonicalReviewFileCount: number,
): boolean {
  return load.expandedReviewFileCount === canonicalReviewFileCount;
}

export function assertSessionNavigationReviewLoadSupported(
  load: Pick<PanelLoadProfile, "expandedReviewFileCount">,
  canonicalReviewFileCount: number,
): void {
  if (canPreserveReviewLoadAcrossSessionNavigation(load, canonicalReviewFileCount)) return;
  throw new Error(
    `T3 product contract cannot preserve ${load.expandedReviewFileCount}/${canonicalReviewFileCount} expanded Review files across a session return: DiffPanel stores one component-local collapse scope and resets a different thread to all expanded.`,
  );
}

export function canonicalReviewExpansionPaths(
  diffPaths: ReadonlyArray<string>,
  count: number,
): ReadonlyArray<string> {
  return diffPaths.toSorted().slice(0, count);
}

export function remainingReadinessTimeout(deadlineMs: number, nowMs: number): number {
  return Math.max(0, deadlineMs - nowMs);
}

export function t3BenchmarkWorkspaceRoot(stateRoot: string): string {
  // ReviewService accepts repositories under the server workspace root or
  // this state clone's managed worktrees directory. The desktop development
  // server root is the T3 checkout, so benchmark fixtures belong here.
  return NodePath.join(stateRoot, "worktrees", "benchmark-fixtures");
}

type WorkspacePanelAction =
  | "open-cold"
  | "toggle-open-close"
  | "toggle-close-open"
  | "open-warm-data"
  | "switch-surface"
  | "open-file"
  | "switch-file-tab"
  | "toggle-diff-view"
  | "collapse-all"
  | "expand-all";

interface RendererTrace {
  readonly clock: "performance.now";
  readonly transitionMode: "none" | "animated";
  readonly milestones: ReadonlyArray<{
    readonly id: string;
    readonly at: number;
  }>;
  readonly frameTimestampsMs: ReadonlyArray<number>;
  readonly longAnimationFrames: ReadonlyArray<{
    readonly start: number;
    readonly duration: number;
    readonly blockingDuration: number;
    readonly renderStart: number;
    readonly styleAndLayoutStart: number;
    readonly scripts: ReadonlyArray<{
      readonly sourceURL: string;
      readonly functionName: string;
      readonly invokerType: string;
      readonly duration: number;
      readonly forcedStyleAndLayoutDuration: number;
    }>;
  }>;
  readonly counterInterval: {
    readonly start: number;
    readonly end: number;
  };
  readonly counters: {
    readonly scriptDurationMs: number;
    readonly styleRecalcDurationMs: number;
    readonly layoutDurationMs: number;
    readonly taskDurationMs: number;
  };
}

interface ActiveLaunch {
  readonly processes: ReadonlyArray<OwnedProcess>;
  readonly readiness: ReadinessReceipt;
  readonly clock: MonotonicClock;
}

interface SwitchCase {
  readonly caseId: string;
  readonly workload:
    | "isolated-latency"
    | "transcript-size-latency"
    | "progressive-resource"
    | "resource-control";
  readonly sessionState?: "cold" | "warm";
  readonly sourceSessionId?: string;
  readonly destinationSessionId: string;
}

interface WorkspacePanelCase {
  readonly caseId: string;
  readonly action: WorkspacePanelAction;
  readonly sessionId?: string;
  readonly targetSessionId?: string;
}

type WorkspacePanelV2Action =
  | "open-panel"
  | "close-panel"
  | "files-to-review"
  | "review-to-files"
  | "open-file"
  | "switch-file-tab"
  | "expand-all"
  | "collapse-all";

interface WorkspacePanelV2Case {
  readonly caseId: string;
  readonly workload: "workspace-panel-interaction";
  readonly action: WorkspacePanelV2Action;
  readonly loadProfile: PanelLoadProfileId;
  readonly sessionId?: string;
  readonly targetSessionId?: string;
}

type SessionNavigationType =
  | "first-visit"
  | "return-visited-panel-closed"
  | "return-visited-panel-open";

interface SessionNavigationCase {
  readonly caseId: string;
  readonly workload: "session-navigation";
  readonly trend: "history-size" | "panel-load";
  readonly navigationType: SessionNavigationType;
  readonly transcriptBytes: number;
  readonly loadProfile?: PanelLoadProfileId;
  readonly sourceSessionId: string;
  readonly destinationSessionId: string;
}

interface WorkspacePanelSwitchCase {
  readonly caseId: string;
  readonly panelProfile: PanelProfile;
  readonly workspaceRelation: "within-workspace" | "across-workspaces";
  readonly sessionState: "cold" | "warm";
  readonly sourceSessionId: string;
  readonly destinationSessionId: string;
}

interface StartCase {
  readonly caseId: string;
  readonly startMode: "new-application-state" | "initialized-application-state";
}

interface T3DriverDependencies {
  readonly hello: Record<string, unknown>;
  readonly prepare: (params: PrepareParams) => Promise<PreparedDriverState>;
  readonly launch: (stateHandle: string, initialSessionId: string) => Promise<ActiveLaunch>;
  readonly activate: (
    target: ReadinessTarget,
    readinessAttempts?: number,
  ) => Promise<MonotonicClock>;
  readonly executeWorkspacePanelAction: (
    benchmarkCase: WorkspacePanelCase | WorkspacePanelV2Case,
    target: ReadinessTarget,
    loadProfile?: PanelLoadProfile,
  ) => Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace: RendererTrace;
  }>;
  readonly executeWorkspacePanelSwitch: (
    benchmarkCase: WorkspacePanelSwitchCase,
    source: ReadinessTarget,
    destination: ReadinessTarget,
  ) => Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace: RendererTrace;
  }>;
  readonly executeSessionNavigation: (
    benchmarkCase: SessionNavigationCase,
    source: ReadinessTarget,
    destination: ReadinessTarget,
    loadProfile?: PanelLoadProfile,
  ) => Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace?: RendererTrace;
  }>;
  readonly shutdown: () => Promise<{
    readonly terminated: ReadonlyArray<OwnedProcess>;
    readonly survivors: ReadonlyArray<OwnedProcess>;
  }>;
}

interface PrepareParams {
  readonly scenarioId: string;
  readonly scenarioDigestSha256: string;
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly corpusDigestSha256: string;
  readonly corpusDefinitionDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
  readonly runDirectory: string;
  readonly scenarioDefinition?: Record<string, unknown>;
  readonly fixtureSeed?: string;
  readonly workspaceFixtureManifest?: WorkspaceFixtureManifest;
  readonly workspaceFixtureDigestSha256?: string;
}

interface LaunchParams {
  readonly scenarioId: string;
  readonly stateHandle: string;
  readonly initialSessionId: string;
  readonly groupId: string;
}

interface ExecuteParams {
  readonly scenarioId: string;
  readonly stateHandle?: string;
  readonly case:
    | StartCase
    | SwitchCase
    | WorkspacePanelCase
    | WorkspacePanelV2Case
    | WorkspacePanelSwitchCase
    | SessionNavigationCase;
}

export interface T3PublicDriver {
  readonly hello: () => Promise<Record<string, unknown>>;
  readonly prepare: (params: PrepareParams) => Promise<Record<string, unknown>>;
  readonly launch: (params: LaunchParams) => Promise<Record<string, unknown>>;
  readonly execute: (params: ExecuteParams) => Promise<Record<string, unknown>>;
  readonly shutdown: () => Promise<Record<string, unknown>>;
}

export function createT3PublicDriver(dependencies: T3DriverDependencies): T3PublicDriver {
  let prepared: PreparedDriverState | undefined;
  let panelLoadProfiles = new Map<PanelLoadProfileId, PanelLoadProfile>();
  let active = false;
  /** Logical session IDs first-visited in the current app process (history returns may reuse them later). */
  let visitedDestinations = new Set<string>();

  const requirePrepared = (): PreparedDriverState => {
    if (!prepared) throw new Error("T3 driver has not prepared the public corpus.");
    return prepared;
  };
  const resolveTarget = (logicalSessionId: string): ReadinessTarget => {
    const target = requirePrepared().materialization.readinessTargets.get(logicalSessionId);
    if (!target) throw new Error(`T3 has no materialized target for ${logicalSessionId}.`);
    return target;
  };
  const requireStateHandle = (stateHandle: string): void => {
    const handles = requirePrepared().stateHandles;
    if (stateHandle !== handles.P0 && stateHandle !== handles.P1)
      throw new Error("T3 rejected an unknown state handle.");
  };
  const resolvePanelLoad = (id: PanelLoadProfileId): PanelLoadProfile => {
    const profile = panelLoadProfiles.get(id);
    if (!profile) throw new Error(`T3 has no prepared panel load profile ${id}.`);
    return profile;
  };

  return {
    hello: async () => dependencies.hello,
    prepare: async (params) => {
      if (prepared) throw new Error("T3 driver is already prepared.");
      panelLoadProfiles = readPanelLoadProfiles(params);
      prepared = await dependencies.prepare(params);
      return {
        materializationMode: "translated",
        corpusDigestSha256: prepared.materialization.corpusDigestSha256,
        eventSchemaDigestSha256: prepared.materialization.eventSchemaDigestSha256,
        mappingDigestSha256: prepared.materialization.mappingDigestSha256,
        workspaceFixtureDigestSha256:
          prepared.materialization.workspaceFixtureDigestSha256 ?? undefined,
        stateHandles: prepared.stateHandles,
        sessionMapping: prepared.materialization.sessionMapping,
      };
    },
    launch: async (params) => {
      if (active) throw new Error("T3 application is already running.");
      requireStateHandle(params.stateHandle);
      resolveTarget(params.initialSessionId);
      const launch = await dependencies.launch(params.stateHandle, params.initialSessionId);
      if (launch.processes.length === 0) throw new Error("T3 launch returned no application root.");
      active = true;
      visitedDestinations = new Set();
      return {
        ready: true,
        processes: launch.processes,
        readiness: launch.readiness,
      };
    },
    execute: async (params) => {
      if (["workspace-panel-v1", "workspace-panel-v2"].includes(params.scenarioId)) {
        if (!active) throw new Error("T3 workspace-panel actions require a running application.");
        if (!("action" in params.case))
          throw new Error("T3 workspace-panel request is missing its action.");
        const benchmarkCase = params.case;
        if (params.scenarioId === "workspace-panel-v2") {
          assertWorkspacePanelV2Case(benchmarkCase);
        }
        const target = resolveTarget(
          benchmarkCase.targetSessionId ?? benchmarkCase.sessionId ?? "control",
        );
        const result = await dependencies.executeWorkspacePanelAction(
          benchmarkCase,
          target,
          "loadProfile" in benchmarkCase ? resolvePanelLoad(benchmarkCase.loadProfile) : undefined,
        );
        return panelExecution(
          benchmarkCase.caseId,
          result.clock,
          result.rendererTrace,
          params.scenarioId === "workspace-panel-v2" ? "pointerdown" : "click",
        );
      }
      if (params.scenarioId === "session-navigation-v1") {
        if (!active) throw new Error("T3 session navigation requires a running application.");
        assertSessionNavigationCase(params.case);
        const benchmarkCase = params.case;
        const source = resolveTarget(benchmarkCase.sourceSessionId);
        const destination = resolveTarget(benchmarkCase.destinationSessionId);
        if (benchmarkCase.navigationType === "first-visit") {
          if (visitedDestinations.has(benchmarkCase.destinationSessionId))
            throw new Error("T3 first-visit destination was already displayed in this process.");
        } else if (benchmarkCase.navigationType === "return-visited-panel-closed") {
          if (!visitedDestinations.has(benchmarkCase.destinationSessionId))
            throw new Error(
              "T3 return navigation requires a prior first-visit of the destination in this process.",
            );
        }
        const result = await dependencies.executeSessionNavigation(
          benchmarkCase,
          source,
          destination,
          benchmarkCase.loadProfile ? resolvePanelLoad(benchmarkCase.loadProfile) : undefined,
        );
        if (benchmarkCase.navigationType === "first-visit") {
          visitedDestinations.add(benchmarkCase.destinationSessionId);
        }
        return result.rendererTrace
          ? panelExecution(benchmarkCase.caseId, result.clock, result.rendererTrace, "pointerdown")
          : {
              ...execution(benchmarkCase.caseId, result.clock, readinessReceipt(result.clock.end)),
              timingEvidence: {
                trustedInputAt: result.clock.start,
                trustedInputEvent: "pointerdown",
              },
            };
      }
      if (params.scenarioId === "session-switch-workspace-panel-v1") {
        if (!active)
          throw new Error("T3 panel-profile session switching requires a running application.");
        if (!("panelProfile" in params.case))
          throw new Error("T3 panel-profile session-switch request is incomplete.");
        const benchmarkCase = params.case;
        const source = resolveTarget(benchmarkCase.sourceSessionId);
        const destination = resolveTarget(benchmarkCase.destinationSessionId);
        const result = await dependencies.executeWorkspacePanelSwitch(
          benchmarkCase,
          source,
          destination,
        );
        return panelExecution(benchmarkCase.caseId, result.clock, result.rendererTrace);
      }
      if (["app-start-v1", "app-start-v3"].includes(params.scenarioId)) {
        if (active) throw new Error("T3 app-start requires no running application.");
        if (!("startMode" in params.case) || !params.stateHandle)
          throw new Error("T3 app-start request is incomplete.");
        requireStateHandle(params.stateHandle);
        const launch = await dependencies.launch(params.stateHandle, "control");
        active = true;
        return execution(
          params.case.caseId,
          launch.clock,
          params.scenarioId === "app-start-v3"
            ? withTimingEvidence(launch.readiness, launch.clock.end)
            : launch.readiness,
        );
      }
      if (
        !["session-switch-v1", "session-switch-v3"].includes(params.scenarioId) ||
        "startMode" in params.case ||
        !("workload" in params.case)
      )
        throw new Error(`T3 does not support scenario ${params.scenarioId}.`);
      if (!active) throw new Error("T3 session switching requires a running application.");
      assertSwitchCase(params.case);
      const benchmarkCase = params.case;
      const destination = resolveTarget(benchmarkCase.destinationSessionId);
      const control = resolveTarget(benchmarkCase.sourceSessionId ?? "control");
      if (benchmarkCase.workload !== "resource-control") {
        if (benchmarkCase.sessionState === "warm") await dependencies.activate(destination);
        await dependencies.activate(control);
      }
      const clock = await dependencies.activate(
        destination,
        benchmarkCase.workload === "resource-control" ? 6 : 1,
      );
      return execution(
        benchmarkCase.caseId,
        clock,
        readinessReceipt(params.scenarioId === "session-switch-v3" ? clock.end : undefined),
      );
    },
    shutdown: async () => {
      const result = await dependencies.shutdown();
      active = false;
      visitedDestinations = new Set();
      return result;
    },
  };
}

const PANEL_LOAD_PROFILE_IDS = new Set<PanelLoadProfileId>(["light", "moderate", "heavy"]);
const PANEL_LOAD_PROFILE_CONTRACT: ReadonlyArray<PanelLoadProfile> = [
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
];
const WORKSPACE_PANEL_V2_ACTIONS = new Set<WorkspacePanelV2Action>([
  "open-panel",
  "close-panel",
  "files-to-review",
  "review-to-files",
  "open-file",
  "switch-file-tab",
  "expand-all",
  "collapse-all",
]);

function readPanelLoadProfiles(params: PrepareParams): Map<PanelLoadProfileId, PanelLoadProfile> {
  if (!["session-navigation-v1", "workspace-panel-v2"].includes(params.scenarioId))
    return new Map();
  const cases = params.scenarioDefinition?.cases;
  const panelLoads =
    cases && typeof cases === "object" && !Array.isArray(cases)
      ? (cases as Record<string, unknown>).panelLoads
      : undefined;
  if (!Array.isArray(panelLoads))
    throw new Error("T3 requires scenarioDefinition.cases.panelLoads for this scenario.");
  if (panelLoads.length !== PANEL_LOAD_PROFILE_CONTRACT.length)
    throw new Error("T3 requires exactly light, moderate, and heavy panel load profiles.");
  const profiles = new Map<PanelLoadProfileId, PanelLoadProfile>();
  for (const [index, value] of panelLoads.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("T3 rejected a malformed panel load profile.");
    const profile = value as Record<string, unknown>;
    const id = profile.id;
    if (typeof id !== "string" || !PANEL_LOAD_PROFILE_IDS.has(id as PanelLoadProfileId))
      throw new Error(`T3 rejected panel load profile id ${String(id)}.`);
    const counts = [
      profile.expandedDirectoryCount,
      profile.retainedFileTabCount,
      profile.expandedReviewFileCount,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0))
      throw new Error(`T3 rejected invalid counts for panel load profile ${id}.`);
    if (profiles.has(id as PanelLoadProfileId))
      throw new Error(`T3 rejected duplicate panel load profile ${id}.`);
    const parsed = profile as unknown as PanelLoadProfile;
    const expected = PANEL_LOAD_PROFILE_CONTRACT[index];
    if (
      !expected ||
      parsed.id !== expected.id ||
      parsed.expandedDirectoryCount !== expected.expandedDirectoryCount ||
      parsed.retainedFileTabCount !== expected.retainedFileTabCount ||
      parsed.expandedReviewFileCount !== expected.expandedReviewFileCount
    )
      throw new Error("T3 panel load profiles do not match the ordered scenario contract.");
    profiles.set(id as PanelLoadProfileId, parsed);
  }
  if (
    profiles.size !== PANEL_LOAD_PROFILE_IDS.size ||
    [...PANEL_LOAD_PROFILE_IDS].some((id) => !profiles.has(id))
  )
    throw new Error("T3 requires exactly light, moderate, and heavy panel load profiles.");
  return profiles;
}

function assertWorkspacePanelV2Case(
  value: ExecuteParams["case"],
): asserts value is WorkspacePanelV2Case {
  if (
    !("workload" in value) ||
    value.workload !== "workspace-panel-interaction" ||
    !("action" in value) ||
    !WORKSPACE_PANEL_V2_ACTIONS.has(value.action as WorkspacePanelV2Action) ||
    !("loadProfile" in value) ||
    typeof value.loadProfile !== "string" ||
    !PANEL_LOAD_PROFILE_IDS.has(value.loadProfile as PanelLoadProfileId)
  )
    throw new Error("T3 workspace-panel-v2 request is incomplete.");
}

function assertSessionNavigationCase(
  value: ExecuteParams["case"],
): asserts value is SessionNavigationCase {
  if (
    !("workload" in value) ||
    value.workload !== "session-navigation" ||
    !("navigationType" in value) ||
    !["first-visit", "return-visited-panel-closed", "return-visited-panel-open"].includes(
      String(value.navigationType),
    ) ||
    !("trend" in value) ||
    !["history-size", "panel-load"].includes(String(value.trend)) ||
    !("transcriptBytes" in value) ||
    !Number.isSafeInteger(value.transcriptBytes) ||
    value.transcriptBytes <= 0 ||
    !("sourceSessionId" in value) ||
    typeof value.sourceSessionId !== "string" ||
    !("destinationSessionId" in value) ||
    typeof value.destinationSessionId !== "string"
  )
    throw new Error("T3 session-navigation request is incomplete.");
  const isPanelOpen = value.navigationType === "return-visited-panel-open";
  if (
    (isPanelOpen &&
      (value.trend !== "panel-load" ||
        !("loadProfile" in value) ||
        typeof value.loadProfile !== "string" ||
        !PANEL_LOAD_PROFILE_IDS.has(value.loadProfile as PanelLoadProfileId))) ||
    (!isPanelOpen && (value.trend !== "history-size" || "loadProfile" in value))
  )
    throw new Error("T3 session-navigation trend does not match its navigation type.");
}

function assertSwitchCase(value: ExecuteParams["case"]): asserts value is SwitchCase {
  if (
    !("workload" in value) ||
    ![
      "isolated-latency",
      "transcript-size-latency",
      "progressive-resource",
      "resource-control",
    ].includes(value.workload) ||
    !("destinationSessionId" in value) ||
    typeof value.destinationSessionId !== "string"
  )
    throw new Error("T3 session-switch request is incomplete.");
}

function execution(caseId: string, clock: MonotonicClock, readiness: ReadinessReceipt) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness };
}

function panelExecution(
  caseId: string,
  clock: MonotonicClock,
  rendererTrace: RendererTrace,
  trustedInputEvent: "click" | "pointerdown" = "click",
) {
  return {
    ...execution(caseId, clock, readinessReceipt(clock.end)),
    ...(trustedInputEvent === "pointerdown"
      ? { timingEvidence: { trustedInputAt: clock.start, trustedInputEvent } }
      : {}),
    rendererTrace,
  };
}

function readinessReceipt(observedAt?: number): ReadinessReceipt {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: [
      {
        id: "content-identity",
        passed: true,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
      {
        id: "first-fold-painted",
        passed: true,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
      {
        id: "two-presentations",
        passed: true,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
      {
        id: "trusted-input",
        passed: true,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
    ],
  };
}

function withTimingEvidence(receipt: ReadinessReceipt, observedAt: number): ReadinessReceipt {
  return {
    ...receipt,
    checks: receipt.checks.map((check) => ({
      ...check,
      observedAt: check.observedAt ?? observedAt,
    })),
  };
}

interface PlaywrightElectronProcess {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

interface PlaywrightElectronApplication {
  readonly process: () => PlaywrightElectronProcess;
  readonly firstWindow: () => Promise<PlaywrightPage>;
  readonly context: () => PlaywrightBrowserContext;
  readonly evaluate: <A>(
    fn: (electron: {
      readonly BrowserWindow: {
        readonly getAllWindows: () => ReadonlyArray<{
          readonly isDestroyed: () => boolean;
          readonly isVisible: () => boolean;
          readonly maximize: () => void;
        }>;
      };
    }) => A,
  ) => Promise<A>;
  readonly close: () => Promise<void>;
}

interface PlaywrightBrowserContext {
  readonly newCDPSession: (page: PlaywrightPage) => Promise<PlaywrightCDPSession>;
}

interface PlaywrightCDPSession {
  readonly send: <A>(method: string, params?: Record<string, unknown>) => Promise<A>;
  readonly on: (event: string, listener: (params: unknown) => void) => void;
  readonly detach: () => Promise<void>;
}

interface PlaywrightLocator {
  readonly count: () => Promise<number>;
  readonly first: () => PlaywrightLocator;
  readonly filter: (input: {
    readonly hasText?: string | RegExp;
    readonly visible?: boolean;
  }) => PlaywrightLocator;
  readonly click: (input?: { readonly timeout?: number }) => Promise<void>;
  readonly fill: (value: string) => Promise<void>;
  readonly hover?: () => Promise<void>;
  readonly getAttribute: (name: string) => Promise<string | null>;
  readonly isVisible: () => Promise<boolean>;
  readonly waitFor: (input: {
    readonly state: "visible" | "hidden";
    readonly timeout?: number;
  }) => Promise<void>;
}

interface PlaywrightPage {
  readonly waitForLoadState: (state: "domcontentloaded") => Promise<void>;
  readonly waitForSelector: (
    selector: string,
    input?: { readonly timeout?: number },
  ) => Promise<unknown>;
  readonly locator: (selector: string) => PlaywrightLocator;
  readonly bringToFront: () => Promise<void>;
  readonly reload: (input: { readonly waitUntil: "domcontentloaded" }) => Promise<unknown>;
  readonly setViewportSize: (size: {
    readonly width: number;
    readonly height: number;
  }) => Promise<void>;
  readonly evaluate: <A>(source: string) => Promise<A>;
}

async function maximizeAgentAppBenchmarkWindow(
  application: Pick<PlaywrightElectronApplication, "evaluate">,
  page: Pick<PlaywrightPage, "evaluate">,
): Promise<{ readonly width: number; readonly height: number }> {
  await application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    const window = windows.find((candidate) => candidate.isVisible()) ?? windows[0];
    if (!window) throw new Error("T3 benchmark has no native BrowserWindow to maximize.");
    window.maximize();
  });
  return page.evaluate<{ readonly width: number; readonly height: number }>(`
    new Promise((resolve) => {
      let previous = '';
      let stableFrames = 0;
      const sample = () => {
        const current = innerWidth + 'x' + innerHeight;
        stableFrames = current === previous ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 2) resolve({ width: innerWidth, height: innerHeight });
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })
  `);
}

type T3BenchmarkLaunchCommandInput =
  | {
      readonly mode: "packaged";
      readonly platform: NodeJS.Platform;
      readonly executablePath: string;
      readonly electronProfile: string;
    }
  | {
      readonly mode: "loose";
      readonly platform: NodeJS.Platform;
      readonly desktopEntry: string;
      readonly electronProfile: string;
      readonly resolveLooseCommand: (args: ReadonlyArray<string>) => {
        readonly electronPath: string;
        readonly args: ReadonlyArray<string>;
      };
    };

export function resolveT3BenchmarkLaunchCommand(input: T3BenchmarkLaunchCommandInput): {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
} {
  const benchmarkArgs = [
    ...(input.platform === "darwin" ? ["--use-mock-keychain"] : []),
    `--user-data-dir=${input.electronProfile}`,
  ];
  if (input.mode === "packaged") {
    return { executablePath: input.executablePath, args: benchmarkArgs };
  }
  const loose = input.resolveLooseCommand([...benchmarkArgs, input.desktopEntry]);
  return { executablePath: loose.electronPath, args: loose.args };
}

export function t3BenchmarkLaunchEnvironment(input: {
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly ambientHome: string;
  readonly stateHome: string;
}): Record<string, string> {
  return {
    ...input.baseEnv,
    HOME: input.ambientHome,
    APPDATA: NodePath.join(input.ambientHome, "app-data"),
    XDG_CONFIG_HOME: NodePath.join(input.ambientHome, "config"),
    XDG_CACHE_HOME: NodePath.join(input.ambientHome, "cache"),
    XDG_DATA_HOME: NodePath.join(input.ambientHome, "data"),
    T3CODE_HOME: input.stateHome,
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    VITE_DEV_SERVER_URL: "",
  };
}

export async function waitForSessionList(
  page: PlaywrightPage,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<void> {
  try {
    await page.waitForSelector("[data-thread-item]", { timeout: timeoutMs });
  } catch (cause) {
    const diagnostic = await page
      .evaluate<string>(
        `
        JSON.stringify({
          url: location.href,
          title: document.title,
          text: (document.body?.innerText ?? "").slice(0, 800),
        })
      `,
      )
      .catch(() => "renderer diagnostic unavailable");
    throw new Error(`T3 session list readiness failed: ${diagnostic}`, {
      cause,
    });
  }
}

async function armTrustedActivation(
  page: PlaywrightPage,
  trustedInputEvent: "click" | "pointerdown" = "click",
): Promise<void> {
  await page.evaluate<void>(`
    globalThis.__t3AgentAppTrustedActivation = undefined;
    document.addEventListener(${JSON.stringify(trustedInputEvent)}, (event) => {
      if (event.isTrusted) globalThis.__t3AgentAppTrustedActivation = performance.now();
    }, { capture: true, once: true });
  `);
}

async function readTrustedActivation(page: PlaywrightPage): Promise<number> {
  const timestamp = await page.evaluate<number>(
    "globalThis.__t3AgentAppTrustedActivation ?? Number.NaN",
  );
  if (!Number.isFinite(timestamp))
    throw new Error("T3 renderer did not observe a trusted activation.");
  return timestamp;
}

async function waitForComposerUsable(
  page: PlaywrightPage,
  observationId?: string,
): Promise<number> {
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${READINESS_TIMEOUT_MS};
      let usableFrames = 0;
      const frame = (at) => {
        const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(observationId)});
        if (observation?.cancelled) return reject(new Error("T3 composer observation was cancelled."));
        const composer = document.querySelector('[data-testid="composer-editor"]');
        const usable = (() => {
          if (!(composer instanceof HTMLElement)) return false;
          const bounds = composer.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && composer.getAttribute("aria-disabled") !== "true" && !composer.hasAttribute("disabled");
        })();
        usableFrames = usable ? usableFrames + 1 : 0;
        if (usableFrames >= 2) return resolve(performance.now());
        if (performance.now() >= deadline) return reject(new Error("T3 composer did not become stably usable."));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

export async function ensureWorkItemsRendered(
  page: PlaywrightPage,
  expectedCount: number,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<void> {
  const rows = page.locator("[data-thread-item]");
  const deadline = NodePerfHooks.performance.now() + timeoutMs;
  let renderedCount = await rows.count();
  while (renderedCount < expectedCount) {
    const showMore = page.locator("button").filter({ hasText: /^Show \d+ more$/u, visible: true });
    const showMoreCount = await showMore.count();
    if (showMoreCount > 1)
      throw new Error("T3 rendered more than one session-list expansion control.");
    if (showMoreCount === 1) await showMore.click();
    await page.evaluate(
      showMoreCount === 1
        ? "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
        : "new Promise((resolve) => setTimeout(resolve, 50))",
    );
    renderedCount = await rows.count();
    if (NodePerfHooks.performance.now() >= deadline)
      throw new Error(`Only ${renderedCount} of ${expectedCount} benchmark sessions rendered.`);
  }
}

async function waitForSemanticTimelinePaint(
  page: PlaywrightPage,
  target: ReadinessTarget,
  timeoutMs = READINESS_TIMEOUT_MS,
  observationId?: string,
): Promise<number> {
  const expectedMessageIds = JSON.stringify(target.expectedMessageIds);
  const expectedOwnerSuffix = JSON.stringify(`:${target.sessionId}`);
  try {
    return await page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const expected = new Set(${expectedMessageIds});
      const deadline = performance.now() + ${timeoutMs};
      let previous;
      const painted = (element, owner) => {
        let current = element;
        while (current instanceof HTMLElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return false;
          if (current === owner) return true;
          current = current.parentElement;
        }
        return false;
      };
      const visible = (element, owner, viewport) => {
        const rect = element.getBoundingClientRect();
        return painted(element, owner) && rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      };
      const hitTested = (element, viewport) => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, viewport.left ?? 0);
        const right = Math.min(rect.right, viewport.right ?? innerWidth);
        const top = Math.max(rect.top, viewport.top);
        const bottom = Math.min(rect.bottom, viewport.bottom);
        if (right <= left || bottom <= top) return false;
        const points = [
          [left + (right - left) / 2, top + (bottom - top) / 2],
          [left + Math.min(24, (right - left) / 2), top + Math.min(24, (bottom - top) / 2)],
        ];
        return points.some(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return hit === element || (hit instanceof Node && element.contains(hit));
        });
      };
      const sample = () => {
        const owners = Array.from(document.querySelectorAll("[data-chat-owner-thread-key]"));
        const owner = owners.find((candidate) => candidate instanceof HTMLElement && candidate.getAttribute("data-chat-owner-thread-key")?.endsWith(${expectedOwnerSuffix}));
        if (!(owner instanceof HTMLElement) || owner.querySelector("[data-thread-sync-drawer]")) return undefined;
        const rows = Array.from(owner.querySelectorAll("[data-timeline-row-id]"));
        const targetRow = rows.find((row) => row instanceof HTMLElement && expected.has(row.getAttribute("data-message-id")));
        if (!(targetRow instanceof HTMLElement)) return undefined;
        let viewport = targetRow.parentElement;
        while (viewport instanceof HTMLElement && !["auto", "scroll"].includes(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
        const scroll = viewport instanceof HTMLElement ? viewport : document.documentElement;
        const bounds = scroll === document.documentElement ? { top: 0, right: innerWidth, bottom: innerHeight, left: 0 } : scroll.getBoundingClientRect();
        const visibleRows = rows.filter((row) => row instanceof HTMLElement && visible(row, owner, bounds));
        if (!visible(targetRow, owner, bounds) || !hitTested(targetRow, bounds) || targetRow.innerText.trim().length === 0 || targetRow.querySelector('[data-slot="skeleton"]')) return undefined;
        const first = visibleRows[0];
        const topGap = first instanceof HTMLElement ? Math.max(0, first.getBoundingClientRect().top - bounds.top) : Infinity;
        const overflow = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (visibleRows.length === 0 || (overflow > 100 && topGap > 96)) return undefined;
        return JSON.stringify(visibleRows.map((row) => [row.getAttribute("data-timeline-row-id"), row.getAttribute("data-message-id"), row.innerText.trim().length, Math.round(row.getBoundingClientRect().top * 10) / 10, Math.round(row.getBoundingClientRect().height * 10) / 10]));
      };
      const frame = (paintedAt) => {
        const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(observationId)});
        if (observation?.cancelled) return reject(new Error("T3 session readiness observation was cancelled."));
        const current = sample();
        // The endpoint is the moment the second identical sample is observed. A rAF timestamp
        // is the frame's scheduled start and precedes the observation by the main thread's
        // lateness, which would discount the busier application more.
        if (current !== undefined && current === previous) return resolve(performance.now());
        previous = current;
        if (performance.now() >= deadline) return reject(new Error("T3 did not paint stable canonical session content."));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
    `);
  } catch (cause) {
    const diagnostic = await page.evaluate<string>(`
      JSON.stringify({
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 8).map((node) => node.textContent?.trim().slice(0, 120)),
        messages: Array.from(document.querySelectorAll("[data-message-id]")).slice(-8).map((node) => node.getAttribute("data-message-id")),
        selectedThreads: Array.from(document.querySelectorAll("[data-thread-item][data-state=selected],[data-thread-item][aria-current=true]")).map((node) => node.getAttribute("data-thread-id")),
      })
    `);
    throw new Error(
      `T3 semantic timeline readiness failed for ${target.logicalSessionId}: ${diagnostic}`,
      { cause },
    );
  }
}

async function activateWorkItem(
  page: PlaywrightPage,
  target: ReadinessTarget,
  launchReadinessAttempts = 1,
  trustedInputEvent: "click" | "pointerdown" = "click",
): Promise<MonotonicClock> {
  const matches = page
    .locator(
      `[data-thread-item][data-thread-id=${JSON.stringify(target.sessionId)}] [role="button"]`,
    )
    .filter({ visible: true });
  if ((await matches.count()) !== 1)
    throw new Error(`T3 benchmark session ${target.logicalSessionId} has no unique visible row.`);
  let start = Number.NaN;
  for (let attempt = 0; attempt < launchReadinessAttempts; attempt += 1) {
    await armTrustedActivation(page, trustedInputEvent);
    try {
      const end = await runRendererObservedAction(
        page,
        (observationId) =>
          observeSessionReady(
            page,
            target,
            launchReadinessAttempts === 1
              ? READINESS_TIMEOUT_MS
              : READINESS_TIMEOUT_MS / launchReadinessAttempts,
            observationId,
          ),
        async () => {
          await matches.first().click();
          start = await readTrustedActivation(page);
        },
      );
      return {
        kind: "single-monotonic-clock",
        clock: "t3-renderer-performance",
        start,
        end,
      };
    } catch (error) {
      if (attempt === launchReadinessAttempts - 1) throw error;
    }
  }
  throw new Error(`T3 failed to activate ${target.logicalSessionId}.`);
}

interface TraceRecording {
  readonly cdp: PlaywrightCDPSession;
  readonly traceEvents: CdpTraceEvent[];
  readonly tracingComplete: Promise<void>;
}

interface CdpTraceEvent {
  readonly name?: string;
  readonly cat?: string;
  readonly ph?: string;
  readonly ts?: number;
  readonly dur?: number;
  readonly pid?: number;
  readonly tid?: number;
}

const COUNTER_START_MARK = "t3-benchmark-counter-start";
const COUNTER_END_MARK = "t3-benchmark-counter-end";

function traceEventMatches(event: CdpTraceEvent, names: ReadonlySet<string>): boolean {
  const name = event.name ?? "";
  for (const candidate of names) {
    if (name === candidate || name.endsWith(`::${candidate}`)) return true;
  }
  return false;
}

function traceDurationMs(
  events: ReadonlyArray<CdpTraceEvent>,
  names: ReadonlySet<string>,
  start: CdpTraceEvent,
  end: CdpTraceEvent,
): number {
  const startAt = start.ts;
  const endAt = end.ts;
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt! < startAt!)
    throw new Error("T3 counter trace has invalid action boundaries.");
  const intervals = events
    .filter(
      (event) =>
        event.pid === start.pid &&
        event.tid === start.tid &&
        event.ph === "X" &&
        Number.isFinite(event.ts) &&
        Number.isFinite(event.dur) &&
        event.dur! >= 0 &&
        traceEventMatches(event, names),
    )
    .map(
      (event) => [Math.max(startAt!, event.ts!), Math.min(endAt!, event.ts! + event.dur!)] as const,
    )
    .filter(([left, right]) => right > left)
    .toSorted(([left], [right]) => left - right);
  let totalMicroseconds = 0;
  let intervalStart = Number.NaN;
  let intervalEnd = Number.NaN;
  for (const [left, right] of intervals) {
    if (!Number.isFinite(intervalStart)) {
      intervalStart = left;
      intervalEnd = right;
      continue;
    }
    if (left <= intervalEnd) {
      intervalEnd = Math.max(intervalEnd, right);
      continue;
    }
    totalMicroseconds += intervalEnd - intervalStart;
    intervalStart = left;
    intervalEnd = right;
  }
  if (Number.isFinite(intervalStart)) totalMicroseconds += intervalEnd - intervalStart;
  return totalMicroseconds / 1_000;
}

export function rendererCountersFromTraceEvents(events: ReadonlyArray<CdpTraceEvent>) {
  const start = events.find((event) => event.name === COUNTER_START_MARK);
  const end = events.find(
    (event) =>
      event.name === COUNTER_END_MARK && event.pid === start?.pid && event.tid === start?.tid,
  );
  if (!start || !end)
    throw new Error("T3 counter trace is missing its trusted-input/complete marks.");
  const scriptEvents = new Set([
    "EventDispatch",
    "TimerFire",
    "FireAnimationFrame",
    "RunMicrotasks",
  ]);
  const styleEvents = new Set(["UpdateLayoutTree", "RecalculateStyles", "RecalculateStyle"]);
  return {
    scriptDurationMs: traceDurationMs(events, scriptEvents, start, end),
    styleRecalcDurationMs: traceDurationMs(events, styleEvents, start, end),
    layoutDurationMs: traceDurationMs(events, new Set(["Layout"]), start, end),
    taskDurationMs: traceDurationMs(events, new Set(["RunTask"]), start, end),
  };
}

async function beginRendererTrace(
  application: PlaywrightElectronApplication,
  page: PlaywrightPage,
  trustedInputEvent: "click" | "pointerdown",
): Promise<TraceRecording> {
  const cdp = await application.context().newCDPSession(page);
  const traceEvents: CdpTraceEvent[] = [];
  let finishTracing: () => void = () => undefined;
  const tracingComplete = new Promise<void>((resolve) => {
    finishTracing = resolve;
  });
  cdp.on("Tracing.dataCollected", (params) => {
    const value = (params as { readonly value?: ReadonlyArray<CdpTraceEvent> }).value;
    if (value) traceEvents.push(...value);
  });
  cdp.on("Tracing.tracingComplete", finishTracing);
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing,toplevel",
    transferMode: "ReportEvents",
    options: "record-until-full",
  });
  await page.evaluate<void>(`
    (() => {
      if (globalThis.__t3WorkspacePanelTrace) throw new Error("A renderer trace is already armed.");
      const trace = {
        active: true,
        frames: [],
        milestones: [],
        longAnimationFrames: [],
        trustedInputEvent: ${JSON.stringify(trustedInputEvent)},
        trustedInputAt: undefined,
        lastTrustedInputAt: undefined,
        shellVisibleAt: undefined,
        dataReadyAtByKind: {},
        transitionMode: matchMedia("(max-width: 980px)").matches ? "animated" : "none",
      };
      const frame = (at) => {
        if (!trace.active) return;
        // Frames before the trusted input are not part of the observation; keep only the
        // last one so a slow actionability wait between arming and the click cannot use
        // up the cap and leave the measured interval without frame evidence.
        if (trace.trustedInputAt === undefined) trace.frames.length = 0;
        if (trace.frames.length < 480) trace.frames.push({ at });
        if (trace.trustedInputAt !== undefined && trace.shellVisibleAt === undefined) {
          const shell = document.querySelector('[data-right-panel-tabbar]');
          if (shell instanceof HTMLElement) {
            const rect = shell.getBoundingClientRect();
            const style = getComputedStyle(shell);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') trace.shellVisibleAt = at;
          }
        }
        requestAnimationFrame(frame);
      };
      trace.input = (event) => {
        if (!event.isTrusted) return;
        trace.lastTrustedInputAt = performance.now();
        if (trace.trustedInputAt === undefined) {
          const counterStart = performance.mark(${JSON.stringify(COUNTER_START_MARK)}).startTime;
          trace.trustedInputAt = counterStart;
          trace.milestones.push({ id: "trusted-input", at: counterStart });
        }
      };
      document.addEventListener(${JSON.stringify(trustedInputEvent)}, trace.input, true);
      trace.dataObserver = new MutationObserver((records) => {
        const inspect = (element) => {
          if (!(element instanceof HTMLElement) || element.getAttribute('data-right-panel-data-state') !== 'ready') return;
          const kind = element.getAttribute('data-right-panel-surface-kind') ?? (element.hasAttribute('data-file-browser-panel') ? 'files' : null);
          if (kind && trace.dataReadyAtByKind[kind] === undefined) trace.dataReadyAtByKind[kind] = performance.now();
        };
        for (const record of records) {
          inspect(record.target);
          for (const node of record.addedNodes) {
            inspect(node);
            if (node instanceof Element) for (const element of node.querySelectorAll('[data-right-panel-data-state="ready"]')) inspect(element);
          }
        }
      });
      trace.dataObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-right-panel-data-state'] });
      if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
        trace.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (trace.longAnimationFrames.length >= 64) break;
            trace.longAnimationFrames.push({
              start: entry.startTime,
              duration: entry.duration,
              blockingDuration: entry.blockingDuration ?? 0,
              renderStart: Number(entry.renderStart ?? entry.startTime),
              styleAndLayoutStart: Number(entry.styleAndLayoutStart ?? entry.startTime),
              scripts: Array.from(entry.scripts ?? []).slice(0, 32).map((script) => ({
                sourceURL: (() => {
                  const value = String(script.sourceURL ?? '');
                  try { return new URL(value).pathname.split('/').slice(-3).join('/').slice(0, 500); }
                  catch { return value.split('/').slice(-3).join('/').slice(0, 500); }
                })(),
                functionName: String(script.sourceFunctionName ?? "").slice(0, 300),
                invokerType: String(script.invokerType ?? script.invoker ?? "").slice(0, 120),
                duration: Number(script.duration ?? 0),
                forcedStyleAndLayoutDuration: Number(script.forcedStyleAndLayoutDuration ?? 0),
              })),
            });
          }
        });
        trace.observer.observe({ type: "long-animation-frame", buffered: false });
      }
      globalThis.__t3WorkspacePanelTrace = trace;
      requestAnimationFrame(frame);
    })()
  `);
  return { cdp, traceEvents, tracingComplete };
}

async function markRendererMilestone(page: PlaywrightPage, id: string): Promise<number> {
  return page.evaluate<number>(`
    (() => {
      const trace = globalThis.__t3WorkspacePanelTrace;
      if (!trace?.active) throw new Error("No active renderer trace.");
      const at = performance.now();
      trace.milestones.push({ id: ${JSON.stringify(id)}, at });
      return at;
    })()
  `);
}

async function completeRendererTrace(page: PlaywrightPage): Promise<void> {
  await page.evaluate<void>(`
    (() => {
      const trace = globalThis.__t3WorkspacePanelTrace;
      if (!trace?.active) throw new Error("No active renderer trace.");
      const interactive = trace.milestones.findLast((item) => item.id === "interactive");
      if (!interactive) throw new Error("The measured action has no interactive endpoint.");
      // The endpoint is the renderer-observed interactive milestone. The counter end mark is
      // back-dated to it so the driver's own CDP round-trips after readiness stay outside both
      // the clock and the counter window.
      const at = interactive.at;
      performance.mark(${JSON.stringify(COUNTER_END_MARK)}, { startTime: at });
      trace.milestones.push({ id: "complete", at });
    })()
  `);
}

async function markRendererMilestones(
  page: PlaywrightPage,
  ids: ReadonlyArray<string>,
  at?: number,
): Promise<number> {
  return page.evaluate<number>(`
    (() => {
      const trace = globalThis.__t3WorkspacePanelTrace;
      if (!trace?.active) throw new Error("No active renderer trace.");
      const at = ${at === undefined ? "performance.now()" : String(at)};
      for (const id of ${JSON.stringify(ids)}) trace.milestones.push({ id, at });
      return at;
    })()
  `);
}

async function readDataReadyAt(page: PlaywrightPage, profile: Exclude<PanelProfile, "closed">) {
  const at = await page.evaluate<number>(`
    globalThis.__t3WorkspacePanelTrace?.dataReadyAtByKind?.[${JSON.stringify(profile)}] ?? Number.NaN
  `);
  if (!Number.isFinite(at))
    throw new Error(`T3 observed no authoritative ${profile} data-ready transition.`);
  return at;
}

async function readMeasuredTrustedInputAt(page: PlaywrightPage): Promise<number> {
  const at = await page.evaluate<number>(
    "globalThis.__t3WorkspacePanelTrace?.trustedInputAt ?? Number.NaN",
  );
  if (!Number.isFinite(at)) throw new Error("T3 renderer trace has no trusted input boundary.");
  return at;
}

async function readTraceTimestamp(
  page: PlaywrightPage,
  field: "lastTrustedInputAt" | "shellVisibleAt",
): Promise<number> {
  const at = await page.evaluate<number>(
    `globalThis.__t3WorkspacePanelTrace?.[${JSON.stringify(field)}] ?? Number.NaN`,
  );
  if (!Number.isFinite(at)) throw new Error(`T3 renderer trace has no ${field} timestamp.`);
  return at;
}

async function panelTransitionMode(page: PlaywrightPage): Promise<RendererTrace["transitionMode"]> {
  const mode = await page.evaluate<string>(
    'matchMedia("(max-width: 980px)").matches ? "animated" : "none"',
  );
  if (mode !== "none" && mode !== "animated")
    throw new Error("T3 renderer trace has no transition mode.");
  return mode;
}

async function endRendererTrace(
  page: PlaywrightPage,
  recording: TraceRecording,
): Promise<RendererTrace> {
  try {
    const trace = await page.evaluate<Omit<RendererTrace, "counters">>(`
      (() => {
        const trace = globalThis.__t3WorkspacePanelTrace;
        if (!trace?.active) throw new Error("No active renderer trace.");
        trace.active = false;
        document.removeEventListener(trace.trustedInputEvent, trace.input, true);
        trace.observer?.disconnect();
        trace.dataObserver?.disconnect();
        delete globalThis.__t3WorkspacePanelTrace;
        if (trace.trustedInputAt === undefined) throw new Error("The measured action had no trusted input.");
        const complete = trace.milestones.find((item) => item.id === 'complete')?.at;
        if (!Number.isFinite(complete)) throw new Error("The renderer trace has no complete boundary.");
        trace.milestones.sort((left, right) => left.at - right.at);
        return {
          clock: "performance.now",
          transitionMode: trace.transitionMode,
          milestones: trace.milestones,
          frameTimestampsMs: trace.frames.map((frame) => frame.at).filter((at) => at >= trace.trustedInputAt && at <= complete),
          longAnimationFrames: trace.longAnimationFrames.filter((entry) => entry.start >= trace.trustedInputAt && entry.start + entry.duration <= complete + 0.5),
          counterInterval: { start: trace.trustedInputAt, end: complete },
        };
      })()
    `);
    await recording.cdp.send("Tracing.end");
    const timeoutController = new AbortController();
    try {
      await Promise.race([
        recording.tracingComplete,
        NodeTimersPromises.setTimeout(READINESS_TIMEOUT_MS, undefined, {
          signal: timeoutController.signal,
        }).then(() => {
          throw new Error("T3 counter trace did not finish.");
        }),
      ]);
    } finally {
      timeoutController.abort();
    }
    return {
      ...trace,
      counters: rendererCountersFromTraceEvents(recording.traceEvents),
    };
  } finally {
    await recording.cdp.detach();
  }
}

function rendererClock(trace: RendererTrace): MonotonicClock {
  const start = trace.milestones.find((milestone) => milestone.id === "trusted-input")?.at;
  const end = trace.milestones.findLast((milestone) => milestone.id === "complete")?.at;
  if (start === undefined || end === undefined || end < start)
    throw new Error("T3 renderer trace is missing its canonical input/complete boundary.");
  return {
    kind: "single-monotonic-clock",
    clock: "performance.now",
    start,
    end,
  };
}

export async function runPrearmedReadiness<A>(
  arm: () => Promise<A>,
  action: () => Promise<void>,
  cancel: () => Promise<void>,
): Promise<A> {
  const readiness = arm();
  void readiness.catch(() => undefined);
  try {
    await action();
    return await readiness;
  } catch (error) {
    try {
      await cancel();
    } catch {}
    await Promise.allSettled([readiness]);
    throw error;
  }
}

let readinessObservationSequence = 0;

async function beginReadinessObservation(page: PlaywrightPage): Promise<string> {
  const id = `t3-readiness-${readinessObservationSequence++}`;
  await page.evaluate<void>(`
    globalThis.__t3ReadinessObservations ??= new Map();
    globalThis.__t3ReadinessObservations.set(${JSON.stringify(id)}, { cancelled: false });
  `);
  return id;
}

async function cancelReadinessObservation(page: PlaywrightPage, id: string): Promise<void> {
  await page.evaluate<void>(`
    (() => {
      const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(id)});
      if (observation) observation.cancelled = true;
    })()
  `);
}

async function finishReadinessObservation(page: PlaywrightPage, id: string): Promise<void> {
  await page.evaluate<void>(`
    globalThis.__t3ReadinessObservations?.delete(${JSON.stringify(id)});
  `);
}

async function runRendererObservedAction<A>(
  page: PlaywrightPage,
  arm: (observationId: string) => Promise<A>,
  action: () => Promise<void>,
): Promise<A> {
  const observationId = await beginReadinessObservation(page);
  try {
    return await runPrearmedReadiness(
      () => arm(observationId),
      action,
      () => cancelReadinessObservation(page, observationId),
    );
  } finally {
    try {
      await finishReadinessObservation(page, observationId);
    } catch {}
  }
}

async function waitForStableElement(
  page: PlaywrightPage,
  selector: string,
  evidenceExpression: string,
  timeoutMs = READINESS_TIMEOUT_MS,
  observationId?: string,
): Promise<number> {
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${timeoutMs};
      let previous;
      const frame = (at) => {
        const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(observationId)});
        if (observation?.cancelled) return reject(new Error("T3 readiness observation was cancelled."));
        const trace = globalThis.__t3WorkspacePanelTrace;
        // Inside a measured action only frames after the trusted input count towards the
        // two-presentation stability rule, so a pre-input sample can never satisfy it and
        // every valid observation carries at least two frames inside its interval.
        if (trace?.active && (trace.trustedInputAt === undefined || at < trace.trustedInputAt)) {
          previous = undefined;
          requestAnimationFrame(frame);
          return;
        }
        const element = document.querySelector(${JSON.stringify(selector)});
        let sample;
        if (element instanceof HTMLElement) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const canonical = (() => { ${evidenceExpression} })();
          if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && canonical) {
            sample = JSON.stringify([Math.round(rect.width * 10), Math.round(rect.height * 10), element.innerText.trim().length, canonical]);
          }
        }
        if (sample !== undefined && sample === previous) return resolve(performance.now());
        previous = sample;
        if (performance.now() >= deadline) return reject(new Error("Canonical element did not reach a stable painted state: " + ${JSON.stringify(selector)}));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

async function waitForPanelShell(page: PlaywrightPage): Promise<void> {
  await waitForStableElement(page, "[data-right-panel-tabbar]", "return true;");
}

async function waitForPanelAnimationSettled(
  page: PlaywrightPage,
  observationId?: string,
): Promise<number> {
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${READINESS_TIMEOUT_MS};
      let previous;
      let stableFrames = 0;
      const frame = (at) => {
        const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(observationId)});
        if (observation?.cancelled) return reject(new Error("T3 panel animation observation was cancelled."));
        const trace = globalThis.__t3WorkspacePanelTrace;
        // Inside a measured action only frames after the trusted input count towards the
        // two-presentation stability rule, so a pre-input sample can never satisfy it and
        // every valid observation carries at least two frames inside its interval.
        if (trace?.active && (trace.trustedInputAt === undefined || at < trace.trustedInputAt)) {
          previous = undefined;
          stableFrames = 0;
          requestAnimationFrame(frame);
          return;
        }
        const shell = document.querySelector('[data-right-panel-tabbar]');
        if (shell instanceof HTMLElement) {
          const rect = shell.getBoundingClientRect();
          const style = getComputedStyle(shell);
          const sample = JSON.stringify([
            Math.round(rect.left * 10),
            Math.round(rect.right * 10),
            Math.round(rect.width * 10),
            style.transform,
          ]);
          stableFrames = sample === previous ? stableFrames + 1 : 0;
          previous = sample;
          if (stableFrames >= 2) return resolve(performance.now());
        }
        if (performance.now() >= deadline) return reject(new Error('T3 right-panel animation did not settle.'));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

async function waitForPanelClosed(page: PlaywrightPage, observationId?: string): Promise<number> {
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${READINESS_TIMEOUT_MS};
      let absentFrames = 0;
      const frame = (at) => {
        const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(observationId)});
        if (observation?.cancelled) return reject(new Error("T3 panel-close observation was cancelled."));
        const trace = globalThis.__t3WorkspacePanelTrace;
        if (trace?.active && (trace.trustedInputAt === undefined || at < trace.trustedInputAt)) {
          absentFrames = 0;
          requestAnimationFrame(frame);
          return;
        }
        absentFrames = document.querySelector('[data-right-panel-tabbar]') === null
          ? absentFrames + 1
          : 0;
        if (absentFrames >= 2) return resolve(performance.now());
        if (performance.now() >= deadline) return reject(new Error("Right panel did not remain closed for two presentations."));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

async function waitForPanelOwner(page: PlaywrightPage, target: ReadinessTarget): Promise<void> {
  await waitForStableElement(
    page,
    "[data-right-panel-surface-content]",
    `
      const owner = element.getAttribute('data-right-panel-owner-thread-key');
      return owner !== null && owner.endsWith(${JSON.stringify(`:${target.sessionId}`)});
    `,
  );
}

async function waitForChatOwner(page: PlaywrightPage, target: ReadinessTarget): Promise<void> {
  await waitForStableElement(
    page,
    "[data-chat-owner-thread-key]",
    `
      const owner = element.getAttribute('data-chat-owner-thread-key');
      return owner !== null && owner.endsWith(${JSON.stringify(`:${target.sessionId}`)});
    `,
  );
}

async function observeSessionReady(
  page: PlaywrightPage,
  target: ReadinessTarget,
  timeoutMs = READINESS_TIMEOUT_MS,
  observationId?: string,
): Promise<number> {
  const owner = waitForStableElement(
    page,
    "[data-chat-owner-thread-key]",
    `
      const owner = element.getAttribute('data-chat-owner-thread-key');
      return owner !== null && owner.endsWith(${JSON.stringify(`:${target.sessionId}`)});
    `,
    timeoutMs,
    observationId,
  );
  const composer = waitForComposerUsable(page, observationId);
  const content = waitForSemanticTimelinePaint(page, target, timeoutMs, observationId);
  const timestamps = await Promise.all([owner, composer, content]);
  return Math.max(...timestamps);
}

interface WorkspaceFixtureEvidence {
  readonly filePaths: ReadonlyArray<string>;
  readonly allFilePaths: ReadonlyArray<string>;
  readonly directoryPaths: ReadonlyArray<string>;
  readonly diffPaths: ReadonlyArray<string>;
  readonly fileCount: number;
  readonly diffCount: number;
}

export interface ReviewReadinessSnapshot {
  readonly dataState: string | null;
  readonly renderedFileCount: number;
  readonly truncated: boolean;
  readonly headerPaths: ReadonlyArray<string>;
  readonly expandedPaths: ReadonlyArray<string>;
  readonly paintedBodyCount: number;
  readonly loading: boolean;
}

export function canonicalReviewModelFailure(
  snapshot: Pick<ReviewReadinessSnapshot, "dataState" | "renderedFileCount" | "truncated"> & {
    readonly ownerThreadKey: string | null;
  },
  canonicalFileCount: number,
  expectedOwnerSessionId?: string,
): string | undefined {
  if (
    expectedOwnerSessionId !== undefined &&
    (snapshot.ownerThreadKey === null ||
      !snapshot.ownerThreadKey.endsWith(`:${expectedOwnerSessionId}`))
  )
    return undefined;
  if (snapshot.dataState !== "ready") return undefined;
  if (snapshot.truncated)
    return `T3 product Review preview limit cannot represent the canonical ${canonicalFileCount}-file workspace fixture: the resolved preview is truncated at ${snapshot.renderedFileCount} files.`;
  if (snapshot.renderedFileCount !== canonicalFileCount)
    return `T3 product Review preview resolved ${snapshot.renderedFileCount}/${canonicalFileCount} canonical workspace files.`;
  return undefined;
}

export function isStrictReviewReady(
  snapshot: ReviewReadinessSnapshot,
  canonicalPaths: ReadonlyArray<string>,
  expectedExpandedPaths: ReadonlyArray<string> | undefined,
): boolean {
  const sorted = (values: ReadonlyArray<string>) => [...values].toSorted();
  return (
    snapshot.dataState === "ready" &&
    !snapshot.truncated &&
    snapshot.renderedFileCount === canonicalPaths.length &&
    JSON.stringify(sorted(snapshot.headerPaths)) === JSON.stringify(sorted(canonicalPaths)) &&
    (expectedExpandedPaths === undefined ||
      (JSON.stringify(sorted(snapshot.expandedPaths)) ===
        JSON.stringify(sorted(expectedExpandedPaths)) &&
        snapshot.paintedBodyCount === expectedExpandedPaths.length)) &&
    !snapshot.loading
  );
}

export function isVirtualizedReviewViewportReady(
  snapshot: ReviewReadinessSnapshot,
  canonicalPaths: ReadonlyArray<string>,
  expectedExpandedPaths: ReadonlyArray<string> | undefined,
): boolean {
  const unique = (values: ReadonlyArray<string>) => [...new Set(values)].toSorted();
  const canonical = new Set(canonicalPaths);
  const mountedHeaders = unique(snapshot.headerPaths);
  const mountedExpanded = unique(snapshot.expandedPaths);
  const expected = expectedExpandedPaths === undefined ? undefined : new Set(expectedExpandedPaths);
  const expectedMounted =
    expected === undefined ? undefined : mountedHeaders.filter((path) => expected.has(path));
  return (
    snapshot.dataState === "ready" &&
    !snapshot.truncated &&
    snapshot.renderedFileCount === canonicalPaths.length &&
    mountedHeaders.length > 0 &&
    mountedHeaders.every((path) => canonical.has(path)) &&
    (expectedMounted === undefined ||
      (JSON.stringify(mountedExpanded) === JSON.stringify(expectedMounted) &&
        snapshot.paintedBodyCount === expectedMounted.length)) &&
    (expectedMounted !== undefined || snapshot.paintedBodyCount > 0) &&
    !snapshot.loading
  );
}

function fixtureBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function waitForCanonicalReviewModel(
  page: PlaywrightPage,
  canonicalFileCount: number,
  ownerSessionId?: string,
  observationId?: string,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<number> {
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${timeoutMs};
      const frame = (at) => {
        const observation = globalThis.__t3ReadinessObservations?.get(${JSON.stringify(observationId)});
        if (observation?.cancelled) return reject(new Error('T3 Review model observation was cancelled.'));
        const trace = globalThis.__t3WorkspacePanelTrace;
        if (trace?.active && (trace.trustedInputAt === undefined || at < trace.trustedInputAt)) {
          requestAnimationFrame(frame);
          return;
        }
        const panel = document.querySelector('[data-right-panel-surface-kind="diff"][data-right-panel-data-state]');
        if (panel instanceof HTMLElement) {
          const snapshot = {
            dataState: panel.getAttribute('data-right-panel-data-state'),
            renderedFileCount: Number(panel.getAttribute('data-right-panel-file-count')),
            truncated: panel.getAttribute('data-right-panel-truncated') === 'true',
            ownerThreadKey: panel.closest('[data-right-panel-surface-content]')?.getAttribute('data-right-panel-owner-thread-key') ?? null,
          };
          const ownerReady = ${ownerSessionId === undefined ? "true" : `snapshot.ownerThreadKey !== null && snapshot.ownerThreadKey.endsWith(${JSON.stringify(`:${ownerSessionId}`)})`};
          const failure = (${canonicalReviewModelFailure.toString()})(snapshot, ${canonicalFileCount}, ${JSON.stringify(ownerSessionId)});
          if (failure) return reject(new Error(failure));
          if (ownerReady && snapshot.dataState === 'ready') return resolve(performance.now());
          if (ownerReady && snapshot.dataState === 'error') return reject(new Error('T3 product Review preview failed to resolve the canonical workspace fixture.'));
        }
        if (performance.now() >= deadline) return reject(new Error('T3 product Review preview did not resolve the canonical workspace fixture.'));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

async function waitForPanelContent(
  page: PlaywrightPage,
  profile: Exclude<PanelProfile, "closed">,
  fixture: WorkspaceFixtureEvidence,
  options: {
    readonly strictReview?: boolean;
    readonly expandedReviewFileCount?: number;
    readonly ownerSessionId?: string;
    readonly observationId?: string;
  } = {},
): Promise<number> {
  if (profile === "files") {
    if (fixture.fileCount <= 0)
      throw new Error("T3 Files readiness requires attested fixture files.");
    return waitForStableElement(
      page,
      "[data-file-browser-panel]",
      `
        const roots = [element];
        for (let index = 0; index < roots.length; index += 1) {
          for (const child of roots[index].querySelectorAll('*')) if (child.shadowRoot) roots.push(child.shadowRoot);
        }
        const tree = roots.some((root) => root.querySelector('[role="tree"]'));
        const owner = element.closest('[data-right-panel-surface-content]')?.getAttribute('data-right-panel-owner-thread-key');
        const ownerReady = ${options.ownerSessionId === undefined ? "true" : `owner !== null && owner.endsWith(${JSON.stringify(`:${options.ownerSessionId}`)})`};
        return ownerReady && element.getAttribute('data-right-panel-data-state') === 'ready' && Number(element.getAttribute('data-right-panel-file-count')) === ${fixture.fileCount} && tree && !element.querySelector('[data-slot="skeleton"]') && !element.querySelector('[aria-label="Loading"]');
      `,
      READINESS_TIMEOUT_MS,
      options.observationId,
    );
  }
  if (fixture.diffCount <= 0)
    throw new Error("T3 Diff readiness requires attested modified fixture files.");
  if (options.strictReview) {
    if (fixture.diffCount !== 24 || fixture.diffPaths.length !== 24)
      throw new Error("T3 strict Review readiness requires all 24 canonical Review files.");
    const expandedCount = options.expandedReviewFileCount;
    if (
      expandedCount !== undefined &&
      (!Number.isSafeInteger(expandedCount) ||
        expandedCount < 0 ||
        expandedCount > fixture.diffPaths.length)
    )
      throw new Error("T3 strict Review readiness requires an exact expanded-file count.");
    const canonicalPaths = fixture.diffPaths.toSorted();
    const expandedPaths =
      expandedCount === undefined
        ? undefined
        : canonicalReviewExpansionPaths(canonicalPaths, expandedCount);
    const readinessDeadline = NodePerfHooks.performance.now() + READINESS_TIMEOUT_MS;
    await waitForCanonicalReviewModel(
      page,
      canonicalPaths.length,
      options.ownerSessionId,
      options.observationId,
      READINESS_TIMEOUT_MS,
    );
    const viewportTimeout = remainingReadinessTimeout(
      readinessDeadline,
      NodePerfHooks.performance.now(),
    );
    if (viewportTimeout <= 0)
      throw new Error(
        "T3 strict Review readiness exhausted its shared deadline before viewport paint.",
      );
    return waitForStableElement(
      page,
      '[data-right-panel-surface-kind="diff"][data-right-panel-data-state]',
      `
        const roots = [element];
        for (let index = 0; index < roots.length; index += 1) {
          for (const child of roots[index].querySelectorAll('*')) if (child.shadowRoot) roots.push(child.shadowRoot);
        }
        const headerPaths = roots.flatMap((root) => Array.from(root.querySelectorAll('[data-diffs-header] [data-title]')).map((node) => node.textContent?.trim() ?? '').filter(Boolean));
        const expandedPaths = roots.flatMap((root) => Array.from(root.querySelectorAll('button[aria-expanded="true"][aria-label^="Collapse "]')).map((node) => node.getAttribute('aria-label')?.slice('Collapse '.length) ?? '').filter(Boolean));
        const snapshot = {
          dataState: element.getAttribute('data-right-panel-data-state'),
          renderedFileCount: Number(element.getAttribute('data-right-panel-file-count')),
          truncated: element.getAttribute('data-right-panel-truncated') === 'true',
          headerPaths,
          expandedPaths,
          paintedBodyCount: roots.reduce((count, root) => count + root.querySelectorAll('[data-diff]').length, 0),
          loading: roots.some((root) => Boolean(root.querySelector('[data-slot="skeleton"],[aria-label="Loading"]'))) || roots.some((root) => (root.textContent ?? '').includes('Loading ')),
        };
        const owner = element.closest('[data-right-panel-surface-content]')?.getAttribute('data-right-panel-owner-thread-key');
        const ownerReady = ${options.ownerSessionId === undefined ? "true" : `owner !== null && owner.endsWith(${JSON.stringify(`:${options.ownerSessionId}`)})`};
        const ready = ${isVirtualizedReviewViewportReady.toString()};
        return ownerReady && ready(snapshot, ${JSON.stringify(canonicalPaths)}, ${JSON.stringify(expandedPaths)});
      `,
      viewportTimeout,
      options.observationId,
    );
  }
  return waitForStableElement(
    page,
    '[data-right-panel-surface-kind="diff"][data-right-panel-data-state]',
    `
      const collapse = element.querySelector('button[aria-label="Collapse all files"],button[aria-label="Expand all files"]');
      const roots = [element];
      for (let index = 0; index < roots.length; index += 1) {
        for (const child of roots[index].querySelectorAll('*')) if (child.shadowRoot) roots.push(child.shadowRoot);
      }
      const fileHeaders = roots.reduce((count, root) => count + root.querySelectorAll('[data-diffs-header]').length, 0);
      const text = roots.map((root) => root.textContent ?? '').join(' ');
      const renderedFileCount = Number(element.getAttribute('data-right-panel-file-count'));
      const truncated = element.getAttribute('data-right-panel-truncated') === 'true';
      const canonicalCount = ${fixture.diffCount};
      const countMatchesCanonicalSurface = renderedFileCount === canonicalCount || (truncated && renderedFileCount > 0 && renderedFileCount < canonicalCount);
      const owner = element.closest('[data-right-panel-surface-content]')?.getAttribute('data-right-panel-owner-thread-key');
      const ownerReady = ${options.ownerSessionId === undefined ? "true" : `owner !== null && owner.endsWith(${JSON.stringify(`:${options.ownerSessionId}`)})`};
      return ownerReady && element.getAttribute('data-right-panel-data-state') === 'ready' && countMatchesCanonicalSurface && collapse instanceof HTMLElement && fileHeaders > 0 && !element.querySelector('[data-slot="skeleton"]') && !text.includes('Loading ');
    `,
    READINESS_TIMEOUT_MS,
    options.observationId,
  );
}

async function observePanelReady(
  page: PlaywrightPage,
  target: ReadinessTarget,
  profile: Exclude<PanelProfile, "closed">,
  fixture: WorkspaceFixtureEvidence,
  expandedReviewFileCount?: number,
  observationId?: string,
): Promise<number> {
  const owner = waitForStableElement(
    page,
    "[data-right-panel-surface-content]",
    `
      const owner = element.getAttribute('data-right-panel-owner-thread-key');
      return owner !== null && owner.endsWith(${JSON.stringify(`:${target.sessionId}`)});
    `,
    READINESS_TIMEOUT_MS,
    observationId,
  );
  const shell = waitForStableElement(
    page,
    "[data-right-panel-tabbar]",
    "return true;",
    READINESS_TIMEOUT_MS,
    observationId,
  );
  const content = waitForPanelContent(page, profile, fixture, {
    ...(profile === "diff" && expandedReviewFileCount !== undefined
      ? { strictReview: true, expandedReviewFileCount }
      : {}),
    ownerSessionId: target.sessionId,
    ...(observationId === undefined ? {} : { observationId }),
  });
  return Math.max(...(await Promise.all([owner, shell, content])));
}

async function waitForOpenFile(
  page: PlaywrightPage,
  relativePath: string,
  observationId?: string,
): Promise<number> {
  return waitForStableElement(
    page,
    "[data-file-preview-path]",
    `
      return element.getAttribute('data-file-preview-path') === ${JSON.stringify(relativePath)} && element.getAttribute('data-file-preview-data-state') === 'ready' && element.getAttribute('data-file-preview-render-state') === 'painted' && Boolean(element.getAttribute('data-file-preview-content-revision'));
    `,
    READINESS_TIMEOUT_MS,
    observationId,
  );
}

export async function assertFileSurfaceCold(
  page: PlaywrightPage,
  relativePath: string,
): Promise<void> {
  const surfaceId = `file:${relativePath}`;
  const [tabCount, previewCount] = await Promise.all([
    page
      .locator(
        `[data-right-panel-tab-list] [data-right-panel-surface-id=${JSON.stringify(surfaceId)}]`,
      )
      .count(),
    page.locator(`[data-file-preview-path=${JSON.stringify(relativePath)}]`).count(),
  ]);
  if (tabCount !== 0 || previewCount !== 0)
    throw new Error(
      `T3 open-file setup mounted its target surface before measured pointerdown: ${relativePath}.`,
    );
}

async function waitForProjectFilePrefetch(
  page: PlaywrightPage,
  relativePath: string,
): Promise<void> {
  await page
    .locator(
      `[data-file-browser-panel][data-project-file-prefetch-ready=${JSON.stringify(relativePath)}]`,
    )
    .filter({ visible: true })
    .waitFor({ state: "visible", timeout: READINESS_TIMEOUT_MS });
}

async function prepareDataWarmSurfaceColdFile(
  page: PlaywrightPage,
  row: PlaywrightLocator,
  relativePath: string,
): Promise<void> {
  await assertFileSurfaceCold(page, relativePath);
  const observationId = NodeCrypto.randomUUID();
  const surfaceId = `file:${relativePath}`;
  const selectors = [
    `[data-right-panel-tab-list] [data-right-panel-surface-id=${JSON.stringify(surfaceId)}]`,
    `[data-file-preview-path=${JSON.stringify(relativePath)}]`,
  ];
  await page.evaluate<void>(`
    (() => {
      const selectors = ${JSON.stringify(selectors)};
      const matches = (node) => node instanceof Element && selectors.some((selector) => node.matches(selector) || node.querySelector(selector));
      const observation = {
        mounted: selectors.some((selector) => document.querySelector(selector) !== null),
        observer: null,
      };
      observation.observer = new MutationObserver((records) => {
        if (observation.mounted) return;
        observation.mounted = records.some((record) =>
          matches(record.target) || Array.from(record.addedNodes).some(matches)
        );
      });
      observation.observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      globalThis.__t3FileSurfaceColdObservations ??= new Map();
      globalThis.__t3FileSurfaceColdObservations.set(${JSON.stringify(observationId)}, observation);
    })()
  `);
  let mounted = false;
  try {
    if (!row.hover) throw new Error("T3 open-file cannot hover its canonical target row.");
    await dismissVisibleToasts(page);
    await row.hover();
    await waitForProjectFilePrefetch(page, relativePath);
  } finally {
    mounted = await page.evaluate<boolean>(`
      (() => {
        const observations = globalThis.__t3FileSurfaceColdObservations;
        const observation = observations?.get(${JSON.stringify(observationId)});
        observation?.observer?.disconnect();
        observations?.delete(${JSON.stringify(observationId)});
        return observation?.mounted ?? true;
      })()
    `);
  }
  await assertFileSurfaceCold(page, relativePath);
  if (mounted)
    throw new Error(
      `T3 open-file setup mounted its target surface while warming data: ${relativePath}.`,
    );
}

async function clickUniqueVisible(
  page: PlaywrightPage,
  selector: string,
  label: string,
): Promise<void> {
  const matches = page.locator(selector).filter({ visible: true });
  const count = await matches.count();
  if (count !== 1) throw new Error(`T3 expected one visible ${label}; found ${count}.`);
  await matches.first().click();
}

async function abortRendererTrace(page: PlaywrightPage, recording: TraceRecording): Promise<void> {
  await page
    .evaluate<void>(
      `
      (() => {
        const trace = globalThis.__t3WorkspacePanelTrace;
        if (!trace) return;
        trace.active = false;
        document.removeEventListener(trace.trustedInputEvent ?? "click", trace.input, true);
        trace.observer?.disconnect();
        trace.dataObserver?.disconnect();
        delete globalThis.__t3WorkspacePanelTrace;
      })()
    `,
    )
    .catch(() => undefined);
  await recording.cdp.detach().catch(() => undefined);
}

async function measureTrustedRendererAction(
  application: PlaywrightElectronApplication,
  page: PlaywrightPage,
  action: () => Promise<void>,
  trustedInputEvent: "click" | "pointerdown" = "click",
): Promise<{
  readonly clock: MonotonicClock;
  readonly rendererTrace: RendererTrace;
}> {
  const recording = await beginRendererTrace(application, page, trustedInputEvent);
  try {
    await action();
    await completeRendererTrace(page);
    const rendererTrace = await endRendererTrace(page, recording);
    return { clock: rendererClock(rendererTrace), rendererTrace };
  } catch (error) {
    await abortRendererTrace(page, recording);
    throw error;
  }
}

interface SeededPanelState {
  readonly isOpen: boolean;
  readonly activeSurfaceId: string | null;
  readonly surfaces: ReadonlyArray<Record<string, unknown>>;
}

function seededPanelState(profile: PanelProfile): SeededPanelState {
  switch (profile) {
    case "closed":
      return { isOpen: false, activeSurfaceId: null, surfaces: [] };
    case "files":
      return {
        isOpen: true,
        activeSurfaceId: "files",
        surfaces: [{ id: "files", kind: "files" }],
      };
    case "diff":
      return {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      };
  }
}

function retainedFileSurfaces(
  fixture: WorkspaceFixtureEvidence,
  count: number,
): ReadonlyArray<Record<string, unknown>> {
  if (count > fixture.filePaths.length)
    throw new Error(
      `T3 panel load requires ${count} retained file tabs but the fixture attests ${fixture.filePaths.length}.`,
    );
  return fixture.filePaths.slice(0, count).map((path) => ({
    id: `file:${path}`,
    kind: "file",
    relativePath: path,
    revealLine: null,
    revealRequestId: 1,
  }));
}

function loadedPanelState(
  fixture: WorkspaceFixtureEvidence,
  load: PanelLoadProfile,
  activeSurfaceId: "files" | "diff" | `file:${string}`,
  isOpen = true,
): SeededPanelState {
  if (load.expandedDirectoryCount > fixture.directoryPaths.length)
    throw new Error(
      `T3 panel load requires ${load.expandedDirectoryCount} directories but the fixture attests ${fixture.directoryPaths.length}.`,
    );
  if (load.expandedReviewFileCount > fixture.diffCount)
    throw new Error(`T3 panel load ${load.id} exceeds its attested Review fixture.`);
  const surfaces = [
    { id: "files", kind: "files" },
    { id: "diff", kind: "diff" },
    ...retainedFileSurfaces(fixture, load.retainedFileTabCount),
  ];
  if (!surfaces.some((surface) => surface.id === activeSurfaceId))
    throw new Error(`T3 panel load cannot activate missing surface ${activeSurfaceId}.`);
  return { isOpen, activeSurfaceId, surfaces };
}

async function seedRightPanelStates(
  page: PlaywrightPage,
  states: ReadonlyArray<{
    readonly target: ReadinessTarget;
    readonly state: SeededPanelState;
  }>,
): Promise<void> {
  const environmentId = await page.evaluate<string>(`
    (() => {
      const [environmentId] = location.hash.replace(/^#\\/?/, "").split("/");
      if (!environmentId) throw new Error("T3 benchmark route has no environment id.");
      return decodeURIComponent(environmentId);
    })()
  `);
  const serialized = JSON.stringify(
    Object.fromEntries(
      states.map(({ target, state }) => [`${environmentId}:${target.sessionId}`, state]),
    ),
  );
  await page.evaluate<void>(`
    (() => {
      const key = "t3code:right-panel-state:v2";
      const previous = JSON.parse(localStorage.getItem(key) ?? '{"state":{"byThreadKey":{}},"version":11}');
      const previousByThread = previous?.state?.byThreadKey;
      if (previousByThread !== undefined && (previousByThread === null || typeof previousByThread !== "object" || Array.isArray(previousByThread))) {
        throw new Error("T3 persisted right-panel state has an invalid byThreadKey map.");
      }
      localStorage.setItem(key, JSON.stringify({
        state: { byThreadKey: { ...(previousByThread ?? {}), ...${serialized} } },
        version: 11,
      }));
    })()
  `);
}

async function reloadSeededApplication(
  page: PlaywrightPage,
  expectedSessionCount: number,
  target: ReadinessTarget,
): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSessionList(page);
  await ensureWorkItemsRendered(page, expectedSessionCount);
  await activateWorkItem(page, target, 6);
  await dismissVisibleToasts(page);
}

/**
 * Launch notifications (for example the provider-update advisory) float over the
 * panel column and intercept pointer input aimed at the file tree. A user
 * dismisses them before working; untimed setup does the same through the
 * toast's own close control, never by hiding the surface.
 */
async function dismissVisibleToasts(page: PlaywrightPage): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const closeButtons = page.locator('button[data-slot="toast-close"]').filter({ visible: true });
    if ((await closeButtons.count()) === 0) return;
    await closeButtons.first().click();
    await page.evaluate<void>(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  }
}

async function clickPanelToggle(page: PlaywrightPage): Promise<void> {
  await clickUniqueVisible(page, 'button[aria-label^="Toggle right panel"]', "right-panel toggle");
}

async function ensurePanelClosed(page: PlaywrightPage): Promise<void> {
  const open = await page.evaluate<boolean>(
    'document.querySelector("[data-right-panel-tabbar]") !== null',
  );
  if (open) await clickPanelToggle(page);
  await waitForPanelClosed(page);
}

async function clickSurfaceTab(page: PlaywrightPage, title: string): Promise<void> {
  const matches = page.locator("[data-right-panel-tab-list] button").filter({
    hasText: new RegExp(`^${escapeRegularExpression(title)}$`, "u"),
    visible: true,
  });
  const count = await matches.count();
  if (count !== 1) throw new Error(`T3 expected one visible ${title} surface tab; found ${count}.`);
  await matches.first().click();
}

async function prepareFileTreeRow(
  page: PlaywrightPage,
  relativePath: string,
): Promise<PlaywrightLocator> {
  return prepareFileTreeRowThroughSearch(page, relativePath, fixtureBasename(relativePath), "file");
}

async function prepareFileTreeRowThroughSearch(
  page: PlaywrightPage,
  itemPath: string,
  searchTerm: string,
  kind: "file" | "directory",
): Promise<PlaywrightLocator> {
  const search = page
    .locator('[data-file-browser-panel] input[name="project-files-search"]')
    .filter({ visible: true });
  if ((await search.count()) !== 1)
    throw new Error("T3 Files surface has no unique visible canonical search input.");
  await search.first().fill(searchTerm);
  const rows = page
    .locator(
      `[data-file-browser-panel] [role="treeitem"][data-item-path=${JSON.stringify(itemPath)}]`,
    )
    .filter({ visible: true });
  await rows.first().waitFor({ state: "visible", timeout: READINESS_TIMEOUT_MS });
  if ((await rows.count()) !== 1)
    throw new Error(`T3 fixture ${kind} ${itemPath} did not resolve to one searched tree row.`);
  return rows.first();
}

export async function seedExpandedDirectories(
  page: PlaywrightPage,
  fixture: WorkspaceFixtureEvidence,
  count: number,
): Promise<void> {
  for (const path of fixture.directoryPaths.slice(0, count)) {
    const itemPath = `${path}/`;
    const row = await prepareFileTreeRowThroughSearch(
      page,
      itemPath,
      fixtureBasename(path),
      "directory",
    );
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    await waitForStableElement(
      page,
      "[data-file-browser-panel]",
      `
        const roots = [element];
        for (let index = 0; index < roots.length; index += 1) {
          for (const child of roots[index].querySelectorAll('*')) if (child.shadowRoot) roots.push(child.shadowRoot);
        }
        return roots.some((root) => root.querySelector('[role="treeitem"][data-item-path=${JSON.stringify(itemPath)}][aria-expanded="true"]'));
      `,
    );
  }
  const search = page
    .locator('[data-file-browser-panel] input[name="project-files-search"]')
    .filter({ visible: true });
  if ((await search.count()) !== 1)
    throw new Error("T3 Files surface lost its canonical search input while seeding directories.");
  await search.first().fill("");
}

async function setAllReviewFilesCollapsed(
  page: PlaywrightPage,
  fixture: WorkspaceFixtureEvidence,
): Promise<void> {
  const collapse = page
    .locator('button[aria-label="Collapse all files"]')
    .filter({ visible: true });
  if ((await collapse.count()) === 1) await collapse.first().click();
  await page
    .locator('button[aria-label="Expand all files"]')
    .filter({ visible: true })
    .waitFor({ state: "visible", timeout: READINESS_TIMEOUT_MS });
  await waitForPanelContent(page, "diff", fixture, {
    strictReview: true,
    expandedReviewFileCount: 0,
  });
}

async function setReviewFileExpanded(
  page: PlaywrightPage,
  path: string,
  expanded: boolean,
): Promise<void> {
  const desiredLabel = `${expanded ? "Expand" : "Collapse"} ${path}`;
  await page.evaluate<void>(`
    new Promise((resolve, reject) => {
      const deadline = performance.now() + ${READINESS_TIMEOUT_MS};
      const label = ${JSON.stringify(desiredLabel)};
      let scrollTop = 0;
      const seek = () => {
        const panel = document.querySelector('[data-right-panel-surface-kind="diff"][data-right-panel-data-state]');
        if (!(panel instanceof HTMLElement)) {
          if (performance.now() >= deadline) {
            reject(new Error('T3 canonical Review panel did not become available.'));
            return;
          }
          requestAnimationFrame(seek);
          return;
        }
        const roots = [panel];
        for (let index = 0; index < roots.length; index += 1) {
          for (const child of roots[index].querySelectorAll('*')) if (child.shadowRoot) roots.push(child.shadowRoot);
        }
        const button = roots.flatMap((root) => Array.from(root.querySelectorAll('button')))
          .find((candidate) => candidate.getAttribute('aria-label') === label);
        if (button instanceof HTMLElement) {
          button.scrollIntoView({ block: 'center', inline: 'nearest' });
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const rect = button.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight) {
              resolve();
              return;
            }
            requestAnimationFrame(seek);
          }));
          return;
        }
        const scroller = roots
          .flatMap((root) => Array.from(root.querySelectorAll('.diff-render-surface')))
          .find((candidate) => candidate instanceof HTMLElement);
        if (scroller instanceof HTMLElement) {
          if (scrollTop === 0) scroller.scrollTop = 0;
          const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (scroller.scrollTop >= maximum - 1 && scrollTop > 0) {
            if (performance.now() >= deadline) {
              reject(new Error('T3 Review file is absent from the complete virtualized surface: ' + label));
              return;
            }
          } else {
            scrollTop = Math.min(maximum, scroller.scrollTop + Math.max(32, Math.floor(scroller.clientHeight * 0.75)));
            scroller.scrollTop = scrollTop;
          }
        }
        if (performance.now() >= deadline) {
          if (scroller instanceof HTMLElement) {
            reject(new Error('T3 could not reveal canonical Review file toggle: ' + label));
          } else {
            const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll('button[aria-label]')))
              .map((candidate) => candidate.getAttribute('aria-label'))
              .filter(Boolean);
            reject(new Error('T3 canonical Review controls did not become available for ' + label + ': ' + JSON.stringify(buttons)));
          }
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(seek));
      };
      requestAnimationFrame(seek);
    })
  `);
  const desired = page.locator(`button[aria-label=${JSON.stringify(desiredLabel)}]`);
  if ((await desired.count()) !== 1) throw new Error(`T3 could not seed Review file ${path}.`);
  await desired.first().click();
  await page.evaluate<void>(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function seedReviewLoad(
  page: PlaywrightPage,
  fixture: WorkspaceFixtureEvidence,
  load: PanelLoadProfile,
): Promise<void> {
  await setAllReviewFilesCollapsed(page, fixture);
  if (load.expandedReviewFileCount === fixture.diffPaths.length) {
    await clickUniqueVisible(page, 'button[aria-label="Expand all files"]', "Expand all files");
    await page
      .locator('button[aria-label="Collapse all files"]')
      .filter({ visible: true })
      .waitFor({ state: "visible", timeout: READINESS_TIMEOUT_MS });
  } else {
    for (const path of canonicalReviewExpansionPaths(
      fixture.diffPaths,
      load.expandedReviewFileCount,
    ))
      await setReviewFileExpanded(page, path, true);
  }
  await waitForPanelContent(page, "diff", fixture, {
    strictReview: true,
    expandedReviewFileCount: load.expandedReviewFileCount,
  });
}

async function seedPanelLoad(
  page: PlaywrightPage,
  fixture: WorkspaceFixtureEvidence,
  load: PanelLoadProfile,
): Promise<void> {
  await clickSurfaceTab(page, "Files");
  await waitForPanelContent(page, "files", fixture);
  await seedExpandedDirectories(page, fixture, load.expandedDirectoryCount);
  await clickSurfaceTab(page, "Diff");
  await waitForPanelContent(page, "diff", fixture, {
    strictReview: true,
  });
  await seedReviewLoad(page, fixture, load);
}

async function seedWorkspacePanelInteractionLoad(
  page: PlaywrightPage,
  fixture: WorkspaceFixtureEvidence,
  load: PanelLoadProfile,
): Promise<void> {
  await clickSurfaceTab(page, "Files");
  await waitForPanelContent(page, "files", fixture);
  await seedExpandedDirectories(page, fixture, load.expandedDirectoryCount);
  await clickSurfaceTab(page, "Diff");
  await waitForPanelContent(page, "diff", fixture, { strictReview: true });
}

async function gitOutput(repoRoot: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1_048_576 },
      (error, stdout) => {
        if (error) reject(new Error(`Unable to read T3 source identity: ${error.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

export function parseProcessStartTime(output: string, pid: number): number {
  const startTimeMs = Date.parse(output.trim());
  if (!Number.isFinite(startTimeMs) || startTimeMs < 0)
    throw new Error(`Invalid start time for PID ${pid}.`);
  return Math.floor(startTimeMs / 1_000) * 1_000;
}

async function processStartTimeMs(pid: number): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", maxBuffer: 65_536 },
      (error, stdout) => {
        if (error) reject(new Error(`Unable to read start time for PID ${pid}.`));
        else resolve(stdout);
      },
    );
  });
  return parseProcessStartTime(output, pid);
}

async function waitForOwnedProcessExit(
  process: PlaywrightElectronProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => process.once("exit", () => resolve(true))),
    NodeTimersPromises.setTimeout(timeoutMs, false),
  ]);
}

export async function closeOwnedApplication(
  app: Omit<PlaywrightElectronApplication, "evaluate">,
  process: PlaywrightElectronProcess,
  timeouts = {
    closeMs: 5_000,
    gracefulExitMs: 1_000,
    terminateMs: 5_000,
    killMs: 5_000,
  },
): Promise<boolean> {
  const closeFinished = await Promise.race([
    app.close().then(
      () => true,
      () => false,
    ),
    NodeTimersPromises.setTimeout(timeouts.closeMs, false),
  ]);
  if (closeFinished && (await waitForOwnedProcessExit(process, timeouts.gracefulExitMs)))
    return true;
  process.kill("SIGTERM");
  if (await waitForOwnedProcessExit(process, timeouts.terminateMs)) return true;
  process.kill("SIGKILL");
  return waitForOwnedProcessExit(process, timeouts.killMs);
}

export async function shutdownAfterLaunchFailure(
  shutdown: () => Promise<unknown>,
  launchError: unknown,
): Promise<never> {
  try {
    await shutdown();
  } catch (shutdownError) {
    if (launchError instanceof Error) {
      Object.defineProperty(launchError, "cleanupError", {
        configurable: true,
        value: shutdownError,
      });
      throw launchError;
    }
    throw new Error(String(launchError), { cause: shutdownError });
  }
  throw launchError;
}

async function sha256Files(root: string, files: ReadonlyArray<string>): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(NodePath.relative(root, file));
    hash.update("\0");
    hash.update(await NodeFSP.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function runtimeBuildFiles(...directories: ReadonlyArray<string>): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const target = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && !entry.name.endsWith(".map") && !entry.name.endsWith(".d.cts"))
        files.push(target);
    }
  };
  for (const directory of directories) await visit(directory);
  return files.sort();
}

export async function resolveConfiguredT3BenchmarkExecutable(
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured === undefined) return undefined;
  const trimmed = configured.trim();
  if (trimmed.length === 0)
    throw new Error("T3_BENCHMARK_EXECUTABLE is set but does not contain a path.");
  const executable = NodePath.resolve(trimmed);
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.stat(executable);
    await NodeFSP.access(executable, NodeFS.constants.X_OK);
  } catch (cause) {
    throw new Error(`T3 benchmark executable is not executable at ${executable}.`, { cause });
  }
  if (!stat.isFile()) throw new Error(`T3 benchmark executable is not a file at ${executable}.`);
  return executable;
}

export function packagedT3ApplicationAsar(executable: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return platform === "darwin"
    ? path.resolve(path.dirname(executable), "../Resources/app.asar")
    : path.resolve(path.dirname(executable), "resources/app.asar");
}

export function packagedT3BuildDigestFiles(
  executable: string,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  return platform === "darwin"
    ? [executable, packagedT3ApplicationAsar(executable, platform)]
    : [executable];
}

export function assertPackagedT3PackageRevision(
  packageJson: string,
  sourceCommit: string,
  appAsarPath: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch (cause) {
    throw new Error(`T3 packaged metadata is invalid in ${appAsarPath}.`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`T3 packaged metadata is invalid in ${appAsarPath}.`);
  if (!Object.hasOwn(parsed, "t3codeCommitHash")) return;
  const packagedCommit = (parsed as { readonly t3codeCommitHash?: unknown }).t3codeCommitHash;
  if (typeof packagedCommit !== "string" || !SOURCE_COMMIT.test(packagedCommit))
    throw new Error(`T3 packaged t3codeCommitHash is invalid in ${appAsarPath}.`);
  if (packagedCommit !== sourceCommit)
    throw new Error(
      `T3 packaged revision ${packagedCommit} does not match source HEAD ${sourceCommit} in ${appAsarPath}.`,
    );
}

export function assertPackagedT3Revision(appAsarPath: string, sourceCommit: string): void {
  let packageJson: Buffer;
  try {
    packageJson = extractFile(appAsarPath, "package.json");
  } catch (cause) {
    throw new Error(`Unable to inspect T3 packaged metadata in ${appAsarPath}.`, { cause });
  }
  assertPackagedT3PackageRevision(packageJson.toString("utf8"), sourceCommit, appAsarPath);
}

async function sha256FileContents(files: ReadonlyArray<string>): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  }
  return hash.digest("hex");
}

async function makeDefaultDependencies(): Promise<T3DriverDependencies> {
  const sourcePath = NodeURL.fileURLToPath(import.meta.url);
  const repoRoot = NodePath.resolve(NodePath.dirname(sourcePath), "../../../..");
  const materializerPath = NodePath.join(NodePath.dirname(sourcePath), "t3-public-materializer.ts");
  const desktopEntry = NodePath.join(repoRoot, "apps/desktop/dist-electron/main.cjs");
  const packagedExecutable = await resolveConfiguredT3BenchmarkExecutable(
    NODE_PROCESS.env.T3_BENCHMARK_EXECUTABLE,
  );
  const desktopPackage = JSON.parse(
    await NodeFSP.readFile(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof desktopPackage.version !== "string" || desktopPackage.version.length === 0)
    throw new Error("T3 desktop version is missing.");
  const sourceCommit = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  if (!SOURCE_COMMIT.test(sourceCommit)) throw new Error("T3 source revision is invalid.");
  const driverDigestSha256 = await sha256Files(repoRoot, [sourcePath, materializerPath]);
  const buildDigestSha256 = await (async () => {
    if (packagedExecutable) {
      const appAsarPath = packagedT3ApplicationAsar(packagedExecutable, NODE_PROCESS.platform);
      try {
        await NodeFSP.access(appAsarPath, NodeFS.constants.R_OK);
      } catch (cause) {
        throw new Error(`T3 packaged app.asar is missing or unreadable at ${appAsarPath}.`, {
          cause,
        });
      }
      assertPackagedT3Revision(appAsarPath, sourceCommit);
      return sha256FileContents(
        packagedT3BuildDigestFiles(packagedExecutable, NODE_PROCESS.platform),
      );
    }
    await NodeFSP.access(desktopEntry);
    return sha256Files(
      repoRoot,
      await runtimeBuildFiles(
        NodePath.dirname(desktopEntry),
        NodePath.join(repoRoot, "apps/web/dist"),
      ),
    );
  })();
  if (!SHA256.test(driverDigestSha256) || !SHA256.test(buildDigestSha256))
    throw new Error("T3 digest generation failed.");

  let readinessTargets: ReadonlyMap<string, ReadinessTarget> = new Map();
  let workspaceFixture: WorkspaceFixtureEvidence | undefined;
  const workspaceFixtureSeals = new Map<string, T3WorkspaceFixtureSeal>();
  let application: PlaywrightElectronApplication | undefined;
  let page: PlaywrightPage | undefined;
  let processIdentity: OwnedProcess | undefined;
  let activeAttemptHome: string | undefined;
  let preserveActiveAttempt = false;
  let attemptSequence = 0;

  const shutdown = async () => {
    const app = application;
    const identity = processIdentity;
    const attemptHome = activeAttemptHome;
    const preserveAttempt = preserveActiveAttempt;
    application = undefined;
    page = undefined;
    processIdentity = undefined;
    activeAttemptHome = undefined;
    preserveActiveAttempt = false;
    if (!app) {
      if (attemptHome && !preserveAttempt)
        await NodeFSP.rm(attemptHome, { recursive: true, force: true });
      return { terminated: [], survivors: [] };
    }
    const closed = await closeOwnedApplication(app, app.process());
    if (closed && attemptHome && !preserveAttempt)
      await NodeFSP.rm(attemptHome, { recursive: true, force: true });
    if (!identity) {
      if (!closed)
        throw new Error("T3 could not close an application that failed during readiness.");
      return { terminated: [], survivors: [] };
    }
    return closed
      ? { terminated: [identity], survivors: [] }
      : { terminated: [], survivors: [identity] };
  };

  const launch = async (stateHandle: string, initialSessionId: string): Promise<ActiveLaunch> => {
    if (application) throw new Error("T3 application is already running.");
    const target = readinessTargets.get(initialSessionId);
    if (!target) throw new Error(`T3 has no readiness target for ${initialSessionId}.`);
    const attemptHome = NodePath.join(
      NodePath.dirname(stateHandle),
      "attempts",
      String(attemptSequence++),
    );
    await NodeFSP.mkdir(NodePath.dirname(attemptHome), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFSP.cp(stateHandle, attemptHome, {
      recursive: true,
      errorOnExist: true,
      mode: NodeFS.constants.COPYFILE_FICLONE,
    });
    const sourceFixtureSeal = workspaceFixtureSeals.get(stateHandle);
    const rebasedFixtureSeal = await rebaseT3BenchmarkWorkspaces({
      dbPath: NodePath.join(attemptHome, "userdata", "state.sqlite"),
      sourceStateRoot: stateHandle,
      targetStateRoot: attemptHome,
      ...(sourceFixtureSeal ? { workspaceFixtureSeal: sourceFixtureSeal } : {}),
    });
    if (rebasedFixtureSeal) workspaceFixtureSeals.set(attemptHome, rebasedFixtureSeal);
    activeAttemptHome = attemptHome;
    const electronProfile = NodePath.join(attemptHome, "electron-profile");
    const ambientHome = NodePath.join(attemptHome, "ambient");
    await Promise.all([
      NodeFSP.mkdir(electronProfile, { recursive: true, mode: 0o700 }),
      NodeFSP.mkdir(ambientHome, { recursive: true, mode: 0o700 }),
    ]);
    const command = packagedExecutable
      ? resolveT3BenchmarkLaunchCommand({
          mode: "packaged",
          platform: NODE_PROCESS.platform,
          executablePath: packagedExecutable,
          electronProfile,
        })
      : resolveT3BenchmarkLaunchCommand({
          mode: "loose",
          platform: NODE_PROCESS.platform,
          desktopEntry,
          electronProfile,
          resolveLooseCommand: (
            (await import(
              NodeURL.pathToFileURL(
                NodePath.join(repoRoot, "apps/desktop/scripts/electron-launcher.mjs"),
              ).href
            )) as {
              readonly resolveElectronLaunchCommand: (args: ReadonlyArray<string>) => {
                readonly electronPath: string;
                readonly args: ReadonlyArray<string>;
              };
            }
          ).resolveElectronLaunchCommand,
        });
    const start = NodePerfHooks.performance.now();
    const app = (await _electron
      .launch({
        executablePath: command.executablePath,
        args: [...command.args],
        env: t3BenchmarkLaunchEnvironment({
          baseEnv: Object.fromEntries(
            Object.entries(NODE_PROCESS.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          ambientHome,
          stateHome: attemptHome,
        }),
      })
      .catch(async (error) => {
        activeAttemptHome = undefined;
        await NodeFSP.rm(attemptHome, { recursive: true, force: true });
        throw error;
      })) as unknown as PlaywrightElectronApplication;
    application = app;
    try {
      const window = await app.firstWindow();
      await maximizeAgentAppBenchmarkWindow(app, window);
      await window.waitForLoadState("domcontentloaded");
      await waitForSessionList(window);
      await window.bringToFront();
      await ensureWorkItemsRendered(window, readinessTargets.size);
      await activateWorkItem(window, target, 6);
      const end = NodePerfHooks.performance.now();
      const electronProcess = app.process();
      if (electronProcess.pid === undefined) throw new Error("T3 Electron root PID is missing.");
      processIdentity = {
        pid: electronProcess.pid,
        startTimeMs: await processStartTimeMs(electronProcess.pid),
        owner: "application",
        category: "electron-main",
        role: "main",
      };
      page = window;
      return {
        processes: [processIdentity],
        readiness: readinessReceipt(end),
        clock: {
          kind: "single-monotonic-clock",
          clock: "node-perf-hooks",
          start,
          end,
        },
      };
    } catch (error) {
      return shutdownAfterLaunchFailure(shutdown, error);
    }
  };

  const requirePanelRuntime = () => {
    if (!application || !page) throw new Error("T3 renderer is not running.");
    if (!workspaceFixture)
      throw new Error("T3 workspace-panel scenarios require an attested workspace fixture.");
    return { application, page, workspaceFixture };
  };

  const reloadWithState = async (
    target: ReadinessTarget,
    state: SeededPanelState,
  ): Promise<ReturnType<typeof requirePanelRuntime>> => {
    const runtime = requirePanelRuntime();
    await seedRightPanelStates(runtime.page, [{ target, state }]);
    await reloadSeededApplication(runtime.page, readinessTargets.size, target);
    return runtime;
  };

  const executeWorkspacePanelV2Action = async (
    benchmarkCase: WorkspacePanelV2Case,
    target: ReadinessTarget,
    load: PanelLoadProfile,
  ): Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace: RendererTrace;
  }> => {
    const fixture = requirePanelRuntime().workspaceFixture;
    const firstFile = fixture.filePaths[0];
    if (!firstFile) throw new Error("T3 workspace-panel-v2 requires canonical file tabs.");
    const activeFileId = `file:${firstFile}` as const;
    const initialActive =
      benchmarkCase.action === "review-to-files" ||
      benchmarkCase.action === "expand-all" ||
      benchmarkCase.action === "collapse-all"
        ? "diff"
        : benchmarkCase.action === "switch-file-tab"
          ? activeFileId
          : "files";
    const runtime = await reloadWithState(target, loadedPanelState(fixture, load, initialActive));
    const { application: app, page: window } = runtime;
    const measureV2Action = (action: () => Promise<void>) =>
      measureTrustedRendererAction(app, window, action, "pointerdown");
    await seedWorkspacePanelInteractionLoad(window, fixture, load);
    if (benchmarkCase.action === "expand-all") await setAllReviewFilesCollapsed(window, fixture);

    if (benchmarkCase.action === "open-panel") {
      await clickSurfaceTab(window, "Files");
      await waitForPanelContent(window, "files", fixture);
      await seedExpandedDirectories(window, fixture, load.expandedDirectoryCount);
      await clickPanelToggle(window);
      await waitForPanelClosed(window);
      return measureV2Action(async () => {
        const transitionMode = await panelTransitionMode(window);
        const [animationAt, aboveFoldPaintedAt] = await runRendererObservedAction(
          window,
          (observationId) =>
            Promise.all([
              waitForPanelAnimationSettled(window, observationId),
              waitForPanelContent(window, "files", fixture, { observationId }),
            ]),
          () => clickPanelToggle(window),
        );
        const shellAt = await readTraceTimestamp(window, "shellVisibleAt");
        await markRendererMilestones(window, ["shell-visible"], shellAt);
        await markRendererMilestones(
          window,
          ["animation-settled"],
          transitionMode === "none" ? shellAt : animationAt,
        );
        await markRendererMilestones(
          window,
          ["data-ready"],
          await readDataReadyAt(window, "files"),
        );
        await markRendererMilestones(window, ["above-fold-painted"], aboveFoldPaintedAt);
        await markRendererMilestones(
          window,
          ["interactive"],
          Math.max(transitionMode === "none" ? shellAt : animationAt, aboveFoldPaintedAt),
        );
      });
    }
    if (benchmarkCase.action === "close-panel") {
      await clickSurfaceTab(window, "Files");
      await waitForPanelContent(window, "files", fixture);
      await seedExpandedDirectories(window, fixture, load.expandedDirectoryCount);
      return measureV2Action(async () => {
        const actionPaintedAt = await runRendererObservedAction(
          window,
          (observationId) => waitForPanelClosed(window, observationId),
          () => clickPanelToggle(window),
        );
        await markRendererMilestones(window, ["action-painted", "interactive"], actionPaintedAt);
      });
    }
    if (benchmarkCase.action === "files-to-review") {
      await clickSurfaceTab(window, "Files");
      await waitForPanelContent(window, "files", fixture);
      await seedExpandedDirectories(window, fixture, load.expandedDirectoryCount);
      return measureV2Action(async () => {
        const actionPaintedAt = await runRendererObservedAction(
          window,
          (observationId) =>
            waitForPanelContent(window, "diff", fixture, {
              strictReview: true,
              observationId,
            }),
          () => clickSurfaceTab(window, "Diff"),
        );
        await markRendererMilestones(window, ["action-painted", "interactive"], actionPaintedAt);
      });
    }
    if (benchmarkCase.action === "review-to-files") {
      await clickSurfaceTab(window, "Diff");
      await waitForPanelContent(window, "diff", fixture, {
        strictReview: true,
      });
      return measureV2Action(async () => {
        const actionPaintedAt = await runRendererObservedAction(
          window,
          (observationId) => waitForPanelContent(window, "files", fixture, { observationId }),
          () => clickSurfaceTab(window, "Files"),
        );
        await markRendererMilestones(window, ["action-painted", "interactive"], actionPaintedAt);
      });
    }
    if (benchmarkCase.action === "open-file") {
      await clickSurfaceTab(window, "Files");
      await waitForPanelContent(window, "files", fixture);
      await seedExpandedDirectories(window, fixture, load.expandedDirectoryCount);
      const retainedByAnyProfile = new Set(fixture.filePaths);
      const candidates = fixture.allFilePaths.filter(
        (candidate) => !retainedByAnyProfile.has(candidate),
      );
      const path =
        candidates[PANEL_LOAD_PROFILE_CONTRACT.findIndex((profile) => profile.id === load.id)];
      if (!path)
        throw new Error(`T3 open-file requires a distinct ${load.id} file outside retained tabs.`);
      const row = await prepareFileTreeRow(window, path);
      await prepareDataWarmSurfaceColdFile(window, row, path);
      return measureV2Action(async () => {
        const actionPaintedAt = await runRendererObservedAction(
          window,
          (observationId) => waitForOpenFile(window, path, observationId),
          () => row.click(),
        );
        await markRendererMilestones(window, ["action-painted", "interactive"], actionPaintedAt);
      });
    }
    if (benchmarkCase.action === "switch-file-tab") {
      const paths = fixture.filePaths.slice(0, load.retainedFileTabCount);
      const firstPath = paths[0];
      const destinationPath = paths[1];
      if (!firstPath || !destinationPath || firstPath === destinationPath)
        throw new Error("T3 switch-file-tab requires at least two retained file tabs.");
      for (const path of paths) {
        await clickSurfaceTab(window, fixtureBasename(path));
        await waitForOpenFile(window, path);
      }
      await clickSurfaceTab(window, fixtureBasename(firstPath));
      await waitForOpenFile(window, firstPath);
      return measureV2Action(async () => {
        const actionPaintedAt = await runRendererObservedAction(
          window,
          (observationId) => waitForOpenFile(window, destinationPath, observationId),
          () => clickSurfaceTab(window, fixtureBasename(destinationPath)),
        );
        await markRendererMilestones(window, ["action-painted", "interactive"], actionPaintedAt);
      });
    }

    if (benchmarkCase.action !== "expand-all") {
      await clickSurfaceTab(window, "Diff");
      await waitForPanelContent(window, "diff", fixture, {
        strictReview: true,
      });
    }
    const desiredBefore =
      benchmarkCase.action === "collapse-all" ? "Collapse all files" : "Expand all files";
    return measureV2Action(async () => {
      const actionPaintedAt = await runRendererObservedAction(
        window,
        (observationId) =>
          waitForPanelContent(window, "diff", fixture, {
            strictReview: true,
            expandedReviewFileCount:
              benchmarkCase.action === "expand-all" ? fixture.diffPaths.length : 0,
            observationId,
          }),
        () =>
          clickUniqueVisible(
            window,
            `button[aria-label=${JSON.stringify(desiredBefore)}]`,
            desiredBefore,
          ),
      );
      await markRendererMilestones(window, ["action-painted", "interactive"], actionPaintedAt);
    });
  };

  const executeWorkspacePanelAction = async (
    benchmarkCase: WorkspacePanelCase | WorkspacePanelV2Case,
    target: ReadinessTarget,
    loadProfile?: PanelLoadProfile,
  ): Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace: RendererTrace;
  }> => {
    if ("loadProfile" in benchmarkCase) {
      if (!loadProfile)
        throw new Error("T3 workspace-panel-v2 action has no resolved panel load profile.");
      return executeWorkspacePanelV2Action(benchmarkCase, target, loadProfile);
    }
    const action = benchmarkCase.action;
    const filesOpen = seededPanelState("files");
    const filesClosed = { ...filesOpen, isOpen: false };
    const diffOpen = seededPanelState("diff");
    const fixtureBeforeReload = requirePanelRuntime().workspaceFixture;
    const fileTabSurfaces = fixtureBeforeReload.filePaths.slice(0, 2).map((path) => ({
      id: `file:${path}`,
      kind: "file",
      relativePath: path,
      revealLine: null,
      revealRequestId: 1,
    }));
    const firstFileTab = fileTabSurfaces[0];
    const fileTabsOpen: SeededPanelState = {
      isOpen: true,
      activeSurfaceId: firstFileTab?.id ?? null,
      surfaces: fileTabSurfaces,
    };
    const bothFilesActive: SeededPanelState = {
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [
        { id: "files", kind: "files" },
        { id: "diff", kind: "diff" },
      ],
    };
    const runtime = await reloadWithState(
      target,
      action === "open-cold" || action === "toggle-open-close"
        ? filesClosed
        : action === "switch-surface"
          ? bothFilesActive
          : action === "switch-file-tab"
            ? fileTabsOpen
            : action === "toggle-diff-view" || action === "collapse-all" || action === "expand-all"
              ? diffOpen
              : filesOpen,
    );
    const { application: app, page: window, workspaceFixture: fixture } = runtime;

    if (action === "open-cold") {
      await waitForPanelClosed(window);
      return measureTrustedRendererAction(app, window, async () => {
        await clickPanelToggle(window);
        await waitForPanelShell(window);
        const shellAt = await readTraceTimestamp(window, "shellVisibleAt");
        await markRendererMilestones(window, ["shell-visible", "animation-settled"], shellAt);
        await waitForPanelContent(window, "files", fixture);
        await markRendererMilestones(
          window,
          ["data-ready"],
          await readDataReadyAt(window, "files"),
        );
        await markRendererMilestone(window, "above-fold-painted");
        await markRendererMilestone(window, "interactive");
      });
    }
    if (action === "toggle-open-close") {
      await waitForPanelClosed(window);
      await clickPanelToggle(window);
      await waitForPanelShell(window);
      await waitForPanelContent(window, "files", fixture);
      await clickPanelToggle(window);
      await waitForPanelClosed(window);
      const transitionMode = await panelTransitionMode(window);
      return measureTrustedRendererAction(app, window, async () => {
        await clickPanelToggle(window);
        if (transitionMode === "animated") {
          await waitForPanelShell(window);
          await window.evaluate<void>("new Promise((resolve) => requestAnimationFrame(resolve))");
        }
        await clickPanelToggle(window);
        await markRendererMilestones(
          window,
          ["second-toggle-input"],
          await readTraceTimestamp(window, "lastTrustedInputAt"),
        );
        await waitForPanelClosed(window);
        const presentedAt = await markRendererMilestone(window, "final-state-presented");
        await markRendererMilestones(window, ["animation-settled", "interactive"], presentedAt);
      });
    }
    if (action === "toggle-close-open") {
      await waitForPanelContent(window, "files", fixture);
      const transitionMode = await panelTransitionMode(window);
      return measureTrustedRendererAction(app, window, async () => {
        await clickPanelToggle(window);
        if (transitionMode === "animated")
          await window.evaluate<void>("new Promise((resolve) => requestAnimationFrame(resolve))");
        await clickPanelToggle(window);
        await markRendererMilestones(
          window,
          ["second-toggle-input"],
          await readTraceTimestamp(window, "lastTrustedInputAt"),
        );
        await waitForPanelShell(window);
        await waitForPanelContent(window, "files", fixture);
        const presentedAt = await markRendererMilestone(window, "final-state-presented");
        await markRendererMilestones(window, ["animation-settled", "interactive"], presentedAt);
      });
    }
    if (action === "open-warm-data") {
      await waitForPanelContent(window, "files", fixture);
      await clickPanelToggle(window);
      await waitForPanelClosed(window);
      return measureTrustedRendererAction(app, window, async () => {
        await clickPanelToggle(window);
        const inputAt = await readMeasuredTrustedInputAt(window);
        await markRendererMilestones(window, ["data-ready"], inputAt);
        await waitForPanelShell(window);
        const shellAt = await readTraceTimestamp(window, "shellVisibleAt");
        await markRendererMilestones(window, ["shell-visible", "animation-settled"], shellAt);
        await waitForPanelContent(window, "files", fixture);
        await markRendererMilestone(window, "above-fold-painted");
        await markRendererMilestone(window, "interactive");
      });
    }
    if (action === "switch-surface") {
      await waitForPanelContent(window, "files", fixture);
      return measureTrustedRendererAction(app, window, async () => {
        await clickSurfaceTab(window, "Diff");
        await waitForPanelContent(window, "diff", fixture);
        await markRendererMilestones(window, ["action-painted", "interactive"]);
      });
    }
    if (action === "open-file") {
      await waitForPanelContent(window, "files", fixture);
      const path = fixture.filePaths[0];
      if (!path) throw new Error("T3 open-file requires an attested fixture path.");
      const row = await prepareFileTreeRow(window, path);
      return measureTrustedRendererAction(app, window, async () => {
        await row.click();
        await waitForOpenFile(window, path);
        await markRendererMilestones(window, ["action-painted", "interactive"]);
      });
    }
    if (action === "switch-file-tab") {
      const [firstPath, secondPath] = fixture.filePaths;
      if (!firstPath || !secondPath)
        throw new Error("T3 switch-file-tab requires two attested fixture paths.");
      await waitForOpenFile(window, firstPath);
      return measureTrustedRendererAction(app, window, async () => {
        await clickSurfaceTab(window, fixtureBasename(secondPath));
        await waitForOpenFile(window, secondPath);
        await markRendererMilestones(window, ["action-painted", "interactive"]);
      });
    }

    await waitForPanelContent(window, "diff", fixture);
    if (action === "toggle-diff-view") {
      const split = window
        .locator('button[aria-label="Split diff view"]')
        .filter({ visible: true });
      const stacked = window
        .locator('button[aria-label="Stacked diff view"]')
        .filter({ visible: true });
      if ((await split.count()) !== 1 || (await stacked.count()) !== 1)
        throw new Error("T3 Diff surface is missing its canonical view toggles.");
      const targetToggle =
        (await split.first().getAttribute("aria-pressed")) === "true" ? stacked : split;
      const targetLabel = await targetToggle.first().getAttribute("aria-label");
      if (!targetLabel) throw new Error("T3 Diff view target has no canonical label.");
      return measureTrustedRendererAction(app, window, async () => {
        await targetToggle.first().click();
        await waitForStableElement(
          window,
          `button[aria-label=${JSON.stringify(targetLabel)}]`,
          'return element.getAttribute("aria-pressed") === "true";',
        );
        await markRendererMilestones(window, ["action-painted", "interactive"]);
      });
    }
    const desiredBefore = action === "collapse-all" ? "Collapse all files" : "Expand all files";
    const opposite = action === "collapse-all" ? "Expand all files" : "Collapse all files";
    if (
      (await window.locator(`button[aria-label=${JSON.stringify(desiredBefore)}]`).count()) === 0
    ) {
      await clickUniqueVisible(
        window,
        `button[aria-label=${JSON.stringify(opposite)}]`,
        `${opposite} precondition`,
      );
      await window
        .locator(`button[aria-label=${JSON.stringify(desiredBefore)}]`)
        .waitFor({ state: "visible", timeout: READINESS_TIMEOUT_MS });
    }
    return measureTrustedRendererAction(app, window, async () => {
      await clickUniqueVisible(
        window,
        `button[aria-label=${JSON.stringify(desiredBefore)}]`,
        desiredBefore,
      );
      await window
        .locator(`button[aria-label=${JSON.stringify(opposite)}]`)
        .waitFor({ state: "visible", timeout: READINESS_TIMEOUT_MS });
      await window.evaluate<void>(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await markRendererMilestones(window, ["action-painted", "interactive"]);
    });
  };

  const executeWorkspacePanelSwitch = async (
    benchmarkCase: WorkspacePanelSwitchCase,
    source: ReadinessTarget,
    destination: ReadinessTarget,
  ): Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace: RendererTrace;
  }> => {
    const runtime = requirePanelRuntime();
    const state = seededPanelState(benchmarkCase.panelProfile);
    await seedRightPanelStates(runtime.page, [
      { target: source, state },
      { target: destination, state },
    ]);
    await reloadSeededApplication(runtime.page, readinessTargets.size, source);
    if (benchmarkCase.panelProfile !== "closed")
      await waitForPanelContent(runtime.page, benchmarkCase.panelProfile, runtime.workspaceFixture);
    if (benchmarkCase.sessionState === "warm") {
      await activateWorkItem(runtime.page, destination);
      if (benchmarkCase.panelProfile !== "closed")
        await waitForPanelContent(
          runtime.page,
          benchmarkCase.panelProfile,
          runtime.workspaceFixture,
        );
      await activateWorkItem(runtime.page, source);
      if (benchmarkCase.panelProfile !== "closed")
        await waitForPanelContent(
          runtime.page,
          benchmarkCase.panelProfile,
          runtime.workspaceFixture,
        );
    }
    return measureTrustedRendererAction(runtime.application, runtime.page, async () => {
      const matches = runtime.page
        .locator(
          `[data-thread-item][data-thread-id=${JSON.stringify(destination.sessionId)}] [role="button"]`,
        )
        .filter({ visible: true });
      if ((await matches.count()) !== 1)
        throw new Error(
          `T3 destination ${destination.logicalSessionId} has no unique visible row.`,
        );
      const [sessionReadyAt, panelReadyAt] = await runRendererObservedAction(
        runtime.page,
        (observationId) =>
          Promise.all([
            observeSessionReady(runtime.page, destination, READINESS_TIMEOUT_MS, observationId),
            benchmarkCase.panelProfile === "closed"
              ? Promise.all([
                  waitForStableElement(
                    runtime.page,
                    "[data-chat-owner-thread-key]",
                    `
                      const owner = element.getAttribute('data-chat-owner-thread-key');
                      return owner !== null && owner.endsWith(${JSON.stringify(`:${destination.sessionId}`)});
                    `,
                    READINESS_TIMEOUT_MS,
                    observationId,
                  ),
                  waitForPanelClosed(runtime.page, observationId),
                ]).then((timestamps) => Math.max(...timestamps))
              : observePanelReady(
                  runtime.page,
                  destination,
                  benchmarkCase.panelProfile,
                  runtime.workspaceFixture,
                  undefined,
                  observationId,
                ),
          ]),
        () => matches.first().click(),
      );
      await markRendererMilestones(runtime.page, ["session-ready"], sessionReadyAt);
      await markRendererMilestones(runtime.page, ["panel-ready"], panelReadyAt);
      await markRendererMilestones(runtime.page, ["content-identity"], sessionReadyAt);
      await markRendererMilestones(
        runtime.page,
        ["above-fold-painted"],
        Math.max(sessionReadyAt, panelReadyAt),
      );
      await markRendererMilestone(runtime.page, "interactive");
    });
  };

  const executeSessionNavigation = async (
    benchmarkCase: SessionNavigationCase,
    source: ReadinessTarget,
    destination: ReadinessTarget,
    loadProfile?: PanelLoadProfile,
  ): Promise<{
    readonly clock: MonotonicClock;
    readonly rendererTrace?: RendererTrace;
  }> => {
    const runtime = requirePanelRuntime();
    if (
      benchmarkCase.navigationType === "first-visit" ||
      benchmarkCase.navigationType === "return-visited-panel-closed"
    ) {
      // Measured history walks dest→dest. Launch already leaves the app on
      // control once; do not bounce back to source/control between destinations.
      await ensurePanelClosed(runtime.page);
      return {
        clock: await activateWorkItem(runtime.page, destination, 1, "pointerdown"),
      };
    }

    if (!loadProfile)
      throw new Error("T3 open-panel session navigation has no resolved panel load profile.");
    assertSessionNavigationReviewLoadSupported(loadProfile, runtime.workspaceFixture.diffCount);
    // Panel-open only: source/control seeding stays isolated here so history
    // measured clicks are not reset to control between destinations.
    const state = loadedPanelState(runtime.workspaceFixture, loadProfile, "diff");
    await seedRightPanelStates(runtime.page, [
      { target: source, state },
      { target: destination, state },
    ]);
    await reloadSeededApplication(runtime.page, readinessTargets.size, source);
    await seedPanelLoad(runtime.page, runtime.workspaceFixture, loadProfile);
    await activateWorkItem(runtime.page, destination);
    await waitForPanelOwner(runtime.page, destination);
    await seedPanelLoad(runtime.page, runtime.workspaceFixture, loadProfile);
    await activateWorkItem(runtime.page, source);
    await waitForPanelOwner(runtime.page, source);
    await seedPanelLoad(runtime.page, runtime.workspaceFixture, loadProfile);

    const measured = await measureTrustedRendererAction(
      runtime.application,
      runtime.page,
      async () => {
        const matches = runtime.page
          .locator(
            `[data-thread-item][data-thread-id=${JSON.stringify(destination.sessionId)}] [role="button"]`,
          )
          .filter({ visible: true });
        if ((await matches.count()) !== 1)
          throw new Error(
            `T3 destination ${destination.logicalSessionId} has no unique visible row.`,
          );
        const [sessionReadyAt, panelReadyAt] = await runRendererObservedAction(
          runtime.page,
          (observationId) =>
            Promise.all([
              observeSessionReady(runtime.page, destination, READINESS_TIMEOUT_MS, observationId),
              observePanelReady(
                runtime.page,
                destination,
                "diff",
                runtime.workspaceFixture,
                loadProfile.expandedReviewFileCount,
                observationId,
              ),
            ]),
          () => matches.first().click(),
        );
        await markRendererMilestones(runtime.page, ["session-ready"], sessionReadyAt);
        await markRendererMilestones(runtime.page, ["panel-ready"], panelReadyAt);
        await markRendererMilestones(runtime.page, ["content-identity"], sessionReadyAt);
        await markRendererMilestones(
          runtime.page,
          ["above-fold-painted"],
          Math.max(sessionReadyAt, panelReadyAt),
        );
        await markRendererMilestone(runtime.page, "interactive");
      },
      "pointerdown",
    );
    return measured;
  };

  return {
    hello: {
      protocolVersion: 1,
      application: {
        id: "t3",
        name: "T3 Code",
        version: desktopPackage.version,
        buildDigestSha256,
      },
      driver: {
        name: "t3-reference",
        version: "3",
        sourceCommit,
        digestSha256: driverDigestSha256,
      },
      scenarios: [
        "app-start-v1",
        "session-switch-v1",
        "app-start-v3",
        "session-switch-v3",
        "workspace-panel-v1",
        "session-switch-workspace-panel-v1",
        "session-navigation-v1",
        "workspace-panel-v2",
      ],
      sourceEventFormats: ["opencode-event-v1", "opencode-event-v2"],
      materializationModes: ["translated"],
      guiFramework: "electron",
    },
    prepare: async (params) => {
      const privateRoot = NodePath.join(
        NodePath.resolve(params.runDirectory),
        "driver-state",
        "t3",
      );
      const p0 = NodePath.join(privateRoot, "P0");
      const p1 = NodePath.join(privateRoot, "P1");
      const workspaceRoot = t3BenchmarkWorkspaceRoot(p0);
      const dbPath = NodePath.join(p0, "userdata", "state.sqlite");
      await NodeFSP.mkdir(NodePath.dirname(dbPath), {
        recursive: true,
        mode: 0o700,
      });
      await NodeFSP.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      const migrations = (await import(
        NodeURL.pathToFileURL(NodePath.join(repoRoot, "apps/server/src/persistence/Migrations.ts"))
          .href
      )) as {
        readonly runMigrations: () => Effect.Effect<ReadonlyArray<unknown>, Error, never>;
      };
      const sqliteClient = (await import(
        NodeURL.pathToFileURL(
          NodePath.join(repoRoot, "apps/server/src/persistence/NodeSqliteClient.ts"),
        ).href
      )) as { readonly layer: (input: { readonly filename: string }) => never };
      const silentLogger = Logger.layer([Logger.make<unknown, void>(() => undefined)], {
        mergeWithExisting: false,
      });
      await Effect.runPromise(
        migrations
          .runMigrations()
          .pipe(
            Effect.provide(sqliteClient.layer({ filename: dbPath })),
            Effect.provide(silentLogger) as never,
          ),
      );
      const materialization = await materializeT3PublicCorpus({
        corpusDirectory: params.corpusDirectory,
        corpusManifestPath: params.corpusManifestPath,
        expectedCorpusDigestSha256: params.corpusDigestSha256,
        expectedEventSchemaDigestSha256: params.eventSchemaDigestSha256,
        dbPath,
        disposableRoot: privateRoot,
        workspaceRoot,
        ...(params.workspaceFixtureManifest
          ? { workspaceFixtureManifest: params.workspaceFixtureManifest }
          : {}),
        ...(params.workspaceFixtureDigestSha256
          ? { expectedWorkspaceFixtureDigestSha256: params.workspaceFixtureDigestSha256 }
          : {}),
      });
      readinessTargets = materialization.readinessTargets;
      workspaceFixture = materialization.workspaceFixtureAttestation
        ? {
            filePaths:
              materialization.workspaceFixtureAttestation.workspaces[0]?.openFilePaths ?? [],
            allFilePaths:
              materialization.workspaceFixtureAttestation.workspaces[0]?.files.map(
                (entry) => entry.path,
              ) ?? [],
            directoryPaths: params.workspaceFixtureManifest?.directories ?? [],
            diffPaths:
              materialization.workspaceFixtureAttestation.workspaces[0]?.diffs.map(
                (entry) => entry.path,
              ) ?? [],
            fileCount: materialization.workspaceFixtureAttestation.workspaces[0]?.files.length ?? 0,
            diffCount: materialization.workspaceFixtureAttestation.workspaces[0]?.diffs.length ?? 0,
          }
        : undefined;
      const canonicalFixtureSeal =
        materialization.workspaceFixtureDigestSha256 &&
        materialization.workspaceFixtureAttestation &&
        params.workspaceFixtureManifest
          ? {
              digestSha256: materialization.workspaceFixtureDigestSha256,
              manifest: params.workspaceFixtureManifest,
              attestation: materialization.workspaceFixtureAttestation,
            }
          : undefined;
      if (canonicalFixtureSeal) workspaceFixtureSeals.set(p0, canonicalFixtureSeal);
      await NodeFSP.cp(p0, p1, {
        recursive: true,
        errorOnExist: true,
        mode: NodeFS.constants.COPYFILE_FICLONE,
      });
      const initializedFixtureSeal = await rebaseT3BenchmarkWorkspaces({
        dbPath: NodePath.join(p1, "userdata", "state.sqlite"),
        sourceStateRoot: p0,
        targetStateRoot: p1,
        ...(canonicalFixtureSeal ? { workspaceFixtureSeal: canonicalFixtureSeal } : {}),
      });
      if (initializedFixtureSeal) workspaceFixtureSeals.set(p1, initializedFixtureSeal);
      await launch(p1, "control");
      preserveActiveAttempt = true;
      const warmupShutdown = await shutdown();
      if (warmupShutdown.survivors.length > 0)
        throw new Error("T3 P1 initialization left a surviving process.");
      const initializedAttempt = NodePath.join(privateRoot, "attempts", "0");
      await NodeFSP.rm(p1, { recursive: true, force: true });
      await NodeFSP.rename(initializedAttempt, p1);
      const initializedAttemptFixtureSeal = workspaceFixtureSeals.get(initializedAttempt);
      const warmedFixtureSeal = await rebaseT3BenchmarkWorkspaces({
        dbPath: NodePath.join(p1, "userdata", "state.sqlite"),
        sourceStateRoot: initializedAttempt,
        targetStateRoot: p1,
        ...(initializedAttemptFixtureSeal
          ? { workspaceFixtureSeal: initializedAttemptFixtureSeal }
          : {}),
      });
      if (warmedFixtureSeal) workspaceFixtureSeals.set(p1, warmedFixtureSeal);
      return { materialization, stateHandles: { P0: p0, P1: p1 } };
    },
    launch,
    activate: async (target, readinessAttempts = 1) => {
      if (!page) throw new Error("T3 renderer is not running.");
      return activateWorkItem(page, target, readinessAttempts);
    },
    executeWorkspacePanelAction,
    executeWorkspacePanelSwitch,
    executeSessionNavigation,
    shutdown,
  };
}

function asPrepareParams(params: unknown): PrepareParams {
  return params as unknown as PrepareParams;
}
function asLaunchParams(params: unknown): LaunchParams {
  return params as unknown as LaunchParams;
}
function asExecuteParams(params: unknown): ExecuteParams {
  return params as unknown as ExecuteParams;
}

export async function runT3PublicDriver(): Promise<void> {
  const driver = createT3PublicDriver(await makeDefaultDependencies());
  const handlers: DriverHandlers = {
    hello: async () => driver.hello(),
    prepare: async (params) => driver.prepare(asPrepareParams(params)),
    launch: async (params) => driver.launch(asLaunchParams(params)),
    execute: async (params) => driver.execute(asExecuteParams(params)),
    shutdown: async () => driver.shutdown(),
  };
  const cleanup = async () => {
    const result = await driver.shutdown();
    const survivors = result.survivors as ReadonlyArray<unknown>;
    if (survivors.length > 0) throw new Error("T3 driver cleanup left a surviving process.");
  };
  const terminate = (code: number) => {
    void cleanup().finally(() => NODE_PROCESS.exit(code));
  };
  NODE_PROCESS.once("SIGINT", () => terminate(130));
  NODE_PROCESS.once("SIGTERM", () => terminate(143));
  try {
    await serveDriver(handlers);
  } finally {
    await cleanup();
  }
}

if (import.meta.main) await runT3PublicDriver();
