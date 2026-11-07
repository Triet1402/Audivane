import path from "node:path";
import { promises as fs } from "node:fs";
import { freezeRequest } from "@codec-abx/contracts";

export const APP_URL = "codec-abx://app/index.html";
export const IPC_PREFIX = "codec-abx:desktop:v1:";
/** Local source extensions accepted by the native executor and picker. */
export const SOURCE_EXTENSIONS = [
  "wav", "flac", "mp3", "aac", "m4a", "mp4", "ogg", "oga", "opus",
] as const;
export const SOURCE_EXTENSION_PATTERN = new RegExp(
  `\\.(${SOURCE_EXTENSIONS.join("|")})$`,
  "i",
);
export const OPERATIONS = ["pickSource", "capabilities", "prepare", "cancel", "readAudio", "readCanaryAudio", "release", "configure", "snapshot", "bindPrepared", "nextTrial", "answer", "trialAudio", "seal", "reset", "export", "dispose"] as const;
export type Operation = typeof OPERATIONS[number];
export class BoundaryError extends Error {
  readonly reasons: readonly string[] = [];
  readonly uncertain = false;
  constructor(readonly code: string, message: string) { super(message); }
}
export function fail(code = "invalid-request", message = "Desktop request refused"): never { throw new BoundaryError(code, message); }
export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) fail();
}
export function handle(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(value)) fail();
}
/** A bounded correlation ID can be echoed even when authorization/arguments fail. */
export function correlationId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "id")) fail();
  const id = (value as Record<string, unknown>).id;
  handle(id);
  return id;
}
export function validateRequest(operation: Operation, value: unknown): { id: string; args: unknown[] } {
  exact(value, ["version", "id", "args"]);
  if (value.version !== 1) fail();
  handle(value.id);
  if (!Array.isArray(value.args)) fail();
  const a: unknown[] = value.args;
  const lengths: Record<Operation, number[]> = { pickSource: [0], capabilities: [0], prepare: [3], cancel: [1], readAudio: [2], readCanaryAudio: [2], release: [1], configure: [1], snapshot: [0], bindPrepared: [1], nextTrial: [0], answer: [2], trialAudio: [2], seal: [0, 1], reset: [0], export: [0], dispose: [0] };
  if (!lengths[operation].includes(a.length)) fail();
  if (["prepare", "cancel", "readAudio", "readCanaryAudio", "release", "bindPrepared", "answer", "trialAudio"].includes(operation)) handle(a[0]);
  if (operation === "prepare") {
    exact(a[1], ["version", "sampleRateMode", "a", "b"], ["preparationPolicy", "canaryEnabled"]);
    if (a[1].version === 1) {
      exact(a[1].a, ["codecId", "bitrateKbps"]); exact(a[1].b, ["codecId", "bitrateKbps"]);
    } else if (a[1].version === 2) {
      for (const side of [a[1].a, a[1].b]) {
        if (!Array.isArray(side) || side.length < 1 || side.length > 4) fail();
        for (const stage of side) exact(stage, ["codecId", "bitrateKbps"]);
      }
    } else fail();
    if (a[1].preparationPolicy !== "aligned-gain-matched-v1") fail("invalid-request", "Desktop preparation requires aligned-gain-matched-v1");
    try { freezeRequest(a[1]); } catch { fail(); }
    handle(a[2]);
  }
  if (operation === "configure") {
    exact(a[0], ["version", "plannedTrials", "alpha", "labelMode", "calibrationEnabled"]);
    const p = a[0];
    if (p.version !== 1 || (p.plannedTrials !== null && (typeof p.plannedTrials !== "number" || !Number.isSafeInteger(p.plannedTrials) || p.plannedTrials < 1 || p.plannedTrials > 1000)) || typeof p.alpha !== "number" || !Number.isFinite(p.alpha) || p.alpha <= 0 || p.alpha >= 1 || !["fixed", "blind_random"].includes(String(p.labelMode)) || typeof p.calibrationEnabled !== "boolean") fail();
  }
  if (operation === "readAudio" && a[1] !== "a" && a[1] !== "b") fail();
  if (operation === "readCanaryAudio" && a[1] !== "pristine" && a[1] !== "degraded") fail();
  if (operation === "answer" && a[1] !== "A" && a[1] !== "B") fail();
  if (operation === "trialAudio" && a[1] !== "A" && a[1] !== "B" && a[1] !== "X") fail();
  if (operation === "seal" && a.length && (typeof a[0] !== "string" || a[0].length < 1 || a[0].length > 512 || /[\x00-\x1f]/.test(a[0]))) fail();
  return { id: value.id, args: a };
}
export function allowedDocument(url: string): boolean { return url === APP_URL; }
export function allowedResource(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "codec-abx:" && u.host === "app" && !u.username && !u.password && !u.port && !u.search && !u.hash; } catch { return false; }
}
/** Realpath containment also rejects symlinks out of the packaged asset directory. */
export async function assetPath(root: string, url: string): Promise<string> {
  if (!allowedResource(url)) fail("forbidden", "Only bundled local assets may be read");
  const parsed = new URL(url);
  let name: string;
  try { name = decodeURIComponent(parsed.pathname); } catch { return fail("forbidden"); }
  if (name.includes("\\") || name.includes("\0") || name.split("/").some(p => p === ".." || p === ".")) fail("forbidden");
  const base = await fs.realpath(root);
  const candidate = await fs.realpath(path.resolve(base, `.${name}`));
  const rel = path.relative(base, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail("forbidden");
  return candidate;
}
export function allowedDownload(url: string, mime: string, chain: readonly string[]): boolean {
  return /^blob:codec-abx:\/\/app\/[a-f0-9-]{36}$/i.test(url) && chain.length === 1 && chain[0] === url && ["application/json", "audio/wav", "audio/x-wav", "text/plain"].includes(mime);
}
