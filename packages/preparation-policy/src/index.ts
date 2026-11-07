/**
 * @codec-abx/preparation-policy
 *
 * The frozen `aligned-gain-matched-v1` diagnostic preparation policy. Pure,
 * synchronous and runtime-independent: no filesystem, Node/browser globals,
 * network, codec execution or caller-array mutation. Serialized WAV bytes are
 * returned to the caller and are the only delivery measured in the report.
 */
export {
  preparePair,
  PREPARATION_LAG_SECONDS,
  PREPARATION_MIN_SECONDS,
  PREPARATION_PEAK_CEILING,
  PREPARATION_POLICY_ID,
  PREPARATION_PROBE_SAMPLES,
  PREPARATION_TARGET_LUFS,
} from "./prepare.js";
export type { PreparePairResult } from "./prepare.js";
export {
  CANARY_MIN_RESIDUAL_DB,
  NULL_GATE_THRESHOLD_DB,
  evaluateCanaryDepth,
  evaluateNullGate,
} from "./validity.js";
export {
  PREPARATION_GATE_FAILED_CODE,
  PREPARATION_GATE_INVERTED_MARGIN,
  PREPARATION_GATE_INVERTED_MIN_CONFIDENCE,
  PREPARATION_GATE_MIN_AC_RMS,
  PREPARATION_GATE_PEAK_VALUE_TOLERANCE,
  PREPARATION_GATE_POLICY_ID,
  PREPARATION_GATE_SAME_MIN_CONFIDENCE,
  PreparationGateRefusalError,
  assertPreparationGateDecision,
  assertPreparationGatePassed,
  evaluatePreparationGate,
  evaluatePreparationGateV1,
} from "./preparation-gate.js";
export {
  CANARY_CLIP_LEVEL,
  CANARY_CUTOFF_HZ,
  CANARY_DRIVE,
  CANARY_EXCERPT_SECONDS,
  buildCanaryExcerptPair,
  buildCanaryPair,
  canaryExcerptFrames,
  canaryExcerptPcm,
} from "./canary.js";
export type { CanaryPairResult } from "./canary.js";
export { PreparationPolicyError } from "./errors.js";
export type { PreparationPolicyErrorCode } from "./errors.js";
