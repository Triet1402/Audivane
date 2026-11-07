import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeliveredValidityV1,
  DeliveredValidityV2,
  NullGateDecision,
  PairValidityReport,
} from "@codec-abx/contracts";
import {
  assessPairRelation,
  type PairRelationReport,
  type RelationPeak,
} from "@codec-abx/measurements";

import {
  PREPARATION_GATE_INVERTED_MARGIN,
  PREPARATION_GATE_MIN_AC_RMS,
  PREPARATION_GATE_PEAK_VALUE_TOLERANCE,
  PREPARATION_GATE_POLICY_ID,
  PREPARATION_GATE_SAME_MIN_CONFIDENCE,
  PreparationPolicyError,
  evaluatePreparationGate,
  evaluatePreparationGateV1,
  preparePair,
} from "../src/index.js";

const SAMPLE_RATE = 48_000;
const LCG_SEED = 123_456_789;

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

function pcm(channels: readonly Float64Array[]) {
  return { sampleRate: SAMPLE_RATE, channels };
}

interface EvidenceOptions {
  readonly acA?: number;
  readonly acB?: number;
  readonly sameConfidence?: number;
  readonly sameLag?: number;
  readonly invertedConfidence?: number;
  readonly invertedLag?: number;
  readonly samePeaks?: readonly RelationPeak[];
  readonly maxLag?: number;
}

function makeEvidence(options: EvidenceOptions = {}): PairRelationReport {
  const acA = options.acA ?? 0.1;
  const acB = options.acB ?? 0.1;
  const sameConfidence = options.sameConfidence ?? 0.9;
  const sameLag = sameConfidence > 0 ? (options.sameLag ?? 0) : 0;
  const invertedConfidence = options.invertedConfidence ?? 0.1;
  const invertedLag = invertedConfidence > 0 ? (options.invertedLag ?? 0) : 0;
  const maxLag = options.maxLag ?? 100;
  const samePeaks = options.samePeaks ?? [{ lagSamples: sameLag, confidence: sameConfidence }];
  const sameStatus = sameConfidence > 0 ? "estimated" : "no-evidence";
  const invertedStatus = invertedConfidence > 0 ? "estimated" : "no-evidence";
  const same = {
    polarity: "same" as const,
    lagSamples: sameLag,
    confidence: sameConfidence,
    status: sameStatus as "estimated" | "no-evidence",
    rawCorrelationSum: sameConfidence,
    atSearchBoundary:
      sameStatus === "estimated" && maxLag > 0 && Math.abs(sameLag) === maxLag,
    peaks: samePeaks,
  };
  const inverted = {
    polarity: "inverted" as const,
    lagSamples: invertedLag,
    confidence: invertedConfidence,
    status: invertedStatus as "estimated" | "no-evidence",
    rawCorrelationSum: invertedConfidence,
    atSearchBoundary:
      invertedStatus === "estimated" && maxLag > 0 && Math.abs(invertedLag) === maxLag,
    peaks:
      invertedStatus === "estimated"
        ? [{ lagSamples: invertedLag, confidence: invertedConfidence }]
        : [],
  };
  const chosen = invertedConfidence > sameConfidence ? inverted : same;
  return {
    policy: "pair-relation-v1",
    sampleRate: SAMPLE_RATE,
    channels: 1,
    comparedFrames: 4096,
    maxLagSamples: maxLag,
    probeSamples: 4096,
    searchRange: { minLagSamples: -maxLag, maxLagSamples: maxLag },
    probe: {
      startFrame: 0,
      frames: 4096,
      fftSize: 8192,
      energyA: 1,
      energyB: 1,
      normalization: 1,
      centering: "first-sample-compensated-mean-v1",
    },
    acRms: {
      a: { fullScale: acA, codeSteps: acA * 32768 },
      b: { fullScale: acB, codeSteps: acB * 32768 },
    },
    same,
    inverted,
    chosen: {
      polarity: chosen.polarity,
      lagSamples: chosen.lagSamples,
      confidence: chosen.confidence,
      status: chosen.status,
      atSearchBoundary: chosen.atSearchBoundary,
    },
    notes: [],
  };
}

function isInvalidEvidence(error: unknown): boolean {
  return (
    error instanceof PreparationPolicyError && error.code === "invalid-evidence"
  );
}

test("frozen v1 LCG B=-A regression still trims 719, while the new gate refuses inversion at lag 0", () => {
  const a = lcg(LCG_SEED, 28_800);
  const b = a.map((value) => -value);

  const prepared = preparePair(pcm([a]), pcm([b]));
  assert.equal(prepared.report.alignment.lagSamples, 719);
  assert.equal(prepared.report.alignment.startFrameA, 0);
  assert.equal(prepared.report.alignment.startFrameB, 719);
  assert.ok(prepared.report.alignment.confidence > 0);

  const relation = assessPairRelation(pcm([a]), pcm([b]));
  assert.equal(relation.inverted.lagSamples, 0);
  assert.ok(relation.inverted.confidence > 0.999);
  assert.ok(relation.same.confidence < 0.05);

  const gate = evaluatePreparationGate(relation);
  assert.equal(gate.policy, PREPARATION_GATE_POLICY_ID);
  assert.equal(gate.status, "failed");
  assert.equal(gate.classification, "globally-inverted");
  assert.equal(gate.disclosure, null);
});

test("constant .1/.125 DC fails as non-evidentiary", () => {
  const a = new Float64Array(28_800).fill(0.1);
  const b = new Float64Array(28_800).fill(0.125);
  const relation = assessPairRelation(pcm([a]), pcm([b]));
  assert.equal(relation.acRms.a.fullScale, 0);
  assert.equal(relation.acRms.b.fullScale, 0);

  const gate = evaluatePreparationGate(relation);
  assert.equal(gate.status, "failed");
  assert.equal(gate.classification, "non-evidentiary");
});

test("unrelated deterministic seeds fail as weak-or-unrelated", () => {
  const a = lcg(LCG_SEED, 4096);
  const b = lcg(987_654_321, 4096);
  const relation = assessPairRelation(pcm([a]), pcm([b]), {
    maxLagSamples: 64,
    probeSamples: 4096,
  });
  const gate = evaluatePreparationGate(relation);
  assert.equal(gate.status, "failed");
  assert.equal(gate.classification, "weak-or-unrelated");
});

test("correct positive and negative broadband delays pass as same-polarity-unique", () => {
  const source = lcg(42, 4096);
  for (const [a, b, expectedLag] of [
    [source, delayed(source, 37), 37],
    [delayed(source, 40), source, -40],
  ] as const) {
    const relation = assessPairRelation(pcm([a]), pcm([b]), {
      maxLagSamples: 200,
      probeSamples: 4096,
    });
    assert.equal(relation.same.lagSamples, expectedLag);
    const gate = evaluatePreparationGate(relation);
    assert.equal(gate.status, "passed");
    assert.equal(gate.classification, "same-polarity-unique");
    assert.equal(gate.disclosure, null);
  }
});

test("periodic tones pass only with a mandatory no-unique-lag disclosure", () => {
  const frames = 28_800;
  const tone = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) {
    tone[index] = 0.4 * Math.sin((2 * Math.PI * 480 * index) / SAMPLE_RATE);
  }
  const relation = assessPairRelation(pcm([tone]), pcm([tone]), {
    maxLagSamples: 200,
    probeSamples: frames,
  });
  const gate = evaluatePreparationGate(relation);
  assert.equal(gate.status, "passed");
  assert.equal(gate.classification, "same-polarity-periodic-ambiguous");
  assert.ok(gate.disclosure?.includes("no unique lag"));
  assert.ok(gate.notes.some((note) => note.includes("no unique lag")));
  assert.ok(gate.evidence.distinctPositivePeaksWithinTolerance > 1);
});

test("a chosen best lag exactly at the search bound fails alignment-at-search-bound", () => {
  const source = lcg(314, 2048);
  const relation = assessPairRelation(
    pcm([source]),
    pcm([delayed(source, 64)]),
    { maxLagSamples: 64, probeSamples: 2048 },
  );
  const gate = evaluatePreparationGate(relation);
  assert.equal(gate.status, "failed");
  assert.equal(gate.classification, "alignment-at-search-bound");
});

test("AC RMS threshold is exact and strict below 1/32768", () => {
  const atFloor = evaluatePreparationGate(
    makeEvidence({ acA: PREPARATION_GATE_MIN_AC_RMS, acB: 0.1 }),
  );
  assert.equal(atFloor.status, "passed");
  assert.equal(atFloor.classification, "same-polarity-unique");

  const belowFloor = evaluatePreparationGate(
    makeEvidence({ acA: PREPARATION_GATE_MIN_AC_RMS * (1 - 1e-9), acB: 0.1 }),
  );
  assert.equal(belowFloor.status, "failed");
  assert.equal(belowFloor.classification, "non-evidentiary");
});

test("same-polarity confidence threshold at .5 is inclusive", () => {
  const atFloor = evaluatePreparationGate(
    makeEvidence({ sameConfidence: PREPARATION_GATE_SAME_MIN_CONFIDENCE }),
  );
  assert.equal(atFloor.status, "passed");
  assert.equal(atFloor.classification, "same-polarity-unique");

  const below = evaluatePreparationGate(
    makeEvidence({ sameConfidence: PREPARATION_GATE_SAME_MIN_CONFIDENCE - 1e-6 }),
  );
  assert.equal(below.status, "failed");
  assert.equal(below.classification, "weak-or-unrelated");
});

test("inverted margin must strictly exceed .25 and inverted floor is .5", () => {
  const exactMargin = evaluatePreparationGate(
    makeEvidence({ sameConfidence: 0.7, invertedConfidence: 0.7 + PREPARATION_GATE_INVERTED_MARGIN }),
  );
  assert.equal(exactMargin.policy, "preparation-validity-v2");
  assert.equal(exactMargin.classification, "polarity-ambiguous");
  assert.equal(exactMargin.status, "passed");
  assert.match(exactMargin.disclosure ?? "", /^polarity ambiguous:/);
  assert.ok(exactMargin.notes.includes(exactMargin.disclosure!));
  const historical = evaluatePreparationGateV1(makeEvidence({ sameConfidence: 0.7, invertedConfidence: 0.95 }));
  assert.equal(historical.policy, "preparation-validity-v1");
  assert.equal(historical.classification, "same-polarity-unique");
  assert.equal(historical.disclosure, null);
  assert.deepEqual(exactMargin.evidence, historical.evidence);
  assert.deepEqual(exactMargin.constants, historical.constants);

  const aboveMargin = evaluatePreparationGate(
    makeEvidence({ sameConfidence: 0.7, invertedConfidence: 0.7 + PREPARATION_GATE_INVERTED_MARGIN + 1e-6 }),
  );
  assert.equal(aboveMargin.classification, "globally-inverted");
  assert.equal(aboveMargin.status, "failed");

  const belowFloor = evaluatePreparationGate(
    makeEvidence({ sameConfidence: 0.1, invertedConfidence: 0.499_999 }),
  );
  assert.equal(belowFloor.classification, "weak-or-unrelated");
});

test("a real linear mixture with competing polarity is disclosed without changing the original gate", () => {
  const a = lcg(LCG_SEED, 28800);
  const shifted = delayed(a, 137);
  const b = a.map((value, index) => 0.7 * value - 0.95 * shifted[index]!);
  const relation = assessPairRelation(pcm([a]), pcm([b]), { maxLagSamples: 4800, probeSamples: 240000 });
  const historical = evaluatePreparationGateV1(relation);
  const current = evaluatePreparationGate(relation);
  assert.equal(historical.classification, "same-polarity-unique");
  assert.equal(current.status, "passed");
  assert.equal(current.classification, "polarity-ambiguous");
  assert.match(current.disclosure ?? "", /^polarity ambiguous:/);
  assert.deepEqual(current.evidence, historical.evidence);
  assert.deepEqual(current.constants, historical.constants);
});

test("peak tolerance is exact: a second peak .01 below best is ambiguous", () => {
  const atTolerance = evaluatePreparationGate(
    makeEvidence({
      sameConfidence: 0.9,
      samePeaks: [
        { lagSamples: 0, confidence: 0.9 },
        { lagSamples: 5, confidence: 0.9 - PREPARATION_GATE_PEAK_VALUE_TOLERANCE },
      ],
    }),
  );
  assert.equal(atTolerance.classification, "same-polarity-periodic-ambiguous");

  const outsideTolerance = evaluatePreparationGate(
    makeEvidence({
      sameConfidence: 0.9,
      samePeaks: [
        { lagSamples: 0, confidence: 0.9 },
        { lagSamples: 5, confidence: 0.9 - PREPARATION_GATE_PEAK_VALUE_TOLERANCE - 1e-9 },
      ],
    }),
  );
  assert.equal(outsideTolerance.classification, "same-polarity-unique");
});

test("boundary classification is exact and interior lag passes", () => {
  const atBoundary = evaluatePreparationGate(makeEvidence({ sameLag: 100, maxLag: 100 }));
  assert.equal(atBoundary.status, "failed");
  assert.equal(atBoundary.classification, "alignment-at-search-bound");

  const interior = evaluatePreparationGate(makeEvidence({ sameLag: 99, maxLag: 100 }));
  assert.equal(interior.status, "passed");
  assert.equal(interior.classification, "same-polarity-unique");
});

test("malformed or nonfinite evidence is refused instead of trusted", () => {
  const cases: Array<(evidence: ReturnType<typeof makeEvidence>) => void> = [
    (evidence) => {
      (evidence as { policy: string }).policy = "pair-relation-v2";
    },
    (evidence) => {
      (evidence.acRms.a as { fullScale: number }).fullScale = Number.NaN;
    },
    (evidence) => {
      (evidence.acRms.b as { codeSteps: number }).codeSteps += 1;
    },
    (evidence) => {
      (evidence.same as { confidence: number }).confidence = 1.1;
    },
    (evidence) => {
      (evidence.same as { lagSamples: number }).lagSamples = 0.5;
    },
    (evidence) => {
      (evidence.chosen as { confidence: number }).confidence += 0.01;
    },
    (evidence) => {
      (evidence.same.peaks[0] as { confidence: number }).confidence = Number.POSITIVE_INFINITY;
    },
  ];
  for (const mutate of cases) {
    const bad = makeEvidence();
    mutate(bad);
    assert.throws(() => evaluatePreparationGate(bad), isInvalidEvidence);
  }
});

test("gate evaluation does not mutate evidence", () => {
  const evidence = makeEvidence({ sameConfidence: 0.9, sameLag: 5 });
  const before = JSON.stringify(evidence);
  evaluatePreparationGate(evidence);
  assert.equal(JSON.stringify(evidence), before);
});

test("delivered-validity-v1 meaning is retained and v2 adds the preparation gate", () => {
  const nullGate: NullGateDecision = {
    policy: "identical-pipeline-null-v1",
    expectedIdentical: true,
    thresholdDb: -60,
    depthDb: {
      status: "negative-infinity",
      value: null,
      reason: "exact null",
    },
    status: "passed",
    reason: "passed",
  };
  const v1: DeliveredValidityV1 = {
    policy: "delivered-validity-v1",
    nullGate,
    notes: [],
  };
  const gate = evaluatePreparationGate(makeEvidence());
  const v2: DeliveredValidityV2 = {
    policy: "delivered-validity-v2",
    nullGate,
    preparationGate: gate,
    notes: [],
  };
  const reports: PairValidityReport[] = [v1, v2];
  assert.deepEqual(reports.map((report) => report.policy), [
    "delivered-validity-v1",
    "delivered-validity-v2",
  ]);
  assert.equal(reports[0]?.policy === "delivered-validity-v1" ? reports[0].nullGate.status : null, "passed");
  assert.equal(reports[1]?.policy === "delivered-validity-v2" ? reports[1].preparationGate.status : null, "passed");
});
