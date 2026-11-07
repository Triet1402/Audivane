import type {
  AudioDescription,
  CanaryMaterialReport,
  CanarySide,
  LevelMeasurement,
  PairValidityReport,
  PreparationGateDecision,
  PreparationRequest,
} from "@codec-abx/contracts";
import type { PairRelationReport } from "@codec-abx/measurements";
import { decodePcm16, measureNullDepth } from "@codec-abx/measurements";
import {
  assertPreparationGateDecision,
  canaryExcerptFrames,
  evaluateCanaryDepth,
  evaluateNullGate,
  evaluatePreparationGate,
} from "@codec-abx/preparation-policy";

import {
  parsePcm16Wav,
  sha256Hex,
  wavDescription,
  type WavFacts,
} from "./wav.js";

/** Worker-owned canary bytes plus descriptions of the exact served buffers. */
export interface ValidatedCanary {
  readonly report: CanaryMaterialReport;
  readonly audio: Readonly<Record<CanarySide, AudioDescription>> | null;
  readonly bytes: Readonly<Record<CanarySide, Uint8Array>> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

/** Exact data equality for the JSON-safe frozen gate DTO. */
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => sameData(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
  }
  return false;
}

function sameLevel(actual: LevelMeasurement, expected: LevelMeasurement): boolean {
  return actual.status === expected.status && actual.value === expected.value &&
    actual.reason === expected.reason;
}

function notes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((note) => typeof note !== "string")) {
    throw new Error(`${label} returned invalid notes`);
  }
  return value as string[];
}

/**
 * Recompute the frozen identical-pipeline decision from the validated request
 * and the delivered measurement. The worker's status, applicability, level and
 * reason must all agree exactly; a corrupted decision cannot be published.
 */
export function assertValidityReport(
  value: unknown,
  request: PreparationRequest,
  deliveredDepth: LevelMeasurement,
  relation: PairRelationReport,
): PairValidityReport {
  if (!isRecord(value) || value.policy !== "delivered-validity-v2") {
    throw new Error("Preparation worker returned an invalid delivered-validity-v2 report");
  }
  exactKeys(
    value,
    ["policy", "nullGate", "preparationGate", "notes"],
    "delivered-validity-v2 report",
  );
  if (!isRecord(value.nullGate)) {
    throw new Error("Preparation worker returned an invalid null gate");
  }
  exactKeys(
    value.nullGate,
    ["policy", "expectedIdentical", "thresholdDb", "depthDb", "status", "reason"],
    "delivered-validity-v2 null gate",
  );
  const gate = value.nullGate;
  if (gate.policy !== "identical-pipeline-null-v1" ||
      typeof gate.expectedIdentical !== "boolean" || gate.thresholdDb !== -60 ||
      (gate.status !== "passed" && gate.status !== "failed" &&
        gate.status !== "not-applicable") ||
      typeof gate.reason !== "string" || gate.reason.length === 0) {
    throw new Error("Preparation worker returned invalid null-gate fields");
  }
  const expected = evaluateNullGate(request, deliveredDepth);
  const actualDepth = gate.depthDb as LevelMeasurement;
  if (gate.expectedIdentical !== expected.expectedIdentical ||
      gate.thresholdDb !== expected.thresholdDb || gate.status !== expected.status ||
      gate.reason !== expected.reason ||
      !isRecord(actualDepth) || !sameLevel(actualDepth, expected.depthDb)) {
    throw new Error(
      "Preparation worker returned a null decision inconsistent with the frozen request " +
      "and delivered null depth",
    );
  }

  // The worker is the only place FFT work runs. The main thread validates the
  // exact gate DTO and re-evaluates the pure classification from the worker's
  // final relation evidence; a forged or stale decision cannot be published.
  assertPreparationGateDecision(value.preparationGate);
  const declared = value.preparationGate as unknown as PreparationGateDecision;
  const expectedPreparationGate = evaluatePreparationGate(relation);
  if (!sameData(declared, expectedPreparationGate)) {
    throw new Error(
      "Preparation worker returned a preparation gate inconsistent with its final relation evidence",
    );
  }
  return {
    policy: "delivered-validity-v2",
    nullGate: expected,
    preparationGate: expectedPreparationGate,
    notes: notes(value.notes, "Delivered-validity report"),
  };
}

function pcmPayload(bytes: Uint8Array, facts: WavFacts): Uint8Array {
  return bytes.slice(facts.dataOffset, facts.dataOffset + facts.dataSize);
}

/** Linear boundary check only: no FFT, gain or second preparation on the UI thread. */
export function assertDeliveredNullDepth(
  declared: LevelMeasurement,
  aBytes: Uint8Array,
  aFacts: WavFacts,
  bBytes: Uint8Array,
  bFacts: WavFacts,
): void {
  const decode = (bytes: Uint8Array, facts: WavFacts) => decodePcm16(bytes, {
    sampleRate: facts.sampleRate, channels: facts.channels,
    dataOffset: facts.dataOffset, dataSize: facts.dataSize,
  });
  const measured = measureNullDepth(decode(aBytes, aFacts), decode(bBytes, bFacts));
  if (!sameLevel(declared, measured.depthDb)) {
    throw new Error("Preparation worker returned null depth inconsistent with its delivered WAV bytes");
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function assertCanaryReport(
  value: unknown,
  finalAFacts: WavFacts,
): {
  readonly report: CanaryMaterialReport;
  readonly usable: boolean;
  readonly excerptFrames: number;
} {
  if (!isRecord(value) || !isRecord(value.report)) {
    throw new Error("Preparation worker returned invalid canary material");
  }
  const report = value.report;
  if (report.policy !== "delivered-canary-v1" || report.cutoffHz !== 3000 ||
      report.frequencyGrid !== "numpy-rfftfreq-v1" || report.drive !== 10 ||
      report.clipLevel !== 0.45 ||
      (report.status !== "usable" && report.status !== "not-usable") ||
      typeof report.usable !== "boolean" || report.minimumResidualDb !== -30 ||
      typeof report.reason !== "string" || report.reason.length === 0 ||
      typeof report.sampleRate !== "number" || !Number.isInteger(report.sampleRate) ||
      (report.channels !== 1 && report.channels !== 2) ||
      typeof report.frames !== "number" || !Number.isSafeInteger(report.frames) ||
      report.frames <= 0) {
    throw new Error("Preparation worker returned invalid canary report fields");
  }
  const decision = evaluateCanaryDepth(report.depthDb as LevelMeasurement);
  if (report.status !== decision.status || report.usable !== decision.usable ||
      report.minimumResidualDb !== decision.minimumResidualDb ||
      report.reason !== decision.reason ||
      !sameLevel(report.depthDb as LevelMeasurement, decision.depthDb)) {
    throw new Error("Preparation worker returned an inconsistent canary depth decision");
  }
  const excerptFrames = canaryExcerptFrames(finalAFacts.sampleRate, finalAFacts.frames);
  if (report.sampleRate !== finalAFacts.sampleRate ||
      report.channels !== finalAFacts.channels || report.frames !== excerptFrames) {
    throw new Error(
      "Canary report layout disagrees with the final delivered Side A calibration prefix",
    );
  }
  return {
    report: {
      ...decision,
      policy: "delivered-canary-v1",
      cutoffHz: 3000,
      frequencyGrid: "numpy-rfftfreq-v1",
      drive: 10,
      clipLevel: 0.45,
      sampleRate: finalAFacts.sampleRate,
      channels: finalAFacts.channels,
      frames: excerptFrames,
      notes: notes(report.notes, "Canary report"),
    },
    usable: decision.usable,
    excerptFrames,
  };
}

/**
 * Fail closed on canary material. Usable material must carry both transferred
 * WAVs with the final Side A layout and an independently remeasured depth;
 * unusable material must carry no served bytes. Hashes cover the exact
 * transferred bytes, and pristine PCM must equal the delivered Side A payload.
 */
export async function assertCanaryMaterial(
  value: unknown,
  finalABytes: Uint8Array,
  finalAFacts: WavFacts,
): Promise<ValidatedCanary | null> {
  if (value === undefined) return null;
  const { report, usable, excerptFrames } = assertCanaryReport(value, finalAFacts);
  const material = value as Record<string, unknown>;
  const pristineValue = material.pristine;
  const degradedValue = material.degraded;

  if (!usable) {
    if ((pristineValue !== null && pristineValue !== undefined) ||
        (degradedValue !== null && degradedValue !== undefined)) {
      throw new Error("Unusable canary material must not retain or serve WAV bytes");
    }
    return { report, audio: null, bytes: null };
  }

  if (!(pristineValue instanceof ArrayBuffer) || !(degradedValue instanceof ArrayBuffer)) {
    throw new Error("Usable canary material is missing its transferred WAV buffers");
  }
  const pristineBytes = new Uint8Array(pristineValue);
  const degradedBytes = new Uint8Array(degradedValue);
  const pristineFacts = parsePcm16Wav(pristineBytes);
  const degradedFacts = parsePcm16Wav(degradedBytes);
  for (const [label, facts] of [
    ["pristine", pristineFacts],
    ["degraded", degradedFacts],
  ] as const) {
    if (facts.sampleRate !== report.sampleRate || facts.channels !== report.channels ||
        facts.frames !== report.frames) {
      throw new Error(`Canary ${label} WAV layout disagrees with its report and Side A`);
    }
  }
  // Long tracks calibrate on exactly the FIRST ten seconds of Side A. The
  // pristine payload must be that exact prefix, never a suffix or other excerpt.
  const finalAPrefix = finalABytes.subarray(
    finalAFacts.dataOffset,
    finalAFacts.dataOffset + excerptFrames * finalAFacts.channels * 2,
  );
  if (!sameBytes(pcmPayload(pristineBytes, pristineFacts), finalAPrefix)) {
    throw new Error(
      "Canary pristine PCM payload does not match the FIRST delivered Side A prefix",
    );
  }

  const decodedPristine = decodePcm16(pristineBytes, {
    sampleRate: pristineFacts.sampleRate,
    channels: pristineFacts.channels,
    dataOffset: pristineFacts.dataOffset,
    dataSize: pristineFacts.dataSize,
  });
  const decodedDegraded = decodePcm16(degradedBytes, {
    sampleRate: degradedFacts.sampleRate,
    channels: degradedFacts.channels,
    dataOffset: degradedFacts.dataOffset,
    dataSize: degradedFacts.dataSize,
  });
  const measured = measureNullDepth(decodedPristine, decodedDegraded);
  const measuredDecision = evaluateCanaryDepth(measured.depthDb);
  if (!sameLevel(measured.depthDb, report.depthDb) ||
      measuredDecision.status !== report.status ||
      measuredDecision.usable !== report.usable ||
      measuredDecision.reason !== report.reason) {
    throw new Error("Canary report depth disagrees with an independent measurement of its bytes");
  }

  const [pristineHash, degradedHash] = await Promise.all([
    sha256Hex(pristineBytes),
    sha256Hex(degradedBytes),
  ]);
  return {
    report: { ...report, ...measuredDecision, notes: report.notes },
    audio: Object.freeze({
      pristine: wavDescription(pristineBytes, pristineHash),
      degraded: wavDescription(degradedBytes, degradedHash),
    }),
    bytes: Object.freeze({
      pristine: pristineBytes,
      degraded: degradedBytes,
    }),
  };
}
