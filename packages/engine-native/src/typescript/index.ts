/**
 * Internal native codec execution boundary.
 *
 * This is package 1 of the shared-preparation stack. The next layer owns
 * alignment/gain/crop/PCM16 serialization/canary/scoring and public DTOs.
 */
export {
  NativeCodecExecutor,
  NativeCodecCleanupError,
  NATIVE_CODEC_MAX_SOURCE_BYTES,
  NATIVE_CODEC_MAX_DURATION_SECONDS,
  NATIVE_CODEC_MAX_RETAINED_PCM_BYTES,
  NATIVE_CODEC_MAX_ENCODED_BYTES,
  nativeSessionFrameBound,
} from "./executor.js";
export type {
  NativeBitrateBasis,
  NativeCodecExecuteOptions,
  NativeCodecExecutorOptions,
  NativeCodecRunResult,
  NativeCodecSource,
  NativeCodecStageResult,
  NativeCodecTrackResult,
  NativeEncodedRateSource,
} from "./executor.js";
export type {
  NativeCodecCapabilities,
  NativeCodecCapability,
} from "./capabilities.js";
export type { NativeBinaryOptions, NativeBinaryResolution } from "./binaries.js";
export { resolveNativeBinaries } from "./binaries.js";
export {
  assessNativeReadiness,
  formatNativeReadiness,
} from "./readiness.js";
export type {
  NativeReadinessCodec,
  NativeReadinessReport,
  NativeReadinessTool,
} from "./readiness.js";
export type {
  NativeProcessObservation,
  NativeProcessObserver,
  NativeSpawnCommand,
} from "./process.js";
export { resolveNativeSpawnCommand } from "./process.js";
/** Runtime-private supervision utility; never exposed through renderer IPC. */
export { hasLiveOwnedProcess } from "./process-group.js";
export {
  NATIVE_LDAC_DECODER_DISCLOSURE,
  nativeCodecEncodedChannels,
  nativeCodecInternalRate,
  nativeCodecPlan,
} from "./catalog.js";
export type { NativeCodecKind, NativeCodecPlan } from "./catalog.js";
export {
  NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE,
  parseFloat64Pcm,
  pcmDurationSeconds,
  scanPcm,
  serializeFloat64Pcm,
  validatePcmLayout,
} from "./pcm.js";
export {
  NATIVE_SOURCE_EXTENSIONS,
  NATIVE_SOURCE_FORMATS,
  acceptsProbedCodec,
  acceptsProbedContainer,
  resolveNativeSourceFormat,
} from "./source-format.js";
export type {
  NativeSourceFormat,
  NativeSourceFormatId,
} from "./source-format.js";

export {
  TypeScriptNativePreparationEngine,
  NATIVE_PREPARATION_MAX_RETAINED_BYTES,
  NATIVE_PREPARATION_MAX_SECONDS,
  NATIVE_PREPARATION_MIN_SECONDS,
  NATIVE_PREPARATION_POLICY,
} from "./preparation.js";
export type {
  NativePreparationExecutor,
  TypeScriptNativePreparationEngineOptions,
} from "./preparation.js";
export {
  NATIVE_SHARED_ENGINE_ID,
  NATIVE_SHARED_POLICY,
} from "./preparation-evidence.js";
export type { CanonicalPcm16WavFacts } from "./preparation-wav.js";
