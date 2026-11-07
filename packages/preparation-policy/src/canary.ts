import { AUDIO_CANARY_EXCERPT_SECONDS, type CanaryMaterialReport } from "@codec-abx/contracts";
import {
  SUPPORTED_SAMPLE_RATES,
  decodePcm16,
  measureNullDepth,
  type PcmAudio,
} from "@codec-abx/measurements";
import { createFftPlan } from "@codec-abx/measurements/fft";

import { PreparationPolicyError } from "./errors.js";
import { PCM16_WAV_HEADER_BYTES, encodePcm16Wav } from "./pcm16.js";
import { evaluateCanaryDepth } from "./validity.js";

/** Frozen core.canary constants. */
export const CANARY_CUTOFF_HZ = 3000 as const;
export const CANARY_DRIVE = 10 as const;
export const CANARY_CLIP_LEVEL = 0.45 as const;
const CANARY_MAX_SECONDS = 10 as const;

/** Caller-owned material plus the check measured on the served bytes. */
export interface CanaryPairResult {
  readonly pristineWav: Uint8Array;
  readonly degradedWav: Uint8Array;
  readonly report: CanaryMaterialReport;
}

const CANARY_NOTES = [
  "Degradation band-limits every channel with a full-length Float64 FFT " +
    "(actual frame count, including odd lengths), zeroes bins strictly above " +
    "3000 Hz on the reference NumPy rfftfreq grid, multiplies by 10 and " +
    "hard-clips to [-0.45, +0.45]. A nominal cutoff bin can round above 3000 Hz " +
    "on this grid and is then removed, matching the reference.",
  "The pristine payload is serialized with the package's existing biased-floor " +
    "PCM16 writer without resampling, gain matching, downmix, dither or a second " +
    "normalization. It preserves an input already on the PCM16 grid.",
  "The residual and usability decision were measured from both final WAV byte " +
    "buffers decoded independently, not from float intermediates.",
  "Usable means a measured material difference; it is not proof of human " +
    "audibility, a passed calibration trial or an experiment-validity result.",
] as const;

/** Frozen calibration ceiling. Producers pass a prefix; the DSP is unchanged. */
export const CANARY_EXCERPT_SECONDS = AUDIO_CANARY_EXCERPT_SECONDS;

/**
 * Number of leading frames a producer may calibrate on. Short material keeps
 * its exact previous extent; long material uses the FIRST ten seconds.
 */
export function canaryExcerptFrames(sampleRate: number, frames: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    fail(`Canary sample rate ${String(sampleRate)} is not positive`);
  }
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    fail(`Canary frame count ${String(frames)} is not a positive safe integer`);
  }
  return Math.min(frames, CANARY_EXCERPT_SECONDS * sampleRate);
}

/**
 * Select the leading canary calibration prefix. When the material already fits
 * the frozen ceiling the original object is returned unchanged.
 */
export function canaryExcerptPcm(pristine: PcmAudio): PcmAudio {
  const total = pristine.channels[0]?.length ?? 0;
  const frames = canaryExcerptFrames(pristine.sampleRate, total);
  if (frames === total) return pristine;
  return {
    sampleRate: pristine.sampleRate,
    channels: pristine.channels.map((channel) => channel.subarray(0, frames)),
  };
}

function fail(message: string): never {
  throw new PreparationPolicyError("invalid-pcm", message);
}

interface ValidatedCanaryInput {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
}

/**
 * Validate decoded FINAL delivered PCM. Only exact signed PCM16 grid values in
 * the supported browser envelope are accepted; a malformed float source cannot
 * silently clip or alter the pristine reference.
 */
function validateCanaryInput(pristine: PcmAudio): ValidatedCanaryInput {
  if (!pristine || typeof pristine !== "object") fail("Canary PCM is not an object");
  if (!SUPPORTED_SAMPLE_RATES.some((rate) => rate === pristine.sampleRate)) {
    fail(
      `Canary sample rate ${String(pristine.sampleRate)} is unsupported; ` +
        `expected one of ${SUPPORTED_SAMPLE_RATES.join(", ")} Hz`,
    );
  }
  if (
    !Array.isArray(pristine.channels) ||
    (pristine.channels.length !== 1 && pristine.channels.length !== 2)
  ) {
    fail("Canary PCM must have one or two channels");
  }
  const frames = pristine.channels[0]?.length ?? 0;
  if (frames <= 0) fail("Canary PCM contains no frames");
  if (frames > CANARY_MAX_SECONDS * pristine.sampleRate) {
    fail(
      `Canary PCM is ${frames} frames, longer than the ${CANARY_MAX_SECONDS} s ` +
        `(${String(CANARY_MAX_SECONDS * pristine.sampleRate)} frame) ceiling`,
    );
  }
  for (let channel = 0; channel < pristine.channels.length; channel += 1) {
    const samples = pristine.channels[channel];
    if (!(samples instanceof Float64Array)) {
      fail(`Canary channel ${channel} must be a Float64Array`);
    }
    if (samples.length !== frames) fail("Canary channels must have equal lengths");
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = samples[frame] ?? Number.NaN;
      if (!Number.isFinite(sample)) {
        fail(`Canary PCM contains a non-finite sample at channel ${channel}, frame ${frame}`);
      }
      const integer = sample * 32768;
      if (!Number.isInteger(integer) || integer < -32768 || integer > 32767) {
        fail(
          `Canary PCM sample at channel ${channel}, frame ${frame} is not on the ` +
            `signed PCM16 grid (${String(sample)})`,
        );
      }
    }
  }
  return {
    sampleRate: pristine.sampleRate,
    channels: pristine.channels.length === 1 ? 1 : 2,
    frames,
  };
}

/**
 * Match core.canary.degrade_for_canary in Float64: full-length per-channel real
 * DFT, zero strictly-above-cutoff bins, inverse at the original N, then 10x
 * drive and hard clipping. Inputs are never modified.
 */
function degradeChannels(
  channels: readonly Float64Array[],
  sampleRate: number,
  frames: number,
): Float64Array[] {
  const plan = createFftPlan(frames);
  // Preserve NumPy's arithmetic order. (bin * rate) / N can keep a cutoff
  // bin that NumPy computes as 3000.0000000000005 Hz and removes.
  const frequencyStep = 1 / (frames * (1 / sampleRate));
  return channels.map((source, channel) => {
    const re = new Float64Array(source);
    const im = new Float64Array(frames);
    plan.transform(re, im, false);
    for (let bin = 0; bin < frames; bin += 1) {
      const folded = Math.min(bin, frames - bin);
      const frequency = folded * frequencyStep;
      if (frequency > CANARY_CUTOFF_HZ) {
        re[bin] = 0;
        im[bin] = 0;
      }
    }
    plan.transform(re, im, true);
    const output = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const value = (re[frame] ?? 0) * CANARY_DRIVE;
      if (!Number.isFinite(value)) {
        fail(`Canary degradation produced a non-finite sample at channel ${channel}, frame ${frame}`);
      }
      output[frame] = Math.max(-CANARY_CLIP_LEVEL, Math.min(CANARY_CLIP_LEVEL, value));
    }
    return output;
  });
}

function decodedLayout(
  encoded: ReturnType<typeof encodePcm16Wav>,
  sampleRate: number,
  channels: 1 | 2,
) {
  return {
    sampleRate,
    channels,
    dataOffset: PCM16_WAV_HEADER_BYTES,
    dataSize: encoded.dataSize,
  } as const;
}

/**
 * Build the deliberately-easy canary material from decoded FINAL delivered
 * Side A PCM. JSON-safe report, caller-owned WAV bytes, no source mutation.
 */
export function buildCanaryPair(pristine: PcmAudio): CanaryPairResult {
  const layout = validateCanaryInput(pristine);

  const degradedChannels = degradeChannels(
    pristine.channels,
    layout.sampleRate,
    layout.frames,
  );
  const encodedPristine = encodePcm16Wav(pristine.channels, layout.sampleRate);
  const encodedDegraded = encodePcm16Wav(degradedChannels, layout.sampleRate);

  const deliveredPristine = decodePcm16(
    encodedPristine.bytes,
    decodedLayout(encodedPristine, layout.sampleRate, layout.channels),
  );
  const deliveredDegraded = decodePcm16(
    encodedDegraded.bytes,
    decodedLayout(encodedDegraded, layout.sampleRate, layout.channels),
  );
  const measured = measureNullDepth(deliveredPristine, deliveredDegraded);
  const decision = evaluateCanaryDepth(measured.depthDb);

  const report: CanaryMaterialReport = {
    ...decision,
    policy: "delivered-canary-v1",
    cutoffHz: CANARY_CUTOFF_HZ,
    frequencyGrid: "numpy-rfftfreq-v1",
    drive: CANARY_DRIVE,
    clipLevel: CANARY_CLIP_LEVEL,
    sampleRate: layout.sampleRate,
    channels: layout.channels,
    frames: layout.frames,
    notes: CANARY_NOTES,
  };

  return {
    pristineWav: encodedPristine.bytes,
    degradedWav: encodedDegraded.bytes,
    report,
  };
}

/**
 * Build calibration material from the FIRST min(10 s, delivered Side A) prefix.
 *
 * `buildCanaryPair` itself stays frozen: this wrapper only selects the prefix
 * and appends the disclosure when long material was shortened. Short material
 * is byte-for-byte the previous behaviour, including the report notes.
 */
export function buildCanaryExcerptPair(deliveredSideA: PcmAudio): CanaryPairResult {
  const totalFrames = deliveredSideA.channels[0]?.length ?? 0;
  const frames = canaryExcerptFrames(deliveredSideA.sampleRate, totalFrames);
  if (frames === totalFrames) return buildCanaryPair(deliveredSideA);

  const result = buildCanaryPair(canaryExcerptPcm(deliveredSideA));
  return {
    ...result,
    report: {
      ...result.report,
      notes: Object.freeze([
        ...result.report.notes,
        `Calibration excerpt: the FIRST ${String(frames)} frames ` +
          `(${(frames / deliveredSideA.sampleRate).toFixed(6)} s at ` +
          `${String(deliveredSideA.sampleRate)} Hz) of the ` +
          `${String(totalFrames)}-frame delivered Side A. The frozen full-length ` +
          "FFT canary algorithm is unchanged; no later material is substituted.",
      ]),
    },
  };
}
