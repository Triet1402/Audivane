/** Public data only. Unrevealed trial assignments never belong here. */
export { AUDIO_MAX_INPUT_BYTES, AUDIO_MAX_DURATION_SECONDS, AUDIO_MAX_WAV_BYTES,
  AUDIO_MAX_RETAINED_BYTES, AUDIO_CANARY_EXCERPT_SECONDS, AUDIO_MAX_SOURCE_PADDING_SECONDS,
  AUDIO_MAX_DELIVERY_PADDING_SECONDS, AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_DECODE_SENTINEL_SECONDS, AUDIO_MAX_SAMPLE_RATE, AUDIO_MAX_CHANNELS,
  AUDIO_PCM16_BYTES_PER_SAMPLE, AUDIO_FLOAT64_BYTES_PER_SAMPLE,
  AUDIO_MAX_DELIVERY_FRAMES, AUDIO_MAX_CANARY_WAV_BYTES,
  AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE,
  AUDIO_MAX_RETAINED_FLOAT64_BYTES } from "./audio-limits.js";
export type { DesktopSource, DesktopExperimentBridge, DesktopBridge, DesktopRuntimeFailure } from "./desktop.js";
export type { OutputDeviceEntry, OutputDeviceOperation, OutputDeviceSupport,
  OutputRouteChange, PlaybackLoop, PlaybackOutputState, PlaybackSnapshot,
  TrialAudioReader, TrialLoadOptions, TrialPlayer } from "./playback.js";
export type { DisplayAnswer, PlaybackLabel, TrialKind, ExperimentLifecycle,
  ExperimentPlan, PublicTrial, AnswerReceipt, ExperimentStatistics, ExperimentGates,
  ExperimentSnapshot, ExperimentAuditRow, ExperimentExport, ExperimentClient } from "./experiment.js";
import type { DeliveredPairMeasurements } from "./measurements.js";
import type { PairPreparationReport, PreparationPolicyId } from "./preparation-policy.js";
import type { CanaryMaterialReport, PairValidityReport } from "./validity.js";
export type { NullGateDecision, CanaryDepthDecision, CanaryMaterialReport,
  DeliveredValidityV1, DeliveredValidityV2, PreparationGateClassification,
  PreparationGateDecision, PreparationGateEvidenceSummary,
  PairValidityReport } from "./validity.js";
export type { PairPreparationReport, PreparationPolicyId } from "./preparation-policy.js";
export type { AlignmentEstimate, LevelMeasurement, AudioMeasurementSummary,
  DeliveredPairMeasurements } from "./measurements.js";
export type EngineLocation = "desktop-native" | "browser-local" | "optional-server";
export type Side = "a" | "b";
export type CanarySide = "pristine" | "degraded";
export const CODEC_IDS = Object.freeze(["noop_passthrough", "opus", "aac", "ogg_vorbis", "mp3", "mp2", "lc3", "sbc", "aptx", "aptx_hd", "ldac"] as const);
export type CodecId = typeof CODEC_IDS[number];
export const CODEC_CATALOG: Readonly<Record<CodecId, Readonly<{ codecId: CodecId; displayName: string; bitrateOptionsKbps: readonly number[] }>>> = Object.freeze({
  noop_passthrough: Object.freeze({ codecId: "noop_passthrough", displayName: "No-op / Lossless passthrough", bitrateOptionsKbps: Object.freeze([0]) }),
  opus: Object.freeze({ codecId: "opus", displayName: "Opus", bitrateOptionsKbps: Object.freeze([16, 24, 32, 48, 64, 96, 128, 160, 192, 256, 320]) }),
  aac: Object.freeze({ codecId: "aac", displayName: "AAC", bitrateOptionsKbps: Object.freeze([48, 64, 80, 96, 128, 160, 192, 256, 320]) }),
  ogg_vorbis: Object.freeze({ codecId: "ogg_vorbis", displayName: "Ogg Vorbis", bitrateOptionsKbps: Object.freeze([64, 96, 128, 160, 192, 256, 320]) }),
  mp3: Object.freeze({ codecId: "mp3", displayName: "MP3", bitrateOptionsKbps: Object.freeze([64, 96, 128, 160, 192, 256, 320]) }),
  mp2: Object.freeze({ codecId: "mp2", displayName: "MP2", bitrateOptionsKbps: Object.freeze([64, 96, 128, 160, 192, 224, 256, 320, 384]) }),
  lc3: Object.freeze({ codecId: "lc3", displayName: "LC3", bitrateOptionsKbps: Object.freeze([32, 48, 64, 96, 128, 160, 192, 256, 320]) }),
  sbc: Object.freeze({ codecId: "sbc", displayName: "SBC", bitrateOptionsKbps: Object.freeze([96, 128, 160, 192, 256, 320]) }),
  aptx: Object.freeze({ codecId: "aptx", displayName: "aptX", bitrateOptionsKbps: Object.freeze([352]) }),
  aptx_hd: Object.freeze({ codecId: "aptx_hd", displayName: "aptX HD", bitrateOptionsKbps: Object.freeze([576]) }),
  ldac: Object.freeze({ codecId: "ldac", displayName: "LDAC", bitrateOptionsKbps: Object.freeze([330, 660, 990]) }),
});
export type SampleRateMode = "native" | "force_48k";

export interface CodecSelection {
  readonly codecId: CodecId;
  readonly bitrateKbps: number;
}

export interface SingleStagePreparationRequest {
  readonly version: 1;
  /** Omission preserves the adapter's existing default; unsupported policies reject. */
  readonly preparationPolicy?: PreparationPolicyId;
  /** Explicit opt-in to diagnostic canary material; never enables a scored trial. */
  readonly canaryEnabled?: boolean;
  readonly sampleRateMode: SampleRateMode;
  readonly a: CodecSelection;
  readonly b: CodecSelection;
}

export interface ChainPreparationRequest {
  readonly version: 2;
  readonly preparationPolicy?: PreparationPolicyId;
  readonly canaryEnabled?: boolean;
  readonly sampleRateMode: SampleRateMode;
  readonly a: readonly CodecSelection[];
  readonly b: readonly CodecSelection[];
}
export type PreparationRequest = SingleStagePreparationRequest | ChainPreparationRequest;

export function stagesForSide(request: PreparationRequest, side: Side): readonly CodecSelection[] {
  return request.version === 1 ? Object.freeze([request[side]]) : request[side];
}
export function finalSelectionForSide(request: PreparationRequest, side: Side): CodecSelection {
  const stages = stagesForSide(request, side);
  return stages[stages.length - 1]!;
}
export function samePipelines(request: PreparationRequest): boolean {
  const a = stagesForSide(request, "a"), b = stagesForSide(request, "b");
  return a.length === b.length && a.every((stage, i) => stage.codecId === b[i]!.codecId && stage.bitrateKbps === b[i]!.bitrateKbps);
}
export function requestsEqual(a: PreparationRequest, b: PreparationRequest): boolean {
  return JSON.stringify(freezeRequest(a)) === JSON.stringify(freezeRequest(b));
}

export interface CodecCapability {
  readonly codecId: CodecId;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly encoder: string;
  readonly decoder: string;
  readonly reason: string | null;
}

export interface EngineCapabilities {
  readonly engineId: string;
  readonly location: EngineLocation;
  readonly build: string;
  readonly codecs: readonly CodecCapability[];
  readonly channels: readonly (1 | 2)[];
  /** Omission does not establish chain support; adapters must refuse unsupported chains. */
  readonly maxStagesPerSide?: number;
  /** Bounds for this spike, not product-wide guarantees. */
  readonly maxInputBytes: number;
  readonly maxDurationSeconds: number;
  readonly preparationPolicy: PreparationPolicyId;
  readonly supportedPreparationPolicies?: readonly PreparationPolicyId[];
  /** Diagnostic canary generation, not a listener calibration/scoring service. */
  readonly supportsCanaryMaterial?: boolean;
  readonly limitations: readonly string[];
}

export interface AudioDescription {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  /** SHA-256 of serialized delivered WAV bytes, not a hash of a float array. */
  readonly wavSha256: string;
}

export interface StageProvenance {
  readonly stageIndex: number;
  readonly requested: CodecSelection;
  readonly encoder: string;
  readonly decoder: string;
  readonly actualBitrateKbps: number | null;
  readonly encodedSampleRate: number | null;
}

export interface TrackProvenance {
  readonly stages?: readonly StageProvenance[];
  readonly requested: CodecSelection;
  readonly encoder: string;
  readonly decoder: string;
  readonly actualBitrateKbps: number | null;
  readonly encodedSampleRate: number | null;
  readonly delivered: AudioDescription;
}

/** A probe is never sufficient evidence to start a scored ABX run. */
export interface PreparedArtifact {
  readonly id: string;
  readonly request: PreparationRequest;
  readonly engine: EngineCapabilities;
  readonly sourceSha256: string;
  readonly a: TrackProvenance;
  readonly b: TrackProvenance;
  readonly elapsedMs: number;
  readonly measurements: {
    readonly policy: PreparationPolicyId | "delivered-pcm-measurements-v1";
    readonly alignmentLagSamples: number | null;
    readonly alignmentConfidence: number | null;
    readonly loudnessDeltaDb: number | null;
    /** Non-finite reference values must be JSON-safe null, with their meaning in notes. */
    readonly nullDepthDb: number | null;
    readonly notes: readonly string[];
    /** Detailed statuses for serialized delivery. Applied correction is recorded separately; no gates implied. */
    readonly delivered?: DeliveredPairMeasurements;
  };
  readonly preparation?: PairPreparationReport;
  readonly validity?: PairValidityReport;
  readonly canary?: {
    readonly report: CanaryMaterialReport;
    /** No downloads when the serialized pristine/degraded canary pair fails its material check. */
    readonly audio: Readonly<Record<CanarySide, AudioDescription>> | null;
  };
  readonly disclosures: readonly string[];
  readonly purpose: "diagnostic-only";
}

export interface PreparationProgress {
  readonly phase: "loading" | "probing" | "encoding" | "preparing" | "measuring" | "complete";
  readonly message: string;
}

export const OPUS_BITRATES_KBPS = CODEC_CATALOG.opus.bitrateOptionsKbps;

/** Freeze a validated canonical copy before asynchronous work. Unknown fields are refused. */
export function freezeRequest(value: unknown): PreparationRequest {
  const record = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid preparation request");
    return raw as Record<string, unknown>;
  };
  const request = record(value);
  if (Object.keys(request).some((key) => !["version", "sampleRateMode", "preparationPolicy", "canaryEnabled", "a", "b"].includes(key))) throw new Error("Unexpected preparation request field");
  if (request.version !== 1 && request.version !== 2) throw new Error("Unsupported preparation request version");
  if (request.canaryEnabled !== undefined && typeof request.canaryEnabled !== "boolean") throw new Error("Invalid canary option; expected a boolean");
  if (request.preparationPolicy !== undefined && request.preparationPolicy !== "codec-probe-only" && request.preparationPolicy !== "aligned-gain-matched-v1") throw new Error("Unsupported preparation policy");
  if (request.sampleRateMode !== "native" && request.sampleRateMode !== "force_48k") throw new Error("Unsupported sample-rate mode");
  const selection = (raw: unknown): CodecSelection => {
    const entry = record(raw);
    if (Object.keys(entry).some((key) => !["codecId", "bitrateKbps"].includes(key))) throw new Error("Unexpected codec selection field");
    const id = entry.codecId;
    if (typeof id !== "string" || !CODEC_IDS.includes(id as CodecId) || typeof entry.bitrateKbps !== "number" || !CODEC_CATALOG[id as CodecId].bitrateOptionsKbps.includes(entry.bitrateKbps)) throw new Error("Unsupported codec or bitrate; substitution is disabled");
    return Object.freeze({ codecId: id as CodecId, bitrateKbps: entry.bitrateKbps });
  };
  const global: Pick<SingleStagePreparationRequest, "sampleRateMode" | "preparationPolicy" | "canaryEnabled"> = { sampleRateMode: request.sampleRateMode,
    ...(request.preparationPolicy === undefined ? {} : { preparationPolicy: request.preparationPolicy }),
    ...(request.canaryEnabled === undefined ? {} : { canaryEnabled: request.canaryEnabled }) };
  if (request.version === 1) return Object.freeze({ version: 1, ...global, a: selection(request.a), b: selection(request.b) });
  const chain = (raw: unknown): readonly CodecSelection[] => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new Error("Each pipeline requires one through four stages");
    return Object.freeze(Array.from(raw, selection));
  };
  return Object.freeze({ version: 2, ...global, a: chain(request.a), b: chain(request.b) });
}
