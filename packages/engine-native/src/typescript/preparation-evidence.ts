import {
  AUDIO_CANARY_EXCERPT_SECONDS,
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_RETAINED_BYTES,
  CODEC_IDS,
  finalSelectionForSide,
  stagesForSide,
  type AudioDescription,
  type CanaryMaterialReport,
  type CanarySide,
  type CodecCapability,
  type EngineCapabilities,
  type LevelMeasurement,
  type PairPreparationReport,
  type PreparationGateDecision,
  type PreparationRequest,
  type Side,
  type StageProvenance,
  type TrackProvenance,
} from "@codec-abx/contracts";
import { decodePcm16, measureNullDepth, type PcmAudio } from "@codec-abx/measurements";
import {
  buildCanaryExcerptPair,
  canaryExcerptFrames,
  evaluateCanaryDepth,
} from "@codec-abx/preparation-policy";

import type {
  NativeCodecRunResult,
  NativeCodecStageResult,
  NativeCodecTrackResult,
} from "./executor.js";
import type { NativeCodecCapabilities } from "./capabilities.js";
import {
  describeCanonicalWav,
  parseCanonicalPcm16Wav,
  sameBytes,
  type CanonicalPcm16WavFacts,
} from "./preparation-wav.js";

export const NATIVE_SHARED_ENGINE_ID = "engine-native-typescript" as const;
export const NATIVE_SHARED_POLICY = "aligned-gain-matched-v1" as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  return `${String(bytes)} bytes (${(bytes / (1024 * 1024)).toFixed(1)} MiB)`;
}

function positiveInteger(value: number | null): number | null {
  return value === null ? null : Number.isSafeInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value: number | null): number | null {
  return value === null ? null : Number.isFinite(value) && value > 0 ? value : null;
}

function capability(
  codecId: (typeof CODEC_IDS)[number],
  probe: NativeCodecCapabilities | null,
  failure: string | null,
): CodecCapability {
  if (!probe) {
    return {
      codecId,
      availability: "unknown",
      encoder: "unknown",
      decoder: "unknown",
      reason: failure ?? "native codec capability probe was unavailable",
    };
  }
  const entry = probe.codecs.find((candidate) => candidate.codecId === codecId);
  if (!entry) {
    return {
      codecId,
      availability: "unknown",
      encoder: "unknown",
      decoder: "unknown",
      reason: "native codec capability probe did not report this codec",
    };
  }
  return {
    codecId,
    availability: entry.availability,
    encoder: entry.encoder,
    decoder: entry.decoder,
    reason: entry.reason,
  };
}

/** Public capability facts for this shared-preparation engine. */
export function buildNativeSharedCapabilities(
  probe: NativeCodecCapabilities | null,
  failure: string | null,
): EngineCapabilities {
  const codecs: CodecCapability[] = CODEC_IDS.map((codecId) =>
    capability(codecId, probe, failure),
  );
  const build = probe
    ? `TypeScript native codec executor; ` +
      `${probe.ffmpegVersion ?? "FFmpeg version unknown"}; ` +
      `${probe.ffprobeVersion ?? "ffprobe version unknown"}; ` +
      `LDAC helper: ${probe.ldacHelperVersion ?? "unavailable"}; ` +
      `shared ${NATIVE_SHARED_POLICY} preparation`
    : `TypeScript native shared-preparation engine; ` +
      `capability probe unavailable (${failure ?? "unknown reason"})`;
  const limitations = unique([
    `Input is a bounded local WAV, FLAC, MP3, AAC, M4A/MP4, Ogg or Opus source of at most ` +
      `${formatBytes(AUDIO_MAX_INPUT_BYTES)}, mono/stereo, with explicit format demuxers and ` +
      "no playlist/network input. 32-bit integer/float WAV precision and the FLAC bit depths " +
      "supported by the installed FFmpeg are decoded as sources; delivery remains canonical PCM16.",
    `Source and codec-stage decode allow ${String(AUDIO_MAX_DURATION_SECONDS)} s plus explicit end padding. ` +
      `The final aligned/cropped delivery is required to be 0.4–${String(AUDIO_MAX_DURATION_SECONDS + 0.5)} s ` +
      `and the retained pair, calibration prefix and canary bytes at most ` +
      `${formatBytes(AUDIO_MAX_RETAINED_BYTES)}. Longer final material is refused, never silently trimmed.`,
    `Full-length canary DSP is frozen at ${String(AUDIO_CANARY_EXCERPT_SECONDS)} s; long ` +
      "tracks use exactly the FIRST ten seconds of final Side A, with the selected prefix " +
      "disclosed in the report. Short material is unchanged.",
    `Supported preparation policy is ${NATIVE_SHARED_POLICY} (or omission, which selects it). ` +
      "The engine rejects codec-probe-only before source reads, capability probes or " +
      "subprocess work; there is no fallback.",
    "Direct native FFmpeg/ffprobe/LDAC-helper execution is used. No external interpreter, " +
      "module, bridge or fallback is used or required.",
    "Native and browser WASM codec output/quality are not claimed equal; the shared policy " +
      "is not a codec-equivalence guarantee.",
    "Alignment/gain/crop/PCM16 serialization and final-byte measurement are synchronous " +
      "shared DSP. Cancellation is observed between codec processes and before/after " +
      "numerical passes, not in the middle of a synchronous call.",
    "Sample peaks are sample peaks, not oversampled true peaks. The -16 LUFS target and " +
      "the compatible K-weighting/block/gate implementation are a frozen product policy, " +
      "not an ITU/EBU conformance certification.",
    "Alignment maximizes signed correlation and has no confidence gate. Globally polarity-inverted " +
      "or weakly related A/B signals can produce an unreliable lag/crop; the separate " +
      "preparation-validity-v2 preflight refuses non-evidentiary, globally inverted, weak, " +
      "unrelated or search-bound pairs before correction, and periodic/ambiguous pairs are " +
      "passed only with an explicit no-unique-lag disclosure. Codec execution alone does not " +
      "establish that every pair meets those assumptions.",
    "Diagnostic canary material is available only with explicit canaryEnabled and the " +
      "shared policy. Usable material is not proof of human audibility, a calibration " +
      "trial or a scored ABX run.",
    "The identical-pipeline null decision is measured on final delivered bytes and is " +
      "diagnostic evidence, not experiment authority.",
    "Delivered validity v2 adds a preparation-validity-v2 decision on the exact final " +
      "serialized pair. Its thresholds are frozen product choices, not scientific, " +
      "perceptual or ABX certification.",
  ]);
  return Object.freeze({
    engineId: NATIVE_SHARED_ENGINE_ID,
    location: "desktop-native",
    build,
    codecs: Object.freeze(codecs),
    channels: Object.freeze([1, 2] as const),
    maxStagesPerSide: 4,
    maxInputBytes: AUDIO_MAX_INPUT_BYTES,
    maxDurationSeconds: AUDIO_MAX_DURATION_SECONDS,
    preparationPolicy: NATIVE_SHARED_POLICY,
    supportedPreparationPolicies: Object.freeze([NATIVE_SHARED_POLICY]),
    supportsCanaryMaterial: true,
    limitations: Object.freeze(limitations),
  });
}

function stageProvenance(
  request: PreparationRequest,
  side: Side,
  stage: NativeCodecStageResult,
  index: number,
): StageProvenance {
  const selections = stagesForSide(request, side);
  const expected = selections[index];
  if (!expected || stage.stageIndex !== index + 1 ||
      stage.requested.codecId !== expected.codecId ||
      stage.requested.bitrateKbps !== expected.bitrateKbps) {
    throw new Error(`Native stage ${String(index + 1)} provenance disagrees with the frozen request`);
  }
  const actualBitrateKbps = positiveNumber(stage.actualBitrateKbps);
  if (stage.actualBitrateKbps !== null && actualBitrateKbps === null) {
    throw new Error(`Native stage ${String(index + 1)} actual bitrate is not finite and positive`);
  }
  const encodedSampleRate = positiveInteger(stage.encodedSampleRate);
  if (encodedSampleRate === null) {
    throw new Error(`Native stage ${String(index + 1)} encoded sample rate is invalid`);
  }
  return Object.freeze({
    stageIndex: stage.stageIndex,
    requested: Object.freeze({
      codecId: expected.codecId,
      bitrateKbps: expected.bitrateKbps,
    }),
    encoder: stage.encoder,
    decoder: stage.decoder,
    actualBitrateKbps,
    encodedSampleRate,
  });
}

/**
 * Canonical public track provenance. Pre-crop measured bitrate/rate facts from
 * every stage are retained, while the delivered description covers the exact
 * corrected PCM16 bytes retained for this artifact.
 */
export function buildTrackProvenance(
  request: PreparationRequest,
  side: Side,
  track: NativeCodecTrackResult,
  bytes: Uint8Array,
  facts: CanonicalPcm16WavFacts,
): TrackProvenance {
  const selections = stagesForSide(request, side);
  if (track.stages.length !== selections.length) {
    throw new Error("Native track stage count disagrees with the frozen request");
  }
  const stages = track.stages.map((stage, index) =>
    stageProvenance(request, side, stage, index),
  );
  const finalStage = stages[stages.length - 1];
  if (!finalStage) throw new Error("Native track contains no stages");
  if (track.encoder !== finalStage.encoder || track.decoder !== finalStage.decoder ||
      track.actualBitrateKbps !== finalStage.actualBitrateKbps ||
      track.encodedSampleRate !== finalStage.encodedSampleRate) {
    throw new Error("Native track final summary disagrees with its ordered stages");
  }
  return Object.freeze({
    requested: finalSelectionForSide(request, side),
    stages: Object.freeze(stages),
    encoder: finalStage.encoder,
    decoder: finalStage.decoder,
    actualBitrateKbps: finalStage.actualBitrateKbps,
    encodedSampleRate: finalStage.encodedSampleRate,
    delivered: describeCanonicalWav(bytes, facts),
  });
}

function sameLevel(a: LevelMeasurement, b: LevelMeasurement): boolean {
  return a.status === b.status && a.value === b.value && a.reason === b.reason;
}

export function levelNote(level: LevelMeasurement, unit: string): string {
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

export function buildMeasurementNotes(
  delivered: {
    readonly a: { readonly integratedLufs: LevelMeasurement; readonly samplePeakDbfs: LevelMeasurement };
    readonly b: { readonly integratedLufs: LevelMeasurement; readonly samplePeakDbfs: LevelMeasurement };
    readonly loudnessDeltaDb: LevelMeasurement;
    readonly alignment: { readonly lagSamples: number; readonly confidence: number; readonly status: string };
    readonly nullDepth: { readonly depthDb: LevelMeasurement; readonly comparedFrames: number };
  },
  preparation: PairPreparationReport,
): string[] {
  const applied = preparation.alignment;
  return unique([
    "Residual lag, loudness, sample peak and null depth were measured from the exact " +
      "final canonical PCM16 WAV bytes, not from pre-serialization float intermediates.",
    `Side A integrated loudness ${levelNote(delivered.a.integratedLufs, "LUFS")}; ` +
      `sample peak ${levelNote(delivered.a.samplePeakDbfs, "dBFS")} (sample peak, not true peak).`,
    `Side B integrated loudness ${levelNote(delivered.b.integratedLufs, "LUFS")}; ` +
      `sample peak ${levelNote(delivered.b.samplePeakDbfs, "dBFS")} (sample peak, not true peak).`,
    `Loudness delta ${levelNote(delivered.loudnessDeltaDb, "dB")}.`,
    `Residual alignment lag is ${String(delivered.alignment.lagSamples)} samples ` +
      `(positive means B is delayed) with confidence ` +
      `${delivered.alignment.confidence.toExponential(6)}. The applied alignment was ` +
      `${String(applied.lagSamples)} samples with status ${applied.status}; applied head ` +
      `trim was A ${String(applied.startFrameA)} and B ${String(applied.startFrameB)} ` +
      `frames, producing ${String(applied.outputFrames)} output frames.`,
    `Final-delivery unshifted common-prefix null depth ` +
      `${levelNote(delivered.nullDepth.depthDb, "dB")} over ` +
      `${String(delivered.nullDepth.comparedFrames)} compared frames.`,
    `Applied independent gains were ${preparation.loudness.gainADb.toFixed(6)} dB (A) and ` +
      `${preparation.loudness.gainBDb.toFixed(6)} dB (B), followed by one common peak trim ` +
      `of ${preparation.loudness.commonTrimDb.toFixed(6)} dB.`,
    "Non-finite delivered levels keep their explicit status in the delivered report; the " +
      "legacy summary fields publish them as JSON-safe null with their meaning stated here. " +
      "These are diagnostic measurements, not proof of an audible difference or a valid run.",
  ]);
}

export interface RetainedCanaryMaterial {
  readonly report: CanaryMaterialReport;
  readonly audio: Readonly<Record<CanarySide, AudioDescription>> | null;
  readonly bytes: Readonly<Record<CanarySide, Uint8Array>> | null;
}

/**
 * Build canary material only from the exact final served Side A. Usable material
 * is re-parsed, re-hashed and re-measured from its own bytes before retention;
 * unusable material retains no served audio.
 */
export function buildRetainedCanary(
  finalA: PcmAudio,
  finalABytes: Uint8Array,
  finalAFacts: CanonicalPcm16WavFacts,
): RetainedCanaryMaterial {
  const totalFrames = finalA.channels[0]?.length ?? 0;
  const excerptFrames = canaryExcerptFrames(finalA.sampleRate, totalFrames);
  const material = buildCanaryExcerptPair(finalA);
  if (!material.report.usable) {
    return {
      report: material.report,
      audio: null,
      bytes: null,
    };
  }

  const pristineFacts = parseCanonicalPcm16Wav(material.pristineWav);
  const degradedFacts = parseCanonicalPcm16Wav(material.degradedWav);
  for (const [label, facts] of [
    ["pristine", pristineFacts],
    ["degraded", degradedFacts],
  ] as const) {
    if (facts.sampleRate !== finalAFacts.sampleRate ||
        facts.channels !== finalAFacts.channels ||
        facts.frames !== excerptFrames) {
      throw new Error(
        `Canary ${label} layout disagrees with the selected ` +
          `${String(excerptFrames)}-frame Side A calibration prefix`,
      );
    }
  }
  if (excerptFrames === totalFrames) {
    if (!sameBytes(material.pristineWav, finalABytes)) {
      throw new Error("Canary pristine WAV is not the exact final delivered Side A");
    }
  } else {
    // Long tracks retain exactly the FIRST ten seconds, never arbitrary material.
    const pristinePayload = material.pristineWav.subarray(
      pristineFacts.dataOffset,
      pristineFacts.dataOffset + pristineFacts.dataSize,
    );
    const finalPrefix = finalABytes.subarray(
      finalAFacts.dataOffset,
      finalAFacts.dataOffset + pristineFacts.dataSize,
    );
    if (!sameBytes(pristinePayload, finalPrefix)) {
      throw new Error(
        "Canary pristine WAV is not the exact FIRST calibration prefix of the final delivered Side A",
      );
    }
  }

  const decode = (bytes: Uint8Array, facts: CanonicalPcm16WavFacts): PcmAudio =>
    decodePcm16(bytes, {
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      dataOffset: facts.dataOffset,
      dataSize: facts.dataSize,
    });
  const measured = measureNullDepth(
    decode(material.pristineWav, pristineFacts),
    decode(material.degradedWav, degradedFacts),
  );
  const decision = evaluateCanaryDepth(measured.depthDb);
  if (!sameLevel(measured.depthDb, material.report.depthDb) ||
      decision.status !== material.report.status ||
      decision.usable !== material.report.usable ||
      decision.reason !== material.report.reason) {
    throw new Error("Canary report depth disagrees with its exact retained WAV bytes");
  }

  const report: CanaryMaterialReport = Object.freeze({
    ...material.report,
    ...decision,
    notes: material.report.notes,
  });
  return {
    report,
    audio: Object.freeze({
      pristine: describeCanonicalWav(material.pristineWav, pristineFacts),
      degraded: describeCanonicalWav(material.degradedWav, degradedFacts),
    }),
    bytes: Object.freeze({
      pristine: material.pristineWav,
      degraded: material.degradedWav,
    }),
  };
}

export function buildPreparationDisclosures(
  native: NativeCodecRunResult,
  canary: RetainedCanaryMaterial | undefined,
  preflightGate: PreparationGateDecision,
): string[] {
  const canaryEnabled = canary !== undefined;
  return unique([
    `Original source: ${native.source.format.toUpperCase()}, ${native.session.sourceSampleRate} Hz, ` +
      `${native.session.sourceChannels} channels. Session: ${native.session.sampleRate} Hz, ` +
      `${native.session.channels} channels (${native.session.sampleRateMode}).`,
    `Original source detail: ${native.source.formatLabel} container ${native.source.container}, ` +
      `codec ${native.source.codec}, ${String(native.session.sourceSampleRate)} Hz, ` +
      `${String(native.session.sourceChannels)} channel(s). It was explicitly decoded to ` +
      `${String(native.session.sampleRate)} Hz/${String(native.session.channels)} channel ` +
      "Float64 PCM with an allowlisted format demuxer; the source hash still covers the " +
      "original compressed bytes.",
    ...native.disclosures.map(note => `Codec execution before shared preparation: ${note}`),
    "Prepared by the TypeScript native shared-preparation engine: direct " +
      "native FFmpeg/ffprobe/helper codec execution, then exactly one shared " +
      `${NATIVE_SHARED_POLICY} correction pass. No external interpreter, module, bridge or ` +
      "fallback participated.",
    "The frozen public request names the actual applied policy " +
      `${NATIVE_SHARED_POLICY}. codec-probe-only and every other unsupported ` +
      "policy are refused before source reads, capability probes, workers or subprocesses.",
    "The selected source was privately snapshotted, hashed and decoded by the executor. " +
      "The source path is control input and is never published in this artifact.",
    "Artifact WAV hashes, layouts, frame counts and retained bytes describe the exact final " +
      "canonical PCM16 delivery. The shared alignment crop is the only trim applied; codec " +
      "padding and frame-count changes are retained and disclosed rather than silently trimmed.",
    "Encoded bitrate and encoded sample-rate provenance are measured per codec stage before " +
      "the final alignment crop/gains. Actual bitrate includes each stage's container " +
      "overhead/padding and is distinct from the requested bitrate.",
    "The final delivery is bounded to 0.4–" +
      `${String(AUDIO_MAX_DURATION_SECONDS + 0.5)} s and the retained pair-plus-canary bytes to ` +
      `${formatBytes(AUDIO_MAX_RETAINED_BYTES)}. Source intake and codec-stage decoding are ` +
      `bounded to ${formatBytes(AUDIO_MAX_INPUT_BYTES)} and ${String(AUDIO_MAX_DURATION_SECONDS)} s ` +
      "plus explicit end padding; longer material is refused rather than silently cropped.",
    "Integrated loudness uses the frozen pyloudnorm 0.2.0-compatible K-weighting, 400 ms " +
      "blocks, 75% overlap and absolute/relative gating already used by the shared policy. " +
      "The -16 LUFS target is a product choice, not an ITU/EBU certification.",
    "Sample peaks are sample peaks, not oversampled true peaks. PCM16 serialization uses " +
      "floor quantization with the documented 2^-17 code-step pre-floor bias and no dither; " +
      "this is an existing product quantizer choice, not a libsndfile compatibility requirement.",
    "Signed-correlation alignment has no confidence gate and can misalign globally polarity-inverted " +
      "or weakly related A/B signals. The separate preparation-validity-v2 preflight refuses " +
      "non-evidentiary, globally inverted, weak, unrelated and search-bound pairs before " +
      "correction; periodic/ambiguous preflight passes carry an explicit no-unique-lag disclosure.",
    `Preparation-validity-v1 preflight on the decoded codec-stage pair classified ` +
      `${preflightGate.classification} with same-polarity confidence ` +
      `${preflightGate.evidence.sameConfidence.toExponential(6)} and inverted-hypothesis ` +
      `confidence ${preflightGate.evidence.invertedConfidence.toExponential(6)}. This ` +
      "preflight is product-policy evidence, not proof of audibility or a valid ABX run.",
    ...(preflightGate.disclosure === null ? [] : [preflightGate.disclosure]),
    "The identical-pipeline null decision is evaluated on the final served pair. It is a " +
      "diagnostic delivered-audio check, not experiment authority or proof of audibility.",
    canaryEnabled
      ? `Diagnostic canary material was explicitly requested and generated only from the ` +
        `FIRST ${String(canary.report.frames)} frames ` +
        `(${(canary.report.frames / canary.report.sampleRate).toFixed(6)} s) of the final ` +
        "served Side A. Short material uses its full extent; long material is not " +
        "substituted with later audio. Usable material is retained; unusable material " +
        "retains no audio. No listener calibration, listener gate or ABX scoring ran."
      : "No canary material was requested. No bandwidth filtering, listener calibration, " +
        "listener gate or ABX scoring ran.",
    "Native codec builds/output are not claimed byte- or quality-equivalent to browser " +
      "WASM codecs or to another FFmpeg build, encoder or platform.",
    "Shared numerical DSP is synchronous and bounded. Cancellation is checked between " +
      "codec processes and before/after numerical passes; a mid-call interrupt is not claimed.",
  ]);
}

export { errorMessage };
