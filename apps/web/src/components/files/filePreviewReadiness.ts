import { fileContentRevision } from "./fileContentRevision";

export interface FilePreviewReadiness {
  readonly revision: string | null;
  readonly dataState: "idle" | "loading" | "ready" | "error";
  readonly renderState: "pending" | "painted";
}

export function resolveFilePreviewReadiness(input: {
  readonly relativePath: string | null;
  readonly contents: string | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly paintedRevision: string | null;
}): FilePreviewReadiness {
  const revision =
    input.relativePath && input.contents !== null
      ? `${input.relativePath}:${fileContentRevision(input.contents)}`
      : null;
  return {
    revision,
    dataState:
      input.contents !== null
        ? "ready"
        : input.error
          ? "error"
          : input.isPending
            ? "loading"
            : "idle",
    renderState: revision !== null && input.paintedRevision === revision ? "painted" : "pending",
  };
}
