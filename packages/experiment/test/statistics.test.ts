import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANCE,
  CI_DECIMALS,
  CI_ABS_TOLERANCE,
  DEFAULT_ALPHA,
  HOLM_DECIMALS,
  MAX_SUPPORTED_TRIALS,
  P_VALUE_ABS_TOLERANCE,
  StatisticsInputError,
  binomialCi,
  binomTail,
  holmBonferroni,
  isSignificant,
  minCorrectForSignificance,
  oneTailedPValue,
  requiredTrialsForPower,
  roundTo,
} from "../src/statistics.js";

function closeTo(actual: number, expected: number, tolerance: number): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("published ABX tables agree within 1e-12", () => {
  const expected: ReadonlyArray<readonly [number, number, number]> = [
    [8, 7, 0.03515625],
    [8, 8, 0.00390625],
    [10, 8, 0.0546875],
    [10, 9, 0.0107421875],
    [13, 10, 0.046142578125],
    [16, 12, 0.0384063720703125],
    [16, 13, 0.0106353759765625],
    [20, 15, 0.020694732666015625],
    [25, 18, 0.021642625331878662],
    [10, 10, 0.0009765625],
    [1, 1, 0.5],
    [2, 2, 0.25],
  ];
  for (const [n, k, value] of expected) {
    closeTo(oneTailedPValue(n, k), value, P_VALUE_ABS_TOLERANCE);
  }
});

test("zero trials, no correct and all correct are handled exactly", () => {
  assert.equal(oneTailedPValue(0, 0), 1);
  assert.equal(isSignificant(0, 0, DEFAULT_ALPHA), false);
  assert.equal(minCorrectForSignificance(0), null);
  assert.deepEqual(binomialCi(0, 0), [0, 1]);

  assert.equal(oneTailedPValue(10, 0), 1);
  assert.equal(oneTailedPValue(10, 1), 1 - 2 ** -10);
  assert.equal(oneTailedPValue(10, 10), 2 ** -10);
  assert.equal(oneTailedPValue(1000, 0), 1);
  assert.equal(oneTailedPValue(1000, 1000), 2 ** -1000);
});

test("exhaustive small-n tails match direct binomial arithmetic", () => {
  // Independent direct expansion of sum_{i=k..n} C(n,i) p^i (1-p)^(n-i).
  for (let n = 0; n <= 24; n += 1) {
    for (let k = 0; k <= n; k += 1) {
      let direct = 0;
      let combination = 1;
      for (let i = 0; i <= n; i += 1) {
        if (i >= k) direct += combination * CHANCE ** i * (1 - CHANCE) ** (n - i);
        combination = (combination * (n - i)) / (i + 1);
      }
      closeTo(oneTailedPValue(n, k), direct, P_VALUE_ABS_TOLERANCE);
      closeTo(binomTail(n, k, CHANCE), direct, P_VALUE_ABS_TOLERANCE);
    }
  }
});

test("tail is monotone in k for every supported small n", () => {
  for (const n of [1, 2, 3, 10, 25, 100, 1000]) {
    let previous = 1;
    for (let k = 0; k <= n; k += 1) {
      const value = oneTailedPValue(n, k);
      assert.ok(value <= previous + Number.EPSILON, `not monotone at n=${n}, k=${k}`);
      previous = value;
    }
  }
});

test("n=1000 tails stay representable and monotone", () => {
  const expected: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [1, 1],
    [500, 0.5126125090891804],
    [999, 9.341968821217221e-299],
    [1000, 9.332636185032189e-302],
  ];
  for (const [k, p] of expected) {
    const value = oneTailedPValue(1000, k);
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0 && value <= 1);
    closeTo(value, p, Math.max(P_VALUE_ABS_TOLERANCE, p * 1e-12));
  }
});

test("thresholds are the smallest strictly passing count", () => {
  const expected: ReadonlyArray<readonly [number, number | null]> = [
    [0, null],
    [1, null],
    [2, null],
    [3, null],
    [5, 5],
    [8, 7],
    [10, 9],
    [13, 10],
    [20, 15],
    [60, 37],
  ];
  for (const [n, threshold] of expected) {
    assert.equal(minCorrectForSignificance(n), threshold, `n=${n}`);
    if (threshold !== null) {
      assert.equal(isSignificant(n, threshold), true);
      assert.equal(isSignificant(n, threshold - 1), false);
    }
  }
  for (let n = 3; n <= 60; n += 1) {
    const threshold = minCorrectForSignificance(n);
    if (threshold === null) {
      continue;
    }
    assert.equal(isSignificant(n, threshold), true);
    assert.equal(isSignificant(n, threshold - 1), false);
  }
  assert.equal(minCorrectForSignificance(1), null);
  assert.equal(minCorrectForSignificance(2), null);
});

test("alpha equality uses strict p < alpha, never <=", () => {
  const boundaries: ReadonlyArray<readonly [number, number, number]> = [
    [1, 1, 0.5],
    [2, 2, 0.25],
    [3, 3, 0.125],
    [4, 4, 0.0625],
    [5, 5, 0.03125],
    [5, 4, 0.1875],
  ];
  for (const [n, k, alpha] of boundaries) {
    const p = oneTailedPValue(n, k);
    assert.equal(p, alpha, "exact dyadic tail should be represented exactly");
    assert.equal(isSignificant(n, k, alpha), false, "exact equality must not pass");
    assert.equal(
      isSignificant(n, k, alpha - 1e-15),
      false,
      "a smaller alpha cannot make the same p significant",
    );
    assert.equal(
      isSignificant(n, k, alpha + 1e-15),
      true,
      "a slightly larger alpha makes the same p strictly significant",
    );
    const threshold = minCorrectForSignificance(n, alpha);
    const thresholdBelow = minCorrectForSignificance(n, alpha - 1e-15);
    const thresholdAbove = minCorrectForSignificance(n, alpha + 1e-15);
    if (threshold !== null) {
      assert.equal(isSignificant(n, threshold, alpha), true);
      assert.equal(isSignificant(n, threshold - 1, alpha), false);
    }
    assert.equal(thresholdBelow, threshold);
    assert.equal(thresholdAbove, k);
  }
});

test("Clopper-Pearson intervals match known values and endpoints", () => {
  const expected: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [0, 0, 0.95, 0, 1],
    [1, 0, 0.95, 0, 0.975],
    [1, 1, 0.95, 0.025, 1],
    [10, 0, 0.95, 0, 0.308497],
    [10, 10, 0.95, 0.691503, 1],
    [10, 7, 0.95, 0.347547, 0.93326],
    [10, 7, 0.9, 0.393376, 0.912736],
    [16, 13, 0.95, 0.543543, 0.959526],
  ];
  for (const [n, k, confidence, lower, upper] of expected) {
    const interval = binomialCi(n, k, confidence);
    closeTo(interval[0], lower, CI_ABS_TOLERANCE);
    closeTo(interval[1], upper, CI_ABS_TOLERANCE);
    assert.ok(interval[0] >= 0 && interval[0] <= interval[1] && interval[1] <= 1);
    assert.match(String(interval[0]), new RegExp(`^\\d+(\\.\\d{0,${CI_DECIMALS}})?$`));
    assert.match(String(interval[1]), new RegExp(`^\\d+(\\.\\d{0,${CI_DECIMALS}})?$`));
  }

  assert.deepEqual(binomialCi(1, 0), [0, 0.975]);
  assert.deepEqual(binomialCi(1, 1), [0.025, 1]);
  assert.deepEqual(binomialCi(10, 10), [0.691503, 1]);
  assert.deepEqual(binomialCi(16, 13), [0.543543, 0.959526]);
  assert.deepEqual(binomialCi(0, 0), [0, 1]);
});

test("CI is bounded at n=1000 and contains the point estimate", () => {
  const started = Date.now();
  const [lower, upper] = binomialCi(1000, 500);
  const elapsed = Date.now() - started;
  assert.ok(Number.isFinite(lower) && Number.isFinite(upper));
  assert.ok(lower <= 0.5 && upper >= 0.5);
  assert.ok(upper - lower > 0.01 && upper - lower < 0.1);
  assert.ok(elapsed < 5000, `n=1000 CI took ${elapsed}ms`);
  for (const k of [0, 1, 500, 999, 1000]) {
    const [lo, hi] = binomialCi(1000, k);
    assert.ok(0 <= lo && lo <= k / 1000 && k / 1000 <= hi && hi <= 1);
  }
});

test("Holm correction preserves ordering, rounding and decisions", () => {
  const families: ReadonlyArray<{
    readonly pValues: readonly number[];
    readonly alpha: number;
    readonly results: readonly { index: number; adjustedP: number; reject: boolean }[];
  }> = [
    { pValues: [], alpha: 0.05, results: [] },
    { pValues: [0.001], alpha: 0.05, results: [{ index: 0, adjustedP: 0.001, reject: true }] },
    { pValues: [0.05], alpha: 0.05, results: [{ index: 0, adjustedP: 0.05, reject: false }] },
    {
      pValues: [0.001, 0.02, 0.04, 0.5],
      alpha: 0.05,
      results: [
        { index: 0, adjustedP: 0.004, reject: true },
        { index: 1, adjustedP: 0.06, reject: false },
        { index: 2, adjustedP: 0.08, reject: false },
        { index: 3, adjustedP: 0.5, reject: false },
      ],
    },
    {
      pValues: [0.01, 0.01, 0.01, 0.2],
      alpha: 0.05,
      results: [
        { index: 0, adjustedP: 0.04, reject: true },
        { index: 1, adjustedP: 0.04, reject: true },
        { index: 2, adjustedP: 0.04, reject: true },
        { index: 3, adjustedP: 0.2, reject: false },
      ],
    },
    {
      pValues: [0.01, 0.04, 0.03, 0.002],
      alpha: 0.1,
      results: [
        { index: 3, adjustedP: 0.008, reject: true },
        { index: 0, adjustedP: 0.03, reject: true },
        { index: 2, adjustedP: 0.06, reject: true },
        { index: 1, adjustedP: 0.06, reject: true },
      ],
    },
    {
      pValues: [0.2, 0.1, 0.05],
      alpha: 0.05,
      results: [
        { index: 2, adjustedP: 0.15, reject: false },
        { index: 1, adjustedP: 0.2, reject: false },
        { index: 0, adjustedP: 0.2, reject: false },
      ],
    },
  ];
  for (const family of families) {
    const input = family.pValues.slice();
    const result = holmBonferroni(input, family.alpha);
    assert.deepEqual(result, family.results);
    assert.deepEqual(input, family.pValues, "input family must not be mutated");
  }

  const ties = holmBonferroni([0.01, 0.01, 0.01, 0.2]);
  assert.deepEqual(
    ties.map((entry) => entry.index),
    [0, 1, 2, 3],
    "stable ordering preserves family order for equal p-values",
  );
  assert.equal(ties[0]?.adjustedP, 0.04);
  assert.equal(ties[1]?.adjustedP, 0.04);
  assert.equal(ties[2]?.adjustedP, 0.04);
  assert.equal(HOLM_DECIMALS, 8);
});

test("Holm decisions at exact alpha use the unrounded running maximum", () => {
  const single = holmBonferroni([0.05], 0.05);
  assert.equal(single[0]?.adjustedP, 0.05);
  assert.equal(single[0]?.reject, false);
  const family = holmBonferroni([0.025, 0.025], 0.05);
  assert.deepEqual(family.map((entry) => entry.reject), [false, false]);
  assert.deepEqual(family.map((entry) => entry.adjustedP), [0.05, 0.05]);
});

test("Holm decimal-boundary rounding matches the exact binary-float value", () => {
  // The binary value 3 * 2.5e-8 is just BELOW 7.5e-8.
  assert.deepEqual(holmBonferroni([0.000000025, 0.123456785, 0.999999995]), [
    { index: 0, adjustedP: 0.00000007, reject: true },
    { index: 1, adjustedP: 0.24691357, reject: false },
    { index: 2, adjustedP: 1, reject: false },
  ]);
});

test("Holm rejects sparse families rather than silently skipping a comparison", () => {
  assert.throws(() => holmBonferroni(new Array<number>(2)), StatisticsInputError);
});

test("ability rounding uses exact half-even boundaries", () => {
  const rows: ReadonlyArray<readonly [number, number, number]> = [
    [1, 32, 0.0312],
    [3, 32, 0.0938],
    [5, 32, 0.1562],
    [7, 32, 0.2188],
    [2, 64, 0.0312],
    [1, 200, 0.005],
    [3, 200, 0.015],
  ];
  for (const [k, n, ability] of rows) {
    assert.equal(roundTo(k / n, 4), ability);
  }
  assert.equal(roundTo(0.12505, 4), 0.125);
  assert.equal(roundTo(0.12515, 4), 0.1252);
  assert.equal(roundTo(-0.12505, 4), -0.125);
  assert.equal(roundTo(0.5, 0), 0);
  assert.equal(roundTo(1.5, 0), 2);
  assert.equal(roundTo(2.5, 0), 2);
});

test("power estimates match the planning formula", () => {
  const rows: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.6, 0.05, 0.8, 153],
    [0.7, 0.05, 0.8, 37],
    [0.75, 0.05, 0.8, 23],
    [0.8, 0.05, 0.8, 15],
    [0.9, 0.05, 0.8, 8],
    [0.6, 0.01, 0.9, 321],
    [0.55, 0.05, 0.8, 617],
  ];
  for (const [pAbility, alpha, power, required] of rows) {
    assert.equal(requiredTrialsForPower(pAbility, alpha, power), required);
  }
  assert.equal(requiredTrialsForPower(0.75), 23);
  assert.equal(requiredTrialsForPower(0.7), 37);
  assert.ok(requiredTrialsForPower(0.6) > 140);
  assert.ok(requiredTrialsForPower(0.9) < 20);
});

test("general binomial tail agrees with direct small-n arithmetic", () => {
  for (const p of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
    for (const n of [0, 1, 2, 5, 10, 30]) {
      for (let k = 0; k <= n; k += 1) {
        let direct = 0;
        let combination = 1;
        for (let i = 0; i <= n; i += 1) {
          if (i >= k) {
            direct += combination * p ** i * (1 - p) ** (n - i);
          }
          combination = (combination * (n - i)) / (i + 1);
        }
        closeTo(binomTail(n, k, p), direct, 2e-12);
      }
    }
  }
  assert.equal(binomTail(10, 0, 0), 1);
  assert.equal(binomTail(10, 1, 0), 0);
  assert.equal(binomTail(10, 10, 1), 1);
});

test("malformed statistics inputs are rejected with a stable error", () => {
  const badNumbers = [NaN, Infinity, -Infinity];
  for (const bad of badNumbers) {
    assert.throws(() => oneTailedPValue(bad, 0), StatisticsInputError);
    assert.throws(() => oneTailedPValue(10, bad), StatisticsInputError);
    assert.throws(() => binomTail(10, 1, bad), StatisticsInputError);
    assert.throws(() => isSignificant(10, 1, bad), StatisticsInputError);
    assert.throws(() => minCorrectForSignificance(10, bad), StatisticsInputError);
    assert.throws(() => binomialCi(10, 1, bad), StatisticsInputError);
    assert.throws(
      () => requiredTrialsForPower(bad as unknown as number),
      StatisticsInputError,
    );
  }
  for (const n of [-1, 1.5, MAX_SUPPORTED_TRIALS + 1]) {
    assert.throws(() => oneTailedPValue(n, 0), StatisticsInputError);
    assert.throws(() => binomialCi(n, 0), StatisticsInputError);
    assert.throws(() => minCorrectForSignificance(n), StatisticsInputError);
  }
  for (const k of [-1, 11, 1.5]) {
    assert.throws(() => oneTailedPValue(10, k), StatisticsInputError);
    assert.throws(() => binomialCi(10, k), StatisticsInputError);
  }
  for (const alpha of [0, 1, -0.1, 1.1]) {
    assert.throws(() => isSignificant(10, 1, alpha), StatisticsInputError);
    assert.throws(() => minCorrectForSignificance(10, alpha), StatisticsInputError);
    assert.throws(() => holmBonferroni([0.1], alpha), StatisticsInputError);
  }
  for (const p of [-0.01, 1.01]) {
    assert.throws(() => binomTail(10, 1, p), StatisticsInputError);
  }
  for (const p of [-0.1, 1.1, 0, 1]) {
    assert.throws(() => requiredTrialsForPower(0.75, 0.05, p), StatisticsInputError);
  }
  assert.throws(() => requiredTrialsForPower(0.5), StatisticsInputError);
  assert.throws(() => requiredTrialsForPower(1), StatisticsInputError);
  assert.throws(
    () => holmBonferroni("nope" as unknown as readonly number[]),
    StatisticsInputError,
  );
  assert.throws(() => holmBonferroni([0.1, NaN]), StatisticsInputError);
});

test("statistics calls do not mutate caller arrays and return fresh intervals", () => {
  const family = [0.01, 0.02, 0.03];
  const copy = family.slice();
  holmBonferroni(family);
  assert.deepEqual(family, copy);

  const first = binomialCi(40, 28);
  const second = binomialCi(40, 28);
  assert.notEqual(first, second);
  (first as unknown as number[])[0] = 0;
  assert.notEqual(binomialCi(40, 28)[0], 0);
});
