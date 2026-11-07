import { SUPPORTED_SAMPLE_RATES } from "./types.js";
import type { PcmAudio, SupportedSampleRate } from "./types.js";

/** Number of frames in validated planar PCM. */
export function frameCount(audio: PcmAudio): number {
  return audio.channels[0]?.length ?? 0;
}

/** True for the three rates this slice supports. */
export function isSupportedSampleRate(rate: number): rate is SupportedSampleRate {
  return SUPPORTED_SAMPLE_RATES.some((supported) => supported === rate);
}

export function assertSupportedSampleRate(rate: number, what: string): void {
  if (!Number.isInteger(rate) || !isSupportedSampleRate(rate)) {
    throw new Error(
      `${what} sample rate ${String(rate)} is unsupported; ` +
        `expected one of ${SUPPORTED_SAMPLE_RATES.join(", ")} Hz`,
    );
  }
}

/**
 * Validate a planar PCM boundary value without copying or changing it.
 * Mono/stereo, equal non-zero channel lengths and finite samples only.
 */
export function assertPcmAudio(audio: PcmAudio, what: string): number {
  if (!audio || typeof audio !== "object") throw new Error(`${what} PCM is not an object`);
  assertSupportedSampleRate(audio.sampleRate, what);
  if (!Array.isArray(audio.channels) || (audio.channels.length !== 1 && audio.channels.length !== 2)) {
    throw new Error(`${what} PCM must have one or two channels`);
  }
  const first = audio.channels[0];
  if (!(first instanceof Float64Array)) {
    throw new Error(`${what} PCM channels must be Float64Array values`);
  }
  const frames = first.length;
  if (frames <= 0) throw new Error(`${what} PCM contains no frames`);
  for (let channel = 0; channel < audio.channels.length; channel += 1) {
    const samples = audio.channels[channel];
    if (!(samples instanceof Float64Array)) {
      throw new Error(`${what} PCM channel ${channel} must be Float64Array`);
    }
    if (samples.length !== frames) {
      throw new Error(`${what} PCM channels must have equal lengths`);
    }
    for (let frame = 0; frame < frames; frame += 1) {
      if (!Number.isFinite(samples[frame] ?? Number.NaN)) {
        throw new Error(`${what} PCM contains a non-finite sample at frame ${frame}`);
      }
    }
  }
  return frames;
}

/** Validate a pair boundary: equal rate and channel layout. */
export function assertPairCompatible(a: PcmAudio, b: PcmAudio): void {
  if (a.sampleRate !== b.sampleRate) {
    throw new Error(
      `Pair sample rates differ (${a.sampleRate} vs ${b.sampleRate}); resampling is not measurement`,
    );
  }
  if (a.channels.length !== b.channels.length) {
    throw new Error(
      `Pair channel layouts differ (${a.channels.length} vs ${b.channels.length}); ` +
        "downmixing is not measurement",
    );
  }
}

export function assertLagOptions(
  maxLagSamples: number,
  probeSamples: number,
): void {
  if (!Number.isSafeInteger(maxLagSamples) || maxLagSamples < 0) {
    throw new Error("maxLagSamples must be a non-negative integer");
  }
  if (!Number.isSafeInteger(probeSamples) || probeSamples < 2) {
    throw new Error("probeSamples must be an integer of at least 2");
  }
}
