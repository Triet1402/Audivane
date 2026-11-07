import type { LevelMeasurement } from "./measurements.js";

/** A delivered-audio check, not experiment authority or proof of audibility. */
export interface NullGateDecision {
  readonly policy: "identical-pipeline-null-v1";
  readonly expectedIdentical: boolean;
  readonly thresholdDb: -60;
  readonly depthDb: LevelMeasurement;
  readonly status: "passed" | "failed" | "not-applicable";
  readonly reason: string;
}

export interface CanaryDepthDecision {
  readonly status: "usable" | "not-usable";
  readonly usable: boolean;
  /** Usable requires a finite depth STRICTLY greater than this threshold. */
  readonly minimumResidualDb: -30;
  readonly depthDb: LevelMeasurement;
  readonly reason: string;
}

export interface CanaryMaterialReport extends CanaryDepthDecision {
  readonly policy: "delivered-canary-v1";
  readonly cutoffHz: 3000;
  /** Frozen arithmetic of NumPy rfftfreq(N, d=1/rate), including boundary rounding. */
  readonly frequencyGrid: "numpy-rfftfreq-v1";
  readonly drive: 10;
  readonly clipLevel: 0.45;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly notes: readonly string[];
}

/** Frozen product classifications for preparation suitability. */
export type PreparationGateClassification =
  | "non-evidentiary"
  | "globally-inverted"
  | "weak-or-unrelated"
  | "alignment-at-search-bound"
  | "same-polarity-periodic-ambiguous"
  | "polarity-ambiguous"
  | "same-polarity-unique";

/** Validated inputs the gate used, copied for later inspection. */
export interface PreparationGateEvidenceSummary {
  readonly acRmsFullScaleA: number;
  readonly acRmsFullScaleB: number;
  readonly acRmsCodeStepsA: number;
  readonly acRmsCodeStepsB: number;
  readonly sameConfidence: number;
  readonly sameLagSamples: number;
  readonly invertedConfidence: number;
  readonly invertedLagSamples: number;
  readonly chosenPolarity: "same" | "inverted";
  readonly chosenLagSamples: number;
  readonly chosenConfidence: number;
  readonly searchMinLagSamples: number;
  readonly searchMaxLagSamples: number;
  readonly distinctPositivePeaksWithinTolerance: number;
}

/** A frozen product-policy decision, not a scientific or perceptual certificate. */
export interface PreparationGateDecision {
  readonly policy: "preparation-validity-v1" | "preparation-validity-v2";
  readonly status: "passed" | "failed";
  readonly classification: PreparationGateClassification;
  readonly reason: string;
  readonly constants: {
    readonly minAcRmsFullScale: number;
    readonly invertedMinConfidence: 0.5;
    readonly invertedMargin: 0.25;
    readonly sameMinConfidence: 0.5;
    readonly peakValueTolerance: 0.01;
  };
  readonly evidence: PreparationGateEvidenceSummary;
  /** Mandatory for ambiguous passes: describes competing lag or polarity hypotheses. */
  readonly disclosure: string | null;
  readonly notes: readonly string[];
}

/** Frozen delivered-audio validity semantics. Kept exactly for existing artifacts. */
export interface DeliveredValidityV1 {
  readonly policy: "delivered-validity-v1";
  readonly nullGate: NullGateDecision;
  readonly notes: readonly string[];
}

/** Adds preparation suitability while retaining the v1 null gate unchanged. */
export interface DeliveredValidityV2 {
  readonly policy: "delivered-validity-v2";
  readonly nullGate: NullGateDecision;
  readonly preparationGate: PreparationGateDecision;
  readonly notes: readonly string[];
}

export type PairValidityReport = DeliveredValidityV1 | DeliveredValidityV2;
