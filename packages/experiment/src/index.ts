/** Runtime-independent experiment numerics and commit-reveal primitives. */
export {
  CHANCE,
  DEFAULT_ALPHA,
  DEFAULT_POWER,
  MAX_SUPPORTED_TRIALS,
  P_VALUE_ABS_TOLERANCE,
  CI_DECIMALS,
  CI_ABS_TOLERANCE,
  HOLM_DECIMALS,
  StatisticsInputError,
  binomTail,
  oneTailedPValue,
  minCorrectForSignificance,
  isSignificant,
  binomialCi,
  holmBonferroni,
  requiredTrialsForPower,
} from "./statistics.js";
export type { HolmResult } from "./statistics.js";

export {
  ExperimentService,
} from "./runtime/service.js";
export { ExperimentServiceError } from "./runtime/errors.js";
export type { ExperimentErrorCode } from "./runtime/errors.js";
export type { ArtifactReaders } from "./runtime/validation.js";

export {
  SECRET_BYTES,
  COMMITMENT_PREFIX,
  COMMITMENT_HEX_LENGTH,
  MAX_TRIAL_INDEX,
  MAX_SEQUENCE_LENGTH,
  CommitmentInputError,
  createSecret,
  randomBit,
  secretToHex,
  secretFromHex,
  commitSecret,
  xSourceForIndex,
  xSequence,
  verifyReveal,
} from "./commitment.js";
