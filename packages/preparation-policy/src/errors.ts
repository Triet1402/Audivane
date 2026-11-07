/** Stable machine-readable reasons for a refused preparation. */
export type PreparationPolicyErrorCode =
  | "invalid-pcm"
  | "incompatible-pair"
  | "empty-crop"
  | "short-crop"
  | "loudness-unavailable"
  | "nonfinite-processing"
  | "invalid-request"
  | "invalid-level"
  | "invalid-evidence";

/**
 * A policy refusal, never a partially valid delivery. The message is for
 * diagnostics; the code is the stable classification a shell may branch on.
 */
export class PreparationPolicyError extends Error {
  readonly code: PreparationPolicyErrorCode;

  constructor(code: PreparationPolicyErrorCode, message: string) {
    super(message);
    this.name = "PreparationPolicyError";
    this.code = code;
  }
}
