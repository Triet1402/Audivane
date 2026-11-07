import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Desktop window zoom policy. Zoom is applied to the trusted Electron
 * webContents only; it never changes audio policy, renderer privileges or OS
 * display scaling. Steps follow the familiar browser ladder so the persisted
 * value always lands on a usable, reviewable size.
 */
export const MIN_ZOOM_FACTOR = 0.8;
export const MAX_ZOOM_FACTOR = 2;
export const DEFAULT_ZOOM_FACTOR = 1;
export const ZOOM_FACTORS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const ZOOM_STATE_VERSION = 1;
export const ZOOM_STATE_FILE = "zoom.json";

export type ZoomAction = "in" | "out" | "reset";

export interface ZoomKeyInput {
  type: string;
  key: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Snap any finite factor into the bounded, discrete zoom ladder. */
export function normalizeZoomFactor(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  const bounded = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value));
  let best = DEFAULT_ZOOM_FACTOR;
  for (const candidate of ZOOM_FACTORS) {
    if (Math.abs(candidate - bounded) < Math.abs(best - bounded)) best = candidate;
  }
  return best;
}

/** Next factor for a menu or keyboard zoom action. */
export function zoomFactorForAction(current: number, action: ZoomAction): number {
  if (action === "reset") return DEFAULT_ZOOM_FACTOR;
  const normalized = normalizeZoomFactor(current);
  const index = ZOOM_FACTORS.findIndex(factor => factor === normalized);
  const nextIndex = action === "in"
    ? Math.min(index + 1, ZOOM_FACTORS.length - 1)
    : Math.max(index - 1, 0);
  return ZOOM_FACTORS[nextIndex] ?? DEFAULT_ZOOM_FACTOR;
}

/**
 * Parse the local preference file without trusting it. Missing, malformed,
 * unknown-version and non-finite values fall back to 100%; usable out-of-range
 * values are clamped to the 80-200% policy instead of making the window
 * unusable.
 */
export function parseZoomState(text: string | null | undefined): number {
  if (!text) return DEFAULT_ZOOM_FACTOR;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return DEFAULT_ZOOM_FACTOR; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_ZOOM_FACTOR;
  const state = parsed as Record<string, unknown>;
  if (state["version"] !== ZOOM_STATE_VERSION) return DEFAULT_ZOOM_FACTOR;
  const factor = state["zoomFactor"];
  if (typeof factor !== "number" || !Number.isFinite(factor)) return DEFAULT_ZOOM_FACTOR;
  return normalizeZoomFactor(factor);
}

export function serializeZoomState(factor: number): string {
  return `${JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: normalizeZoomFactor(factor) })}\n`;
}

export function readZoomState(filePath: string): number {
  try { return parseZoomState(readFileSync(filePath, "utf8")); }
  catch { return DEFAULT_ZOOM_FACTOR; }
}

/** Replace the preference atomically so an interrupted write cannot corrupt it. */
export function writeZoomState(filePath: string, factor: number): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, serializeZoomState(factor), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/**
 * Recognize the usual zoom shortcuts, including shifted equals/plus and numpad
 * variants. The renderer cannot reach this policy; Electron delivers the input
 * to the main process before the page sees it.
 */
export function zoomActionForKey(input: ZoomKeyInput, platform: NodeJS.Platform = process.platform): ZoomAction | null {
  if (input.type !== "keyDown" || input.alt === true) return null;
  const primaryModifier = platform === "darwin"
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
  if (!primaryModifier) return null;
  const code = input.code ?? "";
  if (input.key === "0" || code === "Numpad0") return "reset";
  if (input.key === "+" || input.key === "=" || code === "NumpadAdd") return "in";
  if (input.key === "-" || input.key === "_" || code === "NumpadSubtract") return "out";
  return null;
}
