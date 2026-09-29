// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Public benchmark adapter owns isolated state and child lifecycle.
/// <reference lib="dom" />
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { extractFile } from "@electron/asar";
import {
  frameLogOf,
  serveDriver,
  settleExpression,
  type AppFacts,
  type DriverHandlers,
  type FrameLog,
  type PageSettle,
} from "agent-app-benchmark/driver-sdk";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { chromium } from "playwright-core";

import {
  materializeT3PublicCorpus,
  rebaseT3BenchmarkWorkspaces,
  type T3PublicMaterializationResult,
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

interface Activation {
  readonly clock: MonotonicClock;
  readonly frameLog: FrameLog;
}

interface PreparedDriverState {
  readonly materialization: T3PublicMaterializationResult;
  readonly stateHandles: { readonly P0: string; readonly P1: string };
}

export function t3BenchmarkWorkspaceRoot(stateRoot: string): string {
  // Inside the state root so each attempt's copy of the state carries its own
  // workspaces, which rebaseT3BenchmarkWorkspaces requires.
  return NodePath.join(stateRoot, "worktrees", "benchmark-fixtures");
}

interface ActiveLaunch {
  readonly processes: ReadonlyArray<OwnedProcess>;
  readonly readiness: ReadinessReceipt;
  readonly clock: MonotonicClock;
  readonly frameLog: FrameLog;
}

interface SwitchCase {
  readonly caseId: string;
  readonly workload: "progressive-resource" | "resource-control" | "list-walk";
  readonly sessionState?: "cold" | "warm";
  /** A list walk's step index within its pass; step 0 enters the list from outside or wraps to its top. */
  readonly walkPosition?: number;
  readonly sourceSessionId?: string;
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
  readonly activate: (target: ReadinessTarget, readinessTimeoutMs?: number) => Promise<Activation>;
  /** The session-list rows of every benchmark session, top to bottom. */
  readonly listedSessionIds: () => Promise<ReadonlyArray<string>>;
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
  readonly case: StartCase | SwitchCase;
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
  let active = false;
  /** Logical session IDs the list walk has displayed in the current app process. */
  let walkedSessions = new Set<string>();

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

  return {
    hello: async () => dependencies.hello,
    prepare: async (params) => {
      if (prepared) throw new Error("T3 driver is already prepared.");
      prepared = await dependencies.prepare(params);
      return {
        materializationMode: "translated",
        corpusDigestSha256: prepared.materialization.corpusDigestSha256,
        eventSchemaDigestSha256: prepared.materialization.eventSchemaDigestSha256,
        mappingDigestSha256: prepared.materialization.mappingDigestSha256,
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
      walkedSessions = new Set();
      return {
        ready: true,
        processes: launch.processes,
        readiness: launch.readiness,
      };
    },
    execute: async (params) => {
      if (APP_START_SCENARIO_IDS.includes(params.scenarioId)) {
        if (active) throw new Error("T3 app-start requires no running application.");
        if (!("startMode" in params.case) || !params.stateHandle)
          throw new Error("T3 app-start request is incomplete.");
        requireStateHandle(params.stateHandle);
        const launch = await dependencies.launch(params.stateHandle, "control");
        active = true;
        return {
          ...execution(
            params.case.caseId,
            launch.clock,
            withTimingEvidence(launch.readiness, launch.clock.end),
          ),
          frameLog: launch.frameLog,
        };
      }
      if (
        !SESSION_SWITCH_SCENARIO_IDS.includes(params.scenarioId) ||
        "startMode" in params.case ||
        !("workload" in params.case)
      )
        throw new Error(`T3 does not support scenario ${params.scenarioId}.`);
      if (!active) throw new Error("T3 session switching requires a running application.");
      assertSwitchCase(params.case);
      const benchmarkCase = params.case;
      const destination = resolveTarget(benchmarkCase.destinationSessionId);
      if (benchmarkCase.workload === "list-walk") {
        const source = resolveTarget(benchmarkCase.sourceSessionId ?? "control");
        if (
          (benchmarkCase.sessionState === "cold") ===
          walkedSessions.has(destination.logicalSessionId)
        )
          throw new Error(
            `T3 list-walk ${benchmarkCase.sessionState} step to ${destination.logicalSessionId} does not match this process's visits.`,
          );
        if (benchmarkCase.walkPosition !== 0) {
          const listed = await dependencies.listedSessionIds();
          const sourceRow = listed.indexOf(source.sessionId);
          if (sourceRow < 0 || listed[sourceRow + 1] !== destination.sessionId)
            throw new Error(
              `T3 lists ${destination.logicalSessionId} ${sourceRow < 0 ? "without" : "not directly below"} ${source.logicalSessionId}.`,
            );
        }
        const measured = await dependencies.activate(destination);
        walkedSessions.add(destination.logicalSessionId);
        return activationExecution(benchmarkCase.caseId, measured);
      }
      const control = resolveTarget(benchmarkCase.sourceSessionId ?? "control");
      if (benchmarkCase.workload !== "resource-control") await dependencies.activate(control);
      const measured = await dependencies.activate(
        destination,
        benchmarkCase.workload === "resource-control"
          ? RESOURCE_CONTROL_READINESS_TIMEOUT_MS
          : undefined,
      );
      return activationExecution(benchmarkCase.caseId, measured);
    },
    shutdown: async () => {
      try {
        return await dependencies.shutdown();
      } finally {
        active = false;
        walkedSessions = new Set();
      }
    },
  };
}

/**
 * The resource workload's return to control is a validity check, not a scored
 * latency; the compared driver uses the same ceiling so a return that never
 * becomes ready costs both runs the same bounded wait.
 */
const RESOURCE_CONTROL_READINESS_TIMEOUT_MS = 5_000;

const APP_START_SCENARIO_IDS: ReadonlyArray<string> = ["app-start", "app-start-real-sessions"];
const SESSION_SWITCH_SCENARIO_IDS: ReadonlyArray<string> = [
  "session-switch-walk",
  "session-switch-walk-real-sessions",
];

function assertSwitchCase(value: ExecuteParams["case"]): asserts value is SwitchCase {
  if (
    !("workload" in value) ||
    !["progressive-resource", "resource-control", "list-walk"].includes(value.workload) ||
    !("destinationSessionId" in value) ||
    typeof value.destinationSessionId !== "string"
  )
    throw new Error("T3 session-switch request is incomplete.");
}

function execution(caseId: string, clock: MonotonicClock, readiness: ReadinessReceipt) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness };
}

function activationExecution(caseId: string, measured: Activation) {
  return {
    ...execution(caseId, measured.clock, readinessReceipt(measured.clock.end)),
    frameLog: measured.frameLog,
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
  readonly close: () => Promise<void>;
}

interface PlaywrightLocator {
  readonly count: () => Promise<number>;
  readonly first: () => PlaywrightLocator;
  readonly filter: (input: {
    readonly hasText?: string | RegExp;
    readonly visible?: boolean;
  }) => PlaywrightLocator;
  readonly click: (input?: { readonly timeout?: number }) => Promise<void>;
}

interface PlaywrightPage {
  readonly waitForLoadState: (state: "domcontentloaded") => Promise<void>;
  readonly waitForSelector: (
    selector: string,
    input?: { readonly timeout?: number },
  ) => Promise<unknown>;
  readonly locator: (selector: string) => PlaywrightLocator;
  readonly bringToFront: () => Promise<void>;
  readonly emulateMedia: (input: { readonly colorScheme: null }) => Promise<void>;
  readonly evaluate: <A>(source: string) => Promise<A>;
}

/**
 * The window is maximized by the persisted desktop settings the materialized
 * state carries (T3 maximizes on reveal, before first show), so a measured
 * launch never relayouts from a driver-side maximize. This only proves that
 * the viewport the measurement ran in is the display's available area.
 */
async function assertMaximizedViewport(page: Pick<PlaywrightPage, "evaluate">): Promise<void> {
  const viewport = await page.evaluate<{
    readonly width: number;
    readonly availWidth: number;
    readonly height: number;
  }>("({ width: innerWidth, availWidth: screen.availWidth, height: innerHeight })");
  if (viewport.width !== viewport.availWidth)
    throw new Error(`T3 window is not maximized: ${JSON.stringify(viewport)}`);
}

export const T3_MAXIMIZED_DESKTOP_SETTINGS = {
  mainWindowBounds: { x: 0, y: 0, width: 1200, height: 800 },
  mainWindowMaximized: true,
} as const;

/**
 * Spawns the app exactly as a user launch would, plus a remote-debugging port,
 * and attaches over CDP. Playwright's Electron launcher instead holds the
 * app's ready event until its Node inspector attaches, keeps that inspector in
 * the process family, and adds about forty Chromium switches (PaintHolding
 * disabled among them) that the compared app never receives.
 */
function devToolsEndpointAnswers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = NodeHttp.get(url, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
  });
}

async function availableLoopbackPort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string")
    throw new Error("No loopback port was free.");
  return address.port;
}

async function launchT3OverCdp(input: {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}): Promise<PlaywrightElectronApplication> {
  const port = await availableLoopbackPort();
  const child = NodeChildProcess.spawn(
    input.executablePath,
    [...input.args, `--remote-debugging-port=${port}`],
    { env: input.env, stdio: "ignore" },
  );
  const exited = new Promise<never>((_, reject) =>
    child.once("exit", (code, signal) =>
      reject(new Error(`T3 exited before CDP attach (code ${code}, signal ${signal}).`)),
    ),
  );
  exited.catch(() => undefined);
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = NodePerfHooks.performance.now() + READINESS_TIMEOUT_MS;
  while (!(await devToolsEndpointAnswers(`${endpoint}/json/version`))) {
    if (child.exitCode !== null || child.signalCode !== null) await exited;
    if (NodePerfHooks.performance.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error("T3 never opened its DevTools endpoint.");
    }
    await NodeTimersPromises.setTimeout(5);
  }
  const browser = await Promise.race([chromium.connectOverCDP(endpoint), exited]);
  const context = browser.contexts()[0];
  if (!context) throw new Error("T3 exposed no browser context over CDP.");
  return {
    process: () => child as unknown as PlaywrightElectronProcess,
    firstWindow: async () => {
      const page = (context.pages()[0] ??
        (await context.waitForEvent("page"))) as unknown as PlaywrightPage;
      // Attaching emulates prefers-color-scheme: light on the page, so T3's
      // follow-the-system theme would render light on a dark host.
      await page.emulateMedia({ colorScheme: null });
      return page;
    },
    close: async () => {
      await browser.close().catch(() => undefined);
      child.kill("SIGTERM");
    },
  };
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

async function revealWorkItem(
  page: PlaywrightPage,
  target: ReadinessTarget,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<void> {
  const row = page.locator(
    `[data-thread-item][data-thread-id=${JSON.stringify(target.sessionId)}]`,
  );
  const deadline = NodePerfHooks.performance.now() + timeoutMs;
  while ((await row.count()) === 0) {
    const showMore = page.locator("button").filter({ hasText: /^Show \d+ more$/u, visible: true });
    if ((await showMore.count()) === 1) await showMore.click();
    await page.evaluate("new Promise((resolve) => requestAnimationFrame(resolve))");
    if (NodePerfHooks.performance.now() >= deadline)
      throw new Error(`T3 never rendered the ${target.logicalSessionId} session row.`);
  }
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

async function activateWorkItem(
  page: PlaywrightPage,
  target: ReadinessTarget,
  attempts = 1,
  readinessTimeoutMs = READINESS_TIMEOUT_MS,
): Promise<PageSettle> {
  const matches = page
    .locator(
      `[data-thread-item][data-thread-id=${JSON.stringify(target.sessionId)}] [role="button"]`,
    )
    .filter({ visible: true });
  if ((await matches.count()) !== 1)
    throw new Error(`T3 benchmark session ${target.logicalSessionId} has no unique visible row.`);
  const expression = settleExpression({
    facts: t3SessionFacts,
    target: { sessionId: target.sessionId, expectedMessageIds: target.expectedMessageIds },
    timeoutMs: readinessTimeoutMs / attempts,
    start: "trusted-pointerdown",
  });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await runPrearmedReadiness(
        () =>
          page.evaluate<PageSettle>(expression).catch((cause: unknown) => {
            throw new Error(
              `T3 session readiness failed for ${target.logicalSessionId}: ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            );
          }),
        async () => {
          // Playwright sends evaluations in call order, so this round trip
          // returns only after the clock's pointerdown listener is installed.
          await page.evaluate<void>("undefined");
          await matches.first().click();
        },
      );
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    }
  }
  throw new Error(`T3 failed to activate ${target.logicalSessionId}.`);
}

/**
 * The page clock cannot be cancelled, so a failed action waits for it to end;
 * left running, it would take the next attempt's pointerdown as its start and
 * sample frames during that attempt.
 */
export async function runPrearmedReadiness<A>(
  arm: () => Promise<A>,
  action: () => Promise<void>,
): Promise<A> {
  const readiness = arm();
  void readiness.catch(() => undefined);
  try {
    await action();
  } catch (error) {
    await Promise.allSettled([readiness]);
    throw error;
  }
  return readiness;
}

interface T3FactsTarget {
  readonly sessionId: string;
  readonly expectedMessageIds: ReadonlyArray<string>;
}

/**
 * Serialized into the renderer by `settleExpression`, so it may reference only
 * browser globals and `target`. The destination is the chat owner whose thread
 * key ends with its session id, and its transcript is the nearest scrolling
 * ancestor of the timeline root inside that owner.
 */
export const t3SessionFacts = (target: T3FactsTarget): AppFacts => {
  const ownerSuffix = `:${target.sessionId}`;
  const expected = new Set(target.expectedMessageIds);
  const shown = (element: Element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      style.contentVisibility !== "hidden" &&
      bounds.width > 0 &&
      bounds.height > 0
    );
  };
  const owner = () =>
    Array.from(document.querySelectorAll("[data-chat-owner-thread-key]")).find((candidate) =>
      candidate.getAttribute("data-chat-owner-thread-key")?.endsWith(ownerSuffix),
    );
  const transcript = () => {
    const current = owner();
    let viewport = current?.querySelector("[data-timeline-root]")?.parentElement;
    while (
      viewport instanceof HTMLElement &&
      viewport !== current &&
      !["auto", "scroll"].includes(getComputedStyle(viewport).overflowY)
    )
      viewport = viewport.parentElement;
    return viewport instanceof HTMLElement && viewport !== current ? viewport : null;
  };
  const rows = () =>
    Array.from(transcript()?.querySelectorAll<HTMLElement>("[data-timeline-row-id]") ?? []);
  return {
    displayed: () => {
      const current = owner();
      return (
        current instanceof HTMLElement &&
        !current.querySelector("[data-thread-sync-drawer]") &&
        shown(current)
      );
    },
    latestTurnRows: () =>
      rows()
        .filter(
          (row) =>
            expected.has(row.getAttribute("data-message-id") ?? "") &&
            getComputedStyle(row).contentVisibility !== "hidden",
        )
        .sort(
          (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
        ),
    composer: () => {
      const composer = owner()?.querySelector('[data-testid="composer-editor"]');
      return composer instanceof HTMLElement &&
        composer.getAttribute("contenteditable") === "true" &&
        getComputedStyle(composer).contentVisibility !== "hidden"
        ? composer
        : null;
    },
    placeholder: () => !!transcript()?.querySelector('[data-slot="skeleton"]'),
    transcript,
    rows,
    rowKey: (row) => row.getAttribute("data-timeline-row-id") ?? "",
  };
};

export function switchMeasurement(settle: PageSettle): Activation {
  return {
    clock: {
      kind: "single-monotonic-clock",
      clock: "t3-renderer-performance",
      start: settle.startAt,
      end: settle.settledAt,
    },
    frameLog: frameLogOf(settle),
  };
}

/** App start runs from the process spawn on the driver's clock; `rendererOffsetMs` maps renderer time onto it. */
export function appStartMeasurement(
  settle: PageSettle,
  spawnAt: number,
  rendererOffsetMs: number,
): Activation {
  return {
    clock: {
      kind: "single-monotonic-clock",
      clock: "node-perf-hooks",
      start: spawnAt,
      end: settle.settledAt + rendererOffsetMs,
    },
    frameLog: frameLogOf(settle, {
      startAt: spawnAt - rendererOffsetMs,
      offsetMs: rendererOffsetMs,
    }),
  };
}

/**
 * Readiness requires a visible, focused window, and an app launched from a
 * background process need not take focus while the user works in another app.
 * The Claxedo and OpenCode drivers raise their apps the same way.
 */
async function ensureFrontWindow(page: PlaywrightPage, pid: number | undefined): Promise<void> {
  const front = () =>
    page.evaluate<boolean>('document.visibilityState === "visible" && document.hasFocus()');
  if (await front()) return;
  if (pid === undefined)
    throw new Error("T3 process id is unknown, so its window cannot be raised.");
  NodeChildProcess.spawnSync(
    "osascript",
    [
      "-e",
      `tell application "System Events" to set frontmost of (first process whose unix id is ${String(pid)}) to true`,
    ],
    { stdio: "ignore", timeout: 5_000 },
  );
  const deadline = NodePerfHooks.performance.now() + 3_000;
  while (NodePerfHooks.performance.now() < deadline) {
    if (await front()) return;
    await NodeTimersPromises.setTimeout(100);
  }
  throw new Error("T3 window is not visible and focused; keep the app frontmost during the run.");
}

/**
 * Launch notifications (for example the provider-update advisory) float over
 * the window and can intercept the pointer input aimed at a session row. A user
 * dismisses them before working; untimed setup does the same through the
 * toast's own close control, never by hiding the surface.
 */
async function dismissVisibleToasts(page: PlaywrightPage): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // The corner control is reachable by keyboard and by a DOM click; a pointer click
    // through actionability checks waited out its entrance transition for 30 s.
    const dismissed = await page.evaluate<number>(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button[data-slot="toast-close"]'));
        for (const button of buttons) button.click();
        return buttons.length;
      })()
    `);
    if (dismissed === 0) return;
    await page.evaluate<void>(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  }
}

const BENCHMARK_DRIVER_PATHS = [
  "scripts/lib/agent-app-benchmark/",
  "docs/internals/agent-app-performance-benchmark.md",
];

/**
 * A commit that changes only the driver or its document on top of the packaged
 * revision leaves the measured application byte-identical, so it does not need
 * a rebuild. Anything else changed since the packaged commit, including
 * uncommitted edits elsewhere, means the bundle no longer matches the source.
 */
function changedOnlyBenchmarkDriverBetween(repoRoot: string, packagedCommit: string): boolean {
  const git = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  try {
    git(["merge-base", "--is-ancestor", packagedCommit, "HEAD"]);
  } catch {
    return false;
  }
  const changed = git(["diff", "--name-only", packagedCommit]).split("\n").filter(Boolean);
  return changed.every((file) => BENCHMARK_DRIVER_PATHS.some((path) => file.startsWith(path)));
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

interface ProcessIdentity {
  readonly pid: number;
  readonly startTimeMs: number;
}

interface ProcessRow extends ProcessIdentity {
  readonly parentPid: number;
}

/** Rows of `ps -axo pid=,ppid=,lstart=`; `lstart` is the last five fields. */
export function parseProcessTable(output: string): ReadonlyArray<ProcessRow> {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length === 7)
    .map(([pid, parentPid, ...start]) => ({
      pid: Number(pid),
      parentPid: Number(parentPid),
      startTimeMs: parseProcessStartTime(start.join(" "), Number(pid)),
    }));
}

async function readProcessTable(): Promise<ReadonlyArray<ProcessRow>> {
  const output = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "ps",
      ["-axo", "pid=,ppid=,lstart="],
      { encoding: "utf8", maxBuffer: 16_777_216 },
      (error, stdout) => {
        if (error) reject(new Error(`Unable to read the process table: ${error.message}`));
        else resolve(stdout);
      },
    );
  });
  return parseProcessTable(output);
}

export function descendantsOf(
  table: ReadonlyArray<ProcessRow>,
  rootPid: number,
): ReadonlyArray<ProcessIdentity> {
  const found: ProcessRow[] = [];
  let parents = new Set([rootPid]);
  while (parents.size > 0) {
    const children = table.filter((row) => parents.has(row.parentPid) && row.pid !== rootPid);
    found.push(...children);
    parents = new Set(children.map((row) => row.pid));
  }
  return found.map(({ pid, startTimeMs }) => ({ pid, startTimeMs }));
}

/**
 * Electron's helper processes outlive the main process: the network service
 * still flushes the profile's Cache_Data after the root exits, and removing the
 * profile under it failed with ENOTEMPTY. The helpers reparent to launchd once
 * the root is gone, so they are recorded while it runs and awaited here by pid
 * and start time. Returns the ones still alive after SIGKILL.
 */
export async function waitForDescendantExit(
  descendants: ReadonlyArray<ProcessIdentity>,
  readTable: () => Promise<ReadonlyArray<ProcessRow>> = readProcessTable,
  timeouts = { graceMs: 5_000, killMs: 3_000 },
): Promise<ReadonlyArray<ProcessIdentity>> {
  const alive = async () => {
    const table = await readTable();
    return descendants.filter((item) =>
      table.some((row) => row.pid === item.pid && row.startTimeMs === item.startTimeMs),
    );
  };
  const waitUntil = async (deadline: number) => {
    let remaining = await alive();
    while (remaining.length > 0 && NodePerfHooks.performance.now() < deadline) {
      await NodeTimersPromises.setTimeout(50);
      remaining = await alive();
    }
    return remaining;
  };
  const lingering = await waitUntil(NodePerfHooks.performance.now() + timeouts.graceMs);
  for (const item of lingering) {
    if (item.pid <= 1) continue;
    try {
      NODE_PROCESS.kill(item.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return lingering.length === 0 ? [] : waitUntil(NodePerfHooks.performance.now() + timeouts.killMs);
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
  app: PlaywrightElectronApplication,
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
  changedOnlyBenchmarkDriverSince: (packagedCommit: string) => boolean = () => false,
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
  if (packagedCommit !== sourceCommit && !changedOnlyBenchmarkDriverSince(packagedCommit))
    throw new Error(
      `T3 packaged revision ${packagedCommit} does not match source HEAD ${sourceCommit} in ${appAsarPath}.`,
    );
}

function packagedT3Version(appAsarPath: string): unknown {
  try {
    return (
      JSON.parse(extractFile(appAsarPath, "package.json").toString("utf8")) as { version?: unknown }
    ).version;
  } catch (cause) {
    throw new Error(`Unable to read the T3 packaged version in ${appAsarPath}.`, { cause });
  }
}

export function assertPackagedT3Revision(
  appAsarPath: string,
  sourceCommit: string,
  changedOnlyBenchmarkDriverSince?: (packagedCommit: string) => boolean,
): void {
  let packageJson: Buffer;
  try {
    packageJson = extractFile(appAsarPath, "package.json");
  } catch (cause) {
    throw new Error(`Unable to inspect T3 packaged metadata in ${appAsarPath}.`, { cause });
  }
  assertPackagedT3PackageRevision(
    packageJson.toString("utf8"),
    sourceCommit,
    appAsarPath,
    changedOnlyBenchmarkDriverSince,
  );
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
  // A release build stamps its version at packaging (--build-version), so the
  // source tree's apps/desktop/package.json can name an older one.
  const applicationVersion = packagedExecutable
    ? packagedT3Version(packagedT3ApplicationAsar(packagedExecutable, NODE_PROCESS.platform))
    : desktopPackage.version;
  if (typeof applicationVersion !== "string" || applicationVersion.length === 0)
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
      assertPackagedT3Revision(appAsarPath, sourceCommit, (packagedCommit) =>
        changedOnlyBenchmarkDriverBetween(repoRoot, packagedCommit),
      );
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
  let application: PlaywrightElectronApplication | undefined;
  let page: PlaywrightPage | undefined;
  let processIdentity: OwnedProcess | undefined;
  let activeAttemptHome: string | undefined;
  let preserveActiveAttempt = false;
  let attemptSequence = 0;
  let attemptsRoot: string | undefined;

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
    const rootPid = app.process().pid;
    const descendants =
      rootPid === undefined ? [] : descendantsOf(await readProcessTable(), rootPid);
    const closed = await closeOwnedApplication(app, app.process());
    const lingering = closed ? await waitForDescendantExit(descendants) : descendants;
    const survivors: OwnedProcess[] = lingering.map((item) => ({
      ...item,
      owner: "application",
      category: "electron-descendant",
    }));
    if (closed && survivors.length === 0 && attemptHome && !preserveAttempt)
      await NodeFSP.rm(attemptHome, { recursive: true, force: true });
    if (!identity) {
      if (!closed || survivors.length > 0)
        throw new Error("T3 could not close an application that failed during readiness.");
      return { terminated: [], survivors: [] };
    }
    return closed
      ? { terminated: [identity], survivors }
      : { terminated: [], survivors: [identity, ...survivors] };
  };

  const launch = async (stateHandle: string, initialSessionId: string): Promise<ActiveLaunch> => {
    if (application) throw new Error("T3 application is already running.");
    const target = readinessTargets.get(initialSessionId);
    if (!target) throw new Error(`T3 has no readiness target for ${initialSessionId}.`);
    if (!attemptsRoot) throw new Error("T3 launch requires preparation.");
    const attemptHome = NodePath.join(attemptsRoot, String(attemptSequence++));
    await NodeFSP.mkdir(NodePath.dirname(attemptHome), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFSP.cp(stateHandle, attemptHome, {
      recursive: true,
      errorOnExist: true,
      mode: NodeFS.constants.COPYFILE_FICLONE,
    });
    await rebaseT3BenchmarkWorkspaces({
      dbPath: NodePath.join(attemptHome, "userdata", "state.sqlite"),
      sourceStateRoot: stateHandle,
      targetStateRoot: attemptHome,
    });
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
    const app = await launchT3OverCdp({
      executablePath: command.executablePath,
      args: command.args,
      env: t3BenchmarkLaunchEnvironment({
        baseEnv: Object.fromEntries(
          Object.entries(NODE_PROCESS.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ambientHome,
        stateHome: attemptHome,
      }),
    }).catch(async (error) => {
      activeAttemptHome = undefined;
      await NodeFSP.rm(attemptHome, { recursive: true, force: true });
      throw error;
    });
    application = app;
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await waitForSessionList(window);
      await window.bringToFront();
      await revealWorkItem(window, target);
      await ensureFrontWindow(window, app.process().pid);
      const settle = await activateWorkItem(window, target, 6);
      const measured = appStartMeasurement(
        settle,
        start,
        settle.timeOrigin - NodePerfHooks.performance.timeOrigin,
      );
      await assertMaximizedViewport(window);
      await ensureWorkItemsRendered(window, readinessTargets.size);
      await dismissVisibleToasts(window);
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
        readiness: readinessReceipt(measured.clock.end),
        clock: measured.clock,
        frameLog: measured.frameLog,
      };
    } catch (error) {
      return shutdownAfterLaunchFailure(shutdown, error);
    }
  };

  return {
    hello: {
      protocolVersion: 1,
      application: {
        id: "t3",
        name: "T3 Code",
        version: applicationVersion,
        buildDigestSha256,
      },
      driver: {
        name: "t3-reference",
        version: "4",
        sourceCommit,
        digestSha256: driverDigestSha256,
      },
      scenarios: [...APP_START_SCENARIO_IDS, ...SESSION_SWITCH_SCENARIO_IDS],
      sourceEventFormats: ["opencode-event"],
      materializationModes: ["translated"],
      guiFramework: "electron",
      clockRule: "settle-31-frames",
    },
    prepare: async (params) => {
      const runRoot = NodePath.join(NodePath.resolve(params.runDirectory), "driver-state", "t3");
      attemptsRoot = NodePath.join(runRoot, "attempts");
      const cacheRoot = NODE_PROCESS.env.AGENT_APP_BENCHMARK_STATE_CACHE;
      const privateRoot = cacheRoot ?? runRoot;
      const p0 = NodePath.join(privateRoot, "P0");
      const p1 = NodePath.join(privateRoot, "P1");
      const cached = cacheRoot
        ? await readT3PreparedCache(cacheRoot, params.corpusDigestSha256)
        : undefined;
      if (cached) {
        readinessTargets = cached.readinessTargets;
        return { materialization: cached, stateHandles: { P0: p0, P1: p1 } };
      }
      const workspaceRoot = t3BenchmarkWorkspaceRoot(p0);
      const dbPath = NodePath.join(p0, "userdata", "state.sqlite");
      await NodeFSP.mkdir(NodePath.dirname(dbPath), {
        recursive: true,
        mode: 0o700,
      });
      await NodeFSP.writeFile(
        NodePath.join(p0, "userdata", "desktop-settings.json"),
        `${JSON.stringify(T3_MAXIMIZED_DESKTOP_SETTINGS)}\n`,
        { mode: 0o600 },
      );
      await NodeFSP.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      const migrations = (await import(
        NodeURL.pathToFileURL(NodePath.join(repoRoot, "apps/server/src/persistence/Migrations.ts"))
          .href
      )) as {
        readonly runMigrations: () => Effect.Effect<ReadonlyArray<unknown>, Error, never>;
      };
      const sqliteClient = (await import(
        NodeURL.pathToFileURL(NodePath.join(repoRoot, "packages/shared/src/nodeSqliteClient.ts"))
          .href
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
      });
      readinessTargets = materialization.readinessTargets;
      await NodeFSP.cp(p0, p1, {
        recursive: true,
        errorOnExist: true,
        mode: NodeFS.constants.COPYFILE_FICLONE,
      });
      await rebaseT3BenchmarkWorkspaces({
        dbPath: NodePath.join(p1, "userdata", "state.sqlite"),
        sourceStateRoot: p0,
        targetStateRoot: p1,
      });
      await launch(p1, "control");
      preserveActiveAttempt = true;
      const warmupShutdown = await shutdown();
      if (warmupShutdown.survivors.length > 0)
        throw new Error("T3 P1 initialization left a surviving process.");
      const initializedAttempt = NodePath.join(attemptsRoot, "0");
      await NodeFSP.rm(p1, { recursive: true, force: true });
      await NodeFSP.rename(initializedAttempt, p1);
      await rebaseT3BenchmarkWorkspaces({
        dbPath: NodePath.join(p1, "userdata", "state.sqlite"),
        sourceStateRoot: initializedAttempt,
        targetStateRoot: p1,
      });
      if (cacheRoot) await writeT3PreparedCache(cacheRoot, materialization);
      return { materialization, stateHandles: { P0: p0, P1: p1 } };
    },
    launch,
    activate: async (target, readinessTimeoutMs = READINESS_TIMEOUT_MS) => {
      if (!page) throw new Error("T3 renderer is not running.");
      await dismissVisibleToasts(page);
      await ensureFrontWindow(page, application?.process().pid);
      return switchMeasurement(await activateWorkItem(page, target, 1, readinessTimeoutMs));
    },
    listedSessionIds: async () => {
      if (!page) throw new Error("T3 renderer is not running.");
      return page.evaluate<ReadonlyArray<string>>(
        `Array.from(document.querySelectorAll("[data-thread-item][data-thread-id]"), (row) => row.getAttribute("data-thread-id"))`,
      );
    },
    shutdown,
  };
}

const T3_PREPARED_CACHE_FILE = "prepared.json";

/**
 * Written only after P1 seeding succeeded, so its presence means both state
 * handles beside it are complete. Launches copy the handles, which keeps P0
 * never-launched for every scenario that reuses it.
 */
async function writeT3PreparedCache(
  cacheRoot: string,
  materialization: T3PublicMaterializationResult,
): Promise<void> {
  await NodeFSP.writeFile(
    NodePath.join(cacheRoot, T3_PREPARED_CACHE_FILE),
    JSON.stringify({ ...materialization, readinessTargets: [...materialization.readinessTargets] }),
    { mode: 0o600 },
  );
}

async function readT3PreparedCache(
  cacheRoot: string,
  corpusDigestSha256: string,
): Promise<T3PublicMaterializationResult | undefined> {
  const text = await NodeFSP.readFile(
    NodePath.join(cacheRoot, T3_PREPARED_CACHE_FILE),
    "utf8",
  ).catch(() => undefined);
  if (text === undefined) return undefined;
  const record = JSON.parse(text) as Omit<T3PublicMaterializationResult, "readinessTargets"> & {
    readonly readinessTargets: ReadonlyArray<
      [
        string,
        T3PublicMaterializationResult["readinessTargets"] extends ReadonlyMap<string, infer V>
          ? V
          : never,
      ]
    >;
  };
  if (record.corpusDigestSha256 !== corpusDigestSha256 || !Array.isArray(record.readinessTargets))
    throw new Error("T3 prepared-state cache belongs to a different corpus.");
  return { ...record, readinessTargets: new Map(record.readinessTargets) };
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
