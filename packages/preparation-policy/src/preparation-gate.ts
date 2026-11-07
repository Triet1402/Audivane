import type {
  PreparationGateClassification,
  PreparationGateDecision,
} from "@codec-abx/contracts";
import type { PairRelationReport, RelationPeak } from "@codec-abx/measurements";

import { PreparationPolicyError } from "./errors.js";

/** Frozen product constants. These are declared policy choices, not standards. */
export const PREPARATION_GATE_POLICY_ID = "preparation-validity-v2" as const;
const LEGACY_PREPARATION_GATE_POLICY_ID = "preparation-validity-v1" as const;
/** One PCM16 quantum, the minimum AC RMS for either side to count as evidence. */
export const PREPARATION_GATE_MIN_AC_RMS = 1 / 32768;
export const PREPARATION_GATE_INVERTED_MIN_CONFIDENCE = 0.5;
export const PREPARATION_GATE_INVERTED_MARGIN = 0.25;
export const PREPARATION_GATE_SAME_MIN_CONFIDENCE = 0.5;
export const PREPARATION_GATE_PEAK_VALUE_TOLERANCE = 0.01;

const GATE_NOTES = [
  "preparation-validity-v1 is a frozen product policy. Its constants are declared " +
    "product choices, not scientific or perceptual certification.",
  "Confidence is normalized correlation in [0, 1], not probability, and does not " +
    "establish audibility, a valid ABX run or experiment authority.",
  "The gate classifies unchanged PCM relation evidence. It never flips polarity, " +
    "shifts samples, trims, gain-matches or applies a new correction.",
] as const;

function invalid(message: string): never {
  throw new PreparationPolicyError("invalid-evidence", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function finite(
  value: unknown,
  label: string,
  minimum?: number,
  maximum?: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${label} must be a finite number`);
  }
  if (minimum !== undefined && value < minimum) {
    invalid(`${label} must be at least ${String(minimum)}`);
  }
  if (maximum !== undefined && value > maximum) {
    invalid(`${label} must be at most ${String(maximum)}`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum?: number,
  maximum?: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalid(`${label} must be a safe integer`);
  }
  if (minimum !== undefined && value < minimum) {
    invalid(`${label} must be at least ${String(minimum)}`);
  }
  if (maximum !== undefined && value > maximum) {
    invalid(`${label} must be at most ${String(maximum)}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
  return value;
}

interface ValidatedPeak {
  readonly lagSamples: number;
  readonly confidence: number;
}

interface ValidatedHypothesis {
  readonly polarity: "same" | "inverted";
  readonly lagSamples: number;
  readonly confidence: number;
  readonly status: "estimated" | "no-evidence";
  readonly rawCorrelationSum: number;
  readonly atSearchBoundary: boolean;
  readonly peaks: readonly ValidatedPeak[];
}

function validatePeaks(
  value: unknown,
  label: string,
  minLag: number,
  maxLag: number,
): readonly ValidatedPeak[] {
  if (!Array.isArray(value)) invalid(`${label} peaks must be an array`);
  const lags = new Set<number>();
  return value.map((entry, index) => {
    const peak = record(entry, `${label} peak ${index}`);
    const lag = safeInteger(peak.lagSamples, `${label} peak ${index} lag`, minLag, maxLag);
    if (lags.has(lag)) invalid(`${label} peaks must be distinct; lag ${lag} repeats`);
    lags.add(lag);
    return Object.freeze({
      lagSamples: lag,
      confidence: finite(peak.confidence, `${label} peak ${index} confidence`, 0, 1),
    });
  });
}

function validateHypothesis(
  value: unknown,
  label: string,
  expectedPolarity: "same" | "inverted",
  minLag: number,
  maxLag: number,
): ValidatedHypothesis {
  const entry = record(value, label);
  if (entry.polarity !== expectedPolarity) {
    invalid(`${label} polarity must be ${expectedPolarity}`);
  }
  const status = entry.status;
  if (status !== "estimated" && status !== "no-evidence") {
    invalid(`${label} has an unknown status`);
  }
  const confidence = finite(entry.confidence, `${label} confidence`, 0, 1);
  if (status === "estimated" && confidence <= 0) {
    invalid(`${label} is estimated with no positive confidence`);
  }
  if (status === "no-evidence" && confidence !== 0) {
    invalid(`${label} is no-evidence with nonzero confidence`);
  }
  const lag = safeInteger(entry.lagSamples, `${label} lag`, minLag, maxLag);
  const atSearchBoundary = booleanValue(
    entry.atSearchBoundary,
    `${label} at-search-boundary flag`,
  );
  const expectedBoundary =
    status === "estimated" && maxLag > 0 && Math.abs(lag) === maxLag;
  if (atSearchBoundary !== expectedBoundary) {
    invalid(`${label} at-search-boundary flag disagrees with its lag`);
  }
  return Object.freeze({
    polarity: expectedPolarity,
    lagSamples: lag,
    confidence,
    status,
    rawCorrelationSum: finite(
      entry.rawCorrelationSum,
      `${label} raw correlation sum`,
    ),
    atSearchBoundary,
    peaks: Object.freeze(
      validatePeaks(entry.peaks, label, minLag, maxLag) as ValidatedPeak[],
    ),
  });
}

interface ValidatedEvidence {
  readonly acRmsFullScaleA: number;
  readonly acRmsFullScaleB: number;
  readonly acRmsCodeStepsA: number;
  readonly acRmsCodeStepsB: number;
  readonly minLag: number;
  readonly maxLag: number;
  readonly same: ValidatedHypothesis;
  readonly inverted: ValidatedHypothesis;
  readonly chosenPolarity: "same" | "inverted";
}

/**
 * Validate evidence rather than trusting its discriminants. Structural,
 * numerical and internal-consistency failures all refuse with
 * `PreparationPolicyError("invalid-evidence")`.
 */
function validateEvidence(value: unknown): ValidatedEvidence {
  const evidence = record(value, "preparation relation evidence");
  if (evidence.policy !== "pair-relation-v1") {
    invalid("preparation relation evidence must use policy pair-relation-v1");
  }

  const search = record(evidence.searchRange, "relation search range");
  const minLag = safeInteger(search.minLagSamples, "search min lag");
  const maxLag = safeInteger(search.maxLagSamples, "search max lag");
  if (minLag > 0 || maxLag < 0) invalid("relation search range must straddle zero");
  if (minLag !== -maxLag) invalid("relation search range must be symmetric");

  const acRms = record(evidence.acRms, "relation AC RMS");
  const side = (name: "a" | "b"): { fullScale: number; codeSteps: number } => {
    const entry = record(acRms[name], `AC RMS ${name.toUpperCase()}`);
    const fullScale = finite(entry.fullScale, `AC RMS ${name.toUpperCase()} full scale`, 0);
    const codeSteps = finite(entry.codeSteps, `AC RMS ${name.toUpperCase()} code steps`, 0);
    const expected = fullScale * 32768;
    const tolerance = 1e-9 * Math.max(1, expected);
    if (Math.abs(codeSteps - expected) > tolerance) {
      invalid(`AC RMS ${name.toUpperCase()} code steps disagree with full scale`);
    }
    return { fullScale, codeSteps };
  };
  const a = side("a");
  const b = side("b");

  const same = validateHypothesis(evidence.same, "same hypothesis", "same", minLag, maxLag);
  const inverted = validateHypothesis(
    evidence.inverted,
    "inverted hypothesis",
    "inverted",
    minLag,
    maxLag,
  );

  const chosen = record(evidence.chosen, "chosen hypothesis");
  const chosenPolarity = chosen.polarity;
  if (chosenPolarity !== "same" && chosenPolarity !== "inverted") {
    invalid("chosen polarity must be same or inverted");
  }
  const expectedChosen = inverted.confidence > same.confidence ? inverted : same;
  if (
    chosenPolarity !== expectedChosen.polarity ||
    safeInteger(chosen.lagSamples, "chosen lag", minLag, maxLag) !==
      expectedChosen.lagSamples ||
    finite(chosen.confidence, "chosen confidence", 0, 1) !==
      expectedChosen.confidence ||
    chosen.status !== expectedChosen.status ||
    booleanValue(chosen.atSearchBoundary, "chosen at-search-boundary flag") !==
      expectedChosen.atSearchBoundary
  ) {
    invalid("chosen hypothesis disagrees with the best validated hypothesis");
  }

  return Object.freeze({
    acRmsFullScaleA: a.fullScale,
    acRmsFullScaleB: b.fullScale,
    acRmsCodeStepsA: a.codeSteps,
    acRmsCodeStepsB: b.codeSteps,
    minLag,
    maxLag,
    same,
    inverted,
    chosenPolarity,
  });
}

function formatNumber(value: number): string {
  return value.toFixed(6);
}

/**
 * Decide whether pair-relation evidence is suitable for scored preparation.
 * Frozen classification order: non-evidentiary, globally inverted,
 * weak-or-unrelated, alignment at search bound, periodic/ambiguous pass, then
 * unique same-polarity pass. No input or pair is modified.
 */
export function evaluatePreparationGateV1(
  evidence: PairRelationReport,
): PreparationGateDecision {
  const validated = validateEvidence(evidence);
  const tolerance = PREPARATION_GATE_PEAK_VALUE_TOLERANCE;
  const peaksWithinTolerance = validated.same.peaks.filter(
    (peak) => peak.confidence >= validated.same.confidence - tolerance,
  ).length;
  const summary = Object.freeze({
    acRmsFullScaleA: validated.acRmsFullScaleA,
    acRmsFullScaleB: validated.acRmsFullScaleB,
    acRmsCodeStepsA: validated.acRmsCodeStepsA,
    acRmsCodeStepsB: validated.acRmsCodeStepsB,
    sameConfidence: validated.same.confidence,
    sameLagSamples: validated.same.lagSamples,
    invertedConfidence: validated.inverted.confidence,
    invertedLagSamples: validated.inverted.lagSamples,
    chosenPolarity: validated.chosenPolarity,
    chosenLagSamples:
      validated.chosenPolarity === "inverted"
        ? validated.inverted.lagSamples
        : validated.same.lagSamples,
    chosenConfidence:
      validated.chosenPolarity === "inverted"
        ? validated.inverted.confidence
        : validated.same.confidence,
    searchMinLagSamples: validated.minLag,
    searchMaxLagSamples: validated.maxLag,
    distinctPositivePeaksWithinTolerance: peaksWithinTolerance,
  });
  const constants = Object.freeze({
    minAcRmsFullScale: PREPARATION_GATE_MIN_AC_RMS,
    invertedMinConfidence: PREPARATION_GATE_INVERTED_MIN_CONFIDENCE,
    invertedMargin: PREPARATION_GATE_INVERTED_MARGIN,
    sameMinConfidence: PREPARATION_GATE_SAME_MIN_CONFIDENCE,
    peakValueTolerance: PREPARATION_GATE_PEAK_VALUE_TOLERANCE,
  } as const);

  const failed = (
    classification: PreparationGateDecision["classification"],
    reason: string,
  ): PreparationGateDecision =>
    Object.freeze({
      policy: LEGACY_PREPARATION_GATE_POLICY_ID,
      status: "failed" as const,
      classification,
      reason,
      constants,
      evidence: summary,
      disclosure: null,
      notes: GATE_NOTES,
    });

  if (
    validated.acRmsFullScaleA < PREPARATION_GATE_MIN_AC_RMS ||
    validated.acRmsFullScaleB < PREPARATION_GATE_MIN_AC_RMS
  ) {
    return failed(
      "non-evidentiary",
      `AC RMS A ${formatNumber(validated.acRmsFullScaleA)} (${formatNumber(
        validated.acRmsCodeStepsA,
      )} code steps), B ${formatNumber(validated.acRmsFullScaleB)} (${formatNumber(
        validated.acRmsCodeStepsB,
      )} code steps): at least one side is below the frozen ${PREPARATION_GATE_MIN_AC_RMS} ` +
        "(1/32768) full-scale floor, so the pair has no reliable AC evidence; " +
        "refusing to certify preparation",
    );
  }

  if (
    validated.inverted.confidence >= PREPARATION_GATE_INVERTED_MIN_CONFIDENCE &&
    validated.inverted.confidence - validated.same.confidence >
      PREPARATION_GATE_INVERTED_MARGIN
  ) {
    return failed(
      "globally-inverted",
      `inverted-hypothesis confidence ${formatNumber(
        validated.inverted.confidence,
      )} meets the ${PREPARATION_GATE_INVERTED_MIN_CONFIDENCE} floor and exceeds ` +
        `same-polarity confidence ${formatNumber(validated.same.confidence)} by more ` +
        `than ${PREPARATION_GATE_INVERTED_MARGIN}: the pair is globally inverted. ` +
        "No polarity flip is applied; refusing to certify preparation",
    );
  }

  if (
    validated.same.status === "no-evidence" ||
    validated.same.confidence < PREPARATION_GATE_SAME_MIN_CONFIDENCE
  ) {
    return failed(
      "weak-or-unrelated",
      `same-polarity confidence ${formatNumber(
        validated.same.confidence,
      )} is missing or below the ${PREPARATION_GATE_SAME_MIN_CONFIDENCE} floor: ` +
        "the pair is weakly related or unrelated; refusing to certify preparation",
    );
  }

  if (
    validated.maxLag > 0 &&
    Math.abs(
      validated.chosenPolarity === "inverted"
        ? validated.inverted.lagSamples
        : validated.same.lagSamples,
    ) === validated.maxLag
  ) {
    return failed(
      "alignment-at-search-bound",
      `chosen best lag ${String(
        validated.chosenPolarity === "inverted"
          ? validated.inverted.lagSamples
          : validated.same.lagSamples,
      )} equals the +/-${String(validated.maxLag)} sample search bound: the true ` +
        "alignment may lie outside the search, so this is not a unique in-range " +
        "result; refusing to certify preparation",
    );
  }

  if (peaksWithinTolerance > 1) {
    const disclosure =
      `no unique lag: ${String(peaksWithinTolerance)} distinct positive local ` +
      `same-polarity peaks lie within ${tolerance} of the best confidence ` +
      `${formatNumber(validated.same.confidence)}. The pair is periodic or otherwise ` +
      "ambiguous; do not treat the chosen lag or polarity as unique.";
    return Object.freeze({
      policy: LEGACY_PREPARATION_GATE_POLICY_ID,
      status: "passed" as const,
      classification: "same-polarity-periodic-ambiguous",
      reason:
        `same-polarity correlation reaches ${formatNumber(
          validated.same.confidence,
        )}, but multiple distinct local peaks are within ${tolerance} of the best: ` +
        "preparation is evidence-visible but has no unique lag. Scored listening " +
        "may proceed only with the mandatory no-unique-lag disclosure.",
      constants,
      evidence: summary,
      disclosure,
      notes: Object.freeze([...GATE_NOTES, disclosure]),
    });
  }

  return Object.freeze({
    policy: LEGACY_PREPARATION_GATE_POLICY_ID,
    status: "passed" as const,
    classification: "same-polarity-unique",
    reason:
      `same-polarity correlation ${formatNumber(
        validated.same.confidence,
      )} meets the ${PREPARATION_GATE_SAME_MIN_CONFIDENCE} floor, the chosen lag is ` +
      "inside the search bounds and there is one dominant positive local peak: " +
      "passed same-polarity-unique. This is not proof of audibility or a valid ABX run.",
    constants,
    evidence: summary,
    disclosure: null,
    notes: GATE_NOTES,
  });
}

/** V2 preserves all floors/refusals and makes competing-polarity passes explicit. */
export function evaluatePreparationGate(evidence: PairRelationReport): PreparationGateDecision {
  const legacy = evaluatePreparationGateV1(evidence);
  const notes = legacy.notes.map(note => note.replace("preparation-validity-v1", PREPARATION_GATE_POLICY_ID));
  const current = { ...legacy, policy: PREPARATION_GATE_POLICY_ID, notes: Object.freeze(notes) };
  if (legacy.status === "passed" && legacy.evidence.chosenPolarity === "inverted") {
    const disclosure = "polarity ambiguous: the inverted correlation hypothesis is stronger, " +
      "but its advantage does not exceed the frozen 0.25 refusal margin. " +
      "The same-polarity hypothesis meets the product floor; neither polarity nor delay is certified as unique.";
    return Object.freeze({ ...current, classification: "polarity-ambiguous", disclosure,
      reason: "Preparation passes the unchanged product floors with competing polarity evidence. " + disclosure,
      notes: Object.freeze([...notes, disclosure]),
    });
  }
  return Object.freeze(current);
}

/** Stable public refusal code for a failed preparation preflight. */
export const PREPARATION_GATE_FAILED_CODE = "preparation-gate-failed" as const;

/**
 * Explicit refusal for a failed preparation validity decision. The stable
 * `code` lets shells branch without parsing the diagnostic message.
 */
export class PreparationGateRefusalError extends Error {
  readonly code = PREPARATION_GATE_FAILED_CODE;
  readonly classification: PreparationGateClassification;

  constructor(decision: PreparationGateDecision) {
    super(
      `preparation-gate-failed (${decision.classification}): ${decision.reason}`,
    );
    this.name = "PreparationGateRefusalError";
    this.classification = decision.classification;
  }
}

/** Throw the stable preparation refusal unless the frozen gate passed. */
export function assertPreparationGatePassed(
  decision: PreparationGateDecision,
): void {
  if (decision.status !== "passed") {
    throw new PreparationGateRefusalError(decision);
  }
}

const FAILED_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "non-evidentiary",
  "globally-inverted",
  "weak-or-unrelated",
  "alignment-at-search-bound",
]);
const PASSED_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "same-polarity-periodic-ambiguous",
  "polarity-ambiguous",
  "same-polarity-unique",
]);

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonemptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function textList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(`${label} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Exact structural guard for a public `PreparationGateDecision`. It validates
 * fields and declared invariants only; it does not re-run or duplicate the
 * classification. Callers with relation evidence should use
 * `evaluatePreparationGate` for the authority and compare the result.
 */
export function assertPreparationGateDecision(value: unknown): void {
  const decision = record(value, "preparation gate decision");
  exactKeys(
    decision,
    [
      "policy",
      "status",
      "classification",
      "reason",
      "constants",
      "evidence",
      "disclosure",
      "notes",
    ],
    "preparation gate decision",
  );
  if (decision.policy !== PREPARATION_GATE_POLICY_ID) {
    invalid(`preparation gate policy must be ${PREPARATION_GATE_POLICY_ID}`);
  }
  const status = decision.status;
  if (status !== "passed" && status !== "failed") {
    invalid("preparation gate status must be passed or failed");
  }
  const classification = decision.classification;
  if (typeof classification !== "string") {
    invalid("preparation gate classification must be a string");
  }
  if (status === "failed" && !FAILED_CLASSIFICATIONS.has(classification)) {
    invalid("failed preparation gate has a passing classification");
  }
  if (status === "passed" && !PASSED_CLASSIFICATIONS.has(classification)) {
    invalid("passed preparation gate has a failing classification");
  }
  nonemptyText(decision.reason, "preparation gate reason");

  const constants = record(decision.constants, "preparation gate constants");
  exactKeys(
    constants,
    [
      "minAcRmsFullScale",
      "invertedMinConfidence",
      "invertedMargin",
      "sameMinConfidence",
      "peakValueTolerance",
    ],
    "preparation gate constants",
  );
  if (constants.minAcRmsFullScale !== PREPARATION_GATE_MIN_AC_RMS ||
      constants.invertedMinConfidence !== PREPARATION_GATE_INVERTED_MIN_CONFIDENCE ||
      constants.invertedMargin !== PREPARATION_GATE_INVERTED_MARGIN ||
      constants.sameMinConfidence !== PREPARATION_GATE_SAME_MIN_CONFIDENCE ||
      constants.peakValueTolerance !== PREPARATION_GATE_PEAK_VALUE_TOLERANCE) {
    invalid("preparation gate constants disagree with the frozen policy");
  }

  const evidence = record(decision.evidence, "preparation gate evidence");
  exactKeys(
    evidence,
    [
      "acRmsFullScaleA",
      "acRmsFullScaleB",
      "acRmsCodeStepsA",
      "acRmsCodeStepsB",
      "sameConfidence",
      "sameLagSamples",
      "invertedConfidence",
      "invertedLagSamples",
      "chosenPolarity",
      "chosenLagSamples",
      "chosenConfidence",
      "searchMinLagSamples",
      "searchMaxLagSamples",
      "distinctPositivePeaksWithinTolerance",
    ],
    "preparation gate evidence",
  );
  const fullScaleA = finite(
    evidence.acRmsFullScaleA,
    "preparation gate AC RMS A",
    0,
  );
  const fullScaleB = finite(
    evidence.acRmsFullScaleB,
    "preparation gate AC RMS B",
    0,
  );
  for (const [label, fullScale, codeSteps] of [
    ["A", fullScaleA, evidence.acRmsCodeStepsA],
    ["B", fullScaleB, evidence.acRmsCodeStepsB],
  ] as const) {
    const value = finite(codeSteps, `preparation gate AC RMS ${label} code steps`, 0);
    const expected = fullScale * 32768;
    const tolerance = 1e-9 * Math.max(1, expected);
    if (Math.abs(value - expected) > tolerance) {
      invalid(`preparation gate AC RMS ${label} code steps disagree with full scale`);
    }
  }
  const sameConfidence = finite(evidence.sameConfidence, "preparation gate same confidence", 0, 1);
  const invertedConfidence = finite(
    evidence.invertedConfidence,
    "preparation gate inverted confidence",
    0,
    1,
  );
  const searchMinLag = safeInteger(evidence.searchMinLagSamples, "preparation gate search min lag");
  const searchMaxLag = safeInteger(evidence.searchMaxLagSamples, "preparation gate search max lag");
  if (searchMinLag > 0 || searchMaxLag < 0 || searchMinLag !== -searchMaxLag) {
    invalid("preparation gate search bounds must be symmetric around zero");
  }
  const sameLag = safeInteger(evidence.sameLagSamples, "preparation gate same lag", searchMinLag, searchMaxLag);
  const invertedLag = safeInteger(
    evidence.invertedLagSamples,
    "preparation gate inverted lag",
    searchMinLag,
    searchMaxLag,
  );
  const chosenPolarity = evidence.chosenPolarity;
  if (chosenPolarity !== "same" && chosenPolarity !== "inverted") {
    invalid("preparation gate chosen polarity must be same or inverted");
  }
  const chosenLag = safeInteger(
    evidence.chosenLagSamples,
    "preparation gate chosen lag",
    searchMinLag,
    searchMaxLag,
  );
  const chosenConfidence = finite(evidence.chosenConfidence, "preparation gate chosen confidence", 0, 1);
  const expectedPolarity = invertedConfidence > sameConfidence ? "inverted" : "same";
  if (chosenPolarity !== expectedPolarity ||
      chosenLag !== (expectedPolarity === "inverted" ? invertedLag : sameLag) ||
      chosenConfidence !== (expectedPolarity === "inverted" ? invertedConfidence : sameConfidence)) {
    invalid("preparation gate chosen evidence disagrees with the two hypotheses");
  }
  safeInteger(
    evidence.distinctPositivePeaksWithinTolerance,
    "preparation gate distinct peak count",
    0,
  );

  const disclosure = decision.disclosure;
  if (disclosure !== null && (typeof disclosure !== "string" || disclosure.length === 0)) {
    invalid("preparation gate disclosure must be null or a non-empty string");
  }
  const notes = textList(decision.notes, "preparation gate notes");
  if (classification === "same-polarity-periodic-ambiguous" || classification === "polarity-ambiguous") {
    if (disclosure === null) invalid("periodic-ambiguous gate must disclose no unique lag");
    if (!notes.includes(disclosure)) {
      invalid("periodic-ambiguous disclosure must be retained in notes");
    }
  } else if (disclosure !== null) {
    invalid("only a periodic-ambiguous gate may carry a disclosure");
  }
  if (status === "failed" && disclosure !== null) {
    invalid("failed preparation gate must not carry a pass disclosure");
  }
}
