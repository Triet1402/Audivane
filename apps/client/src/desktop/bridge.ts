import type { DesktopBridge } from "@codec-abx/contracts";

/** Structured, non-Error payload thrown by the preload contextBridge. */
export interface DesktopErrorShape {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly reasons?: readonly string[];
  readonly uncertain?: boolean;
}

export function desktopError(
  code: string,
  message: string,
  reasons: readonly string[] = [],
  uncertain = false,
): DesktopErrorShape {
  return { name: "DesktopError", code, message, reasons, uncertain };
}

export function isDesktopError(value: unknown): value is DesktopErrorShape {
  return value !== null && typeof value === "object" &&
    typeof (value as { message?: unknown }).message === "string";
}

/** Render the structured preload payload without `[object Object]`. */
export function desktopErrorMessage(error: unknown): string {
  if (isDesktopError(error)) return error.message ?? "Desktop operation failed";
  return error instanceof Error ? error.message : String(error);
}

/**
 * A normal web origin without a bridge selects the browser runtime. A desktop
 * origin or an advertised bridge must have the complete supported surface;
 * failed preload initialization must never select a different engine.
 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const candidate: unknown = window.codecAbxDesktop;
  const desktopOrigin = window.location?.protocol === "codec-abx:";
  if (candidate === undefined && !desktopOrigin) return null;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const methods = (value: unknown, names: readonly string[]): boolean =>
    record(value) && names.every((name) => typeof value[name] === "function");
  if (!record(candidate) || candidate.version !== 1 ||
      !methods(candidate.preparation, ["pickSource", "capabilities", "prepare", "cancel",
        "readAudio", "readCanaryAudio", "release", "onProgress"]) ||
      !methods(candidate.experiment, ["configure", "snapshot", "bindPrepared", "nextTrial",
        "answer", "readAudio", "seal", "reset", "export", "dispose"])) {
    throw desktopError("desktop-unavailable",
      "The desktop connection did not initialize. Close and reopen the app, or rebuild it if the problem persists. Native processing is unavailable; no browser fallback was started.");
  }
  return candidate as unknown as DesktopBridge;
}
