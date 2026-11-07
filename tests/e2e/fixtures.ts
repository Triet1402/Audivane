import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, type Page } from "@playwright/test";
import type {
  CanaryMaterialReport,
  DeliveredPairMeasurements,
  PairPreparationReport,
  PairValidityReport,
  PreparedArtifact,
} from "@codec-abx/contracts";
import { decodePcm16, measurePair, type PcmAudio } from "@codec-abx/measurements";
import { buildCanaryPair, preparePair } from "@codec-abx/preparation-policy";

export interface WavFixtureOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly seconds?: number;
  readonly antiPhase?: boolean;
  /** Sine amplitude before PCM16 quantization. Defaults to 0.2. */
  readonly amplitude?: number;
  /** Constant DC offset added before quantization. Defaults to 0. */
  readonly dc?: number;
}

export function makePcm16Wav(options: WavFixtureOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 48000;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 1;
  const amplitude = options.amplitude ?? 0.2;
  const dc = options.dc ?? 0;
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * channels * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = Math.round(
      (dc + amplitude * Math.sin((2 * Math.PI * 440 * frame) / sampleRate)) * 32767,
    );
    const right = options.antiPhase
      ? -left
      : Math.round(
          (dc + amplitude * Math.sin((2 * Math.PI * 660 * frame) / sampleRate)) * 32767,
        );
    for (let channel = 0; channel < channels; channel += 1) {
      bytes.writeInt16LE(channel === 1 ? right : left, 44 + (frame * channels + channel) * 2);
    }
  }
  return new Uint8Array(bytes);
}

export interface WavInspection {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly dataOffset: number;
  readonly dataSize: number;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/** Independent Node-side WAV reader: it does not trust the app's parser or metadata. */
export function inspectWav(bytes: Uint8Array): WavInspection {
  if (bytes.byteLength < 44) throw new Error("test: delivered WAV is too short");
  if (ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") {
    throw new Error("test: delivered file is not RIFF/WAVE");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bits: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) throw new Error(`test: chunk ${id} exceeds file`);
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) {
        const subFormat = view.getUint16(body + 24, true);
        if (subFormat === 1) format = 1;
      }
    }
    if (id === "data") {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }
  if (format !== 1 || bits !== 16) throw new Error("test: delivered WAV is not PCM16");
  if (channels !== 1 && channels !== 2) throw new Error("test: unexpected channel count");
  if (sampleRate === null || dataOffset === null || dataSize === null) {
    throw new Error("test: delivered WAV is missing fmt/data");
  }
  const blockAlign = channels * 2;
  if (dataSize % blockAlign !== 0) throw new Error("test: partial frame in delivered WAV");
  return {
    sampleRate,
    channels,
    frames: dataSize / blockAlign,
    dataOffset,
    dataSize,
  };
}

export function sampleAt(
  bytes: Uint8Array,
  info: WavInspection,
  frame: number,
  channel: number,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt16(info.dataOffset + (frame * info.channels + channel) * 2, true);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface DiagnosticExport {
  readonly schema: string;
  readonly exportedAt: string;
  readonly purpose: string;
  readonly engineLocation: string;
  readonly preparationPolicy: string;
  readonly supportedPreparationPolicies: readonly string[] | null;
  readonly runAuthority: string;
  readonly scientificStatus: Readonly<Record<string, unknown>>;
  readonly appliedOperations: Readonly<Record<string, unknown>> | null;
  readonly preparation: PairPreparationReport | null;
  readonly validity: PairValidityReport | null;
  readonly canary: PreparedArtifact["canary"] | null;
  readonly deliveredMeasurements: DeliveredPairMeasurements | null;
  readonly artifact: PreparedArtifact;
}

export interface NetworkGuard {
  readonly disallowed: string[];
  readonly wasmAssets: string[];
  readonly sameOriginGets: string[];
}

export async function guardNetwork(page: Page, origin: string): Promise<NetworkGuard> {
  const guard: { disallowed: string[]; wasmAssets: string[]; sameOriginGets: string[] } = {
    disallowed: [],
    wasmAssets: [],
    sameOriginGets: [],
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.continue();
      return;
    }
    const method = request.method();
    if (url.origin !== origin || (method !== "GET" && method !== "HEAD")) {
      guard.disallowed.push(`${method} ${request.url()}`);
      await route.abort("blockedbyclient");
      return;
    }
    guard.sameOriginGets.push(url.pathname);
    if (url.pathname.endsWith(".wasm")) guard.wasmAssets.push(url.pathname);
    await route.continue();
  });
  return guard;
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

export async function openLab(page: Page, origin: string): Promise<NetworkGuard> {
  const guard = await guardNetwork(page, origin);
  await page.goto(origin);
  await expect(page.locator("#capabilities-heading")).toBeVisible();
  // Real codec availability is mandatory in this suite. A missing core fails here.
  await expect(page.locator("#codec-a option[value=opus]")).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator("#codec-a option[value=noop_passthrough]")).toBeEnabled();
  // This helper exercises the explicit manual diagnostic path. The separate
  // fast-start spec verifies the ordinary user defaults and combined action.
  await page.locator(".advanced-preparation > summary").click();
  await page.locator("#preparation-policy").selectOption("codec-probe-only");
  await page.locator(".listening-test-plan > summary").click();
  await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" }))
    .toBeVisible();
  return guard;
}

export async function chooseWav(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.locator("#source-file").setInputFiles({
    name,
    mimeType: "audio/wav",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator(".file-summary")).toContainText(name);
}

export async function configure(
  page: Page,
  options: {
    readonly a?: "noop_passthrough" | "opus";
    readonly b?: "noop_passthrough" | "opus";
    readonly bitrateA?: number;
    readonly bitrateB?: number;
    readonly mode?: "native" | "force_48k";
    readonly policy?: "codec-probe-only" | "aligned-gain-matched-v1";
    readonly canary?: boolean;
  } = {},
): Promise<void> {
  if (options.a) await page.selectOption("#codec-a", options.a);
  if (options.b) await page.selectOption("#codec-b", options.b);
  if (options.bitrateA) await page.selectOption("#bitrate-a", String(options.bitrateA));
  if (options.bitrateB) await page.selectOption("#bitrate-b", String(options.bitrateB));
  if (options.mode || options.policy) {
    await page.locator(".advanced-preparation").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
  }
  if (options.mode) await page.selectOption("#rate-mode", options.mode);
  if (options.policy) await page.selectOption("#preparation-policy", options.policy);
  if (options.canary !== undefined) {
    const checkbox = page.locator("#canary-enabled");
    if (options.canary) await checkbox.check();
    else await checkbox.uncheck();
  }
}

export async function prepare(page: Page): Promise<number> {
  const started = Date.now();
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
  return Date.now() - started;
}

export async function downloadJson(page: Page): Promise<DiagnosticExport> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download JSON diagnostics" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const file = await download.path();
  if (!file) throw new Error("test: JSON download had no local path");
  return JSON.parse(await readFile(file, "utf8")) as DiagnosticExport;
}

export async function downloadWav(page: Page, side: "a" | "b"): Promise<Uint8Array> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: `Download delivered WAV ${side === "a" ? "A" : "B"}` })
      .click(),
  ]);
  const file = await download.path();
  if (!file) throw new Error("test: WAV download had no local path");
  return new Uint8Array(await readFile(file));
}

export async function downloadCanaryWav(
  page: Page,
  side: "pristine" | "degraded",
): Promise<Uint8Array> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: `Download canary WAV ${side}` }).click(),
  ]);
  const file = await download.path();
  if (!file) throw new Error("test: canary WAV download had no local path");
  return new Uint8Array(await readFile(file));
}

export function expectNoRemoteOrUpload(guard: NetworkGuard): void {
  expect(guard.disallowed, "remote/CDN or upload request was attempted").toEqual([]);
}

/**
 * Node-side measurement of the exact downloaded delivered bytes using the
 * shared, runtime-independent TypeScript measurement policy. No audio leaves
 * the process and no native codec output is reused.
 */
export function measureDelivered(
  aBytes: Uint8Array,
  bBytes: Uint8Array,
  options: {
    readonly maxLagSamples?: number;
    readonly probeSamples?: number;
  } = {},
): DeliveredPairMeasurements {
  const decode = (bytes: Uint8Array): PcmAudio => {
    const facts = inspectWav(bytes);
    return decodePcm16(bytes, {
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      dataOffset: facts.dataOffset,
      dataSize: facts.dataSize,
    });
  };
  return measurePair(decode(aBytes), decode(bBytes), options);
}

export interface PreparationResult {
  readonly schema: string;
  readonly policy: "aligned-gain-matched-v1";
  readonly report: PairPreparationReport;
  readonly delivered: DeliveredPairMeasurements;
  readonly aPrepared: Uint8Array;
  readonly bPrepared: Uint8Array;
  readonly aFacts: WavInspection;
  readonly bFacts: WavInspection;
}

/**
 * Runs the shared TypeScript preparation policy on the exact decoded PCM16
 * pair captured from the browser codec stage. Returned WAVs are compared byte
 * for byte with the browser delivery.
 */
export function prepareDelivered(
  aBytes: Uint8Array,
  bBytes: Uint8Array,
): PreparationResult {
  const decode = (bytes: Uint8Array): PcmAudio => {
    const facts = inspectWav(bytes);
    return decodePcm16(bytes, {
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      dataOffset: facts.dataOffset,
      dataSize: facts.dataSize,
    });
  };
  const result = preparePair(decode(aBytes), decode(bBytes));
  return {
    schema: "codec-abx-preparation-shared-v1",
    policy: result.report.policy,
    report: result.report,
    delivered: result.delivered,
    aPrepared: result.aWav,
    bPrepared: result.bWav,
    aFacts: inspectWav(result.aWav),
    bFacts: inspectWav(result.bWav),
  };
}

export interface CanaryMaterialResult {
  readonly schema: string;
  readonly canary: CanaryMaterialReport;
  readonly pristine: WavInspection & { readonly sha256: string };
  readonly degraded: WavInspection & { readonly sha256: string };
  readonly pristineBytes: Uint8Array;
  readonly degradedBytes: Uint8Array;
}

/**
 * Builds the same delivered-canary-v1 material from the exact final delivered
 * Side A WAV captured from the browser. Served bytes are compared by PCM
 * payload; headers are not treated as a policy contract.
 */
export function buildCanaryMaterial(aBytes: Uint8Array): CanaryMaterialResult {
  const facts = inspectWav(aBytes);
  const pcm = decodePcm16(aBytes, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
  const result = buildCanaryPair(pcm);
  return {
    schema: "codec-abx-validity-canary-shared-v1",
    canary: result.report,
    pristine: { ...inspectWav(result.pristineWav), sha256: sha256(result.pristineWav) },
    degraded: { ...inspectWav(result.degradedWav), sha256: sha256(result.degradedWav) },
    pristineBytes: result.pristineWav,
    degradedBytes: result.degradedWav,
  };
}

/** PCM sample payload only, excluding RIFF header/chunk-shape differences. */
export function pcmPayload(bytes: Uint8Array): Uint8Array {
  const info = inspectWav(bytes);
  return bytes.slice(info.dataOffset, info.dataOffset + info.dataSize);
}
