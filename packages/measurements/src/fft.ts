/**
 * Shared numerical radix-2 complex FFT (Cooley-Tukey, decimation in time).
 *
 * The numerical package deliberately has no runtime dependencies: this is
 * enough for the bounded cross-correlation and stays usable in a worker.
 * `inverse` divides by N. Callers guarantee a power-of-two length >= 1.
 */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n !== im.length) throw new Error("FFT arrays must have equal lengths");
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error("FFT length must be a power of two");

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k += 1) {
        // Recompute the twiddle periodically so accumulated recurrence error
        // cannot grow with the block length.
        if (k > 0 && (k & 1023) === 0) {
          const a = angle * k;
          curRe = Math.cos(a);
          curIm = Math.sin(a);
        }
        const evenIndex = start + k;
        const oddIndex = evenIndex + half;
        const evenRe = re[evenIndex] ?? 0;
        const evenIm = im[evenIndex] ?? 0;
        const oddRe0 = re[oddIndex] ?? 0;
        const oddIm0 = im[oddIndex] ?? 0;
        const oddRe = oddRe0 * curRe - oddIm0 * curIm;
        const oddIm = oddRe0 * curIm + oddIm0 * curRe;
        re[evenIndex] = evenRe + oddRe;
        im[evenIndex] = evenIm + oddIm;
        re[oddIndex] = evenRe - oddRe;
        im[oddIndex] = evenIm - oddIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] = (re[i] ?? 0) / n;
      im[i] = (im[i] ?? 0) / n;
    }
  }
}

/** Bounded plan size covers the maximum 10-second 96 kHz browser input. */
export const MAX_FFT_PLAN_LENGTH = 1_048_576;

/** A reusable arbitrary-length complex FFT plan. Buffers belong to the caller. */
export interface FftPlan {
  readonly length: number;
  /**
   * In-place complex transform. Forward uses the e^{-2*pi*i*k*n/N} convention;
   * `inverse` divides by N. Integer lengths 1..MAX_FFT_PLAN_LENGTH are supported.
   */
  transform(re: Float64Array, im: Float64Array, inverse?: boolean): void;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/**
 * Arbitrary-length FFT.
 *
 * Power-of-two lengths use the existing radix-2 kernel unchanged. Other
 * lengths use Bluestein's chirp-z algorithm: one radix-2 convolution of length
 * nextPowerOfTwo(2N-1), which is O(N log N). The real signal is never padded
 * to a different analysis length, so calling this on the actual frame count
 * preserves core.canary's filter exactly (odd lengths included).
 *
 * The chirp and its spectrum are built once per plan. No process-global cache
 * exists; a caller keeps one plan per job and lets it become garbage.
 */
export function createFftPlan(n: number): FftPlan {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_FFT_PLAN_LENGTH) {
    throw new Error(`FFT length must be an integer from 1 to ${MAX_FFT_PLAN_LENGTH}`);
  }

  if ((n & (n - 1)) === 0) {
    return {
      length: n,
      transform(re: Float64Array, im: Float64Array, inverse = false): void {
        if (re.length !== n || im.length !== n) {
          throw new Error("FFT arrays must match the plan length");
        }
        fftInPlace(re, im, inverse);
      },
    };
  }

  const m = nextPowerOfTwo(2 * n - 1);
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  for (let index = 0; index < n; index += 1) {
    // e^{-i*pi*index^2/n}; reducing index^2 modulo 2n keeps the angle small.
    const reduced = (index * index) % (2 * n);
    const angle = (Math.PI * reduced) / n;
    chirpRe[index] = Math.cos(angle);
    chirpIm[index] = -Math.sin(angle);
  }

  const kernelRe = new Float64Array(m);
  const kernelIm = new Float64Array(m);
  kernelRe[0] = 1;
  for (let index = 1; index < n; index += 1) {
    const reduced = (index * index) % (2 * n);
    const angle = (Math.PI * reduced) / n;
    const real = Math.cos(angle);
    const imaginary = Math.sin(angle);
    kernelRe[index] = real;
    kernelIm[index] = imaginary;
    kernelRe[m - index] = real;
    kernelIm[m - index] = imaginary;
  }
  fftInPlace(kernelRe, kernelIm, false);

  const forward = (re: Float64Array, im: Float64Array): void => {
    const aRe = new Float64Array(m);
    const aIm = new Float64Array(m);
    for (let index = 0; index < n; index += 1) {
      const sourceRe = re[index] ?? 0;
      const sourceIm = im[index] ?? 0;
      const cRe = chirpRe[index] ?? 0;
      const cIm = chirpIm[index] ?? 0;
      aRe[index] = sourceRe * cRe - sourceIm * cIm;
      aIm[index] = sourceRe * cIm + sourceIm * cRe;
    }
    fftInPlace(aRe, aIm, false);
    for (let index = 0; index < m; index += 1) {
      const ar = aRe[index] ?? 0;
      const ai = aIm[index] ?? 0;
      const br = kernelRe[index] ?? 0;
      const bi = kernelIm[index] ?? 0;
      aRe[index] = ar * br - ai * bi;
      aIm[index] = ar * bi + ai * br;
    }
    fftInPlace(aRe, aIm, true);
    for (let index = 0; index < n; index += 1) {
      const cRe = aRe[index] ?? 0;
      const cIm = aIm[index] ?? 0;
      const wRe = chirpRe[index] ?? 0;
      const wIm = chirpIm[index] ?? 0;
      re[index] = wRe * cRe - wIm * cIm;
      im[index] = wRe * cIm + wIm * cRe;
    }
  };

  return {
    length: n,
    transform(re: Float64Array, im: Float64Array, inverse = false): void {
      if (re.length !== n || im.length !== n) {
        throw new Error("FFT arrays must match the plan length");
      }
      if (!inverse) {
        forward(re, im);
        return;
      }
      // IFFT(x) = conj(FFT(conj(x))) / N.
      for (let index = 0; index < n; index += 1) im[index] = -(im[index] ?? 0);
      forward(re, im);
      for (let index = 0; index < n; index += 1) {
        re[index] = (re[index] ?? 0) / n;
        im[index] = -(im[index] ?? 0) / n;
      }
    },
  };
}
