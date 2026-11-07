import type {
  AudioMeasurementSummary,
  DeliveredPairMeasurements,
  LevelMeasurement,
} from "@codec-abx/contracts";

import { estimateLagChannels } from "./alignment.js";
import { integratedLoudness } from "./loudness.js";
import { measureNullDepth } from "./null.js";
import { samplePeakDbfs } from "./peak.js";
import {
  DEFAULT_MAX_LAG_SAMPLES,
  DEFAULT_PROBE_SAMPLES,
} from "./types.js";
import type { PairMeasurementOptions, PcmAudio } from "./types.js";
import { assertLagOptions, assertPairCompatible, assertPcmAudio } from "./validate.js";

const NOTES = [
  "Estimated lag is reported only; no samples were shifted.",
  "Measurements describe unchanged delivered PCM without normalization, " +
    "gain matching, amplitude gating or alignment.",
  "These measurements do not establish a valid ABX run or an audible difference.",
] as const;

function summary(audio: PcmAudio, frames: number): AudioMeasurementSummary {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.length === 1 ? 1 : 2,
    frames,
    integratedLufs: integratedLoudness(audio),
    samplePeakDbfs: samplePeakDbfs(audio),
  };
}

function loudnessDelta(a: LevelMeasurement, b: LevelMeasurement): LevelMeasurement {
  if (a.status === "finite" && b.status === "finite") {
    return { status: "finite", value: Math.abs(a.value - b.value), reason: null };
  }
  return {
    status: "unavailable",
    value: null,
    reason:
      "loudness delta unavailable: at least one side has no finite integrated loudness",
  };
}

/**
 * Measure an unchanged delivered A/B pair. No resampling, downmix, gain match,
 * alignment shift, trim or gate is applied. The pair must share a sample rate
 * and mono/stereo layout; unequal frame counts are allowed and the null uses
 * their common prefix. The caller's PCM arrays are never mutated.
 */
export function measurePair(
  a: PcmAudio,
  b: PcmAudio,
  options: PairMeasurementOptions = {},
): DeliveredPairMeasurements {
  const framesA = assertPcmAudio(a, "A");
  const framesB = assertPcmAudio(b, "B");
  assertPairCompatible(a, b);
  const maxLagSamples = options.maxLagSamples ?? DEFAULT_MAX_LAG_SAMPLES;
  const probeSamples = options.probeSamples ?? DEFAULT_PROBE_SAMPLES;
  assertLagOptions(maxLagSamples, probeSamples);

  // Reuse already validated boundaries for the FFT path.
  const alignment = estimateLagChannels(
    a.channels,
    b.channels,
    Math.min(framesA, framesB),
    maxLagSamples,
    probeSamples,
  );
  const aSummary = summary(a, framesA);
  const bSummary = summary(b, framesB);
  const nullMeasurement = measureNullDepth(a, b);

  return {
    policy: "delivered-pcm-measurements-v1",
    a: aSummary,
    b: bSummary,
    alignment,
    loudnessDeltaDb: loudnessDelta(aSummary.integratedLufs, bSummary.integratedLufs),
    nullDepth: nullMeasurement,
    notes: NOTES,
  };
}
