import type {
  DeliveredPairMeasurements,
  PairPreparationReport,
  LevelMeasurement,
} from "@codec-abx/contracts";
import {
  SUPPORTED_SAMPLE_RATES,
  decodePcm16,
  estimateLag,
  integratedLoudness,
  measurePair,
  type PcmAudio,
} from "@codec-abx/measurements";

import { PreparationPolicyError } from "./errors.js";
import {
  encodeGainedPcm16Wav,
  PCM16_WAV_HEADER_BYTES,
  PCM16_FLOOR_BIAS,
} from "./pcm16.js";

/** Frozen policy constants. v1 deliberately has no user-adjustable DSP. */
export const PREPARATION_POLICY_ID = "aligned-gain-matched-v1" as const;
export const PREPARATION_TARGET_LUFS = -16 as const;
export const PREPARATION_LAG_SECONDS = 0.1;
export const PREPARATION_PROBE_SAMPLES = 240_000;
export const PREPARATION_MIN_SECONDS = 0.4;
/** One positive PCM16 quantum of headroom: 32767 / 32768. */
export const PREPARATION_PEAK_CEILING = 32767 / 32768;

/** Caller-owned results. Readonly is a type contract, not a deep runtime freeze;
 * WAV buffers must remain transferable to the adapter. */
export interface PreparePairResult {
  readonly aWav: Uint8Array;
  readonly bWav: Uint8Array;
  readonly report: PairPreparationReport;
  readonly delivered: DeliveredPairMeasurements;
}

interface ValidatedPair {
  readonly framesA: number;
  readonly framesB: number;
  readonly channels: 1 | 2;
}

function fail(code: PreparationPolicyError["code"], message: string): never {
  throw new PreparationPolicyError(code, message);
}

function validatePcm(audio: PcmAudio, side: string): number {
  if (!audio || typeof audio !== "object") fail("invalid-pcm", `${side} PCM is not an object`);
  if (!SUPPORTED_SAMPLE_RATES.some((rate) => rate === audio.sampleRate)) {
    fail(
      "invalid-pcm",
      `${side} sample rate ${String(audio.sampleRate)} is unsupported; ` +
        `expected one of ${SUPPORTED_SAMPLE_RATES.join(", ")} Hz`,
    );
  }
  if (!Array.isArray(audio.channels) || (audio.channels.length !== 1 && audio.channels.length !== 2)) {
    fail("invalid-pcm", `${side} PCM must have one or two channels`);
  }
  const frames = audio.channels[0]?.length ?? 0;
  if (frames <= 0) fail("invalid-pcm", `${side} PCM contains no frames`);
  for (let channel = 0; channel < audio.channels.length; channel += 1) {
    const samples = audio.channels[channel];
    if (!(samples instanceof Float64Array)) {
      fail("invalid-pcm", `${side} PCM channel ${channel} must be a Float64Array`);
    }
    if (samples.length !== frames) {
      fail("invalid-pcm", `${side} PCM channels must have equal lengths`);
    }
    for (let frame = 0; frame < frames; frame += 1) {
      if (!Number.isFinite(samples[frame] ?? Number.NaN)) {
        fail("invalid-pcm", `${side} PCM contains a non-finite sample at frame ${frame}`);
      }
    }
  }
  return frames;
}

function validatePair(a: PcmAudio, b: PcmAudio): ValidatedPair {
  const framesA = validatePcm(a, "A");
  const framesB = validatePcm(b, "B");
  if (a.sampleRate !== b.sampleRate) {
    fail(
      "incompatible-pair",
      `Pair sample rates differ (${a.sampleRate} vs ${b.sampleRate}); ` +
        "resampling is not part of this policy",
    );
  }
  if (a.channels.length !== b.channels.length) {
    fail(
      "incompatible-pair",
      `Pair channel layouts differ (${a.channels.length} vs ${b.channels.length}); ` +
        "downmixing is not part of this policy",
    );
  }
  return { framesA, framesB, channels: a.channels.length === 1 ? 1 : 2 };
}

/**
 * Shift-then-crop exactly like core.alignment.align_pair: trim the leading
 * samples of the side that starts later, then keep the common tail length.
 * Never pad silence. @internal — defensive boundary, not the package public API.
 */
export function cropForLag(
  aChannels: readonly Float64Array[],
  bChannels: readonly Float64Array[],
  lagSamples: number,
): { readonly a: Float64Array[]; readonly b: Float64Array[]; readonly frames: number } {
  if (!Number.isSafeInteger(lagSamples)) {
    fail("invalid-pcm", "Alignment lag must be a safe integer");
  }
  const startA = lagSamples < 0 ? -lagSamples : 0;
  const startB = lagSamples > 0 ? lagSamples : 0;
  const framesA = aChannels[0]?.length ?? 0;
  const framesB = bChannels[0]?.length ?? 0;
  const frames = Math.min(framesA - startA, framesB - startB);
  if (frames <= 0) {
    fail(
      "empty-crop",
      `Alignment crop is empty (A ${framesA} frames, B ${framesB} frames, lag ${lagSamples})`,
    );
  }
  const a = aChannels.map((channel) => channel.subarray(startA, startA + frames));
  const b = bChannels.map((channel) => channel.subarray(startB, startB + frames));
  return { a, b, frames };
}

function requireGainFactor(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) {
    fail("nonfinite-processing", `Gain factor ${String(factor)} is not finite and positive`);
  }
}

/**
 * Peak of the independently gained pair without allocating gained Float64
 * copies. The multiplication and scan order match the previous
 * scale-gained-then-scan implementation exactly.
 */
function maximumAbsoluteGained(
  channelsA: readonly Float64Array[],
  channelsB: readonly Float64Array[],
  gainA: number,
  gainB: number,
): number {
  requireGainFactor(gainA);
  requireGainFactor(gainB);
  let peak = 0;
  for (const [channels, factor] of [
    [channelsA, gainA],
    [channelsB, gainB],
  ] as const) {
    for (const channel of channels) {
      for (let index = 0; index < channel.length; index += 1) {
        const value = (channel[index] ?? 0) * factor;
        if (!Number.isFinite(value)) {
          fail(
            "nonfinite-processing",
            `Gain processing produced a non-finite sample at frame ${index}`,
          );
        }
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
      }
    }
  }
  return peak;
}

function requireFiniteLevel(level: LevelMeasurement, side: string): number {
  if (level.status !== "finite") {
    fail(
      "loudness-unavailable",
      `${side} integrated loudness is unavailable after cropping: ${level.reason}`,
    );
  }
  return level.value;
}

function formatDb(value: number): string {
  return value.toFixed(6);
}

const DELIVERED_NOTES = [
  "Residual lag, loudness, sample peak and null depth were measured on the final " +
    "serialized PCM16 delivery after aligned-gain-matched-v1 preparation.",
  "The delivered alignment lag is residual; the applied alignment trim is " +
    "recorded separately in the preparation report.",
  "Diagnostic measurements only; they do not establish a valid ABX run or an " +
    "audible difference.",
] as const;

/**
 * Pure synchronous shared preparation policy:
 * validate -> estimate lag -> shift/crop -> measure pre-gain LUFS ->
 * independent gains -> one common peak trim -> canonical PCM16 -> remeasure
 * the serialized bytes.
 *
 * The caller's PCM arrays are never mutated. Errors are explicit and carry a
 * stable `PreparationPolicyError.code`; no partial delivery is returned.
 */
export function preparePair(a: PcmAudio, b: PcmAudio): PreparePairResult {
  const { framesA, framesB, channels } = validatePair(a, b);
  const sampleRate = a.sampleRate;
  const maxLagSamples = Math.floor(PREPARATION_LAG_SECONDS * sampleRate);
  const probeSamples = PREPARATION_PROBE_SAMPLES;

  const alignment = estimateLag(a, b, { maxLagSamples, probeSamples });
  const lagSamples = alignment.status === "no-evidence" ? 0 : alignment.lagSamples;
  const startFrameA = lagSamples < 0 ? -lagSamples : 0;
  const startFrameB = lagSamples > 0 ? lagSamples : 0;
  const cropped = cropForLag(a.channels, b.channels, lagSamples);
  const outputFrames = cropped.frames;

  const minFrames = PREPARATION_MIN_SECONDS * sampleRate;
  if (outputFrames < minFrames) {
    fail(
      "short-crop",
      `Aligned output is ${outputFrames} frames (${(outputFrames / sampleRate).toFixed(6)} s), ` +
        `shorter than the ${PREPARATION_MIN_SECONDS} s (${String(minFrames)} frame) minimum`,
    );
  }

  const preA = integratedLoudness({ sampleRate, channels: cropped.a });
  const preB = integratedLoudness({ sampleRate, channels: cropped.b });
  const preLufsA = requireFiniteLevel(preA, "A");
  const preLufsB = requireFiniteLevel(preB, "B");
  const gainADb = PREPARATION_TARGET_LUFS - preLufsA;
  const gainBDb = PREPARATION_TARGET_LUFS - preLufsB;
  if (!Number.isFinite(gainADb) || !Number.isFinite(gainBDb)) {
    fail("nonfinite-processing", "Independent loudness gains are not finite");
  }

  const gainFactorA = 10 ** (gainADb / 20);
  const gainFactorB = 10 ** (gainBDb / 20);
  const peak = maximumAbsoluteGained(cropped.a, cropped.b, gainFactorA, gainFactorB);
  const commonTrimDb =
    peak > PREPARATION_PEAK_CEILING
      ? 20 * Math.log10(peak / PREPARATION_PEAK_CEILING)
      : 0;
  if (!Number.isFinite(commonTrimDb) || commonTrimDb < 0) {
    fail("nonfinite-processing", "Common peak trim is not a finite nonnegative number");
  }
  const commonTrim = 10 ** (-commonTrimDb / 20);
  if (!Number.isFinite(commonTrim) || commonTrim <= 0) {
    fail("nonfinite-processing", "Common peak trim factor is not finite and positive");
  }
  // Serialize directly from cropped inputs with the same two-step arithmetic.
  // This avoids two full gained copies and two full trimmed copies, which would
  // otherwise dominate long-track memory, without changing a single byte.
  const encodedA = encodeGainedPcm16Wav(
    cropped.a,
    sampleRate,
    gainFactorA,
    commonTrim,
  );
  const encodedB = encodeGainedPcm16Wav(
    cropped.b,
    sampleRate,
    gainFactorB,
    commonTrim,
  );
  const layout = {
    sampleRate,
    channels,
    dataOffset: PCM16_WAV_HEADER_BYTES,
    dataSize: encodedA.dataSize,
  } as const;
  if (encodedB.dataSize !== encodedA.dataSize) {
    fail("nonfinite-processing", "Serialized sides unexpectedly differ in length");
  }
  const deliveredA = decodePcm16(encodedA.bytes, layout);
  const deliveredB = decodePcm16(encodedB.bytes, {
    ...layout,
    dataSize: encodedB.dataSize,
  });
  const measured = measurePair(deliveredA, deliveredB, { maxLagSamples, probeSamples });
  const delivered: DeliveredPairMeasurements = Object.freeze({
    ...measured,
    notes: DELIVERED_NOTES,
  });

  const appliedNote =
    lagSamples === 0
      ? "Applied alignment trimmed no leading samples from either side."
      : lagSamples > 0
        ? `Applied alignment trimmed ${String(lagSamples)} leading samples from B (B was delayed); A was not trimmed at the head.`
        : `Applied alignment trimmed ${String(-lagSamples)} leading samples from A (B was early); B was not trimmed at the head.`;
  const notes = [
    appliedNote,
    ...(alignment.status === "no-evidence"
      ? [
          "Alignment produced no lag evidence (silence/DC or a clipped correlation peak); " +
            "zero lag was applied without a confidence gate, because this slice adds none.",
        ]
      : []),
    `Independent constant gains of ${formatDb(gainADb)} dB (A) and ${formatDb(gainBDb)} dB (B) ` +
      `targeted ${String(PREPARATION_TARGET_LUFS)} LUFS; one common peak trim of ` +
      `${formatDb(commonTrimDb)} dB was then applied to both sides. No limiter, amplitude gate, ` +
      "gain clamp, resampling or channel downmix ran.",
    "Serialization is canonical little-endian PCM16 with floor quantization, a 2^-17 " +
      "integer-code-step pre-floor bias matching the reference writer, and no dither. " +
      "Delivered levels, peaks, residual lag and null depth were independently remeasured " +
      "from the final serialized bytes, not reused from pre-serialization floats.",
    "Sample peaks are sample peaks, not oversampled true peaks. This diagnostic preparation " +
      "does not establish a valid ABX run.",
  ];

  const report: PairPreparationReport = {
    policy: PREPARATION_POLICY_ID,
    targetLufs: PREPARATION_TARGET_LUFS,
    minimumDurationSeconds: PREPARATION_MIN_SECONDS,
    maxLagSeconds: PREPARATION_LAG_SECONDS,
    peakCeiling: PREPARATION_PEAK_CEILING,
    alignment: {
      lagSamples,
      confidence: alignment.confidence,
      status: alignment.status,
      maxLagSamples,
      probeSamples,
      inputFramesA: framesA,
      inputFramesB: framesB,
      startFrameA,
      startFrameB,
      outputFrames,
    },
    loudness: {
      preA,
      preB,
      gainADb,
      gainBDb,
      commonTrimDb,
    },
    serialization: {
      format: "pcm16-le",
      rounding: "floor",
      floorBiasCodeSteps: PCM16_FLOOR_BIAS,
      dither: false,
    },
    notes,
  };

  return {
    aWav: encodedA.bytes,
    bWav: encodedB.bytes,
    report,
    delivered,
  };
}
