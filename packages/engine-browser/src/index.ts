import {
  freezeRequest,
  CODEC_IDS,
  stagesForSide,
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_WAV_BYTES,
  type CanarySide,
  type CodecCapability,
  type CodecSelection,
  type DeliveredPairMeasurements,
  type EngineCapabilities,
  type LevelMeasurement,
  type PairPreparationReport,
  type PairValidityReport,
  type PreparedArtifact,
  type PreparationPolicyId,
  type PreparationProgress,
  type PreparationRequest,
  type Side,
  type StageProvenance,
  type TrackProvenance,
} from "@codec-abx/contracts";
import {
  codecInputChannels,
  codecInternalRate,
  implementedPlan,
  probedPlan,
  supplementalPlan,
  type SupplementalPlan,
} from "./codec-plan.js";
import {
  SupplementalCodecRuntime,
  createLc3DecoderSession,
  createLc3EncoderSession,
  createLdacDecoderSession,
  createLdacEncoderSession,
  type SupplementalCodecId,
} from "./supplemental-codecs.js";
import {
  Lc3ContainerWriter,
  type Lc3ContainerHeader,
  lc3FrameSamples,
  parseLc3Header,
  parseLc3Frames,
} from "./lc3-container.js";
import {
  parseLdacContainerAsync,
  writeLdacContainerAsync,
  type LdacContainerAsyncProgress,
} from "./ldac-container.js";
import type { PreparationEngine, PrepareOptions } from "@codec-abx/preparation";
import {
  DEFAULT_MAX_LAG_SAMPLES,
  DEFAULT_PROBE_SAMPLES,
} from "@codec-abx/measurements";
import { FFmpeg } from "@ffmpeg/ffmpeg";

import type {
  MeasurementWorkerRequest,
  MeasurementWorkerResponse,
  PreparationWorkerRequest,
  PreparationWorkerResult,
} from "./measurement-protocol.js";
import {
  assertCanaryMaterial,
  assertDeliveredNullDepth,
  assertValidityReport,
  type ValidatedCanary,
} from "./result-validation.js";
import {
  BROWSER_CHAIN_PADDING_TOLERANCE_SECONDS,
  BROWSER_MAX_WAV_BYTES,
  BROWSER_SOURCE_SAMPLE_RATES,
  buildPcm16Wav,
  parsePcm16Samples,
  parsePcm16Wav,
  sha256Hex,
  wavDescription,
  type WavFacts,
} from "./wav.js";
import {
  decodeAudioSource,
  formatByteCount,
  snapshotAudioSource,
  assertSourceByteLength,
  type ImportedAudioSource,
} from "./source-import.js";

export {
  BROWSER_AUDIO_IMPORT_FORMATS,
} from "./source-import.js";
export type {
  AudioImportFormat,
  AudioImportFormatId,
} from "./source-import.js";

/** Pinned wrapper/core provenance. Kept explicit in every capability report. */
export const FFMPEG_WRAPPER_VERSION = "0.12.15";
export const FFMPEG_CORE_VERSION = "0.12.10";

/** Browser-supported policies. Omission selects the raw codec-probe default. */
export const BROWSER_DEFAULT_PREPARATION_POLICY = "codec-probe-only" as const;
export const BROWSER_SUPPORTED_PREPARATION_POLICIES = [
  "codec-probe-only",
  "aligned-gain-matched-v1",
] as const satisfies readonly PreparationPolicyId[];
const BROWSER_PREPARATION_POLICY: PreparationPolicyId = "aligned-gain-matched-v1";
// Wire-contract constants are checked independently of worker computation;
// changing its policy must not silently widen the adapter's acceptance.
const PCM16_FLOOR_BIAS_CODE_STEPS = 2 ** -17;

export interface BrowserPreparationEngineOptions {
  /** Same-origin URL of ffmpeg-core.js. There is deliberately no CDN default. */
  readonly coreURL: string;
  /** Same-origin URL of ffmpeg-core.wasm. */
  readonly wasmURL: string;
  /**
   * Optional same-origin URL of the supplemental LC3 codec's .wasm asset (the
   * sibling .js Emscripten glue is fetched from the same basename). When
   * omitted, LC3 requests refuse before source reads, exactly like a missing
   * native helper; no substitute or native fallback is ever used.
   */
  readonly lc3WasmURL?: string | null;
  /** Optional same-origin URL of the supplemental LDAC codec's .wasm asset. */
  readonly ldacWasmURL?: string | null;
  /** Optional diagnostic sink for FFmpeg log lines. Never receives audio bytes. */
  readonly logger?: (line: string) => void;
}

interface ProbeResult {
  readonly ffmpegVersion: string | null;
  readonly encoderNames: ReadonlySet<string>;
  readonly decoderNames: ReadonlySet<string>;
}

/**
 * Supplemental (LC3/LDAC) stage metadata carried back from the WASM round trip
 * into processTrack's shared bookkeeping. Nothing here comes from the caller.
 */
interface SupplementalStageMeta {
  readonly encodedSize: number;
  /** LDAC's native "container bytes over header sample duration" basis. */
  readonly actualBitrateKbps: number | null;
  readonly notes: string[];
}

interface EnsureProbe {
  readonly probe: ProbeResult | null;
  readonly failure: string | null;
}

interface ProcessedTrack {
  readonly notes: readonly string[];
  readonly stages: readonly StageProvenance[];
  readonly bytes: Uint8Array;
  readonly facts: WavFacts;
  readonly sha256: string;
  readonly requested: CodecSelection;
  readonly encoder: string;
  readonly decoder: string;
  readonly actualBitrateKbps: number | null;
  readonly encodedSampleRate: number | null;
}

interface PreparedPair {
  readonly aBytes: Uint8Array;
  readonly bBytes: Uint8Array;
  readonly aFacts: WavFacts;
  readonly bFacts: WavFacts;
  readonly report: PairPreparationReport;
  readonly delivered: DeliveredPairMeasurements;
  readonly preflightDisclosure: string | null;
  readonly validity: PairValidityReport;
  readonly canary: ValidatedCanary | null;
}

interface BrowserJob {
  readonly id: string;
  readonly request: PreparationRequest;
  readonly externalSignal: AbortSignal | null;
  readonly abort: AbortController;
  onExternalAbort: (() => void) | null;
  aborted: boolean;
  cancelError: unknown;
  cleanup: Promise<void> | null;
  completion: Promise<PreparedArtifact> | null;
  measurementWorker: Worker | null;
  measurementTermination: Promise<void> | null;
}

interface OwnedArtifact {
  readonly audio: Readonly<Record<Side, Uint8Array>>;
  /** Usable canary bytes only; null/absent when disabled or unusable. */
  readonly canary: Readonly<Record<CanarySide, Uint8Array>> | null;
}

const PROGRESS_COMPLETE: PreparationProgress = {
  phase: "complete",
  message: "Browser diagnostic preparation complete",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Browser heap/WASM memory exhaustion must be reported as a bounded, actionable
 * refusal. The shared byte ceilings describe policy, not a guarantee that every
 * renderer can allocate the largest layout.
 */
function isBrowserMemoryFailure(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  return error instanceof RangeError ||
    /out of memory|allocation failed|cannot enlarge|memory access out of bounds|wasm memory|aborted\(/.test(text);
}

function browserMemoryError(error: unknown): unknown {
  if (!isBrowserMemoryFailure(error)) return error;
  return new Error(
    "Browser audio processing ran out of available WebAssembly/renderer memory: " +
      `${errorMessage(error)}. The local audio envelope is a policy ceiling, not a guaranteed ` +
      "browser capacity. Use shorter material, explicit 48 kHz, or mono audio and retry. No " +
      "partial or shortened audio was delivered.",
  );
}

function abortError(): Error {
  return new DOMException("Preparation aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function disposedError(): Error {
  return new Error("Browser preparation engine has been disposed");
}

/** Honest bounded-slice progress wording for the LDAC container work. */
function ldacContainerStageMessage(
  label: string,
  verb: "writing" | "validating",
  progress: LdacContainerAsyncProgress,
): string {
  const percent = progress.total > 0
    ? Math.min(100, Math.floor((progress.done / progress.total) * 100))
    : 100;
  if (progress.phase === "crc") {
    return `${label}: ${verb === "writing" ? "computing" : "verifying"} LDAC container CRC-32, ` +
      `${String(percent)}%`;
  }
  const verbPhrase = verb === "writing"
    ? (progress.phase === "frames" ? "sizing" : "copying")
    : "walking";
  return `${label}: ${verbPhrase} LDAC frame records ` +
    `${String(progress.done)}/${String(progress.total)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function codedError(message: string, code: string | undefined): Error {
  const error = new Error(message);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

function measurementFailed(error: unknown): Error {
  return codedError(
    `Delivered pair measurement failed: ${errorMessage(error)}`,
    isRecord(error) && typeof error.code === "string" ? error.code : undefined,
  );
}

function preparationFailed(error: unknown): Error {
  return codedError(
    `Aligned/gain-matched preparation failed: ${errorMessage(error)}`,
    isRecord(error) && typeof error.code === "string" ? error.code : undefined,
  );
}

function assertLevel(value: unknown, label: string): LevelMeasurement {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error(`${label} has an invalid status`);
  }
  switch (value.status) {
    case "finite":
      if (typeof value.value !== "number" || !Number.isFinite(value.value) ||
          value.reason !== null) {
        throw new Error(`${label} has an invalid finite value`);
      }
      break;
    case "negative-infinity":
    case "undefined":
    case "unavailable":
      if (value.value !== null || typeof value.reason !== "string" ||
          value.reason.length === 0) {
        throw new Error(`${label} has an invalid non-finite value`);
      }
      break;
    default:
      throw new Error(`${label} has an unknown status`);
  }
  return value as unknown as LevelMeasurement;
}

function assertSummary(value: unknown, label: string): void {
  if (!isRecord(value) || (value.channels !== 1 && value.channels !== 2) ||
      typeof value.sampleRate !== "number" || !Number.isInteger(value.sampleRate) ||
      typeof value.frames !== "number" || !Number.isSafeInteger(value.frames) ||
      value.frames <= 0) {
    throw new Error(`${label} summary is invalid`);
  }
  assertLevel(value.integratedLufs, `${label} integrated loudness`);
  assertLevel(value.samplePeakDbfs, `${label} sample peak`);
}

function assertMeasurements(value: unknown): DeliveredPairMeasurements {
  if (!isRecord(value) || value.policy !== "delivered-pcm-measurements-v1" ||
      !isRecord(value.a) || !isRecord(value.b) || !isRecord(value.alignment) ||
      !isRecord(value.nullDepth) || !Array.isArray(value.notes) ||
      value.notes.some((note) => typeof note !== "string")) {
    throw new Error("Measurement worker returned an invalid result");
  }
  const alignment = value.alignment;
  if (typeof alignment.lagSamples !== "number" ||
      !Number.isSafeInteger(alignment.lagSamples) ||
      typeof alignment.confidence !== "number" || !Number.isFinite(alignment.confidence) ||
      (alignment.status !== "estimated" && alignment.status !== "no-evidence") ||
      typeof alignment.maxLagSamples !== "number" ||
      !Number.isSafeInteger(alignment.maxLagSamples) ||
      typeof alignment.probeSamples !== "number" ||
      !Number.isSafeInteger(alignment.probeSamples) ||
      alignment.maxLagSamples < 0 || alignment.probeSamples < 2 ||
      Math.abs(alignment.lagSamples) > alignment.maxLagSamples ||
      alignment.confidence < 0 || alignment.confidence > 1 ||
      (alignment.status === "estimated" && alignment.confidence === 0)) {
    throw new Error("Measurement worker returned invalid alignment data");
  }
  if (alignment.status === "no-evidence" &&
      (alignment.lagSamples !== 0 || alignment.confidence !== 0)) {
    throw new Error("Measurement worker returned inconsistent no-evidence alignment");
  }
  const nullDepth = value.nullDepth;
  if (nullDepth.basis !== "unshifted-common-prefix" ||
      typeof nullDepth.comparedFrames !== "number" ||
      !Number.isSafeInteger(nullDepth.comparedFrames) || nullDepth.comparedFrames < 0) {
    throw new Error("Measurement worker returned invalid null-depth data");
  }
  assertLevel(nullDepth.depthDb, "null depth");
  assertLevel(value.loudnessDeltaDb, "loudness delta");
  assertSummary(value.a, "Side A");
  assertSummary(value.b, "Side B");
  if (value.a.sampleRate !== value.b.sampleRate || value.a.channels !== value.b.channels ||
      nullDepth.comparedFrames !== Math.min(value.a.frames as number, value.b.frames as number)) {
    throw new Error("Measurement worker returned inconsistent pair layout or null frame count");
  }
  return value as unknown as DeliveredPairMeasurements;
}

/**
 * Fail closed on a preparation result. The report must agree with the exact
 * transferred WAV bytes and the codec-stage inputs; provenance hashes are
 * recomputed by the caller, never taken from the worker.
 */
async function assertPreparationResult(
  message: PreparationWorkerResult,
  inputA: WavFacts,
  inputB: WavFacts,
  request: PreparationRequest,
): Promise<PreparedPair> {
  const report = message.report;
  if (!isRecord(report) || report.policy !== "aligned-gain-matched-v1" ||
      report.targetLufs !== -16 || report.minimumDurationSeconds !== 0.4 ||
      report.maxLagSeconds !== 0.1 || typeof report.peakCeiling !== "number" ||
      report.peakCeiling !== 32767 / 32768 ||
      !isRecord(report.alignment) || !isRecord(report.loudness) ||
      !isRecord(report.serialization) || !Array.isArray(report.notes) ||
      report.notes.some((note) => typeof note !== "string")) {
    throw new Error("Preparation worker returned an invalid report");
  }
  const alignment = report.alignment;
  const lagSamples = alignment.lagSamples;
  if (typeof lagSamples !== "number" || !Number.isSafeInteger(lagSamples) ||
      typeof alignment.confidence !== "number" || !Number.isFinite(alignment.confidence) ||
      (alignment.status !== "estimated" && alignment.status !== "no-evidence") ||
      typeof inputA?.frames !== "number" || typeof inputB?.frames !== "number") {
    throw new Error("Preparation worker returned invalid alignment fields");
  }
  const startFrameA = Math.max(0, -lagSamples);
  const startFrameB = Math.max(0, lagSamples);
  const framesA = alignment.inputFramesA;
  const framesB = alignment.inputFramesB;
  const outputFrames = alignment.outputFrames;
  if (framesA !== inputA.frames || framesB !== inputB.frames ||
      alignment.startFrameA !== startFrameA || alignment.startFrameB !== startFrameB ||
      outputFrames !== Math.min(framesA - startFrameA, framesB - startFrameB) ||
      !Number.isSafeInteger(outputFrames) || outputFrames < 0.4 * inputA.sampleRate) {
    throw new Error("Preparation worker report does not match its input frames");
  }
  if (alignment.status === "no-evidence" &&
      (lagSamples !== 0 || alignment.confidence !== 0)) {
    throw new Error("Preparation worker returned inconsistent no-evidence alignment");
  }
  if (typeof alignment.maxLagSamples !== "number" ||
      !Number.isSafeInteger(alignment.maxLagSamples) ||
      typeof alignment.probeSamples !== "number" ||
      !Number.isSafeInteger(alignment.probeSamples) ||
      alignment.maxLagSamples !== Math.floor(0.1 * inputA.sampleRate) ||
      alignment.probeSamples !== 240_000 || Math.abs(lagSamples) > alignment.maxLagSamples ||
      alignment.confidence < 0 || alignment.confidence > 1 ||
      (alignment.status === "estimated" && alignment.confidence === 0)) {
    throw new Error("Preparation worker returned invalid measurement bounds");
  }

  const loudness = report.loudness;
  if (typeof loudness.gainADb !== "number" || !Number.isFinite(loudness.gainADb) ||
      typeof loudness.gainBDb !== "number" || !Number.isFinite(loudness.gainBDb) ||
      typeof loudness.commonTrimDb !== "number" ||
      !Number.isFinite(loudness.commonTrimDb) || loudness.commonTrimDb < 0) {
    throw new Error("Preparation worker returned invalid gain or trim values");
  }
  const preA = assertLevel(loudness.preA, "pre-gain A");
  const preB = assertLevel(loudness.preB, "pre-gain B");
  if (preA.status !== "finite" || preB.status !== "finite") {
    throw new Error("Preparation worker returned a non-finite pre-gain level");
  }
  if (Math.abs(loudness.gainADb - (report.targetLufs - preA.value)) > 1e-9 ||
      Math.abs(loudness.gainBDb - (report.targetLufs - preB.value)) > 1e-9) {
    throw new Error("Preparation worker returned gains inconsistent with its target and pre-gain levels");
  }

  const serialization = report.serialization;
  if (serialization.format !== "pcm16-le" || serialization.rounding !== "floor" ||
      serialization.floorBiasCodeSteps !== PCM16_FLOOR_BIAS_CODE_STEPS ||
      serialization.dither !== false) {
    throw new Error("Preparation worker returned an unexpected serialization policy");
  }

  if (!(message.a instanceof ArrayBuffer) || !(message.b instanceof ArrayBuffer)) {
    throw new Error("Preparation worker must return serialized WAV ArrayBuffers");
  }
  const aBytes = new Uint8Array(message.a);
  const bBytes = new Uint8Array(message.b);
  const aFacts = parsePcm16Wav(aBytes);
  const bFacts = parsePcm16Wav(bBytes);
  if (aFacts.sampleRate !== inputA.sampleRate ||
      bFacts.sampleRate !== inputB.sampleRate ||
      aFacts.channels !== inputA.channels || bFacts.channels !== inputB.channels ||
      aFacts.frames !== outputFrames || bFacts.frames !== outputFrames ||
      aFacts.frames !== bFacts.frames) {
    throw new Error("Preparation worker WAV bytes disagree with its report layout");
  }

  const delivered = assertMeasurements(message.delivered);
  if (delivered.alignment.maxLagSamples !== alignment.maxLagSamples ||
      delivered.alignment.probeSamples !== alignment.probeSamples) {
    throw new Error("Preparation worker returned inconsistent residual measurement bounds");
  }
  for (const [side, facts] of [["a", aFacts], ["b", bFacts]] as const) {
    const summary = delivered[side];
    if (summary.sampleRate !== facts.sampleRate ||
        summary.channels !== facts.channels || summary.frames !== facts.frames) {
      throw new Error(`Preparation worker residual side ${side} disagrees with its bytes`);
    }
    if (summary.integratedLufs.status !== "finite" || summary.samplePeakDbfs.status !== "finite") {
      throw new Error("Preparation worker returned non-finite delivered levels");
    }
  }
  assertDeliveredNullDepth(delivered.nullDepth.depthDb, aBytes, aFacts, bBytes, bFacts);
  const validity = assertValidityReport(message.validity, request,
    delivered.nullDepth.depthDb, message.relation);
  const preflightDisclosure = message.preflightDisclosure;
  if (preflightDisclosure !== null &&
      (typeof preflightDisclosure !== "string" || preflightDisclosure.length === 0)) {
    throw new Error("Preparation worker returned an invalid preflight disclosure");
  }
  if (request.canaryEnabled === true && message.canary === undefined) {
    throw new Error("Preparation worker omitted the requested canary material report");
  }
  if (request.canaryEnabled !== true && message.canary !== undefined) {
    throw new Error("Preparation worker returned canary material that was not requested");
  }
  const canary = await assertCanaryMaterial(message.canary, aBytes, aFacts);
  return {
    aBytes,
    bBytes,
    aFacts,
    bFacts,
    report: report as unknown as PairPreparationReport,
    delivered,
    preflightDisclosure,
    validity,
    canary,
  };
}


/** Explicit JSON-safe meaning for a level value; null never stands alone. */
function levelNote(level: LevelMeasurement, unit: string): string {
  switch (level.status) {
    case "finite":
      return `${level.value.toFixed(6)} ${unit}`;
    case "negative-infinity":
      return `negative infinity ${unit} (${level.reason})`;
    case "undefined":
      return `undefined ${unit} (${level.reason})`;
    case "unavailable":
      return `unavailable ${unit} (${level.reason})`;
  }
}

function measurementNotes(
  delivered: DeliveredPairMeasurements,
  ffmpegVersion: string | null,
  preparation: PairPreparationReport | null,
): string[] {
  const alignment = delivered.alignment;
  const common = [
    ...delivered.notes,
    `Measurement bounds: maxLagSamples ${String(alignment.maxLagSamples)}, ` +
      `probeSamples ${String(alignment.probeSamples)} (${preparation ? "preparation policy" : "reference defaults"}).`,
    `Side A integrated loudness ${levelNote(delivered.a.integratedLufs, "LUFS")}; ` +
      `sample peak ${levelNote(delivered.a.samplePeakDbfs, "dBFS")} (sample peak, not true peak).`,
    `Side B integrated loudness ${levelNote(delivered.b.integratedLufs, "LUFS")}; ` +
      `sample peak ${levelNote(delivered.b.samplePeakDbfs, "dBFS")} (sample peak, not true peak).`,
    `Loudness delta ${levelNote(delivered.loudnessDeltaDb, "dB")}.`,
  ];
  if (preparation) {
    const applied = preparation.alignment;
    return [
      ...common,
      `Residual alignment lag is ${String(delivered.alignment.lagSamples)} samples ` +
        `(positive means B is delayed) with confidence ` +
        `${delivered.alignment.confidence.toExponential(6)}. The applied alignment was ` +
        `${String(applied.lagSamples)} samples with status ${applied.status}; applied head ` +
        `trim was A ${String(applied.startFrameA)} and B ${String(applied.startFrameB)} ` +
        `frames, producing ${String(applied.outputFrames)} output frames.`,
      `Residual final-delivery null depth ${levelNote(delivered.nullDepth.depthDb, "dB")} ` +
        `over ${String(delivered.nullDepth.comparedFrames)} compared frames; this is not ` +
        "the pre-crop unshifted null.",
      "Aligned/gain-matched preparation and PCM16 serialization ran on the decoded codec " +
        "outputs. The applied independent gains were " +
        `${preparation.loudness.gainADb.toFixed(6)} dB (A) and ` +
        `${preparation.loudness.gainBDb.toFixed(6)} dB (B), followed by one common peak ` +
        `trim of ${preparation.loudness.commonTrimDb.toFixed(6)} dB. No bandwidth ` +
        "filtering, listener canary gate or ABX scoring has run; the delivered null " +
        "decision is reported separately.",
      "The artifact WAV hashes, frame counts and retained bytes describe the final " +
        "corrected PCM16 delivery. Encoded actual bitrate still uses each pre-crop codec-stage " +
        "duration for each individual stage and includes its container overhead and padding.",
      "Browser WASM codec output is not expected to be byte-identical to the native " +
        `FFmpeg reference across builds or architectures (FFmpeg ${ffmpegVersion ?? "unknown"}). ` +
        "This is not a codec-equivalence guarantee.",
    ];
  }
  return [
    ...common,
    alignment.status === "estimated"
      ? `Alignment lag estimated at ${String(alignment.lagSamples)} samples ` +
        `(positive means B is delayed) with confidence ${alignment.confidence.toExponential(6)}. ` +
        "The estimate was not applied; delivered samples were not shifted."
      : "Alignment reported no evidence (silence, DC or a zero correlation peak); " +
        "lag and confidence are zero and no lag was invented or applied.",
    `Unshifted common-prefix null depth ${levelNote(delivered.nullDepth.depthDb, "dB")} ` +
      `over ${String(delivered.nullDepth.comparedFrames)} compared frames.`,
    "An exact nonzero no-op null is reported as negative infinity; an undefined ratio " +
      "means the reference was silent; unavailable with a reason means the clip is too " +
      "short for integrated loudness or a level is not finite.",
    "No alignment shift, gain matching, common peak trim, bandwidth filtering, validity " +
      "evaluation, canary material or ABX scoring has run.",
    "Encoded actual bitrate uses each stage’s encoded container bytes divided by its own " +
      "decoded duration before final correction, including container overhead and padding.",
    "Browser WASM codec output is not expected to be byte-identical to the native " +
      `FFmpeg reference across builds or architectures (FFmpeg ${ffmpegVersion ?? "unknown"}).`,
  ];
}


function randomId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseNameListing(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)\s+/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

function parseVersion(output: string): string | null {
  const match = /ffmpeg version (\S+)/i.exec(output);
  return match?.[1] ?? null;
}

function sameOriginAsset(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be an absolute same-origin URL`);
  }
  const location = globalThis.location;
  if (location && parsed.origin !== location.origin) {
    throw new Error(`${label} must be same-origin; runtime CDN assets are not supported`);
  }
  return parsed.href;
}

/** The browser default is raw measurement. */
function browserPolicy(request: PreparationRequest): PreparationPolicyId {
  const policy = request.preparationPolicy ?? BROWSER_DEFAULT_PREPARATION_POLICY;
  if (policy !== "codec-probe-only" && policy !== BROWSER_PREPARATION_POLICY) {
    throw new Error(`Browser engine does not support preparation policy ${String(policy)}`);
  }
  return policy;
}

function trackProvenance(
  processed: ProcessedTrack,
  deliveredBytes: Uint8Array,
  deliveredFacts: WavFacts,
  deliveredSha256: string,
): TrackProvenance {
  return Object.freeze({
    requested: processed.requested,
    encoder: processed.encoder,
    decoder: processed.decoder,
    actualBitrateKbps: processed.actualBitrateKbps,
    encodedSampleRate: processed.encodedSampleRate,
    stages: processed.stages,
    delivered: wavDescription(deliveredBytes, deliveredSha256),
  });
}

function artifactDisclosures(
  policy: PreparationPolicyId,
  ffmpegVersion: string | null,
  canaryEnabled: boolean,
): string[] {
  const common = [
    "Browser-local processing: audio bytes remain in this tab and its dedicated " +
      "codec and numerical workers.",
    "Diagnostic only; this artifact is not a scientifically prepared ABX comparison.",
    "Opus is encoded at 48 kHz internally with 10 ms frames to avoid a known " +
      "@ffmpeg/core 0.12.10 libopus 48 kHz trap; delivered rate follows the selected " +
      "native/force-48 kHz policy.",
    "AAC/MP3/MP2/SBC use 48 kHz internally for 96 kHz sessions; aptX and aptX HD are " +
      "pinned to 48 kHz internally for every session because their raw containers carry no usable " +
      "rate metadata. Every stage restores the session rate and channels. " +
      "Codec padding or shorter decoder output is retained in raw mode; encoded input above " +
      `${formatByteCount(AUDIO_MAX_INPUT_BYTES)}, a decoded source above ` +
      `${String(AUDIO_MAX_DURATION_SECONDS)} s plus at most 0.1 s codec padding, or a canonical ` +
      `WAV above ${formatByteCount(AUDIO_MAX_WAV_BYTES)} is refused without hidden trimming.`,
    "MP2 uses FFmpeg's built-in mp2 encoder in the pinned WASM core, not native libtwolame; " +
      "no native/WASM MP2 quality or byte parity is claimed.",
    "aptX and aptX HD are fixed-rate and stereo-only in this core. Requested 352/576 kbps are " +
      "nominal; the adapter's disclosed 48 kHz internal payload measures 384 kbps for aptX and " +
      "576 kbps for aptX HD. Mono sessions are carried as dual-mono inside the codec and restored " +
      "to mono; actual bitrate comes from the raw container bytes and decoded duration.",
    "LC3 and LDAC do not run in the pinned @ffmpeg/core. When this app bundle " +
      "serves their supplemental same-origin WASM modules, LC3 uses the pinned " +
      "liblc3 1.1.3 encoder/decoder and LDAC uses the AOSP libldac 2.00.02 " +
      "encoder with the third-party reverse-engineered hegdi/libldacdec decoder " +
      "(ldac_helper v1 container). Bundles without those modules refuse LC3/LDAC " +
      "requests before source reads; no aliasing, simulation or native fallback " +
      "is offered either way.",
    "Requested bitrate is unchanged; actual bitrate uses each stage’s encoded bytes and own decoded pre-correction duration, including container overhead and codec padding.",
    `Built from @ffmpeg/ffmpeg ${FFMPEG_WRAPPER_VERSION}, @ffmpeg/core ` +
      `${FFMPEG_CORE_VERSION} (single-thread WASM), FFmpeg ` +
      `${ffmpegVersion ?? "unknown"}.`,
  ];
  if (policy === BROWSER_PREPARATION_POLICY) {
    return [
      ...common,
      "preparationPolicy aligned-gain-matched-v1 ran on the decoded codec-stage outputs: " +
        "shared lag/crop, independent constant gains and one common peak trim, then " +
        "canonical PCM16 serialization and independent remeasurement of the final bytes.",
      "Before that correction, the preparation-validity-v2 preflight evaluated the exact " +
        "decoded codec-stage pair. Non-evidentiary, globally inverted, weak, unrelated and " +
        "search-bound pairs were refused with preparation-gate-failed; periodic/ambiguous " +
        "passes carry an explicit no-unique-lag disclosure. Delivered validity v2 also " +
        "reports the gate on the exact final serialized pair.",
      "Artifact WAV hashes, layouts, frame counts and retained bytes describe the final " +
        "corrected delivery. Actual encoded bitrate provenance retains the pre-crop " +
        "codec-stage duration.",
      "This is the shared browser diagnostic policy, not a native execution claim " +
        "and not a claim that browser and native codec output are equivalent.",
      "The frozen identical-pipeline null decision was evaluated on the final delivered " +
        "pair. It is a diagnostic delivered-audio check, not experiment authority.",
      canaryEnabled
        ? "Diagnostic canary material was requested and generated from the final delivered " +
          "Side A. A usable result is not proof of human audibility, a calibration trial or " +
          "a valid ABX run. No listener calibration trial, listener canary gate or ABX " +
          "scoring ran."
        : "No canary material was requested. No bandwidth filtering, listener canary gate " +
          "or ABX scoring ran.",
    ];
  }
  return [
    ...common,
    "preparationPolicy remains codec-probe-only: delivered PCM was measured, but no " +
      "gain matching, alignment shift, common peak trim, bandwidth filtering, validity " +
      "evaluation, canary material or ABX scoring was applied.",
    "Estimated lag is reported only; it was not applied to the delivered audio, so " +
      "the null depth is unshifted common-prefix null depth.",
  ];
}


/**
 * Browser-local adapter using the real @ffmpeg/ffmpeg dedicated worker and a
 * packaged single-thread WASM core. The UI thread never executes FFmpeg.
 *
 * Delivered PCM is measured in a second, short-lived dedicated worker. The
 * estimates describe unchanged delivered bytes; preparationPolicy remains
 * codec-probe-only because no alignment, gain matching, trim, gate or scoring
 * is applied.
 */
export class BrowserPreparationEngine implements PreparationEngine<File> {
  private readonly coreURL: string;
  private readonly wasmURL: string;
  private readonly lc3WasmURL: string | null;
  private readonly ldacWasmURL: string | null;
  private readonly supplemental: SupplementalCodecRuntime;
  private readonly logger: ((line: string) => void) | undefined;

  private readonly lifecycle = new AbortController();
  private readonly artifacts = new Map<string, OwnedArtifact>();
  private readonly operations = new Set<Promise<unknown>>();
  private queue: Promise<void> = Promise.resolve();

  private worker: FFmpeg | null = null;
  private workerInit: Promise<void> | null = null;
  private workerReady = false;
  private workerGeneration = 0;
  private probeCache: ProbeResult | null = null;
  private lastSupplementalYield = 0;
  private supplementalProbeTimedOut = false;

  private activeJob: BrowserJob | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: BrowserPreparationEngineOptions) {
    if (!options || typeof options.coreURL !== "string" || typeof options.wasmURL !== "string") {
      throw new Error("Browser engine requires explicit same-origin coreURL and wasmURL");
    }
    this.coreURL = sameOriginAsset(options.coreURL, "coreURL");
    this.wasmURL = sameOriginAsset(options.wasmURL, "wasmURL");
    this.lc3WasmURL = options.lc3WasmURL == null ? null
      : sameOriginAsset(options.lc3WasmURL, "lc3WasmURL");
    this.ldacWasmURL = options.ldacWasmURL == null ? null
      : sameOriginAsset(options.ldacWasmURL, "ldacWasmURL");
    this.supplemental = new SupplementalCodecRuntime({
      lc3HelperUrl: this.lc3WasmURL,
      ldacHelperUrl: this.ldacWasmURL,
    }, this.lifecycle.signal);
    this.logger = options.logger;
  }

  async capabilities(): Promise<EngineCapabilities> {
    if (this.disposed) throw disposedError();
    const run = this.runCapabilities();
    this.operations.add(run);
    try {
      return await run;
    } finally {
      this.operations.delete(run);
    }
  }

  async prepare(
    source: File,
    request: PreparationRequest,
    options: PrepareOptions = {},
  ): Promise<PreparedArtifact> {
    if (this.disposed) throw disposedError();
    if (this.activeJob) throw new Error("A browser preparation is already in progress");
    const externalSignal = options.signal ?? null;
    if (externalSignal?.aborted) throw abortError();

    // Freeze before the first await: callers cannot mutate an in-flight job.
    const frozen = freezeRequest(request);
    // Reject a non-browser policy before source reads, worker creation or WASM
    // work. There is no native fallback inside this adapter.
    const policy = browserPolicy(frozen);
    this.assertImplementedCodecs(frozen);
    if (this.probeCache) this.assertRequestedCodecs(frozen, this.probeCache);
    if (frozen.canaryEnabled === true && policy !== BROWSER_PREPARATION_POLICY) {
      throw new Error(
        "Canary material requires the shared aligned-gain-matched-v1 policy; it is not " +
          "available for raw codec-probe-only or browser-native policy requests",
      );
    }
    if (!source || typeof source !== "object" || typeof source.arrayBuffer !== "function") {
      throw new Error("Browser source must be a File-like object");
    }
    if (typeof source.size === "number") assertSourceByteLength(source.size);

    const job: BrowserJob = {
      id: randomId(),
      request: frozen,
      externalSignal,
      abort: new AbortController(),
      onExternalAbort: null,
      aborted: false,
      cancelError: null,
      cleanup: null,
      completion: null,
      measurementWorker: null,
      measurementTermination: null,
    };
    if (externalSignal) {
      const onAbort = (): void => {
        this.cancelJob(job, abortError());
      };
      job.onExternalAbort = onAbort;
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
    this.activeJob = job;

    const completion = this.runPrepare(job, source, options);
    job.completion = completion;
    try {
      return await completion;
    } finally {
      if (job.onExternalAbort && job.externalSignal) {
        job.externalSignal.removeEventListener("abort", job.onExternalAbort);
      }
      if (this.activeJob === job) this.activeJob = null;
    }
  }

  async readAudio(artifactId: string, side: Side): Promise<ArrayBuffer> {
    if (this.disposed) throw new Error("Unknown or released browser artifact");
    const entry = this.artifacts.get(artifactId);
    if (!entry) throw new Error("Unknown or released browser artifact");
    if (side !== "a" && side !== "b") throw new Error("Unknown artifact side");
    // Return a copy so callers cannot mutate the engine-owned retained bytes.
    const copy = entry.audio[side].slice();
    return copy.buffer;
  }

  async readCanaryAudio(artifactId: string, side: CanarySide): Promise<ArrayBuffer> {
    if (this.disposed) throw new Error("Unknown or released browser artifact");
    const entry = this.artifacts.get(artifactId);
    if (!entry) throw new Error("Unknown or released browser artifact");
    if (side !== "pristine" && side !== "degraded") throw new Error("Unknown canary side");
    const canary = entry.canary;
    if (!canary) throw new Error("Unknown, released or unusable browser canary material");
    // Same exact-copy ownership as readAudio; no second buffer owner exists.
    const copy = canary[side].slice();
    return copy.buffer;
  }

  async release(artifactId: string): Promise<void> {
    this.artifacts.delete(artifactId);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.lifecycle.abort();
    this.disposal = this.performDispose();
    return this.disposal;
  }

  private async performDispose(): Promise<void> {
    const job = this.activeJob;
    if (job) this.cancelJob(job, disposedError());
    const waits: Promise<unknown>[] = [...this.operations];
    if (job?.completion) waits.push(job.completion);
    await Promise.allSettled(waits);
    await this.terminateWorker();
    await this.supplemental.dispose();
    this.artifacts.clear();
  }

  private cancelJob(job: BrowserJob, reason: unknown): void {
    if (job.cancelError === null) job.cancelError = reason;
    job.aborted = true;
    if (!job.abort.signal.aborted) job.abort.abort();
    if (!job.cleanup) job.cleanup = this.cleanupJob(job);
  }

  /**
   * Terminate every worker this job owns and wait until termination is
   * requested. The measurement worker is job-scoped; codec ownership cannot
   * advance through the queue until this cleanup finishes.
   */
  private async cleanupJob(job: BrowserJob): Promise<void> {
    await this.terminateMeasurement(job);
    await this.terminateWorker();
  }

  private terminateMeasurement(job: BrowserJob): Promise<void> {
    if (job.measurementTermination) return job.measurementTermination;
    const worker = job.measurementWorker;
    job.measurementWorker = null;
    if (!worker) return Promise.resolve();
    job.measurementTermination = (async (): Promise<void> => {
      try {
        worker.terminate();
      } catch {
        // The measurement worker may already have stopped.
      }
      // Settle concurrent promise/abort handlers after requesting termination.
      // Worker.terminate() has no asynchronous join API.
      await Promise.resolve();
    })();
    return job.measurementTermination;
  }

  private async throwIfCancelled(job: BrowserJob): Promise<void> {
    if (job.cancelError !== null) {
      await job.cleanup;
      throw job.cancelError;
    }
    if (job.externalSignal?.aborted) {
      this.cancelJob(job, abortError());
      await job.cleanup;
      throw job.cancelError ?? abortError();
    }
  }

  private async acquire(): Promise<() => void> {
    let releaseFn: (() => void) | null = null;
    const current = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    const previous = this.queue;
    this.queue = current;
    await raceWithAbort(previous, this.lifecycle.signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseFn?.();
    };
  }

  private async runCapabilities(): Promise<EngineCapabilities> {
    const release = await this.acquire();
    try {
      if (this.disposed) throw disposedError();
      const result = await this.ensureProbe(this.lifecycle.signal);
      // Configured supplemental assets are probed for real: a capability
      // report must never advertise LC3/LDAC from a URL string alone.
      // Loads cache success and record failure, so every report here states
      // what this bundle actually provides. Failures never throw out of
      // capability discovery; they surface as unavailable codec entries.
      await this.probeSupplementalAssets(this.lifecycle.signal);
      if (this.disposed) throw disposedError();
      return this.capabilitiesFrom(result);
    } catch (error: unknown) {
      if (this.disposed) throw disposedError();
      // Capability discovery must describe an unavailable build, not crash the UI.
      return this.fallbackCapabilities(errorMessage(error));
    } finally {
      release();
    }
  }

  /**
   * Validates configured supplemental LC3/LDAC assets by actually loading
   * them (fetch, instantiate and entry-point check). Results are cached on
   * the runtime: success caches the module, failure records a failed load
   * state with a reason, and nothing throws.
   */
  private async probeSupplementalAssets(signal: AbortSignal): Promise<void> {
    this.supplementalProbeTimedOut = false;
    if (this.lc3WasmURL === null && this.ldacWasmURL === null) return;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      this.supplementalProbeTimedOut = true;
      controller.abort();
    }, 10_000);
    try {
      const tasks: Promise<unknown>[] = [];
      if (this.lc3WasmURL !== null) tasks.push(this.supplemental.load("lc3", controller.signal));
      if (this.ldacWasmURL !== null) tasks.push(this.supplemental.load("ldac", controller.signal));
      await Promise.allSettled(tasks);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Supplemental codec ids actually requested by this preparation request. */
  private requestedSupplementalCodecs(request: PreparationRequest): SupplementalCodecId[] {
    const ids = new Set<SupplementalCodecId>();
    for (const side of ["a", "b"] as const) {
      for (const selection of stagesForSide(request, side)) {
        if (implementedPlan(selection.codecId)) continue;
        if (selection.codecId === "lc3" || selection.codecId === "ldac") {
          ids.add(selection.codecId);
        }
      }
    }
    return [...ids];
  }

  /**
   * Loads and validates every requested supplemental module before any source
   * read or normalization, so prepare() with no prior capabilities() call
   * still refuses missing or invalid assets up front.
   */
  private async assertSupplementalAssets(job: BrowserJob): Promise<void> {
    for (const codecId of this.requestedSupplementalCodecs(job.request)) {
      const assetUrl = codecId === "lc3" ? this.lc3WasmURL : this.ldacWasmURL;
      if (assetUrl === null) continue; // assertImplementedCodecs already refused with the unconfigured wording
      try {
        await this.supplemental.load(codecId, job.abort.signal);
      } catch (error: unknown) {
        if (job.cancelError !== null || job.aborted || isAbort(error)) {
          await job.cleanup;
          throw job.cancelError ?? abortError();
        }
        throw new Error(
          `Browser supplemental-codec-unconfigured: the ${codecId.toUpperCase()} WASM asset at ` +
            `${assetUrl} could not be loaded for use (${errorMessage(error)}). The request refuses ` +
            "before any source audio is read. No alias, simulation or native fallback is offered.",
        );
      }
    }
  }

  private async runPrepare(
    job: BrowserJob,
    source: File,
    options: PrepareOptions,
  ): Promise<PreparedArtifact> {
    const startedAt = performance.now();
    const policy = browserPolicy(job.request);
    let release: (() => void) | null = null;
    let worker: FFmpeg | null = null;
    const files = new Set<string>();
    let completedArtifact: PreparedArtifact | null = null;
    let completedAudio: OwnedArtifact | null = null;
    let imported: ImportedAudioSource | null = null;
    let probeResult: ProbeResult | null = null;

    const report = (progress: PreparationProgress): void => {
      if (job.aborted) return;
      if (!options.onProgress) return;
      try {
        options.onProgress(progress);
      } catch (error: unknown) {
        this.cancelJob(job, error);
        throw error;
      }
    };

    try {
      if (typeof source.size === "number") assertSourceByteLength(source.size);

      // Supplemental LC3/LDAC modules are validated before anything else, so a
      // missing or corrupt asset refuses with supplemental-codec-unconfigured
      // before any source audio is read or normalized, even in prepare() with
      // no prior capabilities() call (the loaded module is then reused).
      await this.assertSupplementalAssets(job);
      await this.throwIfCancelled(job);

      // Source reading, signature classification and the fast strict-PCM16 path
      // are block-scoped so the original encoded bytes can be released before
      // the long codec stages run.
      {
        const sourceBuffer = await raceWithAbort(source.arrayBuffer(), job.abort.signal);
        await this.throwIfCancelled(job);
        const snapshot = await snapshotAudioSource(new Uint8Array(sourceBuffer), {
          sampleRateMode: job.request.sampleRateMode,
        });
        await this.throwIfCancelled(job);

        release = await this.acquire();
        await this.throwIfCancelled(job);

        report({ phase: "loading", message: "Loading local FFmpeg WASM worker" });
        const activeWorker = await this.ensureWorker(job.abort.signal);
        worker = activeWorker;
        await this.throwIfCancelled(job);

        report({ phase: "probing", message: "Probing this build's real encoders and decoders" });
        const probe = await this.ensureProbe(job.abort.signal);
        await this.throwIfCancelled(job);
        if (!probe.probe) {
          throw new Error(
            `FFmpeg capability probe failed before preparation: ${probe.failure ?? "unknown error"}`,
          );
        }
        this.assertRequestedCodecs(job.request, probe.probe);
        probeResult = probe.probe;

        report({
          phase: "encoding",
          message: "Decoding the original source once to a shared canonical PCM16 snapshot",
        });
        imported = await decodeAudioSource({
          exec: (args) => this.runCapture(activeWorker, [...args], job.abort.signal),
          writeFile: async (name, bytes) => {
            files.add(name);
            // @ffmpeg/ffmpeg transfers the Uint8Array buffer into its worker,
            // so the original JS source copy is released here and never read
            // again by the importer.
            await raceWithAbort(activeWorker.writeFile(name, bytes), job.abort.signal);
          },
          readFile: (name) => this.readOwnedFile(activeWorker, name, job),
          trackFile: (name) => { files.add(name); },
          deleteFile: async (name) => {
            await raceWithAbort(activeWorker.deleteFile(name), job.abort.signal);
            files.delete(name);
          },
          checkCancelled: () => this.throwIfCancelled(job),
        }, snapshot, {
          inputName: `src_${job.id}`,
          canonicalName: `canon_${job.id}.wav`,
        });
        await this.throwIfCancelled(job);
      }

      if (!worker || !imported) {
        throw new Error("Source import produced no canonical snapshot");
      }
      if (!probeResult) throw new Error("FFmpeg capability probe did not complete");
      const activeWorker = worker;
      const probeInfo = probeResult;
      const canonicalName = imported.canonicalName;
      const canonicalFacts = imported.canonical;
      const targetRate = job.request.sampleRateMode === "force_48k"
        ? 48000
        : canonicalFacts.sampleRate;
      const channels = canonicalFacts.channels;

      const a = await this.processTrack(job, activeWorker, files, "a", canonicalName,
        targetRate, channels, probeInfo, canonicalFacts, report);
      await this.throwIfCancelled(job);
      const b = await this.processTrack(job, activeWorker, files, "b", canonicalName,
        targetRate, channels, probeInfo, canonicalFacts, report);
      await this.throwIfCancelled(job);

      await this.removeStageFile(activeWorker, files, canonicalName, job);

      let finalABytes = a.bytes;
      let finalBBytes = b.bytes;
      let finalAFacts = a.facts;
      let finalBFacts = b.facts;
      let finalASha256 = a.sha256;
      let finalBSha256 = b.sha256;
      let preparation: PairPreparationReport | null = null;
      let validity: PairValidityReport | null = null;
      let canary: ValidatedCanary | null = null;
      let preflightDisclosure: string | null = null;
      let deliveredMeasurements: DeliveredPairMeasurements;
      if (policy === BROWSER_PREPARATION_POLICY) {
        report({
          phase: "preparing",
          message: "Applying aligned-gain-matched-v1 to the decoded codec-stage pair",
        });
        await this.throwIfCancelled(job);
        const prepared = await this.prepareDelivered(
          job, a.bytes, b.bytes, a.facts, b.facts, report,
        );
        await this.throwIfCancelled(job);
        finalABytes = prepared.aBytes;
        finalBBytes = prepared.bBytes;
        finalAFacts = prepared.aFacts;
        finalBFacts = prepared.bFacts;
        // Provenance hashes cover the exact final corrected bytes retained below.
        finalASha256 = await sha256Hex(finalABytes);
        finalBSha256 = await sha256Hex(finalBBytes);
        await this.throwIfCancelled(job);
        preparation = prepared.report;
        validity = prepared.validity;
        canary = prepared.canary;
        preflightDisclosure = prepared.preflightDisclosure;
        deliveredMeasurements = prepared.delivered;
      } else {
        // Measure copies of the exact serialized bytes that are delivered and
        // retained below. This never detaches or mutates a.bytes/b.bytes.
        deliveredMeasurements = await this.measureDelivered(job, a.bytes, b.bytes, report);
        await this.throwIfCancelled(job);
      }

      const engine = this.capabilitiesFrom({ probe: probeInfo, failure: null }, policy);
      const artifact: PreparedArtifact = {
        id: job.id,
        request: job.request,
        engine,
        sourceSha256: imported.sourceSha256,
        a: trackProvenance(a, finalABytes, finalAFacts, finalASha256),
        b: trackProvenance(b, finalBBytes, finalBFacts, finalBSha256),
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        measurements: {
          policy: "delivered-pcm-measurements-v1",
          alignmentLagSamples: deliveredMeasurements.alignment.lagSamples,
          alignmentConfidence: deliveredMeasurements.alignment.confidence,
          loudnessDeltaDb:
            deliveredMeasurements.loudnessDeltaDb.status === "finite"
              ? deliveredMeasurements.loudnessDeltaDb.value
              : null,
          nullDepthDb:
            deliveredMeasurements.nullDepth.depthDb.status === "finite"
              ? deliveredMeasurements.nullDepth.depthDb.value
              : null,
          notes: unique(measurementNotes(
            deliveredMeasurements,
            probeInfo.ffmpegVersion,
            preparation,
          )),
          delivered: deliveredMeasurements,
        },
        ...(preparation === null ? {} : { preparation }),
        ...(validity === null ? {} : { validity }),
        ...(canary === null
          ? {}
          : {
              canary: {
                report: canary.report,
                audio: canary.audio,
              },
            }),
        disclosures: unique([...artifactDisclosures(
          policy,
          probeInfo.ffmpegVersion,
          job.request.canaryEnabled === true,
        ), ...imported.disclosures, ...a.notes, ...b.notes,
        ...(preflightDisclosure === null ? [] : [preflightDisclosure])]),
        purpose: "diagnostic-only",
      };

      report(PROGRESS_COMPLETE);
      await this.throwIfCancelled(job);

      completedArtifact = artifact;
      completedAudio = {
        audio: Object.freeze({
          a: finalABytes,
          b: finalBBytes,
        }),
        canary: canary?.bytes ?? null,
      };
    } catch (error: unknown) {
      // A failed worker/codec must not leave a partially failed runtime cached
      // for retry. Source-validation failures before acquiring it leave it alone.
      const reported = browserMemoryError(error);
      if (job.cancelError === null && worker && this.worker === worker) {
        this.cancelJob(job, reported);
      }
      if (job.cancelError !== null) {
        await job.cleanup;
        throw job.cancelError;
      }
      throw reported;
    } finally {
      if (worker && !job.aborted && !this.disposed && this.worker === worker) {
        const failed = await this.removeFiles(worker, files);
        if (failed) await this.terminateWorker();
      }
      files.clear();
      release?.();
    }
    // Cleanup awaits worker messages. Abort/dispose can happen during any of
    // those awaits, including the microtask after the final progress callback.
    // Publish only after cleanup and one final synchronous cancellation check.
    if (job.cancelError !== null || job.externalSignal?.aborted || this.disposed) {
      await job.cleanup;
      throw job.cancelError ?? (this.disposed ? disposedError() : abortError());
    }
    if (!completedArtifact || !completedAudio) throw new Error("Preparation produced no artifact");
    const publishedArtifact = { ...completedArtifact,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) };
    this.artifacts.set(publishedArtifact.id, completedAudio);
    return publishedArtifact;
  }

  private async measureDelivered(
    job: BrowserJob,
    aBytes: Uint8Array,
    bBytes: Uint8Array,
    report: (progress: PreparationProgress) => void,
  ): Promise<DeliveredPairMeasurements> {
    return this.runNumericalWorker(
      job,
      "measure",
      aBytes,
      bBytes,
      {
        phase: "measuring",
        message: "Starting the dedicated measurement worker for the unchanged delivered pair",
      },
      "Measurement worker is computing alignment, loudness and null depth",
      (id, a, b) => ({
        type: "measure",
        id,
        a,
        b,
        maxLagSamples: DEFAULT_MAX_LAG_SAMPLES,
        probeSamples: DEFAULT_PROBE_SAMPLES,
      }),
      (message) => {
        if (message.type !== "result") {
          throw new Error("Measurement worker returned an unexpected response type");
        }
        return assertMeasurements(message.measurements);
      },
      measurementFailed,
      report,
    );
  }

  private async prepareDelivered(
    job: BrowserJob,
    aBytes: Uint8Array,
    bBytes: Uint8Array,
    aFacts: WavFacts,
    bFacts: WavFacts,
    report: (progress: PreparationProgress) => void,
  ): Promise<PreparedPair> {
    return this.runNumericalWorker(
      job,
      "prepare",
      aBytes,
      bBytes,
      {
        phase: "preparing",
        message: "Starting the dedicated preparation worker for aligned-gain-matched-v1",
      },
      "Preparation worker is computing alignment, gain matching and common trim",
      (id, a, b) => ({ type: "prepare", id, a, b, request: job.request }),
      (message) => {
        if (message.type !== "prepare-result") {
          throw new Error("Preparation worker returned an unexpected response type");
        }
        return assertPreparationResult(message, aFacts, bFacts, job.request);
      },
      preparationFailed,
      report,
    );
  }

  /**
   * One encoded worker lifecycle for both raw measurement and preparation.
   * The worker can be terminated by abort/dispose while it computes; there is
   * no awaitable Worker.terminate join, so cleanup only awaits local listener
   * settlement after requesting termination.
   */
  private async runNumericalWorker<T>(
    job: BrowserJob,
    mode: "measure" | "prepare",
    aBytes: Uint8Array,
    bBytes: Uint8Array,
    startProgress: PreparationProgress,
    startedMessage: string,
    makeRequest: (
      id: string,
      a: ArrayBuffer,
      b: ArrayBuffer,
    ) => MeasurementWorkerRequest | PreparationWorkerRequest,
    parse: (
      message: Extract<
        MeasurementWorkerResponse,
        { type: "result" } | { type: "prepare-result" }
      >,
    ) => T | Promise<T>,
    failed: (error: unknown) => Error,
    report: (progress: PreparationProgress) => void,
  ): Promise<T> {
    report(startProgress);
    await this.throwIfCancelled(job);

    // An abort can run in the microtask resumed by the await above. Check
    // synchronously before creating a worker or attaching abort listeners.
    if (job.abort.signal.aborted) throw job.cancelError ?? abortError();

    const worker = new Worker(
      new URL("./measurement-worker.ts", import.meta.url),
      { type: "module", name: "codec-abx-measurements" },
    );
    job.measurementWorker = worker;
    const id = job.id;

    const result = new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onMessageError);
        job.abort.signal.removeEventListener("abort", onAbort);
        return true;
      };
      const succeed = (value: T): void => {
        if (finish()) resolve(value);
      };
      const fail = (error: unknown): void => {
        if (finish()) reject(error);
      };
      const onAbort = (): void => {
        fail(job.cancelError ?? abortError());
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        if (!isRecord(data) || data.type === undefined || data.id !== id) return;
        const message = data as unknown as MeasurementWorkerResponse;
        if (message.type === "started") {
          if (message.mode !== undefined && message.mode !== mode) {
            fail(new Error(`Numerical worker reported the wrong mode for this job`));
            return;
          }
          // The worker has queued "started" and is now in its synchronous
          // numerical loop. This is the UI's last chance to Cancel/Reset.
          try {
            report({ phase: mode === "prepare" ? "preparing" : "measuring",
              message: startedMessage });
          } catch (error: unknown) {
            this.cancelJob(job, error);
            fail(error);
          }
          return;
        }
        // A real stage boundary immediately before the synchronous canary work.
        if (message.type === "stage") {
          if (mode !== "prepare" || message.stage !== "canary") {
            fail(new Error("Numerical worker reported an unexpected computation stage"));
            return;
          }
          try {
            report({
              phase: "preparing",
              message: "Canary material is being generated from the final delivered Side A",
            });
          } catch (error: unknown) {
            this.cancelJob(job, error);
            fail(error);
          }
          return;
        }
        if (message.type === "result" || message.type === "prepare-result") {
          try {
            const parsed = parse(message);
            if (parsed instanceof Promise) {
              parsed.then(succeed, (error: unknown) => fail(failed(error)));
            } else {
              succeed(parsed);
            }
          } catch (error: unknown) {
            fail(failed(error));
          }
          return;
        }
        if (message.type === "error") {
          fail(failed(codedError(message.message, message.code)));
        }
      };
      const onError = (event: ErrorEvent): void => {
        event.preventDefault();
        fail(failed(event.message || "numerical worker error"));
      };
      const onMessageError = (): void => {
        fail(new Error("Numerical worker sent a message that could not be deserialized"));
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      job.abort.signal.addEventListener("abort", onAbort, { once: true });

      // Transfer fresh copies. The retained artifact buffers stay attached and
      // byte-identical; the worker never receives caller-owned audio.
      const aCopy = aBytes.slice();
      const bCopy = bBytes.slice();
      const request = makeRequest(id,
        aCopy.buffer as ArrayBuffer, bCopy.buffer as ArrayBuffer);
      try {
        worker.postMessage(request, [aCopy.buffer, bCopy.buffer]);
      } catch (error: unknown) {
        fail(failed(error));
      }
    });

    try {
      const value = await result;
      // Success also terminates the short-lived worker so FFT/PCM allocations
      // are released before the artifact is published.
      await this.terminateMeasurement(job);
      if (job.cancelError !== null) throw job.cancelError;
      return value;
    } catch (error: unknown) {
      await this.terminateMeasurement(job);
      if (job.cancelError !== null) throw job.cancelError;
      if (job.externalSignal?.aborted) throw abortError();
      throw error;
    }
  }

  private async processTrack(
    job: BrowserJob,
    worker: FFmpeg,
    files: Set<string>,
    side: Side,
    inputName: string,
    targetRate: number,
    channels: 1 | 2,
    probe: ProbeResult,
    sourceFacts: WavFacts,
    report: (progress: PreparationProgress) => void,
  ): Promise<ProcessedTrack> {
    let previousName = inputName;
    let final: ProcessedTrack | null = null;
    const stages: StageProvenance[] = [];
    const notes: string[] = [];
    let inputFrames = Math.round(sourceFacts.durationSeconds * targetRate);
    const selections = stagesForSide(job.request, side);
    for (const [index, requested] of selections.entries()) {
      // Only final-stage bytes survive this loop; intermediate PCM stays private.
      final = null;
      await this.throwIfCancelled(job);
      const ffmpegPlan = probedPlan(requested.codecId, probe.decoderNames);
      const supplementalPlanEntry = supplementalPlan(requested.codecId);
      if (ffmpegPlan === null && supplementalPlanEntry === null) {
        throw new Error(`Browser adapter-not-implemented: ${requested.codecId}`);
      }
      const stageLabel = `Side ${side.toUpperCase()} stage ${String(index + 1)}/${String(selections.length)}`;
      const label = job.request.version === 1 ? `Side ${side.toUpperCase()}` : stageLabel;
      const outputName = `out_${side}_${String(index + 1)}_${job.id}.wav`;
      files.add(outputName);
      let encodedSize: number | null = null;
      let supplementalMeta: SupplementalStageMeta | null = null;
      const encodedSampleRate = codecInternalRate(requested.codecId, targetRate);
      const encodedChannels = codecInputChannels(requested.codecId, channels);
      const noop = requested.codecId === "noop_passthrough";
      const encodingMessage = requested.codecId === "opus"
        ? `encoding Opus ${String(requested.bitrateKbps)} kbps CBR`
        : supplementalPlanEntry
          ? `encoding ${requested.codecId} with the supplemental ${supplementalPlanEntry.encoder}`
          : ffmpegPlan?.fixedRate
            ? `encoding ${requested.codecId} with fixed-rate ${ffmpegPlan.encoder} (requested ${String(requested.bitrateKbps)} kbps is nominal)`
            : noop ? `PCM16 passthrough at ${String(targetRate)} Hz` : `encoding ${requested.codecId} with ${ffmpegPlan?.encoder ?? requested.codecId}`;
      report({ phase: "encoding", message: `${label}: ${encodingMessage}` });
      if (job.aborted) throw job.cancelError ?? abortError();
      if (noop) {
        await this.exec(worker, [
          "-c:a", "pcm_s16le", "-i", previousName,
          "-ar", String(targetRate), "-ac", String(channels),
          "-c:a", (ffmpegPlan as { encoder: string }).encoder, "-f", "wav", outputName,
        ], job.abort.signal);
        await this.throwIfCancelled(job);
        if (previousName !== inputName) await this.removeStageFile(worker, files, previousName, job);
      } else if (supplementalPlanEntry) {
        supplementalMeta = await this.runSupplementalStage(
          job, worker, files, previousName, requested, supplementalPlanEntry,
          side, index + 1, targetRate, channels, encodedSampleRate, encodedChannels,
          label, report, inputName, outputName,
        );
        encodedSize = supplementalMeta.encodedSize;
      } else {
        if (ffmpegPlan === null) throw new Error(`Browser adapter-not-implemented: ${requested.codecId}`);
        const plan = ffmpegPlan;
        const encodedName = `enc_${side}_${String(index + 1)}_${job.id}.${plan.extension}`;
        files.add(encodedName);
        // The pinned core traps with the default 20 ms libopus path on this
        // host. Keep the disclosed 10 ms workaround; do not silently substitute.
        const codecOptions = requested.codecId === "opus"
          ? ["-vbr", "off", "-frame_duration", "10"] : [];
        await this.exec(worker, [
          "-c:a", "pcm_s16le", "-i", previousName,
          "-ar", String(encodedSampleRate), "-ac", String(encodedChannels),
          "-c:a", plan.encoder, "-b:a", `${String(requested.bitrateKbps)}k`,
          ...codecOptions, "-f", plan.format, encodedName,
        ], job.abort.signal);
        await this.throwIfCancelled(job);
        // Encoding has consumed the preceding PCM; release it before decoding
        // the new output. Source MEMFS is shared by A/B and remains until both finish.
        if (previousName !== inputName) await this.removeStageFile(worker, files, previousName, job);
        encodedSize = (await this.readOwnedFile(worker, encodedName, job)).byteLength;
        await this.throwIfCancelled(job);
        report({ phase: "encoding", message: `${label}: decoding with explicit ${plan.decoder}; restoring ${String(targetRate)} Hz/${String(channels)} channels` });
        if (job.aborted) throw job.cancelError ?? abortError();
        await this.exec(worker, [
          "-c:a", plan.decoder, "-i", encodedName,
          "-ar", String(targetRate), "-ac", String(channels),
          "-c:a", "pcm_s16le", "-f", "wav", outputName,
        ], job.abort.signal);
        await this.throwIfCancelled(job);
        await this.removeStageFile(worker, files, encodedName, job);
      }
      await this.throwIfCancelled(job);
      report({ phase: "measuring", message: `${label}: hashing and parsing decoded WAV bytes (no correction)` });
      if (job.aborted) throw job.cancelError ?? abortError();
      const bytes = await this.readOwnedFile(worker, outputName, job);
      await this.throwIfCancelled(job);
      const facts = parsePcm16Wav(bytes);
      if (facts.channels !== channels || facts.sampleRate !== targetRate) {
        throw new Error(`${label} decoded WAV layout disagrees with the session rate/channels`);
      }
      if (bytes.byteLength > BROWSER_MAX_WAV_BYTES ||
          facts.durationSeconds >
            AUDIO_MAX_DURATION_SECONDS + BROWSER_CHAIN_PADDING_TOLERANCE_SECONDS) {
        throw new Error(`${label} decoded material, including codec padding, exceeds the local audio ` +
          `envelope (${String(BROWSER_MAX_WAV_BYTES)} bytes per WAV / ` +
          `${String(AUDIO_MAX_DURATION_SECONDS)} s plus at most ` +
          `${String(BROWSER_CHAIN_PADDING_TOLERANCE_SECONDS)} s chain padding); no hidden trim is applied`);
      }
      if (facts.durationSeconds > sourceFacts.durationSeconds + 1e-9) {
        notes.push(`${stageLabel} ${requested.codecId}: decoded ${(facts.durationSeconds -
          sourceFacts.durationSeconds).toFixed(6)} s longer than its canonical input due to codec ` +
          "round-trip padding; retained without cropping.");
      }
      const sha256 = await sha256Hex(bytes);
      await this.throwIfCancelled(job);
      // Each denominator is this stage's own decoded duration before any later
      // stage or final pair correction. Include the encoded container overhead.
      // LDAC mirrors the native engine's basis: container bytes over the header's
      // unpadded sample duration (the decoded WAV is restored-rate, which would
      // misstate the encoded rate for 44.1 sessions).
      const actualBitrateKbps = supplementalMeta?.actualBitrateKbps ??
        (encodedSize === null ? null
          : Math.round((encodedSize * 8) / facts.durationSeconds / 100) / 10);
      if (actualBitrateKbps !== null && (!Number.isFinite(actualBitrateKbps) || actualBitrateKbps <= 0)) {
        throw new Error(`${label} encoded container did not yield a usable actual bitrate`);
      }
      const stageEncoder = supplementalPlanEntry
        ? supplementalPlanEntry.encoder
        : ffmpegPlan?.encoder ?? "not-implemented";
      const stageDecoder = supplementalPlanEntry
        ? supplementalPlanEntry.decoder
        : ffmpegPlan?.decoder ?? "not-implemented";
      const provenance = Object.freeze({ stageIndex: index + 1, requested,
        encoder: stageEncoder, decoder: stageDecoder, actualBitrateKbps, encodedSampleRate });
      stages.push(provenance);
      notes.push(`${stageLabel} ${requested.codecId}: ${String(inputFrames)} input session frames; ` +
        `${String(facts.frames)} decoded session frames (${String(facts.frames - inputFrames)} frame change from codec round trip). ` +
        "No pair correction or hidden padding/cropping runs between stages.");
      for (const note of supplementalMeta?.notes ?? []) notes.push(note);
      if (encodedSampleRate !== targetRate) {
        notes.push(`${stageLabel} ${requested.codecId}: encoded at internal ${String(encodedSampleRate)} Hz ` +
          `for a ${String(targetRate)} Hz session; the decoded stage was restored to ` +
          `${String(targetRate)} Hz/${String(channels)} channel(s) with an explicit output rate/layout.`);
      }
      if (encodedChannels !== channels) {
        notes.push(`${stageLabel} ${requested.codecId}: the selected ${stageEncoder} encoder accepts stereo ` +
          `only, so this mono session was carried as dual-mono inside the codec. The decoded stage was ` +
          `restored to ${String(channels)} channel. This layout adaptation is disclosed and is not a ` +
          "codec substitution.");
      }
      if (ffmpegPlan?.fixedRate) {
        notes.push(`${stageLabel} ${requested.codecId}: ${ffmpegPlan.encoder} is fixed-rate; requested ` +
          `${String(requested.bitrateKbps)} kbps is nominal and the actual encoded bitrate reported here ` +
          `is measured from the raw container bytes and decoded duration.`);
      }
      if (requested.codecId === "mp2") {
        notes.push(`${stageLabel} MP2: this is FFmpeg's built-in mp2 encoder in the pinned WASM core, ` +
          "not native libtwolame; browser and native MP2 output are not claimed equivalent.");
      }
      inputFrames = facts.frames;
      final = { bytes, facts, sha256, ...provenance, stages: [], notes: [] };
      previousName = outputName;
    }
    // Final PCM is retained in owned JS bytes, so its MEMFS copy is no longer needed.
    if (previousName !== inputName) await this.removeStageFile(worker, files, previousName, job);
    if (!final) throw new Error("Codec pipeline contains no stages");
    return { ...final, stages: Object.freeze(stages), notes: Object.freeze(notes) };
  }

  /**
   * One supplemental (LC3/LDAC) codec stage. FFmpeg only normalizes PCM rate
   * and layout before and after; the codec round trip itself runs in the
   * same-origin supplemental WASM build, in small chunked slices so progress,
   * cancellation and UI responsiveness stay honest even on long tracks.
   */
  private async runSupplementalStage(
    job: BrowserJob,
    worker: FFmpeg,
    files: Set<string>,
    previousName: string,
    requested: CodecSelection,
    plan: SupplementalPlan,
    side: Side,
    stageIndex: number,
    targetRate: number,
    channels: 1 | 2,
    encodedSampleRate: number,
    encodedChannels: 1 | 2,
    label: string,
    report: (progress: PreparationProgress) => void,
    inputName: string,
    outputName: string,
  ): Promise<SupplementalStageMeta> {
    // 1) FFmpeg normalizes the preceding PCM to the codec's internal rate and
    //    encoded channel count, exactly like every ffmpeg-based stage.
    const encInName = `enc_in_${side}_${String(stageIndex)}_${String(job.id)}.wav`;
    files.add(encInName);
    await this.exec(worker, [
      "-c:a", "pcm_s16le", "-i", previousName,
      "-ar", String(encodedSampleRate), "-ac", String(encodedChannels),
      "-c:a", "pcm_s16le", "-f", "wav", encInName,
    ], job.abort.signal);
    await this.throwIfCancelled(job);
    const encPcm = parsePcm16Samples(await this.readOwnedFile(worker, encInName, job));
    await this.removeStageFile(worker, files, encInName, job);
    if (encPcm.facts.sampleRate !== encodedSampleRate || encPcm.facts.channels !== encodedChannels) {
      throw new Error(`${label} supplemental encode input disagrees with the internal rate/layout`);
    }
    if (previousName !== inputName) await this.removeStageFile(worker, files, previousName, job);
    const totalSampleFrames = encPcm.facts.frames;
    const interleaved = encPcm.samples;

    // 2) Encode with the supplemental WASM codec, chunked and cancellable.
    const framePayloads: Uint8Array[] = [];
    let containerBytes: Uint8Array;
    let actualFromHeader: number | null = null;
    if (requested.codecId === "lc3") {
      const frameUs = 10_000;
      const frameSamples = lc3FrameSamples(encodedSampleRate, frameUs);
      const fullBlocks = Math.floor(totalSampleFrames / frameSamples);
      const trailing = totalSampleFrames - fullBlocks * frameSamples;
      const contentBlocks = fullBlocks + (trailing > 0 ? 1 : 0);
      const totalBlocks = contentBlocks + 1; // one closing zero block (native shape)
      const encoder = await createLc3EncoderSession(
        this.supplemental, encodedSampleRate, encodedChannels,
        requested.bitrateKbps * 1000, frameUs, job.abort.signal,
      );
      try {
        const writer = new Lc3ContainerWriter(Object.freeze({
          sampleRateHz: encodedSampleRate,
          bitrateBps: encoder.effectiveBitrateBps,
          channels: encodedChannels,
          frameDurationUs: frameUs,
          epMode: false,
          totalSamples: totalSampleFrames,
          hrMode: false,
        }));
        const blockBuffer = new Int16Array(frameSamples * encodedChannels);
        for (let block = 0; block < totalBlocks; block += 1) {
          const offset = block * blockBuffer.length;
          if (block < fullBlocks || (trailing === 0 && block < contentBlocks)) {
            writer.pushFrame(encoder.encodeBlock(
              interleaved.subarray(offset, offset + blockBuffer.length)));
          } else if (block === fullBlocks && trailing > 0) {
            const provided = trailing * encodedChannels;
            blockBuffer.subarray(0, provided).set(
              interleaved.subarray(offset, offset + provided));
            blockBuffer.fill(0, provided);
            writer.pushFrame(encoder.encodeBlock(blockBuffer));
          } else {
            blockBuffer.fill(0);
            writer.pushFrame(encoder.encodeBlock(blockBuffer));
          }
          await this.supplementalTick(job, report, `${label}: encoding LC3 ` +
            `${String(requested.bitrateKbps)} kbps, block ${String(block + 1)}/${String(totalBlocks)}`);
        }
        containerBytes = writer.finish();
      } finally {
        encoder.dispose();
      }
    } else {
      const bitrateRaw = requested.bitrateKbps;
      if (bitrateRaw !== 330 && bitrateRaw !== 660 && bitrateRaw !== 990) {
        throw new Error(`LDAC catalog bitrate out of range: ${String(bitrateRaw)}`);
      }
      const bitrate: 330 | 660 | 990 = bitrateRaw;
      if (encodedSampleRate !== 44_100 && encodedSampleRate !== 48_000) {
        throw new Error(`LDAC internal rate must be 44.1/48 kHz, found ${String(encodedSampleRate)}`);
      }
      const encoder = await createLdacEncoderSession(
        this.supplemental, encodedSampleRate === 44_100 ? 44_100 : 48_000,
        encodedChannels, bitrate, job.abort.signal,
      );
      try {
        const blockFrames = encoder.blockSamples;
        const fullBlocks = Math.floor(totalSampleFrames / blockFrames);
        const trailing = totalSampleFrames - fullBlocks * blockFrames;
        const totalBlocks = fullBlocks + (trailing > 0 ? 1 : 0);
        const blockBuffer = new Int16Array(blockFrames * encodedChannels);
        for (let block = 0; block < totalBlocks; block += 1) {
          const offset = block * blockBuffer.length;
          if (block < fullBlocks) {
            framePayloads.push(...encoder.encodeBlock(
              interleaved.subarray(offset, offset + blockBuffer.length)));
          } else {
            const providedLength = trailing > 0 ? trailing * encodedChannels : 0;
            if (providedLength > 0) {
              blockBuffer.set(
                interleaved.subarray(offset, offset + providedLength), 0);
            }
            blockBuffer.fill(0, providedLength);
            framePayloads.push(...encoder.encodeBlock(blockBuffer));
          }
          await this.supplementalTick(job, report, `${label}: encoding LDAC ` +
            `${String(bitrate)} kbps, frame ${String(block + 1)}/${String(totalBlocks)}`);
        }
        // ldac_helper's flush loop: drain the encoder's internal tail frames.
        for (const flushed of encoder.flushFrames()) {
          framePayloads.push(flushed);
        }
        // Bounded container assembly: record sizing/copy and the CRC-32 pass
        // yield to the event loop, report progress and honor cancellation at
        // every slice boundary (identical bytes and validation rules as the
        // synchronous writer used elsewhere).
        containerBytes = await writeLdacContainerAsync({
          sampleRateHz: encodedSampleRate === 44_100 ? 44_100 : 48_000,
          channels: encodedChannels,
          requestedBitrateKbps: bitrate,
          sampleCount: totalSampleFrames,
          reportedBitrateKbps: encoder.reportedBitrateKbps,
          frames: framePayloads,
        }, {
          signal: job.abort.signal,
          onSlice: async (progress) => {
            await this.supplementalTick(
              job, report, ldacContainerStageMessage(label, "writing", progress));
          },
        });
      } finally {
        encoder.dispose();
      }
    }
    const encodedSize = containerBytes.byteLength;
    await this.throwIfCancelled(job);

    // 3) Decode with the supplemental codec to internal-rate PCM16, then let
    //    ffmpeg restore the session rate/layout exactly like other stages.
    report({ phase: "encoding", message: `${label}: decoding with explicit ${plan.decoder}; ` +
      `restoring ${String(targetRate)} Hz/${String(channels)} channels` });
    if (job.aborted) throw job.cancelError ?? abortError();
    const restored = new Int16Array(Math.floor(totalSampleFrames * encodedChannels));
    let notes: string[] = [];
    if (requested.codecId === "lc3") {
      const containerHeader = parseLc3Header(containerBytes);
      if (containerHeader.totalSamples !== totalSampleFrames ||
          containerHeader.channels !== encodedChannels ||
          containerHeader.sampleRateHz !== encodedSampleRate) {
        throw new Error(`${label} LC3 container header disagrees with the encode input`);
      }
      const frames = parseLc3Frames(containerBytes);
      const decoder = await createLc3DecoderSession(
        this.supplemental, containerHeader.sampleRateHz, containerHeader.channels,
        containerHeader.frameDurationUs, containerHeader.hrMode, job.abort.signal,
      );
      try {
        let writtenFrames = 0;
        // FFmpeg's LC3 pipeline discards the codec's leading algorithmic
        // delay (120 samples at 48 kHz / 10 ms) before the stream begins;
        // the same skip keeps the decoded stream aligned with its source.
        let delayToSkip = decoder.delaySamples;
        for (const frame of frames) {
          if (writtenFrames >= totalSampleFrames) break;
          await this.supplementalTick(job, report, `${label}: decoding LC3 frame ` +
            `${String(writtenFrames)}/${String(totalSampleFrames)}`);
          const block = decoder.decodeBlock(frame);
          let sampleFrames = Math.floor(block.length / encodedChannels);
          let start = 0;
          if (delayToSkip > 0) {
            start = Math.min(delayToSkip, sampleFrames);
            delayToSkip -= start;
          }
          sampleFrames -= start;
          const take = Math.min(totalSampleFrames - writtenFrames, sampleFrames);
          if (take > 0) {
            restored.set(
              block.subarray(start * encodedChannels, (start + take) * encodedChannels),
              writtenFrames * encodedChannels,
            );
          }
          writtenFrames += take;
        }
        if (writtenFrames !== totalSampleFrames) {
          throw new Error(`${label} LC3 decode produced ${String(writtenFrames)} of ` +
            `${String(totalSampleFrames)} frames`);
        }
      } finally {
        decoder.dispose();
      }
      notes = [
        `${label}: LC3 used liblc3 (pinned 1.1.3, same-origin WASM) at an explicit internal ` +
          `${String(encodedSampleRate)} Hz / 10 ms configuration; the raw LC3 container has no ` +
          "rate header, so the encoded rate is the explicit setting.",
      ];
    } else {
      // Bounded validation: CRC-32 and the record walk are sliced and
      // abort-checked so a ten-minute container never freezes the main thread;
      // header/refusal semantics remain exactly the synchronous parser's.
      const containerHeader = await parseLdacContainerAsync(containerBytes, {
        signal: job.abort.signal,
        onSlice: async (progress) => {
          await this.supplementalTick(
            job, report, ldacContainerStageMessage(label, "validating", progress));
        },
      });
      if (containerHeader.sampleCount !== totalSampleFrames ||
          containerHeader.channels !== encodedChannels ||
          containerHeader.sampleRateHz !== encodedSampleRate ||
          containerHeader.requestedBitrateKbps !== requested.bitrateKbps) {
        throw new Error(`${label} LDAC container header disagrees with the encode input`);
      }
      const decoder = await createLdacDecoderSession(
        this.supplemental,
        containerHeader.sampleRateHz === 44_100 ? 44_100 : 48_000,
        containerHeader.channels, job.abort.signal,
      );
      try {
        let written = 0;
        let warmup = 128; // one MDCT-overlap frame, exactly like ldac_helper
        for (let index = 0; index < containerHeader.frameCount; index += 1) {
          if (written >= containerHeader.sampleCount) break;
          const record = framePayloads[index];
          if (record === undefined || record.byteLength === 0) {
            throw new Error(`${label} missing LDAC frame record ${String(index)}`);
          }
          await this.supplementalTick(job, report, `${label}: decoding LDAC frame ` +
            `${String(index + 1)}/${String(containerHeader.frameCount)}`);
          const block = decoder.decodeBlock(record);
          let frames = Math.floor(block.length / encodedChannels);
          let start = 0;
          if (warmup > 0) {
            start = Math.min(warmup, frames);
            warmup -= start;
          }
          frames -= start;
          if (frames > containerHeader.sampleCount - written) {
            frames = containerHeader.sampleCount - written;
          }
          if (frames > 0) {
            restored.set(
              block.subarray(start * encodedChannels, (start + frames) * encodedChannels),
              written * encodedChannels,
            );
          }
          written += frames;
        }
        if (written !== containerHeader.sampleCount) {
          throw new Error(`${label} LDAC decode produced ${String(written)} of ` +
            `${String(containerHeader.sampleCount)} sample frames`);
        }
      } finally {
        decoder.dispose();
      }
      const bitrateDurationSeconds = containerHeader.sampleCount / containerHeader.sampleRateHz;
      actualFromHeader = Math.round(
        ((encodedSize * 8) / bitrateDurationSeconds / 1000) * 10) / 10;
      notes = [
        `${label}: LDAC container header reported ` +
          `${String(containerHeader.reportedBitrateKbps)} kbps; actual ` +
          `${String(actualFromHeader)} kbps recomputed from ${String(encodedSize)} container bytes ` +
          `over the header's ${bitrateDurationSeconds.toFixed(6)} s sample duration ` +
          "(basis: ldac-container-bytes-over-header-sample-duration). LDAC decode used the " +
          "third-party hegdi/libldacdec implementation in this same-origin WASM build; no vendor " +
          "validation or bit-exact equivalence with a retail LDAC sink is established.",
      ];
    }

    // 4) Hand the decoded internal-rate PCM16 back to ffmpeg as a plain WAV so
    //    the shared restore invocation stays identical to every other stage.
    const decInName = `dec_in_${side}_${String(stageIndex)}_${String(job.id)}.wav`;
    files.add(decInName);
    await raceWithAbort(
      worker.writeFile(
        decInName,
        buildPcm16Wav(restored, encodedSampleRate, encodedChannels),
      ),
      job.abort.signal,
    );
    await this.throwIfCancelled(job);
    await this.exec(worker, [
      "-c:a", "pcm_s16le", "-i", decInName,
      "-ar", String(targetRate), "-ac", String(channels),
      "-c:a", "pcm_s16le", "-f", "wav", outputName,
    ], job.abort.signal);
    await this.throwIfCancelled(job);
    await this.removeStageFile(worker, files, decInName, job);
    return { encodedSize, actualBitrateKbps: actualFromHeader, notes };
  }

  /**
   * Chunked supplemental work yields to the event loop and reports at most
   * ~40×/second; cancellation is honored on every slice boundary.
   */
  private async supplementalTick(
    job: BrowserJob,
    report: (progress: PreparationProgress) => void,
    message: string,
  ): Promise<void> {
    const now = performance.now();
    if (now - this.lastSupplementalYield >= 25) {
      this.lastSupplementalYield = now;
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      await this.throwIfCancelled(job);
      report({ phase: "encoding", message });
    }
  }

  private async removeStageFile(worker: FFmpeg, files: Set<string>, name: string, job: BrowserJob): Promise<void> {
    await raceWithAbort(worker.deleteFile(name), job.abort.signal);
    files.delete(name);
    await this.throwIfCancelled(job);
  }

  private async readOwnedFile(
    worker: FFmpeg,
    name: string,
    job: BrowserJob,
  ): Promise<Uint8Array> {
    const data = await raceWithAbort(worker.readFile(name), job.abort.signal);
    if (typeof data === "string") throw new Error(`FFmpeg returned text for ${name}`);
    return new Uint8Array(data);
  }

  private async exec(
    worker: FFmpeg,
    args: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const { code, output } = await this.runCapture(worker, args, signal);
    if (code !== 0) {
      const detail = output.split(/\r?\n/).slice(-8).join("\n");
      throw new Error(`FFmpeg command failed with exit code ${String(code)}: ${detail}`);
    }
  }

  private async runCapture(
    worker: FFmpeg,
    args: string[],
    signal: AbortSignal | null,
  ): Promise<{ readonly code: number; readonly output: string }> {
    const lines: string[] = [];
    const onLog = (event: { type: string; message: string }): void => {
      lines.push(event.message);
      this.logger?.(event.message);
    };
    worker.on("log", onLog);
    try {
      const code = await raceWithAbort(
        // The persistent WASM CLI retains exit_on_error between invocations.
        // Source import opts into -xerror explicitly; reset it first so that
        // choice cannot leak into later, separately validated codec stages.
        worker.exec(["-noxerror", ...args], -1, signal ? { signal } : {}),
        signal,
      );
      return { code, output: lines.join("\n") };
    } finally {
      worker.off("log", onLog);
    }
  }

  private async ensureWorker(signal: AbortSignal | null): Promise<FFmpeg> {
    if (this.disposed) throw disposedError();
    if (this.worker && this.workerReady) return this.worker;
    if (this.workerInit) {
      await raceWithAbort(this.workerInit, signal);
      if (this.worker && this.workerReady) return this.worker;
      if (this.disposed) throw disposedError();
    }

    const worker = new FFmpeg();
    const generation = this.workerGeneration + 1;
    this.workerGeneration = generation;
    this.worker = worker;
    this.workerReady = false;
    this.probeCache = null;

    const init = (async (): Promise<void> => {
      await worker.load({ coreURL: this.coreURL, wasmURL: this.wasmURL });
      if (this.disposed) throw disposedError();
      if (generation !== this.workerGeneration || this.worker !== worker) {
        throw abortError();
      }
      this.workerReady = true;
    })();
    this.workerInit = init;
    try {
      await raceWithAbort(init, signal);
    } catch (error: unknown) {
      if (this.worker === worker && generation === this.workerGeneration) {
        this.worker = null;
        this.workerReady = false;
      }
      try {
        worker.terminate();
      } catch {
        // The worker was already terminated by cancellation.
      }
      throw error;
    } finally {
      if (this.workerInit === init) this.workerInit = null;
    }
    if (this.disposed) throw disposedError();
    if (generation !== this.workerGeneration || this.worker !== worker) {
      throw abortError();
    }
    return worker;
  }

  private async ensureProbe(signal: AbortSignal | null): Promise<EnsureProbe> {
    if (this.probeCache) return { probe: this.probeCache, failure: null };
    try {
      const worker = await this.ensureWorker(signal);
      const version = await this.runCapture(worker, ["-hide_banner", "-version"], signal);
      if (version.code !== 0) throw new Error("FFmpeg -version probe failed");
      const encoders = await this.runCapture(
        worker, ["-hide_banner", "-encoders"], signal,
      );
      if (encoders.code !== 0) throw new Error("FFmpeg -encoders probe failed");
      const decoders = await this.runCapture(
        worker, ["-hide_banner", "-decoders"], signal,
      );
      if (decoders.code !== 0) throw new Error("FFmpeg -decoders probe failed");

      const encoderNames = parseNameListing(encoders.output);
      const decoderNames = parseNameListing(decoders.output);
      const probe: ProbeResult = Object.freeze({
        ffmpegVersion: parseVersion(version.output),
        encoderNames,
        decoderNames,
      });
      this.probeCache = probe;
      return { probe, failure: null };
    } catch (error: unknown) {
      if (this.disposed) throw disposedError();
      return { probe: null, failure: errorMessage(error) };
    }
  }

  private assertImplementedCodecs(request: PreparationRequest): void {
    for (const side of ["a", "b"] as const) {
      for (const selection of stagesForSide(request, side)) {
        if (implementedPlan(selection.codecId)) continue;
        const supplementalPlanEntry = supplementalPlan(selection.codecId);
        if (!supplementalPlanEntry) {
          throw new Error(`Browser adapter-not-implemented: ${selection.codecId} on side ${side.toUpperCase()}; no codec substitution is performed`);
        }
        const assetUrl = selection.codecId === "lc3" ? this.lc3WasmURL : this.ldacWasmURL;
        if (assetUrl === null) {
          throw new Error(
            `Browser supplemental-codec-unconfigured: ${supplementalPlanEntry.codecId.toUpperCase()} ` +
              "WASM asset URL was not provided by this app bundle; the request refuses before any " +
              "source audio is read. No alias, simulation or native fallback is offered.");
        }
      }
    }
  }

  private assertRequestedCodecs(request: PreparationRequest, probe: ProbeResult | null): void {
    if (!probe) throw new Error("FFmpeg capability probe did not complete");
    this.assertImplementedCodecs(request);
    for (const side of ["a", "b"] as const) {
      for (const [index, selection] of stagesForSide(request, side).entries()) {
        const plan = probedPlan(selection.codecId, probe.decoderNames)!;
        if (!plan) {
          // Supplemental codecs (LC3/LDAC) are validated against their own
          // configured WASM assets at stage time; the FFmpeg probe lists
          // neither and must not be asked to authorize them.
          continue;
        }
        if (!probe.encoderNames.has(plan.encoder) || !probe.decoderNames.has(plan.decoder)) {
          throw new Error(`This browser FFmpeg build does not advertise the ${plan.encoder} encoder/${plan.decoder} decoder ` +
            `required by side ${side.toUpperCase()} stage ${String(index + 1)}; no codec substitution is performed`);
        }
      }
    }
  }

  private capabilitiesFrom(
    result: EnsureProbe,
    policy: PreparationPolicyId = BROWSER_DEFAULT_PREPARATION_POLICY,
  ): EngineCapabilities {
    const probe = result.probe;
    const failure = result.failure ?? "browser FFmpeg capability probe was unavailable";
    const codec = (
      codecId: CodecCapability["codecId"],
      encoder: string,
      decoder: string,
      available: boolean,
      missing: string,
    ): CodecCapability => ({
      codecId,
      availability: probe ? (available ? "available" : "unavailable") : "unknown",
      encoder,
      decoder,
      reason: probe
        ? available
          ? null
          : missing
        : failure,
    });
    const supplementalEntry = (
      codecId: "lc3" | "ldac",
    ): CodecCapability => {
      const supplementalPlanEntry = supplementalPlan(codecId)!;
      const assetUrl = codecId === "lc3" ? this.lc3WasmURL : this.ldacWasmURL;
      if (assetUrl === null) {
        return {
          codecId,
          availability: "unavailable",
          encoder: supplementalPlanEntry.encoder,
          decoder: supplementalPlanEntry.decoder,
          reason: "Browser supplemental-codec-unconfigured: the same-origin WASM asset URL was " +
            "not provided by this app bundle; the request refuses before source reads. " +
            "No alias, simulation or native fallback is offered.",
        };
      }
      const state = this.supplemental.availability(codecId);
      if (state.loadState === "failed") {
        return {
          codecId,
          availability: "unavailable",
          encoder: supplementalPlanEntry.encoder,
          decoder: supplementalPlanEntry.decoder,
          reason: "Browser supplemental-codec-unconfigured: the same-origin WASM asset is " +
            `checked against ${assetUrl} but the module could not be loaded and validated` +
            `${state.reason === null ? "" : ` (${state.reason})`}. The request refuses ` +
            "before source reads. No alias, simulation or native fallback is offered.",
        };
      }
      if (state.loadState === "loaded") {
        return {
          codecId,
          availability: probe ? "available" : "unknown",
          encoder: supplementalPlanEntry.encoder,
          decoder: supplementalPlanEntry.decoder,
          reason: probe ? null
            : `Supplemental ${codecId.toUpperCase()} module was validated, but the FFmpeg ` +
              `capability probe required for the complete round trip failed: ${failure}`,
        };
      }
      // Configured but not validated in this report (capability probe failed
      // before the module probe, or the module was never attempted).
      return {
        codecId,
        availability: "unknown",
        encoder: supplementalPlanEntry.encoder,
        decoder: supplementalPlanEntry.decoder,
        reason: "Browser supplemental-codec-unprobed: " +
          (this.supplementalProbeTimedOut
            ? `module validation timed out after 10 s for ${assetUrl}; retry capabilities or preparation. `
            : `the module at ${assetUrl} has not completed validation. `) +
          "No alias, simulation or native fallback is offered.",
      };
    };
    const codecs: CodecCapability[] = CODEC_IDS.map((codecId) => {
      if (codecId === "lc3" || codecId === "ldac") return supplementalEntry(codecId);
      const plan = probedPlan(codecId, probe?.decoderNames ?? new Set());
      if (!plan) return { codecId, availability: "unavailable", encoder: "not-implemented", decoder: "not-implemented",
        reason: "Browser adapter-not-implemented: no validated round trip for this codec; no substitution or native fallback" };
      return codec(codecId, plan.encoder, plan.decoder,
        probe?.encoderNames.has(plan.encoder) === true && probe.decoderNames.has(plan.decoder),
        `FFmpeg build does not list both the ${plan.encoder} encoder and ${plan.decoder} decoder`);
    });
    // Distinguish an unrequested module from an asset that failed validation.
    const supplementalBuild = (["lc3", "ldac"] as const).flatMap((codecId) => {
      const state = this.supplemental.availability(codecId);
      if (!state.configured) return [];
      const label = `${codecId.toUpperCase()} supplemental WASM`;
      if (state.loadState === "loaded") {
        return [codecId === "lc3" ? `${label} (liblc3 1.1.3)`
          : `${label} (AOSP libldac 2.00.02 + hegdi/libldacdec)`];
      }
      return [`${label} (${state.loadState === "failed" ? "asset validation failed" : "not yet validated"})`];
    }).join(", ");
    const build = (probe
      ? `@ffmpeg/ffmpeg ${FFMPEG_WRAPPER_VERSION}; @ffmpeg/core ${FFMPEG_CORE_VERSION}; ` +
        `single-thread WASM; FFmpeg ${probe.ffmpegVersion ?? "unknown"}`
      : `@ffmpeg/ffmpeg ${FFMPEG_WRAPPER_VERSION}; @ffmpeg/core ${FFMPEG_CORE_VERSION}; ` +
        `single-thread WASM; capability probe unavailable (${failure})`) +
      (supplementalBuild ? `; supplemental: ${supplementalBuild}` : "");
    return Object.freeze({
      engineId: "engine-browser",
      location: "browser-local",
      build,
      codecs: Object.freeze(codecs),
      channels: Object.freeze([1, 2] as const),
      maxStagesPerSide: 4,
      maxInputBytes: AUDIO_MAX_INPUT_BYTES,
      maxDurationSeconds: AUDIO_MAX_DURATION_SECONDS,
      preparationPolicy: policy,
      supportedPreparationPolicies: Object.freeze([
        ...BROWSER_SUPPORTED_PREPARATION_POLICIES,
      ]),
      supportsCanaryMaterial: true,
      limitations: Object.freeze(unique([
        `Browser-local input envelope: ${formatByteCount(AUDIO_MAX_INPUT_BYTES)} encoded/container ` +
          `input, ${String(AUDIO_MAX_DURATION_SECONDS)} s source duration plus at most ` +
          `0.1 s codec padding, and at most ${formatByteCount(AUDIO_MAX_WAV_BYTES)} per canonical ` +
          `PCM16 WAV; mono or stereo only. Native-mode source rates are ` +
          `${BROWSER_SOURCE_SAMPLE_RATES.join("/")} Hz.`,
        `The ${String(AUDIO_MAX_DURATION_SECONDS)} s / ${formatByteCount(AUDIO_MAX_INPUT_BYTES)} ` +
          "bounds are policy limits, not a validated capacity claim for every rate or host. A " +
          "full 1800 s 96 kHz stereo pair is about 1.38 GB of PCM16 delivered bytes, and " +
          "downstream numerical stages can materialize Float64 copies several times larger; " +
          "one decoded Float64 side is about 2.76 GB. WebAssembly/renderer memory exhaustion " +
          "is refused with actionable guidance rather than reported as success, and this adapter " +
          "does not claim an unlimited renderer heap.",
        "Accepted source containers are established from leading bytes, never from file " +
          "extension or MIME type: WAV (RIFF/WAVE, including 24-bit, 32-bit integer and 32/64-bit " +
          "float audio decoded by FFmpeg), FLAC at the bit depths supported by the pinned WASM " +
          "FFmpeg build, MP3, MP4/M4A (AAC/ALAC audio), Ogg (Opus/Vorbis) and raw ADTS AAC. " +
          "Playlists, network references and unknown signatures are refused.",
        "The source is decoded exactly once to a shared canonical PCM16 snapshot at the " +
          "decoded native rate and channel count. Higher-precision PCM sources, including " +
          "32-bit integer/float WAV, are quantized by that canonical conversion; no lossless " +
          "restoration is claimed. FFmpeg owns float-to-PCM16 clamping and non-finite " +
          "handling in that canonical decode. An explicit force-48k request " +
          "resamples once during that decode; native mode never invents a rate. Multichannel " +
          "sources are refused, never downmixed. Strict PCM16 WAV input is already canonical " +
          "and is adopted directly without a second decode.",
        `Import never crops to fit. Decode is bounded to ` +
          `${String(AUDIO_MAX_DURATION_SECONDS + 10)} s and a ` +
          `${formatByteCount(AUDIO_MAX_WAV_BYTES)} FFmpeg output ceiling, with a separate ` +
          "cap-detection margin, so overlong or unexpectedly laid-out sources are refused " +
          `rather than silently shortened; codec padding above ${String(AUDIO_MAX_DURATION_SECONDS)} s ` +
          "is limited to the disclosed 0.1 s allowance.",
        "Default policy codec-probe-only measures unchanged delivered PCM and applies no " +
          "correction. Explicit aligned-gain-matched-v1 applies the shared diagnostic " +
          "lag/crop, independent gains and one common peak trim in a dedicated worker.",
        "Capabilities describe this browser/WASM build, not the native FFmpeg reference. " +
          "Listed encoders/decoders do not guarantee every rate, layout or bitrate combination; " +
          "unsupported configurations refuse with FFmpeg diagnostics. The pinned libvorbis " +
          "rejects tested 96 kHz stereo 128/256 kbps configurations without resampling fallback.",
        "Opus is encoded at 48 kHz internally with 10 ms frames because @ffmpeg/core " +
          "0.12.10 traps in the libopus 48 kHz default-frame path; delivered rate follows " +
          "the selected policy.",
        "Actual bitrate uses each stage’s encoded container bytes and its own decoded duration " +
          "before correction, including container overhead and codec padding; PCM passthrough reports null.",
        "AAC/MP3/MP2/SBC at a 96 kHz session use 48 kHz internally. aptX/aptX HD are pinned " +
          "to 48 kHz internally for every session because this core's raw containers do not carry " +
          "usable rate metadata; every stage restores session rate/channels. Raw mode retains decoder " +
          `padding without hidden cropping; encoded input above ${formatByteCount(AUDIO_MAX_INPUT_BYTES)}, ` +
          `decoded source above ${String(AUDIO_MAX_DURATION_SECONDS)} s plus 0.1 s padding, or canonical ` +
          `WAV above ${formatByteCount(AUDIO_MAX_WAV_BYTES)} is refused.`,
        "MP2 is FFmpeg's built-in mp2 encoder in this WASM build, not native libtwolame; no " +
          "native/WASM MP2 quality or byte parity is claimed.",
        "aptX and aptX HD are fixed-rate and stereo-only. Requested 352/576 kbps are nominal; " +
          "actual measured rates are disclosed per stage. Mono sessions are carried as dual-mono " +
          "inside the codec and restored to mono after decode. No channel-count substitution is " +
          "reported as delivered layout.",
        "LC3 uses a same-origin supplemental WASM build of pinned liblc3 1.1.3 at an " +
          "explicit internal 48 kHz / 10 ms configuration; the raw LC3 container has no " +
          "rate header, so the encoded rate is the explicit setting, and every stage " +
          "restores the session rate/channels.",
        "LDAC uses a same-origin supplemental WASM build of the AOSP libldac 2.00.02 " +
          "encoder; LDAC decode uses the third-party reverse-engineered hegdi/libldacdec " +
          "implementation (ldac_helper v1 container). No vendor validation or bit-exact " +
          "equivalence with a retail LDAC sink is established. A 96 kHz session is " +
          "encoded at the disclosed internal 48 kHz and restored afterwards.",
        "Diagnostic canary material is available only with aligned-gain-matched-v1 and an " +
          "explicit canaryEnabled request. It is measured from the final delivered Side A " +
          "and is not a listener calibration, listener gate or ABX scoring service.",
        "The prepared policy computes a delivered identical-pipeline null decision; raw " +
          "mode publishes no validity result. Neither is experiment authority.",
        probe
          ? "Artifacts are diagnostic-only preparation products, not scored ABX evidence."
          : `Audio capability unavailable: ${failure}`,
      ])),
    });
  }

  private fallbackCapabilities(reason: string): EngineCapabilities {
    return this.capabilitiesFrom({ probe: null, failure: reason });
  }

  private async removeFiles(worker: FFmpeg, names: Iterable<string>): Promise<boolean> {
    let failed = false;
    for (const name of names) {
      try {
        await worker.deleteFile(name);
      } catch {
        // A failed command may leave no named output; any cleanup failure resets
        // the worker, which discards the whole MEMFS and guarantees no leak.
        failed = true;
      }
    }
    return failed && this.worker === worker;
  }

  private async terminateWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.workerReady = false;
    this.workerInit = null;
    this.probeCache = null;
    this.workerGeneration += 1;
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // FFmpeg.terminate is best-effort after a worker already stopped.
      }
    }
  }
}
