import type { LevelMeasurement } from "@codec-abx/contracts";

import type { PcmAudio } from "./types.js";
import { assertPcmAudio } from "./validate.js";

/**
 * pyloudnorm 0.2.0 K-weighting filter constants for its default Meter rate.
 * The coefficient expressions follow pyloudnorm/iirfilter.py (MIT) so the
 * result tracks the repository reference, not a textbook approximation.
 */
interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

function highShelf(rate: number): Biquad {
  const gainDb = 4.0;
  const q = 1 / Math.sqrt(2);
  const fc = 1500.0;
  const a = 10 ** (gainDb / 40.0);
  const w0 = 2.0 * Math.PI * (fc / rate);
  const alpha = Math.sin(w0) / (2.0 * q);
  const cosW0 = Math.cos(w0);
  const sqrtA = Math.sqrt(a);
  const b0 = a * ((a + 1) + (a - 1) * cosW0 + 2 * sqrtA * alpha);
  const b1 = -2 * a * ((a - 1) + (a + 1) * cosW0);
  const b2 = a * ((a + 1) + (a - 1) * cosW0 - 2 * sqrtA * alpha);
  const a0 = (a + 1) - (a - 1) * cosW0 + 2 * sqrtA * alpha;
  const a1 = 2 * ((a - 1) - (a + 1) * cosW0);
  const a2 = (a + 1) - (a - 1) * cosW0 - 2 * sqrtA * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highPass(rate: number): Biquad {
  const q = 0.5;
  const fc = 38.0;
  const w0 = 2.0 * Math.PI * (fc / rate);
  const alpha = Math.sin(w0) / (2.0 * q);
  const cosW0 = Math.cos(w0);
  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Apply pyloudnorm's shelf-then-high-pass cascade in one streaming pass and
 * accumulate each overlapping 400 ms block's squared sum. The per-sample
 * arithmetic and per-block addition order are exactly those of materializing
 * the filtered arrays and summing each block in increasing sample order; only
 * the full-length filtered copies are omitted for long material.
 */
function accumulateWeightedBlockSums(
  shelf: Biquad,
  pass: Biquad,
  input: Float64Array,
  lower: Float64Array,
  end: Float64Array,
  sums: Float64Array,
): void {
  let shelfZ1 = 0;
  let shelfZ2 = 0;
  let passZ1 = 0;
  let passZ2 = 0;
  const blocks = sums.length;
  let next = 0;
  let first = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x = input[index] ?? 0;
    const shelfValue = shelf.b0 * x + shelfZ1;
    shelfZ1 = shelf.b1 * x - shelf.a1 * shelfValue + shelfZ2;
    shelfZ2 = shelf.b2 * x - shelf.a2 * shelfValue;
    const weighted = pass.b0 * shelfValue + passZ1;
    passZ1 = pass.b1 * shelfValue - pass.a1 * weighted + passZ2;
    passZ2 = pass.b2 * shelfValue - pass.a2 * weighted;

    while (next < blocks && (lower[next] ?? 0) <= index) next += 1;
    while (first < next && (end[first] ?? 0) <= index) first += 1;
    const squared = weighted * weighted;
    for (let block = first; block < next; block += 1) {
      sums[block] = (sums[block] ?? 0) + squared;
    }
  }
}

/** numpy.round semantics: ties to even, not Math.round's ties to +infinity. */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function meanValues(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Return the raw pyloudnorm integrated loudness for validated planar PCM. */
export function integratedLoudnessValue(
  channels: readonly Float64Array[],
  sampleRate: number,
  frames: number,
): number {
  const blockSeconds = 0.4;
  const overlap = 0.75;
  const step = 1.0 - overlap;
  if (frames < blockSeconds * sampleRate) return Number.NaN;

  const shelf = highShelf(sampleRate);
  const pass = highPass(sampleRate);

  const duration = frames / sampleRate;
  const numBlocks = Math.trunc(
    roundHalfToEven((duration - blockSeconds) / (blockSeconds * step)) + 1,
  );
  const blockLoudness: number[] = [];
  const channelBlocks = channels.map(() => new Float64Array(numBlocks));

  // Precompute the exact frozen block boundaries once. For long tracks the
  // filtered channel is never materialized: squared sums accumulate block by
  // block in the same increasing-sample order as the reference loops.
  const lower = new Float64Array(numBlocks);
  const end = new Float64Array(numBlocks);
  for (let block = 0; block < numBlocks; block += 1) {
    lower[block] = Math.trunc(blockSeconds * (block * step) * sampleRate);
    const upper = Math.trunc(blockSeconds * (block * step + 1) * sampleRate);
    end[block] = Math.min(upper, frames);
  }
  const channelSums = channels.map((channel) => {
    if (!(channel instanceof Float64Array)) {
      throw new Error("Loudness channel is not Float64Array");
    }
    const sums = new Float64Array(numBlocks);
    accumulateWeightedBlockSums(shelf, pass, channel, lower, end, sums);
    return sums;
  });

  for (let block = 0; block < numBlocks; block += 1) {
    let weightedSum = 0;
    for (let channel = 0; channel < channelSums.length; channel += 1) {
      const sums = channelSums[channel];
      const z = channelBlocks[channel];
      if (!sums || !z) throw new Error("Loudness channel disappeared");
      const sumSquares = sums[block] ?? 0;
      const meanSquare = (1.0 / (blockSeconds * sampleRate)) * sumSquares;
      z[block] = meanSquare;
      weightedSum += meanSquare;
    }
    blockLoudness.push(-0.691 + 10.0 * Math.log10(weightedSum));
  }

  const absoluteGated: number[] = [];
  for (let block = 0; block < numBlocks; block += 1) {
    const loudness = blockLoudness[block] ?? Number.NaN;
    if (loudness >= -70.0) absoluteGated.push(block);
  }
  const absoluteMeans = channelBlocks.map((z) =>
    meanValues(absoluteGated.map((block) => z[block] ?? 0)),
  );
  let sumMeans = 0;
  for (const value of absoluteMeans) sumMeans += value;
  const relativeThreshold = -0.691 + 10.0 * Math.log10(sumMeans) - 10.0;

  const relativeGated: number[] = [];
  for (let block = 0; block < numBlocks; block += 1) {
    const loudness = blockLoudness[block] ?? Number.NaN;
    if (loudness > relativeThreshold && loudness > -70.0) relativeGated.push(block);
  }
  let finalSum = 0;
  for (const z of channelBlocks) {
    let value = 0;
    if (relativeGated.length > 0) {
      let sum = 0;
      for (const block of relativeGated) sum += z[block] ?? 0;
      value = sum / relativeGated.length;
    }
    // np.nan_to_num turns the empty-gate NaN into 0 before the final log.
    finalSum += value;
  }
  return -0.691 + 10.0 * Math.log10(finalSum);
}

export function integratedLoudness(audio: PcmAudio): LevelMeasurement {
  const frames = assertPcmAudio(audio, "PCM");
  if (frames < 0.4 * audio.sampleRate) {
    return {
      status: "unavailable",
      value: null,
      reason: "audio is shorter than the 400 ms integrated-loudness block",
    };
  }
  const value = integratedLoudnessValue(audio.channels, audio.sampleRate, frames);
  if (Number.isFinite(value)) return { status: "finite", value, reason: null };
  if (value === Number.NEGATIVE_INFINITY) {
    return {
      status: "negative-infinity",
      value: null,
      reason:
        "no 400 ms block passed the absolute and relative gates " +
        "(silence or below-gate material)",
    };
  }
  return {
    status: "undefined",
    value: null,
    reason: "integrated loudness is not a finite number for this input",
  };
}
