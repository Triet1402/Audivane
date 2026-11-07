/**
 * Exact forced-choice (ABX) statistics, independent of any runtime.
 *
 * This is an exact implementation, not an approximation: the one-tailed
 * p-value is the exact binomial tail against a 50% chance, the threshold uses
 * the strict `p < alpha` rule, the interval is Clopper-Pearson by a 200-step
 * bisection, and Holm decisions use the unrounded running maximum.
 *
 * Numerical notes
 * ---------------
 * * `n` is intentionally bounded to 0..1000. A direct factorial translation
 *   would overflow JavaScript numbers. The 50% tail therefore uses a BigInt
 *   numerator divided once by 2**n (a power of two, so the division is exact
 *   apart from the final IEEE-754 rounding). The general-p tail used by the CI
 *   uses a normalized log-term recurrence so no term is raised to a large
 *   power as a big integer.
 * * The CI bisection does at most 400 bounded passes over at most n+1 terms;
 *   no large integer power is formed.
 * * Accepted error budget (independently verified against exact binomial arithmetic):
 *   p-values <= 1e-12 absolute, rounded CI <= 1e-6, thresholds/Holm decisions
 *   exact.
 */
import type { DisplayAnswer } from "@codec-abx/contracts";

export const CHANCE = 0.5;
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_POWER = 0.8;
export const MAX_SUPPORTED_TRIALS = 1000;

/** Acceptance tolerances, published so tests and reports can cite them. */
export const P_VALUE_ABS_TOLERANCE = 1e-12;
export const CI_DECIMALS = 6;
export const CI_ABS_TOLERANCE = 1e-6;
export const HOLM_DECIMALS = 8;

export interface HolmResult {
  /** Index into the supplied family, not the sorted position. */
  readonly index: number;
  readonly adjustedP: number;
  readonly reject: boolean;
}

export class StatisticsInputError extends RangeError {
  readonly code = "invalid-statistics-input";

  constructor(message: string) {
    super(message);
    this.name = "StatisticsInputError";
  }
}

function requireInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new StatisticsInputError(`${name} must be a finite integer`);
  }
  if (value < minimum || value > maximum) {
    throw new StatisticsInputError(`${name} must be in [${minimum}, ${maximum}]`);
  }
  return value;
}

function requireUnitInterval(name: string, value: number, open: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StatisticsInputError(`${name} must be finite`);
  }
  const outside = open ? value <= 0 || value >= 1 : value < 0 || value > 1;
  if (outside) {
    const bounds = open ? "(0, 1)" : "[0, 1]";
    throw new StatisticsInputError(`${name} must be in ${bounds}`);
  }
  return value;
}

function requireTrials(n: number): number {
  return requireInteger("n", n, 0, MAX_SUPPORTED_TRIALS);
}

function requireCorrect(n: number, k: number): number {
  return requireInteger("k", k, 0, n);
}

function requireAlpha(alpha: number): number {
  return requireUnitInterval("alpha", alpha, true);
}

const logFactorials: number[] = [0];

function logFactorial(value: number): number {
  for (let i = logFactorials.length; i <= value; i += 1) {
    logFactorials.push((logFactorials[i - 1] as number) + Math.log(i));
  }
  return logFactorials[value] as number;
}

function logCombination(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Sum C(n, k..n), exactly, for the 50% case. */
function exactTailNumerator(n: number, k: number): bigint {
  if (k <= 0) {
    return 1n << BigInt(n);
  }
  let coefficient = 1n;
  for (let i = 0; i < k; i += 1) {
    coefficient = (coefficient * BigInt(n - i)) / BigInt(i + 1);
  }
  let total = coefficient;
  for (let i = k; i < n; i += 1) {
    coefficient = (coefficient * BigInt(n - i)) / BigInt(i + 1);
    total += coefficient;
  }
  return total;
}

function exactCdfNumerator(n: number, x: number): bigint {
  if (x < 0) {
    return 0n;
  }
  let coefficient = 1n;
  let total = 1n;
  for (let i = 0; i < x; i += 1) {
    coefficient = (coefficient * BigInt(n - i)) / BigInt(i + 1);
    total += coefficient;
  }
  return total;
}

function exactTail(n: number, k: number): number {
  if (n === 0 || k <= 0) {
    return 1;
  }
  if (k > n) {
    return 0;
  }
  return Number(exactTailNumerator(n, k)) / 2 ** n;
}

function exactCdf(n: number, x: number): number {
  if (x < 0) {
    return 0;
  }
  if (x >= n) {
    return 1;
  }
  return Number(exactCdfNumerator(n, x)) / 2 ** n;
}

/** P(X <= x) by a normalized recurrence; x is in [0, n-1]. */
function binomialCdf(n: number, x: number, p: number): number {
  if (x < 0) {
    return 0;
  }
  if (x >= n) {
    return 1;
  }
  if (p === 0) {
    return 1;
  }
  if (p === 1) {
    return 0;
  }
  if (p === CHANCE) {
    return exactCdf(n, x);
  }

  const q = 1 - p;
  if (x < n * p) {
    return sumDown(n, x, p, q);
  }
  return clampProbability(1 - sumUp(n, x + 1, p, q));
}

/** P(X >= k) by a normalized recurrence; 0 < p < 1 and 0 < k <= n. */
function generalTail(n: number, k: number, p: number): number {
  if (k <= 0) {
    return 1;
  }
  if (k > n) {
    return 0;
  }
  if (p === 0) {
    return 0;
  }
  if (p === 1) {
    return 1;
  }
  if (p === CHANCE) {
    return exactTail(n, k);
  }

  const q = 1 - p;
  if (k <= n * p) {
    return clampProbability(1 - binomialCdf(n, k - 1, p));
  }
  return sumUp(n, k, p, q);
}

function sumUp(n: number, k: number, p: number, q: number): number {
  const logTerm = logCombination(n, k) + k * Math.log(p) + (n - k) * Math.log(q);
  let term = Math.exp(logTerm);
  if (!Number.isFinite(term) || term === 0) {
    return term === 0 ? 0 : clampProbability(term);
  }
  let sum = 0;
  let compensation = 0;
  for (let i = k; i <= n; i += 1) {
    const corrected = term - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
    if (i < n) {
      term *= ((n - i) / (i + 1)) * (p / q);
    }
  }
  return clampProbability(sum);
}

function sumDown(n: number, x: number, p: number, q: number): number {
  const logTerm = logCombination(n, x) + x * Math.log(p) + (n - x) * Math.log(q);
  let term = Math.exp(logTerm);
  if (!Number.isFinite(term) || term === 0) {
    return term === 0 ? 0 : clampProbability(term);
  }
  let sum = 0;
  let compensation = 0;
  for (let i = x; i >= 0; i -= 1) {
    const corrected = term - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
    if (i > 0) {
      term *= (i / (n - i + 1)) * (q / p);
    }
  }
  return clampProbability(sum);
}

/**
 * Exact P(X >= k) for X ~ Binomial(n, p).
 *
 * `k` is required to be in [0, n]; out-of-range counts are rejected rather
 * than silently mapped to numeric sentinel values.
 */
export function binomTail(n: number, k: number, p: number = CHANCE): number {
  const trials = requireTrials(n);
  const correct = requireCorrect(trials, k);
  const probability = requireUnitInterval("p", p, false);
  return generalTail(trials, correct, probability);
}

/** Exact one-tailed p-value against 50% guessing. */
export function oneTailedPValue(n: number, k: number): number {
  const trials = requireTrials(n);
  const correct = requireCorrect(trials, k);
  return exactTail(trials, correct);
}

/**
 * Smallest correct count whose exact one-tailed p-value is strictly below
 * `alpha`, or null when `n` cannot reach it.
 */
export function minCorrectForSignificance(
  n: number,
  alpha: number = DEFAULT_ALPHA,
): number | null {
  const trials = requireTrials(n);
  const threshold = requireAlpha(alpha);
  if (trials === 0) {
    return null;
  }
  let low = 1;
  let high = trials;
  let answer: number | null = null;
  // The tail is non-increasing in k, so the first passing k is monotone.
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (exactTail(trials, middle) < threshold) {
      answer = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return answer;
}

/** Strict significance: exactly `p < alpha`, never `<=`. */
export function isSignificant(
  n: number,
  k: number,
  alpha: number = DEFAULT_ALPHA,
): boolean {
  const trials = requireTrials(n);
  const correct = requireCorrect(trials, k);
  const threshold = requireAlpha(alpha);
  return exactTail(trials, correct) < threshold;
}

/** Round half to even with the requested decimal places. */
export function roundTo(value: number, decimals: number): number {
  // Multiplication by 10**decimals can round a near tie INTO an exact tie.
  // Half-even rounding applies to the original IEEE-754 value: recover that
  // exact binary rational before decimal scaling and make the decision once.
  if (value === 0) return value;
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(value), false);
  const high = bits.getUint32(0, false);
  const low = bits.getUint32(4, false);
  const encodedExponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const significand = encodedExponent === 0 ? fraction : (1n << 52n) | fraction;
  const exponent = encodedExponent === 0 ? -1074 : encodedExponent - 1023 - 52;
  let numerator = significand * 10n ** BigInt(decimals);
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  let rounded = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (twiceRemainder > denominator ||
      (twiceRemainder === denominator && rounded % 2n !== 0n)) rounded += 1n;
  return Math.sign(value) * Number(rounded) / 10 ** decimals;
}

/** Half-even rounding of `min(upper, 1.0)` to six decimals for the reported interval. */
function roundCi(value: number): number {
  return roundTo(Math.min(value, 1), CI_DECIMALS);
}

/**
 * Exact Clopper-Pearson 95% interval for the discrimination probability,
 * rounded to six decimals exactly like `core.stats.binomial_ci`.
 */
export function binomialCi(
  n: number,
  k: number,
  confidence: number = 0.95,
): readonly [number, number] {
  const trials = requireTrials(n);
  const correct = requireCorrect(trials, k);
  const level = requireUnitInterval("confidence", confidence, true);
  if (trials === 0) {
    return [0, 1];
  }

  const tailTarget = (1 - level) / 2;

  let lower: number;
  if (correct === 0) {
    lower = 0;
  } else {
    let low = 0;
    let high = correct / trials;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const middle = (low + high) / 2;
      if (generalTail(trials, correct, middle) > tailTarget) {
        high = middle;
      } else {
        low = middle;
      }
    }
    lower = (low + high) / 2;
  }

  let upper: number;
  if (correct === trials) {
    upper = 1;
  } else {
    let low = correct / trials;
    let high = 1;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const middle = (low + high) / 2;
      if (binomialCdf(trials, correct, middle) > tailTarget) {
        low = middle;
      } else {
        high = middle;
      }
    }
    upper = (low + high) / 2;
  }

  return [roundCi(lower), roundCi(Math.min(upper, 1))];
}

/**
 * Holm-Bonferroni correction over a family of p-values.
 *
 * Returned entries are sorted by adjusted p (stable for ties), and carry the
 * original family index. The `reject` decision uses the unrounded running
 * maximum, so a published adjusted value of `alpha` still rejects nothing.
 */
export function holmBonferroni(
  pValues: readonly number[],
  alpha: number = DEFAULT_ALPHA,
): readonly HolmResult[] {
  if (!Array.isArray(pValues)) {
    throw new StatisticsInputError("pValues must be an array");
  }
  const threshold = requireAlpha(alpha);
  const values = Array.from(pValues, (value, index) =>
    requireUnitInterval(`pValues[${index}]`, value, false),
  );
  if (values.length === 0) {
    return [];
  }

  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);

  const familySize = values.length;
  const results: HolmResult[] = [];
  let runningMaximum = 0;
  order.forEach((entry, rank) => {
    const raw = (familySize - rank) * entry.value;
    runningMaximum = Math.max(runningMaximum, Math.min(1, raw));
    results.push({
      index: entry.index,
      adjustedP: roundTo(runningMaximum, HOLM_DECIMALS),
      reject: runningMaximum < threshold,
    });
  });

  return results.sort((left, right) => left.adjustedP - right.adjustedP);
}

const LOG_GAMMA_HALF = 0.5723649429247001; // ln(sqrt(pi))
const SQRT_TWO = Math.SQRT2;

/** Regularized lower incomplete gamma P(a, x) via its convergent series. */
function gammaPSeries(a: number, x: number): number {
  if (x === 0) {
    return 0;
  }
  const logPrefix = -x + a * Math.log(x) - LOG_GAMMA_HALF;
  let ap = a;
  let sum = 1 / a;
  let term = sum;
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16) {
      break;
    }
  }
  return sum * Math.exp(logPrefix);
}

/** Regularized upper incomplete gamma Q(a, x) via Lentz's continued fraction. */
function gammaQContinued(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let iteration = 1; iteration <= 1000; iteration += 1) {
    const an = -iteration * (iteration - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = b + an / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) {
      break;
    }
  }
  return Math.exp(-x + a * Math.log(x) - LOG_GAMMA_HALF) * h;
}

/** Error function, accurate to double precision for the z range used here. */
function erf(x: number): number {
  if (x === 0) {
    return 0;
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? 1 : -1;
  }
  const absolute = Math.abs(x);
  const squared = absolute * absolute;
  let value: number;
  if (absolute < 2.5) {
    value = gammaPSeries(0.5, squared);
  } else {
    value = 1 - gammaQContinued(0.5, squared);
  }
  return x < 0 ? -value : value;
}

function standardNormalCdf(value: number): number {
  return 0.5 * (1 + erf(value / SQRT_TWO));
}

/** Same 200-step bisection as `core.stats._z_from_alpha`. */
function zFromAlpha(alpha: number, oneSided: boolean): number {
  const target = oneSided ? alpha : alpha / 2;
  let low = -8;
  let high = 8;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const middle = (low + high) / 2;
    if (standardNormalCdf(middle) < target) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

/**
 * Existing planning estimate.
 *
 * This is the normal-approximation estimate, not a new exact power calculation.
 * Faithfully preserved quirks: the result is `max(2, ceil(...))`, so a single
 * trial is never planned. The value may exceed MAX_SUPPORTED_TRIALS for
 * abilities close to chance; the runtime must reject such a plan rather than
 * clamp it. Invalid parameters are rejected explicitly.
 */
export function requiredTrialsForPower(
  pAbility: number,
  alpha: number = DEFAULT_ALPHA,
  power: number = DEFAULT_POWER,
): number {
  if (
    typeof pAbility !== "number" ||
    !Number.isFinite(pAbility) ||
    pAbility <= 0.5 ||
    pAbility >= 1
  ) {
    throw new StatisticsInputError("pAbility must be in (0.5, 1)");
  }
  const threshold = requireAlpha(alpha);
  const targetPower = requireUnitInterval("power", power, true);
  const zAlpha = zFromAlpha(threshold, true);
  const zBeta = zFromAlpha(1 - targetPower, true);
  const numerator =
    (zAlpha * Math.sqrt(0.25) + zBeta * Math.sqrt(pAbility * (1 - pAbility))) ** 2;
  const denominator = (pAbility - 0.5) ** 2;
  const estimate = Math.max(2, Math.ceil(numerator / denominator));
  if (!Number.isSafeInteger(estimate)) {
    throw new StatisticsInputError("power estimate is outside the safe integer range");
  }
  return estimate;
}

/** Re-exported so the runtime can label public trials without a second type. */
export type { DisplayAnswer };
