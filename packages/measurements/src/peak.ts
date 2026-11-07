import type { LevelMeasurement } from "@codec-abx/contracts";

import type { PcmAudio } from "./types.js";
import { assertPcmAudio } from "./validate.js";

/** Raw sample peak in dBFS; core.preparation.sample_peak_dbfs uses -999 at zero. */
export function samplePeakDbfsValue(channels: readonly Float64Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const magnitude = Math.abs(channel[index] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
}

/**
 * Sample peak only, never an oversampled true peak. Silence in the reference
 * signal is reported as an explicit negative-infinity status rather than a
 * numeric sentinel.
 */
export function samplePeakDbfs(audio: PcmAudio): LevelMeasurement {
  assertPcmAudio(audio, "PCM");
  const value = samplePeakDbfsValue(audio.channels);
  if (Number.isFinite(value)) return { status: "finite", value, reason: null };
  return {
    status: "negative-infinity",
    value: null,
    reason:
      "silent input: sample peak is negative infinity",
  };
}
