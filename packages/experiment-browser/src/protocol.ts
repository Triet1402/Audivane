/**
 * Versioned, typed RPC protocol between the renderer client and the dedicated
 * experiment Worker. Only the explicit operation allowlist below is dispatched;
 * no service property name is ever reflected from a message.
 *
 * Requests and responses are strict allowlists. Public snapshots/trials/receipts
 * may never carry pending or future assignments, display mappings or secrets.
 * Export audit rows and the terminal reveal are guarded separately according to
 * the frozen service contract.
 */
import { freezeRequest } from "@codec-abx/contracts";
import type {
  AnswerReceipt,
  DisplayAnswer,
  ExperimentAuditRow,
  ExperimentExport,
  ExperimentGates,
  ExperimentLifecycle,
  ExperimentPlan,
  ExperimentSnapshot,
  ExperimentStatistics,
  PlaybackLabel,
  PreparedArtifact,
  PreparationRequest,
  PublicTrial,
  TrialKind,
} from "@codec-abx/contracts";

import { clientError, isServiceErrorCode, type ExperimentClientErrorCode } from "./errors.js";
import { MAX_RETAINED_BYTES, MAX_WAV_BYTES } from "./wav.js";

export const EXPERIMENT_PROTOCOL = "codec-abx-experiment-rpc-v1" as const;
export const EXPERIMENT_PROTOCOL_VERSION = 1 as const;

const OPERATIONS = [
  "configure",
  "snapshot",
  "nextTrial",
  "answer",
  "readAudio",
  "seal",
  "reset",
  "export",
  "dispose",
  "bindPrepared",
] as const;

export type ExperimentOperation = (typeof OPERATIONS)[number];

interface RpcBase {
  readonly protocol: typeof EXPERIMENT_PROTOCOL;
  readonly version: typeof EXPERIMENT_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: ExperimentOperation;
}

export interface BindPreparedPayload {
  readonly artifact: PreparedArtifact;
  readonly a: ArrayBuffer;
  readonly b: ArrayBuffer;
  readonly canary: {
    readonly pristine: ArrayBuffer;
    readonly degraded: ArrayBuffer;
  } | null;
}

export type ExperimentRequest =
  | (RpcBase & { readonly operation: "configure"; readonly plan: ExperimentPlan })
  | (RpcBase & { readonly operation: "snapshot" })
  | (RpcBase & { readonly operation: "nextTrial" })
  | (RpcBase & {
      readonly operation: "answer";
      readonly token: string;
      readonly answer: DisplayAnswer;
    })
  | (RpcBase & {
      readonly operation: "readAudio";
      readonly token: string;
      readonly label: PlaybackLabel;
    })
  | (RpcBase & { readonly operation: "seal"; readonly reason?: string })
  | (RpcBase & { readonly operation: "reset" })
  | (RpcBase & { readonly operation: "export" })
  | (RpcBase & { readonly operation: "dispose" })
  | (RpcBase & { readonly operation: "bindPrepared" } & BindPreparedPayload);

export interface SafeErrorPayload {
  readonly code: ExperimentClientErrorCode;
  readonly message: string;
  readonly reasons: readonly string[];
}

export type ExperimentResponse =
  | (RpcBase & { readonly ok: true; readonly result: unknown })
  | (RpcBase & { readonly ok: false; readonly error: SafeErrorPayload });

function protocolError(message: string): never {
  throw clientError("protocol-error", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) protocolError(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) protocolError(`${label} has an unexpected field`);
  }
}

function string(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    protocolError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum = 2048): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) {
    protocolError(`${label} must be a bounded string or null`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    protocolError(`${label} must be an array of strings`);
  }
  return [...(value as string[])];
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") protocolError(`${label} must be boolean`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    protocolError(`${label} must be finite`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < minimum || value > maximum) {
    protocolError(`${label} must be an integer in [${String(minimum)}, ${String(maximum)}]`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.some((item) => item === value)) {
    protocolError(`${label} is not an allowed value`);
  }
  return value as T;
}

function hex64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    protocolError(`${label} must be a lowercase 64-character SHA-256 hex string`);
  }
  return value;
}

function answerValue(value: unknown, label: string): DisplayAnswer {
  return oneOf(value, ["A", "B"] as const, label);
}

export function guardPlan(value: unknown): ExperimentPlan {
  const raw = record(value, "plan");
  exactKeys(raw, ["version", "plannedTrials", "alpha", "labelMode", "calibrationEnabled"], "plan");
  if (raw.version !== 1) protocolError("plan version must be 1");
  const plannedTrials = raw.plannedTrials === null
    ? null
    : integer(raw.plannedTrials, "plan.plannedTrials", 1, 1000);
  const alpha = finite(raw.alpha, "plan.alpha");
  if (alpha <= 0 || alpha >= 1) protocolError("plan.alpha must be in (0, 1)");
  return {
    version: 1,
    plannedTrials,
    alpha,
    labelMode: oneOf(raw.labelMode, ["fixed", "blind_random"] as const, "plan.labelMode"),
    calibrationEnabled: boolean(raw.calibrationEnabled, "plan.calibrationEnabled"),
  };
}

function guardPreparationRequest(value: unknown): PreparationRequest {
  const raw = record(value, "prepared.request");
  exactKeys(
    raw,
    ["version", "preparationPolicy", "canaryEnabled", "sampleRateMode", "a", "b"],
    "prepared.request",
  );
  try { return freezeRequest(raw); }
  catch { return protocolError("prepared.request is not a supported canonical request"); }
}

function guardPreparedIdentity(value: unknown): NonNullable<ExperimentSnapshot["prepared"]> {
  const raw = record(value, "snapshot.prepared");
  exactKeys(
    raw,
    [
      "artifactId",
      "aWavSha256",
      "bWavSha256",
      "sourceSha256",
      "engineId",
      "engineBuild",
      "request",
      "preparationLocation",
    ],
    "snapshot.prepared",
  );
  return {
    artifactId: string(raw.artifactId, "snapshot.prepared.artifactId"),
    aWavSha256: hex64(raw.aWavSha256, "snapshot.prepared.aWavSha256"),
    bWavSha256: hex64(raw.bWavSha256, "snapshot.prepared.bWavSha256"),
    sourceSha256: hex64(raw.sourceSha256, "snapshot.prepared.sourceSha256"),
    engineId: string(raw.engineId, "snapshot.prepared.engineId"),
    engineBuild: string(raw.engineBuild, "snapshot.prepared.engineBuild"),
    request: guardPreparationRequest(raw.request),
    preparationLocation: oneOf(
      raw.preparationLocation,
      ["desktop-native", "browser-local", "optional-server"] as const,
      "snapshot.prepared.preparationLocation",
    ),
  };
}

export function guardPublicTrial(value: unknown): PublicTrial {
  const raw = record(value, "trial");
  exactKeys(raw, ["runId", "token", "trialIndex", "kind"], "trial");
  return {
    runId: string(raw.runId, "trial.runId"),
    token: string(raw.token, "trial.token", 512),
    trialIndex: integer(raw.trialIndex, "trial.trialIndex", 1),
    kind: oneOf(raw.kind, ["calibration", "scored"] as const, "trial.kind"),
  };
}

export function guardReceipt(value: unknown): AnswerReceipt {
  const raw = record(value, "receipt");
  exactKeys(
    raw,
    ["runId", "token", "trialIndex", "kind", "answer", "correct", "answeredAtUtc"],
    "receipt",
  );
  return {
    runId: string(raw.runId, "receipt.runId"),
    token: string(raw.token, "receipt.token", 512),
    trialIndex: integer(raw.trialIndex, "receipt.trialIndex", 1),
    kind: oneOf(raw.kind, ["calibration", "scored"] as const, "receipt.kind"),
    answer: answerValue(raw.answer, "receipt.answer"),
    correct: boolean(raw.correct, "receipt.correct"),
    answeredAtUtc: string(raw.answeredAtUtc, "receipt.answeredAtUtc"),
  };
}

function guardGates(value: unknown): ExperimentGates {
  const raw = record(value, "snapshot.gates");
  exactKeys(raw, [
    "nullStatus",
    "preparationStatus",
    "preparationClassification",
    "preparationReason",
    "preparationDisclosure",
    "calibrationStatus",
    "reasons",
  ], "snapshot.gates");
  const preparationStatus = oneOf(
    raw.preparationStatus,
    ["not-measured", "passed", "failed"] as const,
    "snapshot.gates.preparationStatus",
  );
  const preparationClassification = raw.preparationClassification === null
    ? null
    : oneOf(
        raw.preparationClassification,
        [
          "non-evidentiary",
          "globally-inverted",
          "weak-or-unrelated",
          "alignment-at-search-bound",
          "same-polarity-periodic-ambiguous",
          "polarity-ambiguous",
          "same-polarity-unique",
        ] as const,
        "snapshot.gates.preparationClassification",
      );
  if ((preparationStatus === "not-measured") !== (preparationClassification === null)) {
    protocolError("snapshot.gates preparation status/classification disagree");
  }
  const passedClassification = preparationClassification === "same-polarity-unique" ||
    preparationClassification === "same-polarity-periodic-ambiguous" || preparationClassification === "polarity-ambiguous";
  if (preparationStatus !== "not-measured" &&
      (preparationStatus === "passed") !== passedClassification) {
    protocolError("snapshot.gates preparation status contradicts its classification");
  }
  const preparationReason = optionalString(
    raw.preparationReason,
    "snapshot.gates.preparationReason",
  );
  const preparationDisclosure = optionalString(
    raw.preparationDisclosure,
    "snapshot.gates.preparationDisclosure",
  );
  if (preparationStatus === "not-measured" && preparationReason !== null) {
    protocolError("snapshot.gates has a preparation reason without a measured gate");
  }
  if (preparationStatus !== "not-measured" && preparationReason === null) {
    protocolError("snapshot.gates has a measured preparation gate without a reason");
  }
  if (preparationClassification === "same-polarity-periodic-ambiguous") {
    if (preparationStatus !== "passed" || preparationDisclosure === null ||
        !preparationDisclosure.includes("no unique lag")) {
      protocolError("ambiguous preparation pass must carry its no-unique-lag disclosure");
    }
  } else if (preparationClassification === "polarity-ambiguous") {
    if (preparationStatus !== "passed" || preparationDisclosure === null || !preparationDisclosure.startsWith("polarity ambiguous:")) {
      protocolError("competing-polarity preparation pass must carry its disclosure");
    }
  } else if (preparationDisclosure !== null) {
    protocolError("snapshot.gates has a preparation disclosure without periodic ambiguity");
  }
  return {
    nullStatus: oneOf(
      raw.nullStatus,
      ["not-measured", "passed", "failed", "not-applicable"] as const,
      "snapshot.gates.nullStatus",
    ),
    preparationStatus,
    preparationClassification,
    preparationReason,
    preparationDisclosure,
    calibrationStatus: oneOf(
      raw.calibrationStatus,
      ["not-configured", "unavailable", "pending", "passed", "failed"] as const,
      "snapshot.gates.calibrationStatus",
    ),
    reasons: stringArray(raw.reasons, "snapshot.gates.reasons"),
  };
}

function guardStatistics(value: unknown): ExperimentStatistics {
  const raw = record(value, "snapshot.statistics");
  exactKeys(
    raw,
    [
      "scoredTrials",
      "correctTrials",
      "plannedTrials",
      "requiredCorrect",
      "pValue",
      "ability",
      "abilityCi95",
      "significant",
      "isFinal",
      "significantVerdict",
    ],
    "snapshot.statistics",
  );
  if (!Array.isArray(raw.abilityCi95) || raw.abilityCi95.length !== 2) {
    protocolError("snapshot.statistics.abilityCi95 must have two entries");
  }
  const ci = raw.abilityCi95 as unknown[];
  return {
    scoredTrials: integer(raw.scoredTrials, "snapshot.statistics.scoredTrials", 0),
    correctTrials: integer(raw.correctTrials, "snapshot.statistics.correctTrials", 0),
    plannedTrials: raw.plannedTrials === null
      ? null
      : integer(raw.plannedTrials, "snapshot.statistics.plannedTrials", 1, 1000),
    requiredCorrect: raw.requiredCorrect === null
      ? null
      : integer(raw.requiredCorrect, "snapshot.statistics.requiredCorrect", 0),
    pValue: finite(raw.pValue, "snapshot.statistics.pValue"),
    ability: raw.ability === null
      ? null
      : finite(raw.ability, "snapshot.statistics.ability"),
    abilityCi95: [
      finite(ci[0], "snapshot.statistics.abilityCi95[0]"),
      finite(ci[1], "snapshot.statistics.abilityCi95[1]"),
    ],
    significant: boolean(raw.significant, "snapshot.statistics.significant"),
    isFinal: boolean(raw.isFinal, "snapshot.statistics.isFinal"),
    significantVerdict: boolean(
      raw.significantVerdict,
      "snapshot.statistics.significantVerdict",
    ),
  };
}

export function guardSnapshot(value: unknown): ExperimentSnapshot {
  const raw = record(value, "snapshot");
  exactKeys(
    raw,
    [
      "version",
      "runId",
      "authority",
      "lifecycle",
      "plan",
      "lockedAtUtc",
      "commitment",
      "prepared",
      "pendingTrial",
      "lastAnswer",
      "gates",
      "statistics",
      "sealedReason",
      "limitations",
    ],
    "snapshot",
  );
  if (raw.version !== 1) protocolError("snapshot version must be 1");
  const lifecycle: ExperimentLifecycle = oneOf(
    raw.lifecycle,
    ["configured", "running", "completed", "sealed", "void"] as const,
    "snapshot.lifecycle",
  );
  if (raw.authority !== "local-self-test") {
    protocolError("snapshot authority must be local-self-test");
  }
  return {
    version: 1,
    runId: string(raw.runId, "snapshot.runId"),
    authority: "local-self-test",
    lifecycle,
    plan: guardPlan(raw.plan),
    lockedAtUtc: optionalString(raw.lockedAtUtc, "snapshot.lockedAtUtc"),
    commitment: hex64(raw.commitment, "snapshot.commitment"),
    prepared: raw.prepared === null ? null : guardPreparedIdentity(raw.prepared),
    pendingTrial: raw.pendingTrial === null ? null : guardPublicTrial(raw.pendingTrial),
    lastAnswer: raw.lastAnswer === null ? null : guardReceipt(raw.lastAnswer),
    gates: guardGates(raw.gates),
    statistics: guardStatistics(raw.statistics),
    sealedReason: optionalString(raw.sealedReason, "snapshot.sealedReason"),
    limitations: stringArray(raw.limitations, "snapshot.limitations"),
  };
}

function guardAuditRow(value: unknown): ExperimentAuditRow {
  const raw = record(value, "export.trials[]");
  exactKeys(
    raw,
    [
      "runId",
      "token",
      "trialIndex",
      "kind",
      "answer",
      "correct",
      "answeredAtUtc",
      "xSource",
      "answerSource",
      "displayMapping",
    ],
    "export.trials[]",
  );
  const mapping = record(raw.displayMapping, "export.trials[].displayMapping");
  exactKeys(mapping, ["A", "B"], "export.trials[].displayMapping");
  const kind: TrialKind = oneOf(
    raw.kind,
    ["calibration", "scored"] as const,
    "export.trials[].kind",
  );
  return {
    runId: string(raw.runId, "export.trials[].runId"),
    token: string(raw.token, "export.trials[].token", 512),
    trialIndex: integer(raw.trialIndex, "export.trials[].trialIndex", 1),
    kind,
    answer: answerValue(raw.answer, "export.trials[].answer"),
    correct: boolean(raw.correct, "export.trials[].correct"),
    answeredAtUtc: string(raw.answeredAtUtc, "export.trials[].answeredAtUtc"),
    xSource: answerValue(raw.xSource, "export.trials[].xSource"),
    answerSource: answerValue(raw.answerSource, "export.trials[].answerSource"),
    displayMapping: {
      A: answerValue(mapping.A, "export.trials[].displayMapping.A"),
      B: answerValue(mapping.B, "export.trials[].displayMapping.B"),
    },
  };
}

export function guardExport(value: unknown): ExperimentExport {
  const raw = record(value, "export");
  exactKeys(raw, ["schema", "snapshot", "trials", "reveal"], "export");
  if (raw.schema !== "codec-abx-experiment-v1") {
    protocolError("export schema is not codec-abx-experiment-v1");
  }
  const snapshot = guardSnapshot(raw.snapshot);
  if (!Array.isArray(raw.trials)) protocolError("export.trials must be an array");
  const trials = (raw.trials as unknown[]).map(guardAuditRow);
  const reveal = record(raw.reveal, "export.reveal");
  exactKeys(
    reveal,
    ["commitment", "secretHex", "xSequence", "redacted", "verifiable"],
    "export.reveal",
  );
  const secretHex = reveal.secretHex === null
    ? null
    : hex64(reveal.secretHex, "export.reveal.secretHex");
  if (!Array.isArray(reveal.xSequence)) {
    protocolError("export.reveal.xSequence must be an array");
  }
  const xSequence = (reveal.xSequence as unknown[]).map((item, index) =>
    answerValue(item, `export.reveal.xSequence[${String(index)}]`));
  const redacted = boolean(reveal.redacted, "export.reveal.redacted");
  const terminal = snapshot.lifecycle === "completed" ||
    snapshot.lifecycle === "sealed" ||
    snapshot.lifecycle === "void";
  if (terminal) {
    if (secretHex === null) protocolError("terminal export must reveal the run secret");
    if (redacted) protocolError("terminal export cannot be redacted");
  } else if (secretHex !== null || !redacted) {
    protocolError("non-terminal export must stay redacted with no secret");
  }
  if (xSequence.length !== trials.length) {
    protocolError("export reveal sequence must describe exactly the answered trials");
  }
  const answeredCalibration = snapshot.gates.calibrationStatus === "passed" ||
    snapshot.gates.calibrationStatus === "failed" ? 1 : 0;
  if (trials.length !== snapshot.statistics.scoredTrials + answeredCalibration) {
    protocolError("export rows must match the snapshot's answered trial counts");
  }
  if (hex64(reveal.commitment, "export.reveal.commitment") !== snapshot.commitment) {
    protocolError("export commitment disagrees with its snapshot");
  }
  const pendingToken = snapshot.pendingTrial?.token;
  const pendingIndex = snapshot.pendingTrial?.trialIndex;
  const tokens = new Set<string>();
  for (const [index, trial] of trials.entries()) {
    if (trial.runId !== snapshot.runId || trial.trialIndex !== index + 1 ||
        trial.xSource !== xSequence[index] ||
        trial.displayMapping.A === trial.displayMapping.B ||
        trial.answerSource !== trial.displayMapping[trial.answer] ||
        trial.correct !== (trial.answerSource === trial.xSource)) {
      protocolError("export audit row disagrees with its run, sequence or scoring");
    }
    if (tokens.has(trial.token)) protocolError("export repeats an answered trial token");
    tokens.add(trial.token);
    if (pendingToken !== undefined && trial.token === pendingToken) {
      protocolError("export leaked the pending trial as answered");
    }
    if (pendingIndex !== undefined && trial.trialIndex >= pendingIndex) {
      protocolError("export contains a future trial index");
    }
  }
  if (trials.filter((trial) => trial.kind === "scored").length !== snapshot.statistics.scoredTrials ||
      trials.filter((trial) => trial.kind === "calibration").length !== answeredCalibration ||
      (answeredCalibration === 1 && trials[0]?.kind !== "calibration")) {
    protocolError("export trial kinds disagree with the snapshot");
  }
  return {
    schema: "codec-abx-experiment-v1",
    snapshot,
    trials,
    reveal: {
      commitment: hex64(reveal.commitment, "export.reveal.commitment"),
      secretHex,
      xSequence,
      redacted,
      verifiable: boolean(reveal.verifiable, "export.reveal.verifiable"),
    },
  };
}

export function guardReadAudio(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    protocolError("readAudio result must be an ArrayBuffer");
  }
  if (value.byteLength < 44 || value.byteLength > MAX_WAV_BYTES) {
    protocolError("readAudio result is outside the bounded WAV envelope");
  }
  return value;
}

export function guardEmptyResult(value: unknown): null {
  if (value !== null) protocolError("dispose result must be null");
  return null;
}

export function guardSafeError(value: unknown): SafeErrorPayload {
  const raw = record(value, "error");
  exactKeys(raw, ["code", "message", "reasons"], "error");
  if (!isServiceErrorCode(raw.code) && raw.code !== "protocol-error") {
    protocolError("error code is not an allowlisted service/protocol code");
  }
  const code = raw.code as ExperimentClientErrorCode;
  return {
    code,
    message: string(raw.message, "error.message", 1024),
    reasons: stringArray(raw.reasons, "error.reasons")
      .map((reason) => reason.slice(0, 1024)),
  };
}

function guardBindPayload(value: Record<string, unknown>): BindPreparedPayload {
  const artifact = record(value.artifact, "request.artifact");
  if (artifact.purpose !== "diagnostic-only") {
    protocolError("request artifact must be diagnostic-only");
  }
  string(artifact.id, "request.artifact.id");
  if (!(value.a instanceof ArrayBuffer) || !(value.b instanceof ArrayBuffer)) {
    protocolError("request requires A and B ArrayBuffers");
  }
  if (value.a.byteLength > MAX_WAV_BYTES || value.b.byteLength > MAX_WAV_BYTES) {
    protocolError("request binding side exceeds the WAV byte bound");
  }
  let canary: BindPreparedPayload["canary"] = null;
  let total = value.a.byteLength + value.b.byteLength;
  if (value.canary !== null) {
    const raw = record(value.canary, "request.canary");
    exactKeys(raw, ["pristine", "degraded"], "request.canary");
    if (!(raw.pristine instanceof ArrayBuffer) || !(raw.degraded instanceof ArrayBuffer)) {
      protocolError("request canary requires pristine and degraded ArrayBuffers");
    }
    if (raw.pristine.byteLength > MAX_WAV_BYTES || raw.degraded.byteLength > MAX_WAV_BYTES) {
      protocolError("request canary side exceeds the WAV byte bound");
    }
    total += raw.pristine.byteLength + raw.degraded.byteLength;
    canary = { pristine: raw.pristine, degraded: raw.degraded };
  }
  if (total > MAX_RETAINED_BYTES) {
    protocolError("request binding exceeds the retained byte bound");
  }
  return {
    artifact: artifact as unknown as PreparedArtifact,
    a: value.a,
    b: value.b,
    canary,
  };
}

/** Parse and validate one incoming Worker request against the operation allowlist. */
export function parseExperimentRequest(value: unknown): ExperimentRequest {
  const raw = record(value, "request");
  if (raw.protocol !== EXPERIMENT_PROTOCOL) protocolError("request protocol is unsupported");
  if (raw.version !== EXPERIMENT_PROTOCOL_VERSION) protocolError("request version is unsupported");
  const requestId = string(raw.requestId, "request.requestId", 128);
  const operation = oneOf(raw.operation, OPERATIONS, "request.operation");
  const base = {
    protocol: EXPERIMENT_PROTOCOL,
    version: EXPERIMENT_PROTOCOL_VERSION,
    requestId,
  } as const;

  switch (operation) {
    case "configure":
      exactKeys(raw, ["protocol", "version", "requestId", "operation", "plan"], "configure request");
      return { ...base, operation, plan: guardPlan(raw.plan) };
    case "snapshot":
      exactKeys(raw, ["protocol", "version", "requestId", "operation"], "snapshot request");
      return { ...base, operation };
    case "nextTrial":
      exactKeys(raw, ["protocol", "version", "requestId", "operation"], "nextTrial request");
      return { ...base, operation };
    case "answer": {
      exactKeys(
        raw,
        ["protocol", "version", "requestId", "operation", "token", "answer"],
        "answer request",
      );
      return {
        ...base,
        operation,
        token: string(raw.token, "answer.token", 512),
        answer: answerValue(raw.answer, "answer.answer"),
      };
    }
    case "readAudio": {
      exactKeys(
        raw,
        ["protocol", "version", "requestId", "operation", "token", "label"],
        "readAudio request",
      );
      return {
        ...base,
        operation,
        token: string(raw.token, "readAudio.token", 512),
        label: oneOf(raw.label, ["A", "B", "X"] as const, "readAudio.label"),
      };
    }
    case "seal": {
      exactKeys(
        raw,
        ["protocol", "version", "requestId", "operation", "reason"],
        "seal request",
      );
      if (raw.reason !== undefined && typeof raw.reason !== "string") {
        protocolError("seal.reason must be a string");
      }
      return {
        ...base,
        operation,
        ...(raw.reason === undefined ? {} : { reason: raw.reason }),
      };
    }
    case "reset":
      exactKeys(raw, ["protocol", "version", "requestId", "operation"], "reset request");
      return { ...base, operation };
    case "export":
      exactKeys(raw, ["protocol", "version", "requestId", "operation"], "export request");
      return { ...base, operation };
    case "dispose":
      exactKeys(raw, ["protocol", "version", "requestId", "operation"], "dispose request");
      return { ...base, operation };
    case "bindPrepared":
      exactKeys(
        raw,
        ["protocol", "version", "requestId", "operation", "artifact", "a", "b", "canary"],
        "bindPrepared request",
      );
      return { ...base, operation, ...guardBindPayload(raw) };
  }
}

export function parseResponseBase(value: unknown): {
  readonly requestId: string;
  readonly operation: ExperimentOperation;
  readonly ok: boolean;
  readonly raw: Record<string, unknown>;
} {
  const raw = record(value, "response");
  if (raw.protocol !== EXPERIMENT_PROTOCOL) protocolError("response protocol is unsupported");
  if (raw.version !== EXPERIMENT_PROTOCOL_VERSION) {
    protocolError("response version is unsupported");
  }
  const requestId = string(raw.requestId, "response.requestId", 128);
  const operation = oneOf(raw.operation, OPERATIONS, "response.operation");
  const ok = boolean(raw.ok, "response.ok");
  return { requestId, operation, ok, raw };
}

export function successResponse(
  request: ExperimentRequest,
  result: unknown,
): ExperimentResponse {
  return {
    protocol: EXPERIMENT_PROTOCOL,
    version: EXPERIMENT_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    ok: true,
    result,
  };
}

export function errorResponse(
  requestId: string,
  operation: ExperimentOperation,
  error: SafeErrorPayload,
): ExperimentResponse {
  return {
    protocol: EXPERIMENT_PROTOCOL,
    version: EXPERIMENT_PROTOCOL_VERSION,
    requestId,
    operation,
    ok: false,
    error,
  };
}
