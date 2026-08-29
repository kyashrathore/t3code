import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  countProjectFiles,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  prefetchableFileTreePath,
  projectFilePrefetchHoverDecision,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.unstubAllGlobals();
  });

  it("counts files without letting directory entries satisfy file readiness", () => {
    expect(
      countProjectFiles([
        { kind: "directory", path: "src" },
        { kind: "directory", path: "src/components" },
        { kind: "file", path: "src/index.ts" },
      ]),
    ).toBe(1);
  });

  it("prefetches only canonical file rows, never directory rows", () => {
    const entryKinds = new Map([
      ["src", "directory"],
      ["src/index.ts", "file"],
    ] as const);
    expect(prefetchableFileTreePath("src/index.ts", entryKinds)).toBe("src/index.ts");
    expect(prefetchableFileTreePath("src/", entryKinds)).toBeNull();
    expect(prefetchableFileTreePath("missing.ts", entryKinds)).toBeNull();
  });

  it("cancels the previous row timer before cached and in-flight early returns", () => {
    expect(
      projectFilePrefetchHoverDecision({
        cached: true,
        inflight: false,
        nextPath: "src/b.ts",
        scheduledPath: "src/a.ts",
      }),
    ).toEqual({ action: "mark-ready", cancelScheduled: true });
    expect(
      projectFilePrefetchHoverDecision({
        cached: false,
        inflight: true,
        nextPath: "src/b.ts",
        scheduledPath: "src/a.ts",
      }),
    ).toEqual({ action: "wait", cancelScheduled: true });
    expect(
      projectFilePrefetchHoverDecision({
        cached: false,
        inflight: false,
        nextPath: "src/a.ts",
        scheduledPath: "src/a.ts",
      }),
    ).toEqual({ action: "keep-scheduled", cancelScheduled: false });
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });
});
