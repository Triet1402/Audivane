/**
 * Stable, transport-safe refusals for the experiment runtime.
 *
 * Codes are part of the client contract; messages never contain an unanswered
 * assignment, a display mapping, a secret or prepared audio bytes.
 */
export type ExperimentErrorCode =
  | "disposed"
  | "invalid-plan"
  | "invalid-answer"
  | "not-configured"
  | "config-locked"
  | "artifact-invalid"
  | "artifact-unbound"
  | "artifact-reader-unavailable"
  | "artifact-bytes-mismatch"
  | "calibration-unavailable"
  | "null-gate-failed"
  | "preparation-gate-failed"
  | "trial-limit"
  | "practice-limit"
  | "run-closed"
  | "unknown-token"
  | "stale-token"
  | "conflicting-answer"
  | "invalid-state";

export class ExperimentServiceError extends Error {
  readonly code: ExperimentErrorCode;
  readonly reasons: readonly string[];

  constructor(code: ExperimentErrorCode, message: string, reasons: readonly string[] = []) {
    super(message);
    this.name = "ExperimentServiceError";
    this.code = code;
    this.reasons = Object.freeze([...reasons]);
  }
}

export function serviceError(
  code: ExperimentErrorCode,
  message: string,
  reasons: readonly string[] = [],
): never {
  throw new ExperimentServiceError(code, message, reasons);
}
