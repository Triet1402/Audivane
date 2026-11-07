import type {
  CanaryMaterialReport,
  DeliveredPairMeasurements,
  PairPreparationReport,
  PairValidityReport,
  PreparationRequest,
} from "@codec-abx/contracts";
import type { PairRelationReport } from "@codec-abx/measurements";

/**
 * Data-only control protocol between the browser engine and its dedicated
 * numerical worker. Serialized WAV bytes travel as transferable ArrayBuffers;
 * numerical results never include PCM or float arrays.
 *
 * Both raw delivered-pair measurement and the frozen aligned-gain-matched-v1
 * correction share one worker lifecycle. The request discriminant selects the
 * computation rather than creating a second worker protocol.
 */
export interface MeasurementWorkerRequest {
  readonly type: "measure";
  readonly id: string;
  readonly a: ArrayBuffer;
  readonly b: ArrayBuffer;
  readonly maxLagSamples: number;
  readonly probeSamples: number;
}

export interface PreparationWorkerRequest {
  readonly type: "prepare";
  readonly id: string;
  readonly a: ArrayBuffer;
  readonly b: ArrayBuffer;
  /** Frozen request; the worker validates it rather than trusting the adapter. */
  readonly request: PreparationRequest;
}

export type MeasurementWorkerRequestMessage =
  | MeasurementWorkerRequest
  | PreparationWorkerRequest;

export interface MeasurementWorkerStarted {
  readonly type: "started";
  readonly id: string;
  readonly mode: MeasurementWorkerRequestMessage["type"];
}

/** Posted on the worker thread immediately before a distinct synchronous stage. */
export interface MeasurementWorkerStage {
  readonly type: "stage";
  readonly id: string;
  readonly stage: "canary";
}

export interface MeasurementWorkerResult {
  readonly type: "result";
  readonly id: string;
  readonly measurements: DeliveredPairMeasurements;
}

/** Final corrected WAV bytes and data-only validity/material reports. */
export interface PreparationWorkerResult {
  readonly type: "prepare-result";
  readonly id: string;
  readonly a: ArrayBuffer;
  readonly b: ArrayBuffer;
  readonly report: PairPreparationReport;
  readonly delivered: DeliveredPairMeasurements;
  /** Preflight ambiguity disclosure retained even when the final crop resolves it. */
  readonly preflightDisclosure: string | null;
  /**
   * Exact pair-relation evidence measured by the worker on the final serialized
   * pair. The main thread re-evaluates the pure gate from this data without
   * running any FFT itself.
   */
  readonly relation: PairRelationReport;
  readonly validity: PairValidityReport;
  /** Present only when the frozen request explicitly enabled canary material. */
  readonly canary?: {
    readonly report: CanaryMaterialReport;
    /** Usable material transfers both buffers; unusable material transfers none. */
    readonly pristine: ArrayBuffer | null;
    readonly degraded: ArrayBuffer | null;
  };
}

export interface MeasurementWorkerFailure {
  readonly type: "error";
  readonly id: string;
  readonly message: string;
  /** Stable policy refusal code when the failure came from preparation-policy. */
  readonly code?: string;
}

export type MeasurementWorkerResponse =
  | MeasurementWorkerStarted
  | MeasurementWorkerStage
  | MeasurementWorkerResult
  | PreparationWorkerResult
  | MeasurementWorkerFailure;
