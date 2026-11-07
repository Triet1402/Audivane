import { MAX_FFT_PLAN_LENGTH, fftInPlace } from "./fft.js";
import { DEFAULT_MAX_LAG_SAMPLES, DEFAULT_PROBE_SAMPLES } from "./types.js";
import type {
  PairMeasurementOptions,
  PairRelationReport,
  PcmAudio,
  RelationAcRms,
  RelationHypothesis,
  RelationPeak,
} from "./types.js";
import { assertLagOptions, assertPairCompatible, assertPcmAudio } from "./validate.js";

export const PAIR_RELATION_POLICY_ID = "pair-relation-v1" as const;
export const PAIR_RELATION_CENTERING = "first-sample-compensated-mean-v1" as const;
/** Reported top local peaks per polarity hypothesis. Gate ambiguity only needs
 * whether more than one peak is within its value tolerance. */
export const PAIR_RELATION_MAX_REPORTED_PEAKS = 8 as const;

const PCM16_FULL_SCALE = 32768 as const;

const RELATION_NOTES = [
  "pair-relation-v1 measures normalized cross-correlation of unchanged AC-centred " +
    "PCM. Confidence is correlation in [0, 1], not probability.",
  "Centring subtracts each probe channel's first sample before a compensated mean, " +
    "so a constant offset contributes exactly zero AC energy. Corresponding channels " +
    "are summed independently; there is never a mono downmix.",
  "The correlation probe is the first common-prefix block, starting at frame 0 and " +
    "advancing both sides together, with AC energy on both sides. A positive lag " +
    "means B is delayed relative to A.",
  "No samples were shifted, trimmed, gain-matched, polarity-flipped or corrected. " +
    "The report retains the probe bounds, energies and normalization for exact " +
    "re-evaluation without hidden state.",
  "Frozen product policy; thresholds and classifications are not scientific or " +
    "perceptual certification, and a passed relation is not a valid ABX result.",
] as const;

function bitLength(value: number): number {
  let remaining = value;
  let length = 0;
  while (remaining > 0) {
    length += 1;
    remaining = Math.floor(remaining / 2);
  }
  return length;
}

interface Centering {
  readonly offset: number;
  readonly meanShift: number;
}

/** Stable centre estimate: subtract the first value, then a compensated mean. */
function centerOf(channel: Float64Array, start: number, length: number): Centering {
  const offset = channel[start] ?? 0;
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < length; index += 1) {
    const shifted = (channel[start + index] ?? 0) - offset;
    const next = sum + shifted;
    compensation +=
      Math.abs(sum) >= Math.abs(shifted)
        ? (sum - next) + shifted
        : (shifted - next) + sum;
    sum = next;
  }
  return { offset, meanShift: (sum + compensation) / length };
}

function centeredEnergy(channel: Float64Array, start: number, length: number): number {
  const { offset, meanShift } = centerOf(channel, start, length);
  let energy = 0;
  for (let index = 0; index < length; index += 1) {
    const value = (channel[start + index] ?? 0) - offset - meanShift;
    energy += value * value;
  }
  return energy;
}

function fillCentered(
  target: Float64Array,
  channel: Float64Array,
  start: number,
  length: number,
): number {
  const { offset, meanShift } = centerOf(channel, start, length);
  let energy = 0;
  for (let index = 0; index < length; index += 1) {
    const value = (channel[start + index] ?? 0) - offset - meanShift;
    target[index] = value;
    energy += value * value;
  }
  return energy;
}

function acRms(channels: readonly Float64Array[], frames: number): RelationAcRms {
  const channelCount = channels.length;
  let energy = 0;
  for (const channel of channels) energy += centeredEnergy(channel, 0, frames);
  const fullScale = Math.sqrt(energy / (frames * channelCount));
  return Object.freeze({ fullScale, codeSteps: fullScale * PCM16_FULL_SCALE });
}

function noEvidenceHypothesis(polarity: "same" | "inverted"): RelationHypothesis {
  return Object.freeze({
    polarity,
    lagSamples: 0,
    confidence: 0,
    status: "no-evidence" as const,
    rawCorrelationSum: 0,
    atSearchBoundary: false,
    peaks: Object.freeze([] as RelationPeak[]),
  });
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

interface SearchSamples {
  /** Sign-adjusted local-maximum candidates in [0, 1]. */
  readonly peaks: readonly RelationPeak[];
  readonly bestIndex: number;
  readonly bestValue: number;
}

function collectPeaks(
  valueAt: (lag: number) => number,
  minLag: number,
  maxLag: number,
  normalization: number,
): SearchSamples {
  let bestValue = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = valueAt(lag);
    if (!Number.isFinite(value)) continue;
    // Strict comparison preserves first-maximum ordering for ties.
    if (value > bestValue) {
      bestValue = value;
      bestIndex = lag;
    }
  }

  const peaks: RelationPeak[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = valueAt(lag);
    if (!(value > 0) || !Number.isFinite(value)) continue;
    if (lag > minLag && !(value > valueAt(lag - 1))) continue;
    if (lag < maxLag && !(value >= valueAt(lag + 1))) continue;
    peaks.push({
      lagSamples: lag,
      confidence: clampConfidence(value / normalization),
    });
  }

  peaks.sort((left, right) =>
    right.confidence - left.confidence || left.lagSamples - right.lagSamples,
  );
  return {
    peaks: Object.freeze(peaks.slice(0, PAIR_RELATION_MAX_REPORTED_PEAKS)),
    bestIndex,
    bestValue,
  };
}

function hypothesis(
  polarity: "same" | "inverted",
  valueAt: (lag: number) => number,
  minLag: number,
  maxLag: number,
  normalization: number,
): RelationHypothesis {
  const search = collectPeaks(valueAt, minLag, maxLag, normalization);
  const confidence = clampConfidence(search.bestValue / normalization);
  if (!Number.isFinite(search.bestValue) || confidence <= 0) {
    return noEvidenceHypothesis(polarity);
  }
  return Object.freeze({
    polarity,
    lagSamples: search.bestIndex,
    confidence,
    status: "estimated" as const,
    rawCorrelationSum: search.bestValue,
    atSearchBoundary:
      maxLag > 0 && Math.abs(search.bestIndex) === maxLag,
    peaks: search.peaks,
  });
}

/**
 * Assess how two unchanged PCM sides relate: same/inverted best-correlation
 * hypotheses, whole-common-prefix AC RMS, probe bounds and local positive
 * peaks. Pure, synchronous and non-mutating. No downmix, shift, gain match or
 * polarity correction occurs here.
 */
export function assessPairRelation(
  a: PcmAudio,
  b: PcmAudio,
  options: PairMeasurementOptions = {},
): PairRelationReport {
  const framesA = assertPcmAudio(a, "A");
  const framesB = assertPcmAudio(b, "B");
  assertPairCompatible(a, b);
  const maxLagSamples = options.maxLagSamples ?? DEFAULT_MAX_LAG_SAMPLES;
  const probeSamples = options.probeSamples ?? DEFAULT_PROBE_SAMPLES;
  assertLagOptions(maxLagSamples, probeSamples);

  const length = Math.min(framesA, framesB);
  const channelCount = a.channels.length;
  const acRmsA = acRms(a.channels, length);
  const acRmsB = acRms(b.channels, length);

  let start = 0;
  let segmentLength = 0;
  let energyA = 0;
  let energyB = 0;
  while (start < length - 1) {
    const candidate = Math.min(length - start, probeSamples);
    let candidateA = 0;
    let candidateB = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const aChannel = a.channels[channel];
      const bChannel = b.channels[channel];
      if (!aChannel || !bChannel) throw new Error("Relation channels disappeared");
      candidateA += centeredEnergy(aChannel, start, candidate);
      candidateB += centeredEnergy(bChannel, start, candidate);
    }
    if (candidateA > 0 && candidateB > 0 && Number.isFinite(candidateA * candidateB)) {
      segmentLength = candidate;
      energyA = candidateA;
      energyB = candidateB;
      break;
    }
    start += candidate;
  }

  if (segmentLength < 2) {
    const searchMaxLag = Math.min(maxLagSamples, Math.max(0, length - 1));
    const same = noEvidenceHypothesis("same");
    return Object.freeze({
      policy: PAIR_RELATION_POLICY_ID,
      sampleRate: a.sampleRate,
      channels: channelCount === 1 ? 1 : 2,
      comparedFrames: length,
      maxLagSamples,
      probeSamples,
      searchRange: Object.freeze({
        minLagSamples: -searchMaxLag,
        maxLagSamples: searchMaxLag,
      }),
      probe: Object.freeze({
        startFrame: start,
        frames: 0,
        fftSize: 0,
        energyA: 0,
        energyB: 0,
        normalization: 0,
        centering: PAIR_RELATION_CENTERING,
      }),
      acRms: Object.freeze({ a: acRmsA, b: acRmsB }),
      same,
      inverted: noEvidenceHypothesis("inverted"),
      chosen: Object.freeze({
        polarity: same.polarity,
        lagSamples: same.lagSamples,
        confidence: same.confidence,
        status: same.status,
        atSearchBoundary: same.atSearchBoundary,
      }),
      notes: RELATION_NOTES,
    });
  }

  const n = segmentLength;
  const fftSize = 2 ** bitLength(2 * n - 2);
  if (fftSize > MAX_FFT_PLAN_LENGTH) {
    throw new Error(
      `Relation probe requires FFT length ${fftSize}, above the supported ` +
        `maximum ${MAX_FFT_PLAN_LENGTH}`,
    );
  }

  const aRe = new Float64Array(fftSize);
  const aIm = new Float64Array(fftSize);
  const bRe = new Float64Array(fftSize);
  const bIm = new Float64Array(fftSize);
  const sumRe = new Float64Array(fftSize);
  const sumIm = new Float64Array(fftSize);

  let probeEnergyA = 0;
  let probeEnergyB = 0;
  for (let channel = 0; channel < channelCount; channel += 1) {
    const aChannel = a.channels[channel];
    const bChannel = b.channels[channel];
    if (!aChannel || !bChannel) throw new Error("Relation channels disappeared");
    aRe.fill(0);
    aIm.fill(0);
    bRe.fill(0);
    bIm.fill(0);
    probeEnergyA += fillCentered(aRe, aChannel, start, n);
    probeEnergyB += fillCentered(bRe, bChannel, start, n);
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

  const normalization = Math.sqrt(probeEnergyA * probeEnergyB);
  if (!(normalization > 0) || !Number.isFinite(normalization)) {
    // The probe search already established energy on both sides; treat any
    // numerical loss here as absent evidence rather than inventing a relation.
    const searchMaxLag = Math.min(maxLagSamples, Math.max(0, n - 1));
    const same = noEvidenceHypothesis("same");
    return Object.freeze({
      policy: PAIR_RELATION_POLICY_ID,
      sampleRate: a.sampleRate,
      channels: channelCount === 1 ? 1 : 2,
      comparedFrames: length,
      maxLagSamples,
      probeSamples,
      searchRange: Object.freeze({
        minLagSamples: -searchMaxLag,
        maxLagSamples: searchMaxLag,
      }),
      probe: Object.freeze({
        startFrame: start,
        frames: n,
        fftSize,
        energyA: probeEnergyA,
        energyB: probeEnergyB,
        normalization: 0,
        centering: PAIR_RELATION_CENTERING,
      }),
      acRms: Object.freeze({ a: acRmsA, b: acRmsB }),
      same,
      inverted: noEvidenceHypothesis("inverted"),
      chosen: Object.freeze({
        polarity: same.polarity,
        lagSamples: same.lagSamples,
        confidence: same.confidence,
        status: same.status,
        atSearchBoundary: same.atSearchBoundary,
      }),
      notes: RELATION_NOTES,
    });
  }

  fftInPlace(sumRe, sumIm, true);

  const tailStart = fftSize - (n - 1);
  const rawAtLag = (lag: number): number => {
    const index = lag + (n - 1);
    if (index < 0 || index > 2 * n - 2) return Number.NaN;
    return index < n - 1
      ? (sumRe[tailStart + index] ?? 0)
      : (sumRe[index - (n - 1)] ?? 0);
  };

  const searchMaxLag = Math.min(maxLagSamples, n - 1);
  const same = hypothesis("same", rawAtLag, -searchMaxLag, searchMaxLag, normalization);
  const inverted = hypothesis(
    "inverted",
    (lag) => -rawAtLag(lag),
    -searchMaxLag,
    searchMaxLag,
    normalization,
  );
  const chosenSource =
    inverted.confidence > same.confidence ? inverted : same;
  return Object.freeze({
    policy: PAIR_RELATION_POLICY_ID,
    sampleRate: a.sampleRate,
    channels: channelCount === 1 ? 1 : 2,
    comparedFrames: length,
    maxLagSamples,
    probeSamples,
    searchRange: Object.freeze({
      minLagSamples: -searchMaxLag,
      maxLagSamples: searchMaxLag,
    }),
    probe: Object.freeze({
      startFrame: start,
      frames: n,
      fftSize,
      energyA: probeEnergyA,
      energyB: probeEnergyB,
      normalization,
      centering: PAIR_RELATION_CENTERING,
    }),
    acRms: Object.freeze({ a: acRmsA, b: acRmsB }),
    same,
    inverted,
    chosen: Object.freeze({
      polarity: chosenSource.polarity,
      lagSamples: chosenSource.lagSamples,
      confidence: chosenSource.confidence,
      status: chosenSource.status,
      atSearchBoundary: chosenSource.atSearchBoundary,
    }),
    notes: RELATION_NOTES,
  });
}
