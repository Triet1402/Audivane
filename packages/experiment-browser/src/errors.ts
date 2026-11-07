/**
 * Stable, transport-safe client refusals.
 *
 * The service codes mirror `ExperimentServiceError`; they are duplicated here
 * so the renderer entry never imports the runtime service, its numerics or its
 * private assignments. Messages never carry stacks, source paths, unanswered
 * assignments, display mappings or secrets.
 */
export type ExperimentServiceErrorCode =
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

export type ExperimentTransportErrorCode =
  | "worker-start-failed"
  | "worker-fatal"
  | "protocol-error"
  | "request-timeout"
  | "invalid-request"
  | "stale-response";

export type ExperimentClientErrorCode =
  | ExperimentServiceErrorCode
  | ExperimentTransportErrorCode;

const SERVICE_CODES: ReadonlySet<string> = new Set<ExperimentServiceErrorCode>([
  "disposed",
  "invalid-plan",
  "invalid-answer",
  "not-configured",
  "config-locked",
  "artifact-invalid",
  "artifact-unbound",
  "artifact-reader-unavailable",
  "artifact-bytes-mismatch",
  "calibration-unavailable",
  "null-gate-failed",
  "preparation-gate-failed",
  "trial-limit",
  "practice-limit",
  "run-closed",
  "unknown-token",
  "stale-token",
  "conflicting-answer",
  "invalid-state",
]);

const TRANSPORT_CODES: ReadonlySet<string> = new Set<ExperimentTransportErrorCode>([
  "worker-start-failed",
  "worker-fatal",
  "protocol-error",
  "request-timeout",
  "invalid-request",
  "stale-response",
]);

export function isServiceErrorCode(value: unknown): value is ExperimentServiceErrorCode {
  return typeof value === "string" && SERVICE_CODES.has(value);
}

export function isClientErrorCode(value: unknown): value is ExperimentClientErrorCode {
  return typeof value === "string" &&
    (SERVICE_CODES.has(value) || TRANSPORT_CODES.has(value));
}

export class ExperimentClientError extends Error {
  readonly code: ExperimentClientErrorCode;
  readonly reasons: readonly string[];
  /**
   * True only for a timed-out `answer`: the service may already have accepted
   * it. Retry the same token/answer or inspect snapshot.lastAnswer/pendingTrial.
   */
  readonly uncertain: boolean;

  constructor(
    code: ExperimentClientErrorCode,
    message: string,
    reasons: readonly string[] = [],
    uncertain = false,
  ) {
    super(message);
    this.name = "ExperimentClientError";
    this.code = code;
    this.reasons = Object.freeze([...reasons]);
    this.uncertain = uncertain;
  }
}

export function clientError(
  code: ExperimentClientErrorCode,
  message: string,
  reasons: readonly string[] = [],
  uncertain = false,
): ExperimentClientError {
  return new ExperimentClientError(code, message, reasons, uncertain);
}
