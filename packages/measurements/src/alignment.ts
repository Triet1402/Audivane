import { fftInPlace } from "./fft.js";
import {
  DEFAULT_MAX_LAG_SAMPLES,
  DEFAULT_PROBE_SAMPLES,
} from "./types.js";
import type {
  AlignmentMeasurement,
  PairMeasurementOptions,
  PcmAudio,
} from "./types.js";
import {
  assertLagOptions,
  assertPairCompatible,
  assertPcmAudio,
  frameCount,
} from "./validate.js";

/**
 * Match core.alignment.estimate_lag exactly:
 * - B delayed relative to A is a positive lag;
 * - independent per-channel mean removal;
 * - sum corresponding-channel FFT correlations, never a mono downmix;
 * - advance BOTH inputs together past a silent intro;
 * - normalize over the whole chosen probe and clip confidence to [0, 1];
 * - no evidence (silence/DC or a clipped-to-zero peak) is lag 0 confidence 0.
 */
export function estimateLag(
  a: PcmAudio,
  b: PcmAudio,
  options: PairMeasurementOptions = {},
): AlignmentMeasurement {
  const framesA = assertPcmAudio(a, "A");
  const framesB = assertPcmAudio(b, "B");
  assertPairCompatible(a, b);
  const maxLagSamples = options.maxLagSamples ?? DEFAULT_MAX_LAG_SAMPLES;
  const probeSamples = options.probeSamples ?? DEFAULT_PROBE_SAMPLES;
  assertLagOptions(maxLagSamples, probeSamples);
  return estimateLagChannels(
    a.channels,
    b.channels,
    Math.min(framesA, framesB),
    maxLagSamples,
    probeSamples,
  );
}

function noEvidence(maxLagSamples: number, probeSamples: number): AlignmentMeasurement {
  return {
    lagSamples: 0,
    confidence: 0,
    status: "no-evidence",
    maxLagSamples,
    probeSamples,
  };
}

function bitLength(value: number): number {
  let remaining = value;
  let length = 0;
  while (remaining > 0) {
    length += 1;
    remaining = Math.floor(remaining / 2);
  }
  return length;
}

/** Alignment on already-validated equal-layout channels. */
export function estimateLagChannels(
  aChannels: readonly Float64Array[],
  bChannels: readonly Float64Array[],
  length: number,
  maxLagSamples: number,
  probeSamples: number,
): AlignmentMeasurement {
  if (Math.min(length, probeSamples) < 2) {
    return noEvidence(maxLagSamples, probeSamples);
  }

  let start = 0;
  let segmentLength = 0;
  let hasEvidence = false;
  const channelCount = aChannels.length;

  // Shared probe advance past a silent intro. Both sides move together.
  while (start < length - 1) {
    const n = Math.min(length - start, probeSamples);
    const meansA = new Float64Array(channelCount);
    const meansB = new Float64Array(channelCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const a = aChannels[channel];
      const b = bChannels[channel];
      if (!a || !b) throw new Error("Alignment channels disappeared");
      let sumA = 0;
      let sumB = 0;
      for (let index = 0; index < n; index += 1) {
        sumA += a[start + index] ?? 0;
        sumB += b[start + index] ?? 0;
      }
      meansA[channel] = sumA / n;
      meansB[channel] = sumB / n;
    }

    let energyA = 0;
    let energyB = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const a = aChannels[channel];
      const b = bChannels[channel];
      if (!a || !b) throw new Error("Alignment channels disappeared");
      const meanA = meansA[channel] ?? 0;
      const meanB = meansB[channel] ?? 0;
      for (let index = 0; index < n; index += 1) {
        const da = (a[start + index] ?? 0) - meanA;
        const db = (b[start + index] ?? 0) - meanB;
        energyA += da * da;
        energyB += db * db;
      }
    }

    const norm = Math.sqrt(energyA * energyB);
    if (!Number.isFinite(norm)) return noEvidence(maxLagSamples, probeSamples);
    if (norm > 0) {
      segmentLength = n;
      hasEvidence = true;
      break;
    }
    start += n;
  }

  if (!hasEvidence || segmentLength < 2) return noEvidence(maxLagSamples, probeSamples);
  const n = segmentLength;

  // Recompute the segment (with independent means removed) and its norm for
  // the correlation denominator. This repeats the exact chosen segment.
  const fftSize = 2 ** bitLength(2 * n - 2);
  const aRe = new Float64Array(fftSize);
  const aIm = new Float64Array(fftSize);
  const bRe = new Float64Array(fftSize);
  const bIm = new Float64Array(fftSize);
  const sumRe = new Float64Array(fftSize);
  const sumIm = new Float64Array(fftSize);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const a = aChannels[channel];
    const b = bChannels[channel];
    if (!a || !b) throw new Error("Alignment channels disappeared");
    let sumA = 0;
    let sumB = 0;
    for (let index = 0; index < n; index += 1) {
      sumA += a[start + index] ?? 0;
      sumB += b[start + index] ?? 0;
    }
    const meanA = sumA / n;
    const meanB = sumB / n;
    aRe.fill(0);
    aIm.fill(0);
    bRe.fill(0);
    bIm.fill(0);
    for (let index = 0; index < n; index += 1) {
      aRe[index] = (a[start + index] ?? 0) - meanA;
      bRe[index] = (b[start + index] ?? 0) - meanB;
    }
    fftInPlace(aRe, aIm, false);
    fftInPlace(bRe, bIm, false);

    // spectrum = B * conj(A), summed over corresponding channels.
    for (let index = 0; index < fftSize; index += 1) {
      const ar = aRe[index] ?? 0;
      const ai = aIm[index] ?? 0;
      const br = bRe[index] ?? 0;
      const bi = bIm[index] ?? 0;
      sumRe[index] = (sumRe[index] ?? 0) + (br * ar + bi * ai);
      sumIm[index] = (sumIm[index] ?? 0) + (bi * ar - br * ai);
    }
  }

  fftInPlace(sumRe, sumIm, true);

  // Circular correlation layout: concat(circular[-(n-1):], circular[:n]);
  // lags = index-(n-1).
  let best = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  const tailStart = fftSize - (n - 1);
  for (let index = 0; index < 2 * n - 1; index += 1) {
    const lag = index - (n - 1);
    if (Math.abs(lag) > maxLagSamples) continue;
    const value = index < n - 1
      ? (sumRe[tailStart + index] ?? 0)
      : (sumRe[index - (n - 1)] ?? 0);
    // Strict comparison preserves numpy.argmax first-maximum ordering.
    if (value > best) {
      best = value;
      bestIndex = index;
    }
  }

  if (bestIndex < 0) return noEvidence(maxLagSamples, probeSamples);

  // norm was validated for this exact segment above; recompute the same value
  // with the same mean-removed sum used by the reference.
  let energyA = 0;
  let energyB = 0;
  for (let channel = 0; channel < channelCount; channel += 1) {
    const a = aChannels[channel];
    const b = bChannels[channel];
    if (!a || !b) throw new Error("Alignment channels disappeared");
    const meanA = meansFor(a, start, n);
    const meanB = meansFor(b, start, n);
    for (let index = 0; index < n; index += 1) {
      const da = (a[start + index] ?? 0) - meanA;
      const db = (b[start + index] ?? 0) - meanB;
      energyA += da * da;
      energyB += db * db;
    }
  }
  const norm = Math.sqrt(energyA * energyB);
  const confidence = Math.min(1, Math.max(0, best / norm));
  if (confidence === 0 || !Number.isFinite(confidence)) {
    return noEvidence(maxLagSamples, probeSamples);
  }
  return {
    lagSamples: bestIndex - (n - 1),
    confidence,
    status: "estimated",
    maxLagSamples,
    probeSamples,
  };
}

function meansFor(samples: Float64Array, start: number, length: number): number {
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += samples[start + index] ?? 0;
  return sum / length;
}
