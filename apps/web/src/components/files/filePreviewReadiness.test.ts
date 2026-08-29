import { describe, expect, it } from "vite-plus/test";

import { resolveFilePreviewReadiness } from "./filePreviewReadiness";

describe("resolveFilePreviewReadiness", () => {
  it("requires the loaded revision itself to receive a post-render callback", () => {
    const first = resolveFilePreviewReadiness({
      relativePath: "src/example.ts",
      contents: "first",
      error: null,
      isPending: false,
      paintedRevision: null,
    });
    expect(first).toMatchObject({ dataState: "ready", renderState: "pending" });

    expect(
      resolveFilePreviewReadiness({
        relativePath: "src/example.ts",
        contents: "first",
        error: null,
        isPending: false,
        paintedRevision: first.revision,
      }),
    ).toMatchObject({ dataState: "ready", renderState: "painted" });

    expect(
      resolveFilePreviewReadiness({
        relativePath: "src/example.ts",
        contents: "changed at the same path",
        error: null,
        isPending: false,
        paintedRevision: first.revision,
      }),
    ).toMatchObject({ dataState: "ready", renderState: "pending" });
  });

  it("keeps absent file data in the canonical loading state", () => {
    expect(
      resolveFilePreviewReadiness({
        relativePath: "src/example.ts",
        contents: null,
        error: null,
        isPending: true,
        paintedRevision: null,
      }),
    ).toEqual({ revision: null, dataState: "loading", renderState: "pending" });
  });
});
