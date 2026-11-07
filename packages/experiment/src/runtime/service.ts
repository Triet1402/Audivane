/**
 * Runtime-owned ABX experiment service.
 *
 * Public operations implement the frozen `ExperimentClient`; prepared-artifact
 * binding and binary readers are runtime-only and never appear in a public DTO.
 * All unanswered assignments, display mappings, the run secret and the receipt
 * cache stay private. Mutating operations are serialized; binary reads carry an
 * epoch guard so reset/seal/dispose invalidate late reader completions.
 */
import type {
  AnswerReceipt,
  DisplayAnswer,
  ExperimentAuditRow,
  ExperimentClient,
  ExperimentExport,
  ExperimentGates,
  ExperimentLifecycle,
  ExperimentPlan,
  ExperimentSnapshot,
  ExperimentStatistics,
  PlaybackLabel,
  PublicTrial,
  TrialKind,
} from "@codec-abx/contracts";
import { freezeRequest } from "@codec-abx/contracts";
import type { PreparedArtifact } from "@codec-abx/contracts";
import {
  MAX_SUPPORTED_TRIALS,
  binomialCi,
  isSignificant,
  minCorrectForSignificance,
  oneTailedPValue,
  roundTo,
} from "../statistics.js";
import {
  commitSecret as defaultCommitSecret,
  randomBit as defaultRandomBit,
  verifyReveal,
  xSourceForIndex as defaultXSourceForIndex,
} from "../commitment.js";

import { ExperimentServiceError, serviceError } from "./errors.js";
import { validatePreparedArtifact, type ArtifactReaders, type ValidatedArtifact } from "./validation.js";
import { bytesToHex, copyByteBuffer, parseCanonicalPcm16Wav, requireSha256Hex, sha256Hex } from "./wav.js";

const AUTHORITY = "local-self-test" as const;
const PRACTICE_LIMIT = MAX_SUPPORTED_TRIALS;
const DEFAULT_SEAL_REASON = "sealed by the tester";

const LIMITATIONS = Object.freeze([
  "Authority is local self-test only; browser runtime isolation is not tamper-proof or remote trusted custody.",
  "Prepared artifacts remain diagnostic-only; this service does not certify instrumentation or present scored listening UI.",
  "Playback synchronization of A/B/X is outside this slice; binary reads are verified delivery bytes, not listening evidence.",
  "Statistical and commitment behavior follows the documented reference decisions with the stated tightenings.",
]);

export interface ExperimentServiceOptions {
  /** Internal seam: deterministic secrets/run IDs/tokens for fixture tests. */
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Internal seam: deterministic fair label-swap coin for fixture tests. */
  readonly randomBit?: () => boolean;
  /** Internal seam: deterministic clock for fixture tests. */
  readonly now?: () => Date;
  /** Internal seam: deterministic assignment digest for late-crypto tests. */
  readonly xSourceForIndex?: (secret: Uint8Array, index: number) => Promise<DisplayAnswer>;
  /** Internal seam: deterministic commitment await for late-crypto tests. */
  readonly commitSecret?: (secret: Uint8Array) => Promise<string>;
}

interface PendingTrial {
  readonly token: string;
  readonly trialIndex: number;
  readonly kind: TrialKind;
  readonly xSource: DisplayAnswer;
  /** Display label -> source side. Resolved exactly once at staging. */
  readonly displayMapping: Readonly<Record<DisplayAnswer, DisplayAnswer>>;
}

interface StoredTrial {
  readonly token: string;
  readonly trialIndex: number;
  readonly kind: TrialKind;
  readonly xSource: DisplayAnswer;
  readonly answerDisplay: DisplayAnswer;
  readonly answerSource: DisplayAnswer;
  readonly correct: boolean;
  readonly displayMapping: Readonly<Record<DisplayAnswer, DisplayAnswer>>;
  readonly answeredAtUtc: string;
}

interface ReceiptEntry {
  readonly receipt: AnswerReceipt;
  readonly trial: StoredTrial;
}

function clonePlan(plan: ExperimentPlan): ExperimentPlan {
  return {
    version: 1 as const,
    plannedTrials: plan.plannedTrials,
    alpha: plan.alpha,
    labelMode: plan.labelMode,
    calibrationEnabled: plan.calibrationEnabled,
  };
}

function cloneTrial(trial: PublicTrial): PublicTrial {
  return {
    runId: trial.runId,
    token: trial.token,
    trialIndex: trial.trialIndex,
    kind: trial.kind,
  };
}

function cloneReceipt(receipt: AnswerReceipt): AnswerReceipt {
  return {
    runId: receipt.runId,
    token: receipt.token,
    trialIndex: receipt.trialIndex,
    kind: receipt.kind,
    answer: receipt.answer,
    correct: receipt.correct,
    answeredAtUtc: receipt.answeredAtUtc,
  };
}

function cloneAuditRow(trial: StoredTrial): ExperimentAuditRow {
  return {
    runId: "",
    token: trial.token,
    trialIndex: trial.trialIndex,
    kind: trial.kind,
    answer: trial.answerDisplay,
    correct: trial.correct,
    answeredAtUtc: trial.answeredAtUtc,
    xSource: trial.xSource,
    answerSource: trial.answerSource,
    displayMapping: {
      A: trial.displayMapping.A,
      B: trial.displayMapping.B,
    },
  };
}

function validatePlan(value: unknown): ExperimentPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    serviceError("invalid-plan", "Experiment plan must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) serviceError("invalid-plan", "Experiment plan version must be 1");
  let plannedTrials: number | null;
  if (raw.plannedTrials === null) {
    plannedTrials = null;
  } else if (typeof raw.plannedTrials === "number" &&
      Number.isSafeInteger(raw.plannedTrials) &&
      raw.plannedTrials >= 1 &&
      raw.plannedTrials <= MAX_SUPPORTED_TRIALS) {
    plannedTrials = raw.plannedTrials;
  } else {
    serviceError(
      "invalid-plan",
      `plannedTrials must be null or an integer in [1, ${MAX_SUPPORTED_TRIALS}]`,
    );
  }
  if (typeof raw.alpha !== "number" || !Number.isFinite(raw.alpha) ||
      raw.alpha <= 0 || raw.alpha >= 1) {
    serviceError("invalid-plan", "alpha must be finite and in (0, 1)");
  }
  if (raw.labelMode !== "fixed" && raw.labelMode !== "blind_random") {
    serviceError("invalid-plan", "labelMode must be fixed or blind_random");
  }
  if (typeof raw.calibrationEnabled !== "boolean") {
    serviceError("invalid-plan", "calibrationEnabled must be boolean");
  }
  return Object.freeze(clonePlan({
    version: 1,
    plannedTrials,
    alpha: raw.alpha,
    labelMode: raw.labelMode,
    calibrationEnabled: raw.calibrationEnabled,
  }));
}

function isoNow(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ExperimentServiceError("invalid-state", "clock did not return a valid Date");
  }
  return date.toISOString();
}

function copyRandomBytes(
  factory: (length: number) => Uint8Array,
  length: number,
): Uint8Array {
  const value = factory(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new ExperimentServiceError("invalid-state", "random source returned the wrong byte length");
  }
  return new Uint8Array(value);
}

function defaultRandomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new ExperimentServiceError("invalid-state", "WebCrypto randomness is unavailable");
  }
  const output = new Uint8Array(length);
  cryptoApi.getRandomValues(output);
  return output;
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new ExperimentServiceError("invalid-state", message);
  return value;
}

export class ExperimentService implements ExperimentClient {
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #randomBit: () => boolean;
  readonly #now: () => Date;
  readonly #xSourceForIndex: (secret: Uint8Array, index: number) => Promise<DisplayAnswer>;
  readonly #commitSecret: (secret: Uint8Array) => Promise<string>;

  #initialized: Promise<void> | null = null;
  #resetBarrier: Promise<void> | null = null;
  #secret: Uint8Array | null = null;
  #commitment = "";
  #runId = "";
  #epoch = 0;
  #generation = 0;
  #disposed = false;
  #tail: Promise<void> = Promise.resolve();

  #plan: ExperimentPlan | null = null;
  #binding: ValidatedArtifact | null = null;
  #readers: ArtifactReaders | null = null;
  #lifecycle: ExperimentLifecycle = "configured";
  #lockedAtUtc: string | null = null;
  #sealedReason: string | null = null;
  #pending: PendingTrial | null = null;
  #answered: StoredTrial[] = [];
  #canaryTrial: StoredTrial | null = null;
  #receipts = new Map<string, ReceiptEntry>();
  #issued = new Set<string>();
  #lastAnswer: AnswerReceipt | null = null;

  constructor(options: ExperimentServiceOptions = {}) {
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#randomBit = options.randomBit ?? defaultRandomBit;
    this.#now = options.now ?? (() => new Date());
    this.#xSourceForIndex = options.xSourceForIndex ?? defaultXSourceForIndex;
    this.#commitSecret = options.commitSecret ?? defaultCommitSecret;
  }

  #ensureInitialized(): Promise<void> {
    if (this.#initialized === null) {
      this.#initialized = this.#initialize();
    }
    return this.#initialized;
  }

  async #initialize(): Promise<void> {
    const secret = copyRandomBytes(this.#randomBytes, 32);
    const commitment = requireSha256Hex(
      await this.#commitSecret(secret),
      "run commitment",
    );
    if (this.#disposed) serviceError("disposed", "Experiment service has been disposed");
    this.#secret = secret;
    this.#commitment = commitment;
    this.#runId = bytesToHex(copyRandomBytes(this.#randomBytes, 16));
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.#generation;
    const run = this.#tail.then(async () => {
      this.#assertNotDisposed();
      if (this.#resetBarrier) await this.#resetBarrier;
      await this.#ensureInitialized();
      this.#assertGeneration(generation);
      const result = await operation();
      this.#assertGeneration(generation);
      return result;
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) serviceError("disposed", "Experiment service has been disposed");
  }

  #assertEpoch(epoch: number): void {
    if (this.#disposed) serviceError("disposed", "Experiment service has been disposed");
    if (epoch !== this.#epoch) {
      serviceError("stale-token", "The run changed while the operation was in flight");
    }
  }

  #assertGeneration(generation: number): void {
    this.#assertNotDisposed();
    if (generation !== this.#generation) {
      serviceError("stale-token", "The run changed while the operation was queued or in flight");
    }
  }

  #secretBytes(): Uint8Array {
    return required(this.#secret, "run secret is unavailable");
  }

  #planRequired(): ExperimentPlan {
    if (this.#plan === null) {
      serviceError("not-configured", "configure a plan before using the experiment");
    }
    return this.#plan;
  }

  #currentRunId(): string {
    if (!this.#runId) throw new ExperimentServiceError("invalid-state", "run is not initialized");
    return this.#runId;
  }

  #publicTrial(pending: PendingTrial): PublicTrial {
    return {
      runId: this.#currentRunId(),
      token: pending.token,
      trialIndex: pending.trialIndex,
      kind: pending.kind,
    };
  }

  #receiptFor(trial: StoredTrial): AnswerReceipt {
    return {
      runId: this.#currentRunId(),
      token: trial.token,
      trialIndex: trial.trialIndex,
      kind: trial.kind,
      answer: trial.answerDisplay,
      correct: trial.correct,
      answeredAtUtc: trial.answeredAtUtc,
    };
  }

  #gates(): ExperimentGates {
    const plan = this.#plan;
    let nullStatus: ExperimentGates["nullStatus"] = "not-measured";
    let preparationStatus: ExperimentGates["preparationStatus"] = "not-measured";
    let preparationClassification: ExperimentGates["preparationClassification"] = null;
    let preparationReason: string | null = null;
    let preparationDisclosure: string | null = null;
    const reasons: string[] = [];
    if (this.#binding) {
      switch (this.#binding.nullGate.status) {
        case "passed":
          nullStatus = "passed";
          break;
        case "failed":
          nullStatus = "failed";
          reasons.push(this.#binding.nullGate.reason);
          break;
        case "not-applicable":
          nullStatus = "not-applicable";
          break;
      }
      const gate = this.#binding.preparationGate;
      preparationStatus = gate.status;
      preparationClassification = gate.classification;
      preparationReason = gate.reason;
      preparationDisclosure = gate.disclosure;
      if (gate.status === "failed") reasons.push(gate.reason);
    }
    let calibrationStatus: ExperimentGates["calibrationStatus"] = "not-configured";
    if (plan?.calibrationEnabled) {
      if (this.#canaryTrial) {
        calibrationStatus = this.#canaryTrial.correct ? "passed" : "failed";
        if (!this.#canaryTrial.correct) {
          reasons.push("calibration trial failed: the run is void");
        }
      } else if (this.#binding?.canary?.usable && this.#binding.canary.servable) {
        calibrationStatus = "pending";
      } else {
        calibrationStatus = "unavailable";
        reasons.push(
          this.#binding?.canaryUnavailableReason ??
            "calibration is requested but no usable bound canary material is available",
        );
      }
    }
    return {
      nullStatus,
      preparationStatus,
      preparationClassification,
      preparationReason,
      preparationDisclosure,
      calibrationStatus,
      reasons: [...reasons],
    };
  }

  #calibrationReady(plan: ExperimentPlan): boolean {
    if (!plan.calibrationEnabled) return true;
    if (this.#canaryTrial) return true;
    return Boolean(this.#binding?.canary?.usable && this.#binding.canary.servable);
  }

  #runValid(plan: ExperimentPlan): boolean {
    if (this.#binding?.nullGate.status === "failed") return false;
    if (this.#binding?.preparationGate.status !== "passed") return false;
    if (plan.calibrationEnabled) {
      if (!this.#canaryTrial || !this.#canaryTrial.correct) return false;
    }
    return true;
  }

  #statistics(): ExperimentStatistics {
    const plan = this.#planRequired();
    const scored = this.#answered.filter((trial) => trial.kind === "scored");
    const n = scored.length;
    const k = scored.reduce((sum, trial) => sum + (trial.correct ? 1 : 0), 0);
    const pValue = oneTailedPValue(n, k);
    const significant = isSignificant(n, k, plan.alpha);
    const isFinal = this.#lifecycle === "completed" &&
      plan.plannedTrials !== null &&
      n >= plan.plannedTrials;
    const ci = binomialCi(n, k);
    return {
      scoredTrials: n,
      correctTrials: k,
      plannedTrials: plan.plannedTrials,
      requiredCorrect: plan.plannedTrials === null
        ? null
        : minCorrectForSignificance(plan.plannedTrials, plan.alpha),
      pValue,
      ability: n === 0 ? null : roundTo(k / n, 4),
      abilityCi95: [ci[0], ci[1]],
      significant,
      isFinal,
      significantVerdict: significant && isFinal && this.#runValid(plan),
    };
  }

  #preparedIdentity(): ExperimentSnapshot["prepared"] {
    if (!this.#binding) return null;
    return {
      artifactId: this.#binding.identity.artifactId,
      aWavSha256: this.#binding.identity.aWavSha256,
      bWavSha256: this.#binding.identity.bWavSha256,
      sourceSha256: this.#binding.identity.sourceSha256,
      engineId: this.#binding.identity.engineId,
      engineBuild: this.#binding.identity.engineBuild,
      request: freezeRequest(this.#binding.identity.request),
      preparationLocation: this.#binding.identity.preparationLocation,
    };
  }

  #snapshot(): ExperimentSnapshot {
    const plan = this.#planRequired();
    return {
      version: 1,
      runId: this.#currentRunId(),
      authority: AUTHORITY,
      lifecycle: this.#lifecycle,
      plan: clonePlan(plan),
      lockedAtUtc: this.#lockedAtUtc,
      commitment: this.#commitment,
      prepared: this.#preparedIdentity(),
      pendingTrial: this.#pending === null ? null : cloneTrial(this.#publicTrial(this.#pending)),
      lastAnswer: this.#lastAnswer === null ? null : cloneReceipt(this.#lastAnswer),
      gates: this.#gates(),
      statistics: this.#statistics(),
      sealedReason: this.#sealedReason,
      limitations: [...LIMITATIONS],
    };
  }

  async configure(plan: ExperimentPlan): Promise<ExperimentSnapshot> {
    const input = validatePlan(plan);
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      if (this.#lifecycle !== "configured" || this.#lockedAtUtc !== null ||
          this.#pending !== null || this.#answered.length > 0) {
        serviceError(
          "config-locked",
          "the plan is frozen from the first staged trial; reset to plan a new run",
        );
      }
      this.#plan = input;
      return this.#snapshot();
    });
  }

  async snapshot(): Promise<ExperimentSnapshot> {
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      return this.#snapshot();
    });
  }

  /**
   * Runtime-only binding. Not part of `ExperimentClient`; the public DTO gains
   * only audit identity, never mappings, source assignment or audio bytes.
   */
  async bindPrepared(
    artifact: PreparedArtifact,
    readers: ArtifactReaders,
  ): Promise<ExperimentSnapshot> {
    let input: PreparedArtifact;
    try {
      input = structuredClone(artifact);
    } catch {
      serviceError("artifact-invalid", "prepared artifact metadata must be cloneable public data");
    }
    if (typeof readers?.readAudio !== "function") {
      serviceError("artifact-reader-unavailable", "prepared artifact has no audio reader");
    }
    // Capture methods now, with their original receiver, before any queue/crypto
    // await. Caller replacement of a reader property cannot change the binding.
    const privateReaders: ArtifactReaders = Object.freeze({
      readAudio: readers.readAudio.bind(readers),
      ...(typeof readers.readCanaryAudio === "function"
        ? { readCanaryAudio: readers.readCanaryAudio.bind(readers) } : {}),
    });
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      this.#planRequired();
      if (this.#lifecycle !== "configured" || this.#lockedAtUtc !== null ||
          this.#pending !== null || this.#answered.length > 0) {
        serviceError(
          "config-locked",
          "the prepared pair is frozen while a run is active; reset before replacing it",
        );
      }
      const epoch = this.#epoch;
      let binding: ValidatedArtifact;
      try {
        binding = await validatePreparedArtifact(input, privateReaders);
      } catch (error) {
        if (error instanceof ExperimentServiceError) throw error;
        serviceError(
          "artifact-invalid",
          error instanceof Error ? error.message : String(error),
        );
      }
      this.#assertEpoch(epoch);
      this.#binding = binding;
      this.#readers = privateReaders;
      this.#epoch += 1;
      return this.#snapshot();
    });
  }

  async nextTrial(): Promise<PublicTrial> {
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      if (this.#pending !== null) return cloneTrial(this.#publicTrial(this.#pending));
      if (this.#lifecycle === "completed" ||
          this.#lifecycle === "sealed" ||
          this.#lifecycle === "void") {
        serviceError("run-closed", "this run accepts no further trials", this.#gates().reasons);
      }
      const plan = this.#planRequired();
      if (!this.#binding) {
        serviceError("artifact-unbound", "bind a verified prepared artifact before staging a trial");
      }
      if (this.#binding.nullGate.status === "failed") {
        serviceError(
          "null-gate-failed",
          "the bound pair failed the identical-pipeline null gate; trials are blocked",
          [this.#binding.nullGate.reason],
        );
      }
      if (this.#binding.preparationGate.status === "failed") {
        const gate = this.#binding.preparationGate;
        serviceError(
          "preparation-gate-failed",
          "the bound pair failed the frozen preparation-validity gate; all trials are blocked",
          [
            `${gate.classification}: ${gate.reason}`,
            ...(gate.disclosure === null ? [] : [gate.disclosure]),
          ],
        );
      }
      if (!this.#calibrationReady(plan)) {
        serviceError(
          "calibration-unavailable",
          "calibration is requested but usable canary material/reader is unavailable",
          [
            this.#binding.canaryUnavailableReason ??
              "calibration is requested but no usable bound canary material is available",
          ],
        );
      }
      const scored = this.#answered.filter((trial) => trial.kind === "scored").length;
      if (plan.plannedTrials !== null && scored >= plan.plannedTrials) {
        serviceError("trial-limit", "the pre-registered N has been reached");
      }
      if (scored >= PRACTICE_LIMIT) {
        serviceError(
          "practice-limit",
          `practice is bounded to ${PRACTICE_LIMIT} scored answers; seal to reveal`,
        );
      }

      const trialIndex = this.#answered.length + 1;
      const kind: TrialKind = plan.calibrationEnabled && this.#canaryTrial === null
        ? "calibration"
        : "scored";
      const epoch = this.#epoch;
      const secret = this.#secretBytes();
      const xSource = await this.#xSourceForIndex(secret, trialIndex);
      this.#assertEpoch(epoch);
      const swap = plan.labelMode === "blind_random" ? this.#randomBit() : false;
      const displayMapping: Readonly<Record<DisplayAnswer, DisplayAnswer>> = swap
        ? Object.freeze({ A: "B" as const, B: "A" as const })
        : Object.freeze({ A: "A" as const, B: "B" as const });
      let token = bytesToHex(copyRandomBytes(this.#randomBytes, 16));
      while (this.#issued.has(token)) {
        token = bytesToHex(copyRandomBytes(this.#randomBytes, 16));
      }
      const pending: PendingTrial = Object.freeze({
        token,
        trialIndex,
        kind,
        xSource,
        displayMapping,
      });
      if (this.#lifecycle === "configured") {
        this.#lifecycle = "running";
        this.#lockedAtUtc = isoNow(this.#now());
      }
      this.#pending = pending;
      this.#issued.add(token);
      return cloneTrial(this.#publicTrial(pending));
    });
  }

  async answer(token: string, answer: DisplayAnswer): Promise<AnswerReceipt> {
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      if (answer !== "A" && answer !== "B") {
        serviceError("invalid-answer", "answer must be exactly 'A' or 'B'");
      }
      if (typeof token !== "string" || token.length === 0) {
        serviceError("unknown-token", "answer must name the pending trial token");
      }
      const receipt = this.#receipts.get(token);
      if (receipt) {
        if (receipt.receipt.answer !== answer) {
          serviceError(
            "conflicting-answer",
            "this token was already answered differently; the original receipt is final",
          );
        }
        return cloneReceipt(receipt.receipt);
      }
      const pending = this.#pending;
      if (pending === null) {
        if (this.#lifecycle === "completed" ||
            this.#lifecycle === "sealed" ||
            this.#lifecycle === "void") {
          serviceError("run-closed", "this run accepts no further answers", this.#gates().reasons);
        }
        serviceError("unknown-token", "no trial is pending for this token");
      }
      if (pending.token !== token) {
        serviceError(
          this.#issued.has(token) ? "stale-token" : "unknown-token",
          "the token does not name the currently pending trial",
        );
      }
      const plan = this.#planRequired();
      const answerSource = pending.displayMapping[answer];
      const correct = answerSource === pending.xSource;
      const trial: StoredTrial = Object.freeze({
        token: pending.token,
        trialIndex: pending.trialIndex,
        kind: pending.kind,
        xSource: pending.xSource,
        answerDisplay: answer,
        answerSource,
        correct,
        displayMapping: pending.displayMapping,
        answeredAtUtc: isoNow(this.#now()),
      });
      this.#answered.push(trial);
      if (trial.kind === "calibration") this.#canaryTrial = trial;
      const accepted = this.#receiptFor(trial);
      this.#receipts.set(token, { receipt: accepted, trial });
      this.#pending = null;
      this.#lastAnswer = accepted;

      if (trial.kind === "calibration" && !correct) {
        this.#lifecycle = "void";
        this.#sealedReason = "calibration trial failed: the run is void";
        this.#epoch += 1;
      } else if (trial.kind === "scored" &&
          plan.plannedTrials !== null &&
          this.#answered.filter((item) => item.kind === "scored").length >= plan.plannedTrials) {
        this.#lifecycle = "completed";
        this.#epoch += 1;
      }
      return cloneReceipt(accepted);
    });
  }

  async readAudio(token: string, label: PlaybackLabel): Promise<ArrayBuffer> {
    this.#assertNotDisposed();
    await this.#ensureInitialized();
    this.#assertNotDisposed();
    if (label !== "A" && label !== "B" && label !== "X") {
      serviceError("invalid-answer", "playback label must be 'A', 'B' or 'X'");
    }
    const pending = this.#pending;
    if (pending === null || pending.token !== token) {
      serviceError(
        this.#issued.has(token) ? "stale-token" : "unknown-token",
        "audio can only be read for the currently pending trial",
      );
    }
    const binding = this.#binding;
    const readers = this.#readers;
    if (!binding || !readers) {
      serviceError("artifact-unbound", "no prepared artifact is bound");
    }
    const epoch = this.#epoch;
    const source: DisplayAnswer = label === "X"
      ? pending.xSource
      : pending.displayMapping[label];
    let description;
    let expectedFacts;
    let reader: () => Promise<ArrayBuffer>;
    if (pending.kind === "calibration") {
      const canary = binding.canary;
      if (!canary || !canary.usable || !canary.servable || !readers.readCanaryAudio) {
        serviceError(
          "calibration-unavailable",
          canary?.reason ?? "calibration audio is unavailable",
        );
      }
      description = source === "A" ? canary.pristine : canary.degraded;
      expectedFacts = {
        sampleRate: canary.report.sampleRate,
        channels: canary.report.channels,
        frames: canary.report.frames,
      } as const;
      reader = () => readers.readCanaryAudio!(binding.id, source === "A" ? "pristine" : "degraded");
    } else {
      description = source === "A"
        ? { sampleRate: binding.factsA.sampleRate, channels: binding.factsA.channels,
            frames: binding.factsA.frames, wavSha256: binding.identity.aWavSha256 }
        : { sampleRate: binding.factsB.sampleRate, channels: binding.factsB.channels,
            frames: binding.factsB.frames, wavSha256: binding.identity.bWavSha256 };
      expectedFacts = source === "A" ? binding.factsA : binding.factsB;
      reader = () => readers.readAudio(binding.id, source === "A" ? "a" : "b");
    }

    let value: ArrayBuffer;
    try {
      value = await reader();
    } catch {
      serviceError(
        "artifact-reader-unavailable",
        "the prepared audio reader failed",
      );
    }
    let bytes: Uint8Array;
    let facts;
    try {
      bytes = copyByteBuffer(value, "served audio");
      facts = parseCanonicalPcm16Wav(bytes);
    } catch {
      serviceError("artifact-bytes-mismatch", "served audio is outside the verified canonical WAV envelope");
    }
    if (facts.sampleRate !== expectedFacts.sampleRate ||
        facts.channels !== expectedFacts.channels ||
        facts.frames !== expectedFacts.frames ||
        description.sampleRate !== facts.sampleRate ||
        description.channels !== facts.channels ||
        description.frames !== facts.frames) {
      serviceError("artifact-bytes-mismatch", "served audio layout disagrees with its binding");
    }
    const hash = await sha256Hex(bytes);
    if (hash !== description.wavSha256) {
      serviceError("artifact-bytes-mismatch", "served audio bytes do not match their described SHA-256");
    }
    this.#assertEpoch(epoch);
    if (this.#pending === null || this.#pending.token !== token) {
      serviceError("stale-token", "the trial changed while its audio was being read");
    }
    return bytes.slice().buffer as ArrayBuffer;
  }

  async seal(reason?: string): Promise<ExperimentSnapshot> {
    this.#assertNotDisposed();
    await this.#ensureInitialized();
    this.#assertNotDisposed();
    if (this.#resetBarrier) await this.#resetBarrier;
    this.#assertNotDisposed();
    this.#planRequired();
    if (this.#lifecycle === "completed" ||
        this.#lifecycle === "sealed" ||
        this.#lifecycle === "void") {
      return this.#snapshot();
    }
    // Invalidate in-flight crypto/read work immediately: sealing must not wait
    // for a trial assignment or reader that started before the seal.
    this.#lifecycle = "sealed";
    this.#sealedReason = typeof reason === "string" && reason.length > 0
      ? reason
      : DEFAULT_SEAL_REASON;
    this.#pending = null;
    this.#epoch += 1;
    this.#generation += 1;
    return this.#snapshot();
  }

  async reset(): Promise<ExperimentSnapshot> {
    this.#assertNotDisposed();
    await this.#ensureInitialized();
    this.#assertNotDisposed();
    const previous = this.#resetBarrier;
    const operation = (async (): Promise<ExperimentSnapshot> => {
      if (previous) await previous;
      this.#assertNotDisposed();
      this.#planRequired();
      // Bump before awaiting the new commitment so an assignment/reader that
      // started under the old run cannot publish after this reset begins.
      const epoch = this.#epoch + 1;
      this.#epoch = epoch;
      this.#generation += 1;
      const secret = copyRandomBytes(this.#randomBytes, 32);
      const commitment = requireSha256Hex(await this.#commitSecret(secret), "run commitment");
      this.#assertNotDisposed();
      if (this.#epoch !== epoch) {
        serviceError("stale-token", "the run changed while reset was creating a new secret");
      }
      this.#secret = secret;
      this.#commitment = commitment;
      this.#runId = bytesToHex(copyRandomBytes(this.#randomBytes, 16));
      this.#lifecycle = "configured";
      this.#lockedAtUtc = null;
      this.#sealedReason = null;
      this.#pending = null;
      this.#answered = [];
      this.#canaryTrial = null;
      this.#receipts.clear();
      this.#issued.clear();
      this.#lastAnswer = null;
      this.#epoch += 1;
      return this.#snapshot();
    })();
    const barrier = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#resetBarrier = barrier;
    try {
      return await operation;
    } finally {
      if (this.#resetBarrier === barrier) this.#resetBarrier = null;
    }
  }

  async export(): Promise<ExperimentExport> {
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      const snapshot = this.#snapshot();
      const epoch = this.#epoch;
      const terminal = this.#lifecycle === "completed" ||
        this.#lifecycle === "sealed" ||
        this.#lifecycle === "void";
      const secretHex = terminal ? bytesToHex(this.#secretBytes()) : null;
      const xSequence = this.#answered
        .slice()
        .sort((left, right) => left.trialIndex - right.trialIndex)
        .map((trial) => trial.xSource);
      let verifiable = false;
      if (secretHex !== null) {
        verifiable = await verifyReveal(secretHex, this.#commitment, xSequence);
      }
      this.#assertEpoch(epoch);
      return {
        schema: "codec-abx-experiment-v1",
        snapshot,
        trials: this.#answered
          .slice()
          .sort((left, right) => left.trialIndex - right.trialIndex)
          .map((trial) => {
            const row = cloneAuditRow(trial);
            return { ...row, runId: this.#currentRunId() };
          }),
        reveal: {
          commitment: this.#commitment,
          secretHex,
          xSequence,
          redacted: !terminal,
          verifiable,
        },
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#epoch += 1;
    this.#generation += 1;
    this.#pending = null;
    this.#readers = null;
    this.#binding = null;
    this.#receipts.clear();
    this.#issued.clear();
    if (this.#secret) this.#secret.fill(0);
    this.#secret = null;
    this.#commitment = "";
    this.#runId = "";
  }
}
