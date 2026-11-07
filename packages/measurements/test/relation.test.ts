import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPairRelation,
  PAIR_RELATION_CENTERING,
  PAIR_RELATION_POLICY_ID,
  type PcmAudio,
} from "../src/index.js";

const SAMPLE_RATE = 48_000;

function pcm(channels: readonly Float64Array[], sampleRate = SAMPLE_RATE): PcmAudio {
  return { sampleRate, channels };
}

function lcg(seedValue: number, length: number, amplitude = 0.2): Float64Array {
  let seed = seedValue >>> 0;
  const output = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = (seed / 4_294_967_296 - 0.5) * amplitude;
  }
  return output;
}

function delayed(source: Float64Array, delay: number): Float64Array {
  const output = new Float64Array(source.length);
  for (let index = delay; index < source.length; index += 1) {
    output[index] = source[index - delay] ?? 0;
  }
  return output;
}

function negated(source: Float64Array): Float64Array {
  return source.map((value) => -value);
}

/** Independent direct correlation with the same stated centring convention. */
function directCentered(values: Float64Array): Float64Array {
  const offset = values[0] ?? 0;
  const shifted = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    shifted[index] = (values[index] ?? 0) - offset;
  }
  let sum = 0;
  for (const value of shifted) sum += value;
  const mean = sum / shifted.length;
  for (let index = 0; index < shifted.length; index += 1) {
    shifted[index] = (shifted[index] ?? 0) - mean;
  }
  return shifted;
}

function directCorrelation(
  a: Float64Array,
  b: Float64Array,
  lag: number,
): number {
  const centeredA = directCentered(a);
  const centeredB = directCentered(b);
  let energyA = 0;
  let energyB = 0;
  for (let index = 0; index < a.length; index += 1) {
    energyA += (centeredA[index] ?? 0) ** 2;
    energyB += (centeredB[index] ?? 0) ** 2;
  }
  let sum = 0;
  const start = Math.max(0, -lag);
  const end = Math.min(a.length, b.length - lag);
  for (let index = start; index < end; index += 1) {
    sum += (centeredA[index] ?? 0) * (centeredB[index + lag] ?? 0);
  }
  return sum / Math.sqrt(energyA * energyB);
}

function snapshot(channels: readonly Float64Array[]): number[][] {
  return channels.map((channel) => Array.from(channel));
}

test("constant .1 and .125 DC have exactly zero AC evidence", () => {
  const frames = 4096;
  const a = new Float64Array(frames).fill(0.1);
  const b = new Float64Array(frames).fill(0.125);
  const relation = assessPairRelation(pcm([a]), pcm([b]));

  assert.equal(relation.policy, PAIR_RELATION_POLICY_ID);
  assert.equal(relation.acRms.a.fullScale, 0);
  assert.equal(relation.acRms.a.codeSteps, 0);
  assert.equal(relation.acRms.b.fullScale, 0);
  assert.equal(relation.acRms.b.codeSteps, 0);
  assert.equal(relation.same.status, "no-evidence");
  assert.equal(relation.inverted.status, "no-evidence");
  assert.equal(relation.same.confidence, 0);
  assert.equal(relation.inverted.confidence, 0);
  assert.equal(relation.chosen.status, "no-evidence");
  assert.equal(relation.probe.centering, PAIR_RELATION_CENTERING);
});

test("near-DC small AC motion is still measured, not zeroed with the offset", () => {
  const frames = 4096;
  const dither = lcg(123, frames, 2e-5);
  const a = dither.map((value) => 0.1 + value);
  const b = dither.map((value) => 0.125 + value);
  const relation = assessPairRelation(pcm([a]), pcm([b]));

  assert.ok(relation.acRms.a.fullScale > 0);
  assert.ok(relation.acRms.b.fullScale > 0);
  assert.ok(relation.acRms.a.fullScale < 1e-4);
  assert.equal(relation.same.lagSamples, 0);
  assert.ok(relation.same.confidence > 0.999);
});

test("unrelated deterministic seeds have no dominant positive relation", () => {
  const a = lcg(123_456_789, 4096);
  const b = lcg(987_654_321, 4096);
  const relation = assessPairRelation(pcm([a]), pcm([b]), {
    maxLagSamples: 64,
    probeSamples: 4096,
  });

  assert.ok(relation.acRms.a.fullScale > 0);
  assert.ok(relation.acRms.b.fullScale > 0);
  assert.ok(relation.same.confidence < 0.2);
  assert.ok(relation.inverted.confidence < 0.2);
  assert.equal(relation.chosen.atSearchBoundary, false);
});

test("positive and negative broadband delays follow the v1 lag sign", () => {
  const source = lcg(42, 4096);
  const positive = assessPairRelation(pcm([source]), pcm([delayed(source, 37)]), {
    maxLagSamples: 200,
    probeSamples: 4096,
  });
  assert.equal(positive.same.lagSamples, 37);
  assert.equal(positive.same.status, "estimated");
  assert.ok(positive.same.confidence > 0.99);
  assert.equal(positive.same.atSearchBoundary, false);

  const negative = assessPairRelation(pcm([delayed(source, 40)]), pcm([source]), {
    maxLagSamples: 200,
    probeSamples: 4096,
  });
  assert.equal(negative.same.lagSamples, -40);
  assert.equal(negative.same.status, "estimated");
  assert.ok(negative.same.confidence > 0.99);
});

test("globally inverted delayed content is found in the inverted hypothesis", () => {
  const source = lcg(7, 4096);
  const inverted = assessPairRelation(
    pcm([source]),
    pcm([negated(delayed(source, 11))]),
    { maxLagSamples: 100, probeSamples: 4096 },
  );

  assert.ok(inverted.same.confidence < 0.1);
  assert.equal(inverted.inverted.lagSamples, 11);
  assert.ok(inverted.inverted.confidence > 0.99);
  assert.equal(inverted.chosen.polarity, "inverted");
});

test("stereo L = -R is preserved and never downmixed to silence", () => {
  const left = lcg(99, 4096);
  const right = negated(left);
  const a = pcm([left, right]);
  const b = pcm([negated(left), left]);
  const relation = assessPairRelation(a, b, {
    maxLagSamples: 32,
    probeSamples: 4096,
  });

  assert.ok(relation.acRms.a.fullScale > 0.05);
  assert.ok(relation.acRms.b.fullScale > 0.05);
  assert.ok(relation.same.confidence < 0.1);
  assert.equal(relation.inverted.lagSamples, 0);
  assert.ok(relation.inverted.confidence > 0.999);
});

test("periodic tones expose multiple dominant same-polarity peaks", () => {
  const frames = 28_800;
  const tone = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) {
    tone[index] = 0.4 * Math.sin((2 * Math.PI * 480 * index) / SAMPLE_RATE);
  }
  const relation = assessPairRelation(pcm([tone]), pcm([tone]), {
    maxLagSamples: 200,
    probeSamples: frames,
  });

  assert.equal(relation.same.lagSamples, 0);
  assert.ok(relation.same.confidence > 0.999);
  const nearBest = relation.same.peaks.filter(
    (peak) => peak.confidence >= relation.same.confidence - 0.01,
  );
  assert.ok(nearBest.length > 1, `expected periodic peaks, saw ${String(nearBest.length)}`);
  assert.deepEqual(
    nearBest.map((peak) => peak.lagSamples).sort((left, right) => left - right),
    [-200, -100, 0, 100, 200],
  );
});

test("a best lag exactly at either search bound is reported as a boundary", () => {
  const source = lcg(314, 2048);
  const maxLagSamples = 64;
  const positive = assessPairRelation(
    pcm([source]),
    pcm([delayed(source, maxLagSamples)]),
    { maxLagSamples, probeSamples: 2048 },
  );
  assert.equal(positive.same.lagSamples, maxLagSamples);
  assert.equal(positive.same.atSearchBoundary, true);
  assert.equal(positive.chosen.atSearchBoundary, true);

  const negative = assessPairRelation(
    pcm([delayed(source, maxLagSamples)]),
    pcm([source]),
    { maxLagSamples, probeSamples: 2048 },
  );
  assert.equal(negative.same.lagSamples, -maxLagSamples);
  assert.equal(negative.same.atSearchBoundary, true);
});

test("small-N FFT result matches independent direct correlation", () => {
  const a = new Float64Array([0.11, -0.23, 0.07, 0.19, -0.04, 0.13, -0.31, 0.05, 0.22, -0.17, 0.09, 0.02]);
  const b = delayed(a, 2);
  const maxLagSamples = 4;
  const relation = assessPairRelation(pcm([a]), pcm([b]), {
    maxLagSamples,
    probeSamples: a.length,
  });

  let expectedLag = 0;
  let expectedValue = Number.NEGATIVE_INFINITY;
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
    const value = directCorrelation(a, b, lag);
    if (value > expectedValue) {
      expectedValue = value;
      expectedLag = lag;
    }
  }
  assert.equal(relation.same.lagSamples, expectedLag);
  assert.ok(Math.abs(relation.same.confidence - expectedValue) < 1e-10);
  assert.ok(Math.abs(relation.same.rawCorrelationSum / relation.probe.normalization - expectedValue) < 1e-10);
});

test("inputs are not mutated and malformed options/PCM are refused", () => {
  const a = lcg(11, 1024);
  const b = delayed(a, 5);
  const before = snapshot([a, b]);
  assessPairRelation(pcm([a]), pcm([b]), { maxLagSamples: 32, probeSamples: 1024 });
  assert.deepEqual(snapshot([a, b]), before);

  assert.throws(
    () => assessPairRelation(pcm([a]), pcm([b]), { maxLagSamples: -1 }),
    /maxLagSamples/,
  );
  assert.throws(
    () => assessPairRelation(pcm([a]), pcm([b]), { probeSamples: 1 }),
    /probeSamples/,
  );
  assert.throws(
    () => assessPairRelation(pcm([a], 44_100), pcm([b], 48_000)),
    /sample rates differ/,
  );
  assert.throws(
    () => assessPairRelation(pcm([a]), pcm([a, b])),
    /channel layouts differ/,
  );
  const nonfinite = new Float64Array(a);
  nonfinite[3] = Number.NaN;
  assert.throws(() => assessPairRelation(pcm([nonfinite]), pcm([b])), /non-finite/);
});
