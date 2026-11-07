// Frozen pre-streaming implementation, retained only as a test comparison.
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

/** scipy.signal.lfilter direct form II transposed, zero initial state. */
function applyFilter(filter: Biquad, input: Float64Array): Float64Array {
  const output = new Float64Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x = input[index] ?? 0;
    const y = filter.b0 * x + z1;
    z1 = filter.b1 * x - filter.a1 * y + z2;
    z2 = filter.b2 * x - filter.a2 * y;
    output[index] = y;
  }
  return output;
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
  const weighted: Float64Array[] = [];
  for (const channel of channels) {
    weighted.push(applyFilter(pass, applyFilter(shelf, channel)));
  }

  const duration = frames / sampleRate;
  const numBlocks = Math.trunc(
    roundHalfToEven((duration - blockSeconds) / (blockSeconds * step)) + 1,
  );
  const blockLoudness: number[] = [];
  const channelBlocks = weighted.map(() => new Float64Array(numBlocks));

  for (let block = 0; block < numBlocks; block += 1) {
    const lower = Math.trunc(blockSeconds * (block * step) * sampleRate);
    const upper = Math.trunc(blockSeconds * (block * step + 1) * sampleRate);
    const end = Math.min(upper, frames);
    let weightedSum = 0;
    for (let channel = 0; channel < weighted.length; channel += 1) {
      const samples = weighted[channel];
      const z = channelBlocks[channel];
      if (!samples || !z) throw new Error("Loudness channel disappeared");
      let sumSquares = 0;
      for (let index = lower; index < end; index += 1) {
        const value = samples[index] ?? 0;
        sumSquares += value * value;
      }
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

