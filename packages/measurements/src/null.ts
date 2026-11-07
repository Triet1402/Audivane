import type { LevelMeasurement } from "@codec-abx/contracts";

import type { NullMeasurement, PcmAudio } from "./types.js";
import { assertPairCompatible, assertPcmAudio } from "./validate.js";

/** Raw residual depth from core.alignment.null_depth_db on the common prefix. */
export function nullDepthValue(a: PcmAudio, b: PcmAudio, comparedFrames: number): number {
  const channelCount = a.channels.length;
  let referenceEnergy = 0;
  let residualEnergy = 0;
  for (let channel = 0; channel < channelCount; channel += 1) {
    const aChannel = a.channels[channel];
    const bChannel = b.channels[channel];
    if (!aChannel || !bChannel) throw new Error("Null channels disappeared");
    for (let index = 0; index < comparedFrames; index += 1) {
      const reference = aChannel[index] ?? 0;
      const residual = reference - (bChannel[index] ?? 0);
      referenceEnergy += reference * reference;
      residualEnergy += residual * residual;
    }
  }
  const denominator = comparedFrames * channelCount;
  const rmsReference = Math.sqrt(referenceEnergy / denominator);
  const rmsResidual = Math.sqrt(residualEnergy / denominator);
  if (rmsReference <= 0) return Number.NaN;
  if (rmsResidual <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(rmsResidual / rmsReference);
}

function toLevel(value: number): LevelMeasurement {
  if (Number.isFinite(value)) return { status: "finite", value, reason: null };
  if (value === Number.NEGATIVE_INFINITY) {
    return {
      status: "negative-infinity",
      value: null,
      reason: "exact null: the unshifted common-prefix residual is zero",
    };
  }
  return {
    status: "undefined",
    value: null,
    reason: "silent reference: the unshifted common-prefix null depth is undefined",
  };
}

/**
 * Null depth on the unchanged common prefix. No implicit alignment, gain match
 * or channel downmix: every delivered channel is measured.
 */
export function measureNullDepth(a: PcmAudio, b: PcmAudio): NullMeasurement {
  const framesA = assertPcmAudio(a, "A");
  const framesB = assertPcmAudio(b, "B");
  assertPairCompatible(a, b);
  const comparedFrames = Math.min(framesA, framesB);
  return {
    basis: "unshifted-common-prefix",
    comparedFrames,
    depthDb: toLevel(nullDepthValue(a, b, comparedFrames)),
  };
}
