/**
 * @codec-abx/measurements
 *
 * Pure synchronous numerical measurements of delivered planar float PCM.
 * No Node or browser globals, no network and no mutation of caller arrays, so
 * the same code runs in Node tests and a dedicated browser worker.
 *
 * Public surface:
 * - parseCanonicalPcm16WavStructure(bytes): strict structural facts for the
 *   shared canonical 44-byte PCM16 envelope; callers own bounds and errors.
 * - decodePcm16(bytes, layout): strict little-endian interleaved PCM16 -> PcmAudio.
 * - measurePair(a, b, options?): the shared DeliveredPairMeasurements contract.
 * - assessPairRelation(a, b, options?): frozen pair-relation-v1 same/inverted,
 *   AC RMS, probe bounds and peak evidence without changing the pair.
 * - estimateLag / integratedLoudness / samplePeakDbfs / measureNullDepth:
 *   individual measurements for tests and callers.
 *
 * Alignment matches core.alignment.estimate_lag; loudness matches the installed
 * pyloudnorm.Meter default K-weighting and gating; peak is sample peak (never
 * oversampled true peak); null depth uses the unshifted common prefix.
 */
export type {
  AlignmentMeasurement,
  NullMeasurement,
  PairMeasurementOptions,
  PairRelationReport,
  Pcm16Layout,
  PcmAudio,
  RelationAcRms,
  RelationHypothesis,
  RelationPeak,
} from "./types.js";
export {
  DEFAULT_MAX_LAG_SAMPLES,
  DEFAULT_PROBE_SAMPLES,
  SUPPORTED_SAMPLE_RATES,
} from "./types.js";

export {
  CANONICAL_PCM16_HEADER_BYTES,
  CanonicalPcm16WavStructureError,
  parseCanonicalPcm16WavStructure,
  type CanonicalPcm16WavFacts,
  type CanonicalPcm16WavProblem,
} from "./wav.js";
export { decodePcm16 } from "./pcm.js";
export { estimateLag } from "./alignment.js";
export {
  assessPairRelation,
  PAIR_RELATION_CENTERING,
  PAIR_RELATION_MAX_REPORTED_PEAKS,
  PAIR_RELATION_POLICY_ID,
} from "./relation.js";
export { integratedLoudness } from "./loudness.js";
export { samplePeakDbfs } from "./peak.js";
export { measureNullDepth } from "./null.js";
export { measurePair } from "./pair.js";
