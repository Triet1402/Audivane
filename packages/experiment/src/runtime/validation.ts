/**
 * Runtime-private artifact binding and verification.
 *
 * Shared aligned artifacts are accepted only with the current applied
 * preparation policy. Preparation identity, request, delivery reports,
 * null-gate facts and canary material are validated and frozen before any
 * trial can be staged. Raw/probe artifacts, unsupported policies and missing
 * metadata fail closed; there is no silent fallback or relabelling.
 */
import {
  freezeRequest, finalSelectionForSide, stagesForSide,
  type AudioDescription,
  type CanaryMaterialReport,
  type CanarySide,
  type DeliveredPairMeasurements,
  type DeliveredValidityV2,
  type LevelMeasurement,
  type PairPreparationReport,
  type PreparedArtifact,
  type PreparationGateDecision,
  type PreparationRequest,
} from "@codec-abx/contracts";
import {
  assessPairRelation,
  decodePcm16,
  measurePair,
  measureNullDepth,
  type PcmAudio,
} from "@codec-abx/measurements";
import {
  canaryExcerptFrames,
  evaluateCanaryDepth,
  evaluateNullGate,
  evaluatePreparationGate,
  PREPARATION_PROBE_SAMPLES,
} from "@codec-abx/preparation-policy";

import { ExperimentServiceError, serviceError } from "./errors.js";
import {
  MAX_DELIVERED_SECONDS,
  MAX_RETAINED_BYTES,
  copyByteBuffer,
  parseCanonicalPcm16Wav,
  requireSha256Hex,
  sha256Hex,
  wavPcmPayload,
  type CanonicalWavFacts,
} from "./wav.js";

const SERIALIZATION_FLOOR_BIAS = 2 ** -17;
const PEAK_CEILING = 32767 / 32768;
const REQUIRED_POLICY = "aligned-gain-matched-v1" as const;

/** Runtime-only binary readers supplied by the artifact owner. */
export interface ArtifactReaders {
  readAudio(artifactId: string, side: "a" | "b"): Promise<ArrayBuffer>;
  readCanaryAudio?(artifactId: string, side: CanarySide): Promise<ArrayBuffer>;
}

export interface PreparedIdentity {
  readonly artifactId: string;
  readonly aWavSha256: string;
  readonly bWavSha256: string;
  readonly sourceSha256: string;
  readonly engineId: string;
  readonly engineBuild: string;
  readonly request: PreparationRequest;
  readonly preparationLocation: "desktop-native" | "browser-local" | "optional-server";
}

export interface CanaryBinding {
  readonly report: CanaryMaterialReport;
  readonly pristine: AudioDescription;
  readonly degraded: AudioDescription;
  readonly usable: boolean;
  readonly servable: boolean;
  readonly reason: string | null;
}

export interface ValidatedArtifact {
  readonly id: string;
  readonly identity: PreparedIdentity;
  readonly factsA: CanonicalWavFacts;
  readonly factsB: CanonicalWavFacts;
  readonly nullGate: ReturnType<typeof evaluateNullGate>;
  readonly preparationGate: PreparationGateDecision;
  readonly canary: CanaryBinding | null;
  readonly canaryUnavailableReason: string | null;
}

function invalid(message: string): never {
  serviceError("artifact-invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < minimum || value > maximum) {
    invalid(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${label} must be finite`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be boolean`);
  return value;
}

function notes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((note) => typeof note !== "string")) {
    invalid(`${label} must be an array of strings`);
  }
  return Object.freeze([...(value as string[])]);
}

export function validateLevel(value: unknown, label: string): LevelMeasurement {
  const level = record(value, label);
  if (level.status === "finite") {
    const measured = finite(level.value, `${label}.value`);
    if (level.reason !== null) invalid(`${label} has a reason on a finite level`);
    return Object.freeze({ status: "finite", value: measured, reason: null });
  }
  if (level.status === "negative-infinity" ||
      level.status === "undefined" ||
      level.status === "unavailable") {
    if (level.value !== null) invalid(`${label} has a value on a non-finite level`);
    const reason = text(level.reason, `${label}.reason`);
    return Object.freeze({ status: level.status, value: null, reason });
  }
  return invalid(`${label} has an unknown status`);
}

function sameLevel(left: LevelMeasurement, right: LevelMeasurement): boolean {
  return left.status === right.status &&
    left.value === right.value &&
    left.reason === right.reason;
}

function validateAudioDescription(value: unknown, label: string): AudioDescription {
  const description = record(value, label);
  const sampleRate = integer(description.sampleRate, `${label}.sampleRate`, 1);
  const channels = description.channels;
  if (channels !== 1 && channels !== 2) invalid(`${label}.channels must be 1 or 2`);
  const frames = integer(description.frames, `${label}.frames`, 1);
  const wavSha256 = requireSha256Hex(description.wavSha256, `${label}.wavSha256`);
  return Object.freeze({ sampleRate, channels, frames, wavSha256 });
}

function validateAlignment(
  value: unknown,
  label: string,
  sampleRate: number,
): { readonly lagSamples: number; readonly maxLagSamples: number; readonly probeSamples: number } {
  const alignment = record(value, label);
  const lagSamples = integer(alignment.lagSamples, `${label}.lagSamples`, -Number.MAX_SAFE_INTEGER);
  const maxLagSamples = integer(alignment.maxLagSamples, `${label}.maxLagSamples`, 0);
  const probeSamples = integer(alignment.probeSamples, `${label}.probeSamples`, 2);
  if (alignment.status !== "estimated" && alignment.status !== "no-evidence") {
    invalid(`${label}.status is invalid`);
  }
  const confidence = finite(alignment.confidence, `${label}.confidence`);
  if (confidence < 0 || confidence > 1) invalid(`${label}.confidence must be in [0, 1]`);
  if (Math.abs(lagSamples) > maxLagSamples) invalid(`${label}.lagSamples exceeds maxLagSamples`);
  if (maxLagSamples !== Math.floor(0.1 * sampleRate)) {
    invalid(`${label}.maxLagSamples disagrees with the frozen 0.1 s bound`);
  }
  if (probeSamples !== PREPARATION_PROBE_SAMPLES) {
    invalid(`${label}.probeSamples disagrees with the frozen preparation probe`);
  }
  return { lagSamples, maxLagSamples, probeSamples };
}

function validatePreparationReport(
  value: unknown,
  factsA: CanonicalWavFacts,
  factsB: CanonicalWavFacts,
): PairPreparationReport {
  const report = record(value, "preparation report");
  if (report.policy !== REQUIRED_POLICY) {
    invalid("preparation report policy is not aligned-gain-matched-v1");
  }
  if (report.targetLufs !== -16) invalid("preparation targetLufs is not -16");
  if (report.minimumDurationSeconds !== 0.4) {
    invalid("preparation minimumDurationSeconds is not 0.4");
  }
  if (report.maxLagSeconds !== 0.1) invalid("preparation maxLagSeconds is not 0.1");
  if (finite(report.peakCeiling, "preparation peakCeiling") !== PEAK_CEILING) {
    invalid("preparation peakCeiling is not the frozen value");
  }
  const alignment = record(report.alignment, "preparation alignment");
  const validated = validateAlignment(alignment, "preparation alignment", factsA.sampleRate);
  const inputFramesA = integer(alignment.inputFramesA, "preparation inputFramesA", 1);
  const inputFramesB = integer(alignment.inputFramesB, "preparation inputFramesB", 1);
  const startFrameA = integer(alignment.startFrameA, "preparation startFrameA", 0);
  const startFrameB = integer(alignment.startFrameB, "preparation startFrameB", 0);
  const outputFrames = integer(alignment.outputFrames, "preparation outputFrames", 1);
  if (outputFrames !== factsA.frames || factsA.frames !== factsB.frames) {
    invalid("preparation outputFrames disagrees with the delivered A/B layouts");
  }
  if (startFrameA !== (validated.lagSamples < 0 ? -validated.lagSamples : 0) ||
      startFrameB !== (validated.lagSamples > 0 ? validated.lagSamples : 0)) {
    invalid("preparation start frames disagree with the applied lag");
  }
  if (outputFrames !== Math.min(inputFramesA - startFrameA, inputFramesB - startFrameB)) {
    invalid("preparation output disagrees with the full common crop");
  }
  if (factsA.sampleRate !== factsB.sampleRate ||
      factsA.channels !== factsB.channels ||
      factsA.frames !== factsB.frames) {
    invalid("delivered A/B layouts are not a matched pair");
  }

  const loudness = record(report.loudness, "preparation loudness");
  const preA = validateLevel(loudness.preA, "preparation loudness.preA");
  const preB = validateLevel(loudness.preB, "preparation loudness.preB");
  if (preA.status !== "finite" || preB.status !== "finite") {
    invalid("preparation loudness inputs must be finite");
  }
  const gainADb = finite(loudness.gainADb, "preparation gainADb");
  const gainBDb = finite(loudness.gainBDb, "preparation gainBDb");
  const commonTrimDb = finite(loudness.commonTrimDb, "preparation commonTrimDb");
  if (commonTrimDb < 0) invalid("preparation commonTrimDb must be nonnegative");
  if (gainADb !== -16 - preA.value || gainBDb !== -16 - preB.value) {
    invalid("preparation gains disagree with the frozen target and pre-gain loudness");
  }

  const serialization = record(report.serialization, "preparation serialization");
  if (serialization.format !== "pcm16-le" ||
      serialization.rounding !== "floor" ||
      serialization.dither !== false ||
      finite(serialization.floorBiasCodeSteps, "preparation floorBiasCodeSteps") !==
        SERIALIZATION_FLOOR_BIAS) {
    invalid("preparation serialization fields are not the frozen PCM16 policy");
  }

  return Object.freeze({
    policy: REQUIRED_POLICY,
    targetLufs: -16,
    minimumDurationSeconds: 0.4,
    maxLagSeconds: 0.1,
    peakCeiling: PEAK_CEILING,
    alignment: Object.freeze({
      lagSamples: validated.lagSamples,
      confidence: finite(alignment.confidence, "preparation alignment.confidence"),
      status: alignment.status as "estimated" | "no-evidence",
      maxLagSamples: validated.maxLagSamples,
      probeSamples: validated.probeSamples,
      inputFramesA,
      inputFramesB,
      startFrameA,
      startFrameB,
      outputFrames,
    }),
    loudness: Object.freeze({
      preA,
      preB,
      gainADb,
      gainBDb,
      commonTrimDb,
    }),
    serialization: Object.freeze({
      format: "pcm16-le",
      rounding: "floor",
      floorBiasCodeSteps: SERIALIZATION_FLOOR_BIAS,
      dither: false,
    }),
    notes: notes(report.notes, "preparation notes"),
  });
}

function validateDelivered(
  value: unknown,
  factsA: CanonicalWavFacts,
  factsB: CanonicalWavFacts,
  measuredNull: ReturnType<typeof measureNullDepth>,
  preparation: { readonly alignment: Pick<PairPreparationReport["alignment"], "maxLagSamples" | "probeSamples"> },
  measured: DeliveredPairMeasurements,
): DeliveredPairMeasurements {
  const delivered = record(value, "delivered measurements");
  if (delivered.policy !== "delivered-pcm-measurements-v1") {
    invalid("delivered measurements have an unknown policy");
  }
  for (const [key, facts, label] of [
    ["a", factsA, "delivered.a"],
    ["b", factsB, "delivered.b"],
  ] as const) {
    const summary = record(delivered[key], label);
    if (summary.sampleRate !== facts.sampleRate ||
        summary.channels !== facts.channels ||
        summary.frames !== facts.frames) {
      invalid(`${label} layout disagrees with the delivered WAV`);
    }
    const measuredSummary = measured[key];
    if (!sameLevel(validateLevel(summary.integratedLufs, `${label}.integratedLufs`), measuredSummary.integratedLufs) ||
        !sameLevel(validateLevel(summary.samplePeakDbfs, `${label}.samplePeakDbfs`), measuredSummary.samplePeakDbfs)) {
      invalid(`${label} levels disagree with the independently measured delivery`);
    }
  }
  const alignment = validateAlignment(delivered.alignment, "delivered.alignment", factsA.sampleRate);
  if (alignment.maxLagSamples !== preparation.alignment.maxLagSamples ||
      alignment.probeSamples !== preparation.alignment.probeSamples) {
    invalid("delivered alignment bounds disagree with the preparation report");
  }
  if (!sameLevel(validateLevel(delivered.loudnessDeltaDb, "delivered.loudnessDeltaDb"), measured.loudnessDeltaDb)) {
    invalid("delivered loudness delta disagrees with the independently measured delivery");
  }
  const declaredAlignment = record(delivered.alignment, "delivered.alignment");
  if (alignment.lagSamples !== measured.alignment.lagSamples ||
      declaredAlignment.confidence !== measured.alignment.confidence ||
      declaredAlignment.status !== measured.alignment.status) {
    invalid("delivered residual alignment disagrees with the independently measured delivery");
  }
  const nullDepth = record(delivered.nullDepth, "delivered.nullDepth");
  if (nullDepth.basis !== "unshifted-common-prefix" ||
      nullDepth.comparedFrames !== measuredNull.comparedFrames) {
    invalid("delivered null-depth basis/coverage disagrees with an independent measurement");
  }
  const declaredNull = validateLevel(nullDepth.depthDb, "delivered.nullDepth.depthDb");
  if (!sameLevel(declaredNull, measuredNull.depthDb)) {
    invalid("delivered null depth disagrees with the delivered WAV bytes");
  }
  return Object.freeze({
    policy: "delivered-pcm-measurements-v1",
    a: Object.freeze({
      sampleRate: factsA.sampleRate,
      channels: factsA.channels,
      frames: factsA.frames,
      integratedLufs: validateLevel(
        record(delivered.a, "delivered.a").integratedLufs,
        "delivered.a.integratedLufs",
      ),
      samplePeakDbfs: validateLevel(
        record(delivered.a, "delivered.a").samplePeakDbfs,
        "delivered.a.samplePeakDbfs",
      ),
    }),
    b: Object.freeze({
      sampleRate: factsB.sampleRate,
      channels: factsB.channels,
      frames: factsB.frames,
      integratedLufs: validateLevel(
        record(delivered.b, "delivered.b").integratedLufs,
        "delivered.b.integratedLufs",
      ),
      samplePeakDbfs: validateLevel(
        record(delivered.b, "delivered.b").samplePeakDbfs,
        "delivered.b.samplePeakDbfs",
      ),
    }),
    alignment: Object.freeze({
      lagSamples: alignment.lagSamples,
      confidence: finite(
        record(delivered.alignment, "delivered.alignment").confidence,
        "delivered.alignment.confidence",
      ),
      status: record(delivered.alignment, "delivered.alignment").status as
        "estimated" | "no-evidence",
      maxLagSamples: alignment.maxLagSamples,
      probeSamples: alignment.probeSamples,
    }),
    loudnessDeltaDb: validateLevel(delivered.loudnessDeltaDb, "delivered.loudnessDeltaDb"),
    nullDepth: Object.freeze({
      basis: "unshifted-common-prefix" as const,
      comparedFrames: measuredNull.comparedFrames,
      depthDb: declaredNull,
    }),
    notes: notes(delivered.notes, "delivered notes"),
  });
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) => sameJsonValue(left[key], right[key]));
}

function validateValidity(
  value: unknown,
  request: PreparationRequest,
  measuredNull: ReturnType<typeof measureNullDepth>,
  preparationGate: PreparationGateDecision,
): DeliveredValidityV2 {
  const validity = record(value, "validity report");
  if (validity.policy === "delivered-validity-v1") {
    invalid(
      "historical delivered-validity-v1 data is schema-valid but is not authorized " +
      "for scored binding; re-prepare with delivered-validity-v2",
    );
  }
  if (validity.policy !== "delivered-validity-v2") {
    invalid("validity report has an unknown policy");
  }
  if (Object.keys(validity).some((key) =>
    !["policy", "nullGate", "preparationGate", "notes"].includes(key))) {
    invalid("validity report has an unexpected field");
  }
  const gate = record(validity.nullGate, "validity null gate");
  if (Object.keys(gate).some((key) =>
    !["policy", "expectedIdentical", "thresholdDb", "depthDb", "status", "reason"].includes(key))) {
    invalid("validity null gate has an unexpected field");
  }
  if (gate.policy !== "identical-pipeline-null-v1") {
    invalid("validity null gate has an unknown policy");
  }
  const expected = evaluateNullGate(request, measuredNull.depthDb);
  const declaredDepth = validateLevel(gate.depthDb, "validity null gate depth");
  if (gate.expectedIdentical !== expected.expectedIdentical ||
      gate.thresholdDb !== expected.thresholdDb ||
      gate.status !== expected.status ||
      gate.reason !== expected.reason ||
      !sameLevel(declaredDepth, expected.depthDb)) {
    invalid("published null decision disagrees with the request and delivered depth");
  }
  const declaredPreparation = record(validity.preparationGate, "validity preparation gate");
  if (!sameJsonValue(declaredPreparation, preparationGate)) {
    invalid(
      "published preparation gate disagrees with the frozen gate re-evaluated " +
      "from the exact served A/B bytes",
    );
  }
  return Object.freeze({
    policy: "delivered-validity-v2",
    nullGate: expected,
    preparationGate,
    notes: notes(validity.notes, "validity notes"),
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function decode(bytes: Uint8Array, facts: CanonicalWavFacts): PcmAudio {
  return decodePcm16(bytes, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
}

function requireDescriptionMatch(
  description: AudioDescription,
  facts: CanonicalWavFacts,
  label: string,
): void {
  if (description.sampleRate !== facts.sampleRate ||
      description.channels !== facts.channels ||
      description.frames !== facts.frames) {
    invalid(`${label} layout description disagrees with the serialized bytes`);
  }
}

async function readVerifiedSide(
  readers: ArtifactReaders,
  artifactId: string,
  side: "a" | "b",
  description: AudioDescription,
  maxDurationSeconds: number,
): Promise<{ readonly bytes: Uint8Array; readonly facts: CanonicalWavFacts }> {
  let value: ArrayBuffer;
  try {
    value = await readers.readAudio(artifactId, side);
  } catch {
    throw new ExperimentServiceError(
      "artifact-reader-unavailable",
      `Prepared audio reader failed for side ${side}`,
    );
  }
  const bytes = copyByteBuffer(value, `Side ${side}`);
  const facts = parseCanonicalPcm16Wav(bytes);
  if (facts.durationSeconds > maxDurationSeconds) {
    invalid(`Side ${side} exceeds the ${maxDurationSeconds} s runtime bound`);
  }
  requireDescriptionMatch(description, facts, `Side ${side}`);
  const hash = await sha256Hex(bytes);
  if (hash !== description.wavSha256) {
    serviceError("artifact-bytes-mismatch", `Side ${side} bytes do not match their described SHA-256`);
  }
  return { bytes, facts };
}

async function bindCanary(
  artifact: PreparedArtifact,
  readers: ArtifactReaders,
  factsA: CanonicalWavFacts,
  aBytes: Uint8Array,
): Promise<{
  binding: CanaryBinding | null;
  unavailableReason: string | null;
  retainedBytes: number;
}> {
  if (artifact.canary === undefined) {
    return {
      binding: null,
      unavailableReason: "prepared artifact has no canary material",
      retainedBytes: 0,
    };
  }
  const raw = record(artifact.canary, "artifact canary");
  const reportRecord = record(raw.report, "artifact canary report");
  if (reportRecord.policy !== "delivered-canary-v1" ||
      reportRecord.cutoffHz !== 3000 ||
      reportRecord.frequencyGrid !== "numpy-rfftfreq-v1" ||
      reportRecord.drive !== 10 ||
      reportRecord.clipLevel !== 0.45 ||
      reportRecord.minimumResidualDb !== -30) {
    invalid("artifact canary report fields are not the frozen delivered-canary-v1 policy");
  }
  if (reportRecord.status !== "usable" && reportRecord.status !== "not-usable") {
    invalid("artifact canary report has an unknown status");
  }
  const declaredDepth = validateLevel(reportRecord.depthDb, "artifact canary depth");
  const decision = evaluateCanaryDepth(declaredDepth);
  if (reportRecord.status !== decision.status ||
      reportRecord.usable !== decision.usable ||
      reportRecord.reason !== decision.reason ||
      reportRecord.minimumResidualDb !== decision.minimumResidualDb) {
    invalid("artifact canary decision disagrees with its declared delivered depth");
  }
  // The frozen canary DSP is bounded to ten seconds. Long delivered Side A uses
  // exactly its FIRST ten seconds; short material remains its full extent.
  const excerptFrames = canaryExcerptFrames(factsA.sampleRate, factsA.frames);
  if (reportRecord.sampleRate !== factsA.sampleRate ||
      reportRecord.channels !== factsA.channels ||
      reportRecord.frames !== excerptFrames) {
    invalid("artifact canary layout disagrees with the final delivered Side A calibration prefix");
  }
  const report: CanaryMaterialReport = Object.freeze({
    ...decision,
    policy: "delivered-canary-v1",
    cutoffHz: 3000,
    frequencyGrid: "numpy-rfftfreq-v1",
    drive: 10,
    clipLevel: 0.45,
    sampleRate: factsA.sampleRate,
    channels: factsA.channels,
    frames: excerptFrames,
    notes: notes(reportRecord.notes, "artifact canary notes"),
  });

  if (!decision.usable) {
    if (raw.audio !== null && raw.audio !== undefined) {
      invalid("unusable canary material must not retain audio descriptions");
    }
    return {
      binding: {
        report,
        pristine: Object.freeze({
          sampleRate: factsA.sampleRate,
          channels: factsA.channels,
          frames: excerptFrames,
          wavSha256: "0".repeat(64),
        }),
        degraded: Object.freeze({
          sampleRate: factsA.sampleRate,
          channels: factsA.channels,
          frames: excerptFrames,
          wavSha256: "0".repeat(64),
        }),
        usable: false,
        servable: false,
        reason: decision.reason,
      },
      unavailableReason: decision.reason,
      retainedBytes: 0,
    };
  }

  if (raw.audio === null || raw.audio === undefined) {
    const reason = "usable canary material is missing its retained audio descriptions/bytes";
    return {
      binding: {
        report,
        pristine: Object.freeze({
          sampleRate: factsA.sampleRate,
          channels: factsA.channels,
          frames: excerptFrames,
          wavSha256: "0".repeat(64),
        }),
        degraded: Object.freeze({
          sampleRate: factsA.sampleRate,
          channels: factsA.channels,
          frames: excerptFrames,
          wavSha256: "0".repeat(64),
        }),
        usable: true,
        servable: false,
        reason,
      },
      unavailableReason: reason,
      retainedBytes: 0,
    };
  }
  const audio = record(raw.audio, "artifact canary audio");
  const pristine = validateAudioDescription(audio.pristine, "artifact canary pristine");
  const degraded = validateAudioDescription(audio.degraded, "artifact canary degraded");
  for (const [label, description] of [
    ["pristine", pristine],
    ["degraded", degraded],
  ] as const) {
    if (description.sampleRate !== report.sampleRate ||
        description.channels !== report.channels ||
        description.frames !== report.frames) {
      invalid(`artifact canary ${label} layout disagrees with its report`);
    }
  }

  if (typeof readers.readCanaryAudio !== "function") {
    return {
      binding: {
        report,
        pristine,
        degraded,
        usable: true,
        servable: false,
        reason: "canary material is usable but the artifact owner supplied no canary reader",
      },
      unavailableReason:
        "canary material is usable but the artifact owner supplied no canary reader",
      retainedBytes: 0,
    };
  }

  const read = async (side: CanarySide): Promise<Uint8Array> => {
    let value: ArrayBuffer;
    try {
      value = await readers.readCanaryAudio!(artifact.id, side);
    } catch {
      throw new ExperimentServiceError(
        "artifact-reader-unavailable",
        `Prepared canary reader failed for ${side}`,
      );
    }
    return copyByteBuffer(value, `Canary ${side}`);
  };

  let pristineBytes: Uint8Array;
  let degradedBytes: Uint8Array;
  try {
    [pristineBytes, degradedBytes] = await Promise.all([read("pristine"), read("degraded")]);
  } catch (error) {
    if (error instanceof ExperimentServiceError) {
      return {
        binding: {
          report,
          pristine,
          degraded,
          usable: true,
          servable: false,
          reason: error.message,
        },
        unavailableReason: error.message,
        retainedBytes: 0,
      };
    }
    throw error;
  }
  const pristineFacts = parseCanonicalPcm16Wav(pristineBytes);
  const degradedFacts = parseCanonicalPcm16Wav(degradedBytes);
  for (const [label, facts, description] of [
    ["pristine", pristineFacts, pristine],
    ["degraded", degradedFacts, degraded],
  ] as const) {
    if (facts.sampleRate !== report.sampleRate ||
        facts.channels !== report.channels ||
        facts.frames !== report.frames) {
      invalid(`artifact canary ${label} bytes disagree with its report layout`);
    }
    requireDescriptionMatch(description, facts, `artifact canary ${label}`);
    const hash = await sha256Hex(label === "pristine" ? pristineBytes : degradedBytes);
    if (hash !== description.wavSha256) {
      serviceError(
        "artifact-bytes-mismatch",
        `Canary ${label} bytes do not match their described SHA-256`,
      );
    }
  }
  // Pristine calibration material must be the exact FIRST prefix of the
  // delivered Side A, not merely the same length or an arbitrary excerpt.
  const sideAPrefix = aBytes.subarray(
    factsA.dataOffset,
    factsA.dataOffset + excerptFrames * factsA.channels * 2,
  );
  if (!sameBytes(wavPcmPayload(pristineBytes, pristineFacts), sideAPrefix)) {
    invalid(
      "artifact canary pristine PCM is not the exact FIRST calibration prefix " +
        "of the delivered Side A",
    );
  }
  const measured = measureNullDepth(decode(pristineBytes, pristineFacts), decode(degradedBytes, degradedFacts));
  const measuredDecision = evaluateCanaryDepth(measured.depthDb);
  if (!sameLevel(measured.depthDb, decision.depthDb) ||
      measuredDecision.status !== decision.status ||
      measuredDecision.usable !== decision.usable ||
      measuredDecision.reason !== decision.reason) {
    invalid("artifact canary report depth disagrees with its retained bytes");
  }

  return {
    binding: {
      report,
      pristine,
      degraded,
      usable: true,
      servable: true,
      reason: null,
    },
    unavailableReason: null,
    retainedBytes: pristineBytes.byteLength + degradedBytes.byteLength,
  };
}

/**
 * Validate a prepared artifact and independently verify the exact serialized
 * bytes the reader returns. The caller's artifact/readers are never retained.
 */
export async function validatePreparedArtifact(
  value: PreparedArtifact,
  readers: ArtifactReaders,
): Promise<ValidatedArtifact> {
  if (!isRecord(value)) invalid("prepared artifact must be an object");
  if (value.purpose !== "diagnostic-only") {
    invalid("only diagnostic-only prepared artifacts are accepted");
  }
  const id = text(value.id, "artifact id");
  if (typeof readers?.readAudio !== "function") {
    serviceError("artifact-reader-unavailable", "prepared artifact has no audio reader");
  }
  let request: PreparationRequest;
  try {
    request = freezeRequest(value.request);
  } catch (error) {
    invalid(`artifact request is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (request.preparationPolicy !== REQUIRED_POLICY) {
    invalid("only aligned-gain-matched-v1 artifacts are accepted");
  }
  for (const side of ["a", "b"] as const) {
    const track = record(value[side], `artifact ${side}`);
    if (Object.keys(track).some(key => !["requested", "encoder", "decoder", "actualBitrateKbps", "encodedSampleRate", "delivered", "stages"].includes(key))) invalid(`artifact ${side} provenance has unexpected fields`);
    const requested = record(track.requested, `artifact ${side}.requested`);
    if (Object.keys(requested).some(key => !["codecId", "bitrateKbps"].includes(key))) invalid(`artifact ${side} requested provenance has unexpected fields`);
    const final = finalSelectionForSide(request, side);
    if (requested.codecId !== final.codecId || requested.bitrateKbps !== final.bitrateKbps) {
      invalid(`artifact ${side} provenance disagrees with the frozen request`);
    }
    const requestedStages = stagesForSide(request, side);
    const validateImplementation = (entry: Record<string, unknown>, label: string): void => {
      text(entry.encoder, `${label}.encoder`); text(entry.decoder, `${label}.decoder`);
      if (entry.actualBitrateKbps !== null && (typeof entry.actualBitrateKbps !== "number" || !Number.isFinite(entry.actualBitrateKbps) || entry.actualBitrateKbps <= 0)) invalid(`${label} actual bitrate is invalid`);
      if (entry.encodedSampleRate !== null) integer(entry.encodedSampleRate, `${label}.encodedSampleRate`, 1);
    };
    validateImplementation(track, `artifact ${side}`);
    if (request.version === 2 || track.stages !== undefined) {
      if (!Array.isArray(track.stages) || track.stages.length !== requestedStages.length) invalid(`artifact ${side} stage provenance count disagrees with the frozen request`);
      for (let i = 0; i < requestedStages.length; i++) {
        const stage = record(track.stages[i], `artifact ${side} stage ${i + 1}`);
        if (Object.keys(stage).some(key => !["stageIndex", "requested", "encoder", "decoder", "actualBitrateKbps", "encodedSampleRate"].includes(key))) invalid(`artifact ${side} stage provenance has unexpected fields`);
        const selected = record(stage.requested, `artifact ${side} stage requested`);
        if (Object.keys(selected).some(key => !["codecId", "bitrateKbps"].includes(key))) invalid(`artifact ${side} stage requested provenance has unexpected fields`);
        const expected = requestedStages[i]!;
        if (stage.stageIndex !== i + 1 || selected.codecId !== expected.codecId || selected.bitrateKbps !== expected.bitrateKbps) invalid(`artifact ${side} ordered stage provenance disagrees with the frozen request`);
        validateImplementation(stage, `artifact ${side} stage ${i + 1}`);
        if (i === requestedStages.length - 1 && ["encoder", "decoder", "actualBitrateKbps", "encodedSampleRate"].some(key => track[key] !== stage[key])) invalid(`artifact ${side} final summary disagrees with stage provenance`);
      }
    }
  }
  if (value.canary !== undefined && request.canaryEnabled !== true) {
    invalid("artifact canary material requires explicit preparation opt-in");
  }
  const engine = record(value.engine, "artifact engine");
  const engineId = text(engine.engineId, "artifact engine id");
  const engineBuild = text(engine.build, "artifact engine build");
  if (engine.location !== "desktop-native" &&
      engine.location !== "browser-local" &&
      engine.location !== "optional-server") {
    invalid("artifact engine location is invalid");
  }
  const sourceSha256 = requireSha256Hex(value.sourceSha256, "artifact sourceSha256");
  const descriptionA = validateAudioDescription(value.a?.delivered, "artifact a.delivered");
  const descriptionB = validateAudioDescription(value.b?.delivered, "artifact b.delivered");
  if (request.sampleRateMode === "force_48k" &&
      (descriptionA.sampleRate !== 48000 || descriptionB.sampleRate !== 48000)) {
    invalid("forced 48 kHz request disagrees with the delivered layout");
  }

  const sideA = await readVerifiedSide(readers, id, "a", descriptionA, MAX_DELIVERED_SECONDS);
  const sideB = await readVerifiedSide(readers, id, "b", descriptionB, MAX_DELIVERED_SECONDS);
  if (sideA.bytes.byteLength + sideB.bytes.byteLength > MAX_RETAINED_BYTES) {
    invalid(`delivered pair exceeds the ${MAX_RETAINED_BYTES} byte verification bound`);
  }
  const preparation = validatePreparationReport(value.preparation, sideA.facts, sideB.facts);
  // Decode the exact served pair once and reuse it for both independent
  // measurements. Keeping two full-length decodes alive is avoidable memory for
  // ten-minute material and changes no measurement.
  const deliveredA = decode(sideA.bytes, sideA.facts);
  const deliveredB = decode(sideB.bytes, sideB.facts);
  const measured = measurePair(deliveredA, deliveredB, {
    maxLagSamples: preparation.alignment.maxLagSamples,
    probeSamples: preparation.alignment.probeSamples,
  });
  const measuredNull = measured.nullDepth;
  // The preparation gate is recomputed from the exact served decoded bytes,
  // never trusted from the producer's reported confidence or status.
  const relation = assessPairRelation(
    deliveredA,
    deliveredB,
    {
      maxLagSamples: Math.floor(0.1 * sideA.facts.sampleRate),
      probeSamples: PREPARATION_PROBE_SAMPLES,
    },
  );
  const preparationGate = evaluatePreparationGate(relation);
  const delivered = validateDelivered(
    value.measurements?.delivered,
    sideA.facts,
    sideB.facts,
    measuredNull,
    preparation,
    measured,
  );
  const summaryDepth = value.measurements.nullDepthDb;
  if (delivered.nullDepth.depthDb.status === "finite") {
    if (summaryDepth !== delivered.nullDepth.depthDb.value) {
      invalid("artifact measurement summary nullDepthDb disagrees with the delivered measurement");
    }
  } else if (summaryDepth !== null) {
    invalid("non-finite delivered null depth must be published as a null summary");
  }
  if (value.measurements.alignmentLagSamples !== delivered.alignment.lagSamples ||
      value.measurements.alignmentConfidence !== delivered.alignment.confidence ||
      value.measurements.loudnessDeltaDb !== (delivered.loudnessDeltaDb.status === "finite"
        ? delivered.loudnessDeltaDb.value : null)) {
    invalid("artifact legacy measurement summaries disagree with the delivered measurements");
  }
  const validity = validateValidity(
    value.validity,
    request,
    measuredNull,
    preparationGate,
  );

  const canary = await bindCanary(value, readers, sideA.facts, sideA.bytes);
  if (sideA.bytes.byteLength + sideB.bytes.byteLength + canary.retainedBytes >
      MAX_RETAINED_BYTES) {
    invalid(`verified artifact bytes exceed the ${MAX_RETAINED_BYTES} byte bound`);
  }

  return Object.freeze({
    id,
    identity: Object.freeze({
      artifactId: id,
      aWavSha256: descriptionA.wavSha256,
      bWavSha256: descriptionB.wavSha256,
      sourceSha256,
      engineId,
      engineBuild,
      request,
      preparationLocation: engine.location,
    }),
    factsA: sideA.facts,
    factsB: sideB.facts,
    nullGate: validity.nullGate,
    preparationGate: validity.preparationGate,
    canary: canary.binding,
    canaryUnavailableReason: canary.unavailableReason,
  });
}

