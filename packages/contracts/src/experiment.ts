/** Public experiment DTOs. Unanswered assignments and source mappings stay runtime-private. */
import type { PreparationRequest } from "./index.js";
import type { PreparationGateClassification } from "./validity.js";
export type DisplayAnswer = "A" | "B";
export type PlaybackLabel = DisplayAnswer | "X";
export type TrialKind = "calibration" | "scored";
export type ExperimentLifecycle = "configured" | "running" | "completed" | "sealed" | "void";

/** This slice implements local self-testing only, without trusted remote custody. */
export interface ExperimentPlan {
  readonly version: 1;
  /** Null permits descriptive practice only; it can never produce a final verdict. */
  readonly plannedTrials: number | null;
  readonly alpha: number;
  readonly labelMode: "fixed" | "blind_random";
  readonly calibrationEnabled: boolean;
}

export interface PublicTrial {
  readonly runId: string;
  readonly token: string;
  /** Contiguous across calibration and scored trials, beginning at one. */
  readonly trialIndex: number;
  readonly kind: TrialKind;
}

/** Feedback belongs only to an already accepted answer. */
export interface AnswerReceipt {
  readonly runId: string;
  readonly token: string;
  readonly trialIndex: number;
  readonly kind: TrialKind;
  readonly answer: DisplayAnswer;
  readonly correct: boolean;
  readonly answeredAtUtc: string;
}

export interface ExperimentStatistics {
  readonly scoredTrials: number;
  readonly correctTrials: number;
  readonly plannedTrials: number | null;
  readonly requiredCorrect: number | null;
  readonly pValue: number;
  readonly ability: number | null;
  readonly abilityCi95: readonly [number, number];
  readonly significant: boolean;
  readonly isFinal: boolean;
  /** Raw significance alone is never a result. */
  readonly significantVerdict: boolean;
}

export interface ExperimentGates {
  readonly nullStatus: "not-measured" | "passed" | "failed" | "not-applicable";
  readonly preparationStatus: "not-measured" | "passed" | "failed";
  /** Frozen classification when a preparation gate was evaluated; never inferred. */
  readonly preparationClassification: PreparationGateClassification | null;
  readonly preparationReason: string | null;
  /** Mandatory no-unique-lag text for an ambiguous pass; otherwise null. */
  readonly preparationDisclosure: string | null;
  readonly calibrationStatus: "not-configured" | "unavailable" | "pending" | "passed" | "failed";
  readonly reasons: readonly string[];
}

export interface ExperimentSnapshot {
  readonly version: 1;
  readonly runId: string;
  readonly authority: "local-self-test";
  readonly lifecycle: ExperimentLifecycle;
  readonly plan: ExperimentPlan;
  readonly lockedAtUtc: string | null;
  readonly commitment: string;
  readonly prepared: {
    readonly artifactId: string;
    readonly aWavSha256: string;
    readonly bWavSha256: string;
    readonly sourceSha256: string;
    readonly engineId: string;
    readonly engineBuild: string;
    readonly request: PreparationRequest;
    readonly preparationLocation: "desktop-native" | "browser-local" | "optional-server";
  } | null;
  readonly pendingTrial: PublicTrial | null;
  /** Lets a client reconcile an uncertain submission without answering a new trial. */
  readonly lastAnswer: AnswerReceipt | null;
  readonly gates: ExperimentGates;
  readonly statistics: ExperimentStatistics;
  readonly sealedReason: string | null;
  readonly limitations: readonly string[];
}

export interface ExperimentAuditRow extends AnswerReceipt {
  readonly xSource: DisplayAnswer;
  readonly answerSource: DisplayAnswer;
  readonly displayMapping: Readonly<Record<DisplayAnswer, DisplayAnswer>>;
}

export interface ExperimentExport {
  readonly schema: "codec-abx-experiment-v1";
  readonly snapshot: ExperimentSnapshot;
  readonly trials: readonly ExperimentAuditRow[];
  readonly reveal: {
    readonly commitment: string;
    /** Null while configured/running, even if preparation is currently blocked. */
    readonly secretHex: string | null;
    /** Only answered indices; never a pending or future assignment. */
    readonly xSequence: readonly DisplayAnswer[];
    readonly redacted: boolean;
    readonly verifiable: boolean;
  };
}

/** Transport-ready operations. Runtime binding of artifacts/readers is separate. */
export interface ExperimentClient {
  configure(plan: ExperimentPlan): Promise<ExperimentSnapshot>;
  snapshot(): Promise<ExperimentSnapshot>;
  /** An unanswered trial is returned unchanged; retrying never redraws its mapping. */
  nextTrial(): Promise<PublicTrial>;
  /** Same token + same answer retries return the original receipt exactly once. */
  answer(token: string, answer: DisplayAnswer): Promise<AnswerReceipt>;
  /** Labels are resolved once by the runtime; no source identity is returned. */
  readAudio(token: string, label: PlaybackLabel): Promise<ArrayBuffer>;
  seal(reason?: string): Promise<ExperimentSnapshot>;
  /** New run/secret/tokens; retains the prepared pair and its gate evidence. */
  reset(): Promise<ExperimentSnapshot>;
  export(): Promise<ExperimentExport>;
  dispose(): Promise<void>;
}
