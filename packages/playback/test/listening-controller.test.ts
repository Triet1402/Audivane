import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AnswerReceipt,
  CodecId,
  DesktopRuntimeFailure,
  ExperimentExport,
  ExperimentPlan,
  ExperimentSnapshot,
  PlaybackLabel,
  PlaybackLoop,
  PlaybackOutputState,
  PlaybackSnapshot,
  PreparedArtifact,
  PreparationRequest,
  PublicTrial,
  StageProvenance,
  TrialPlayer,
} from "@codec-abx/contracts";

import {
  ListeningController,
  type ListeningClient,
  type ListeningReaders,
} from "../../../apps/client/src/listening/controller.js";
import { LISTENING_EXPORT_SCHEMA } from "../../../apps/client/src/listening/export.js";
import { attachOutputDiscovery } from "../../../apps/client/src/listening/useListening.js";

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

type MutableSnapshot = Mutable<ExperimentSnapshot>;

const PLAN: ExperimentPlan = Object.freeze({
  version: 1,
  plannedTrials: 4,
  alpha: 0.05,
  labelMode: "blind_random",
  calibrationEnabled: true,
});

const ARTIFACT = {
  id: "artifact-1",
  request: {
    version: 1,
    preparationPolicy: "aligned-gain-matched-v1",
    canaryEnabled: true,
    sampleRateMode: "native",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "opus", bitrateKbps: 128 },
  },
  engine: {
    engineId: "engine",
    location: "browser-local",
    build: "build",
    codecs: [],
    channels: [1, 2],
    maxInputBytes: 256 * 1024 * 1024,
    maxDurationSeconds: 600,
    preparationPolicy: "aligned-gain-matched-v1",
    limitations: [],
  },
  sourceSha256: "1".repeat(64),
  a: {
    requested: { codecId: "noop_passthrough", bitrateKbps: 0 },
    encoder: "pcm",
    decoder: "pcm",
    actualBitrateKbps: null,
    encodedSampleRate: 48_000,
    delivered: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "2".repeat(64) },
  },
  b: {
    requested: { codecId: "opus", bitrateKbps: 128 },
    encoder: "libopus",
    decoder: "libopus",
    actualBitrateKbps: 128,
    encodedSampleRate: 48_000,
    delivered: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "3".repeat(64) },
  },
  elapsedMs: 1,
  measurements: {
    policy: "delivered-pcm-measurements-v1",
    alignmentLagSamples: 0,
    alignmentConfidence: 0,
    loudnessDeltaDb: 0,
    nullDepthDb: -40,
    notes: [],
    delivered: {
      policy: "delivered-pcm-measurements-v1",
      alignment: { lagSamples: 0, confidence: 0, maxLagSamples: 4800, probeSamples: 240_000, status: "no-evidence" },
      a: {
        sampleRate: 48_000,
        channels: 1,
        frames: 24_000,
        integratedLufs: { status: "finite", value: -16, reason: null },
        samplePeakDbfs: { status: "finite", value: -12, reason: null },
      },
      b: {
        sampleRate: 48_000,
        channels: 1,
        frames: 24_000,
        integratedLufs: { status: "finite", value: -16, reason: null },
        samplePeakDbfs: { status: "finite", value: -12, reason: null },
      },
      loudnessDeltaDb: { status: "finite", value: 0, reason: null },
      nullDepth: { basis: "residual-aligned", comparedFrames: 24_000, depthDb: { status: "finite", value: -40, reason: null } },
      notes: [],
    },
  },
  preparation: {
    policy: "aligned-gain-matched-v1",
    targetLufs: -16,
    minimumDurationSeconds: 0.4,
    maxLagSeconds: 0.1,
    peakCeiling: 0.98,
    alignment: {
      lagSamples: 0,
      confidence: 0,
      maxLagSamples: 4800,
      probeSamples: 240_000,
      status: "no-evidence",
      inputFramesA: 24_000,
      inputFramesB: 24_000,
      startFrameA: 0,
      startFrameB: 0,
      outputFrames: 24_000,
    },
    loudness: {
      preA: { status: "finite", value: -16, reason: null },
      preB: { status: "finite", value: -16, reason: null },
      gainADb: 0,
      gainBDb: 0,
      commonTrimDb: 0,
    },
    serialization: { format: "pcm16-le", rounding: "floor", floorBiasCodeSteps: 2 ** -17, dither: false },
    notes: [],
  },
  validity: {
    policy: "delivered-validity-v2",
    nullGate: {
      policy: "identical-pipeline-null-v1",
      status: "not-applicable",
      expectedIdentical: false,
      thresholdDb: -60,
      depthDb: { status: "finite", value: -40, reason: null },
      reason: "test fixture",
    },
    preparationGate: {
      policy: "preparation-validity-v2",
      status: "passed",
      classification: "same-polarity-unique",
      reason: "test fixture",
      constants: {
        minAcRmsFullScale: 1 / 32768,
        invertedMinConfidence: 0.5,
        invertedMargin: 0.25,
        sameMinConfidence: 0.5,
        peakValueTolerance: 0.01,
      },
      evidence: {
        acRmsFullScaleA: 0.1,
        acRmsFullScaleB: 0.1,
        acRmsCodeStepsA: 3276.8,
        acRmsCodeStepsB: 3276.8,
        sameConfidence: 0.99,
        sameLagSamples: 0,
        invertedConfidence: 0.01,
        invertedLagSamples: 0,
        chosenPolarity: "same",
        chosenLagSamples: 0,
        chosenConfidence: 0.99,
        searchMinLagSamples: -4800,
        searchMaxLagSamples: 4800,
        distinctPositivePeaksWithinTolerance: 1,
      },
      disclosure: null,
      notes: [],
    },
    notes: [],
  },
  canary: {
    report: {
      policy: "delivered-canary-v1",
      status: "usable",
      usable: true,
      minimumResidualDb: -30,
      depthDb: { status: "finite", value: -20, reason: null },
      reason: "test fixture",
      cutoffHz: 3000,
      frequencyGrid: "numpy-rfftfreq-v1",
      drive: 10,
      clipLevel: 0.45,
      sampleRate: 48_000,
      channels: 1,
      frames: 24_000,
      notes: [],
    },
    audio: {
      pristine: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "4".repeat(64) },
      degraded: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "5".repeat(64) },
    },
  },
  disclosures: [],
  purpose: "diagnostic-only",
} as unknown as PreparedArtifact;

const RAW_ARTIFACT = {
  ...ARTIFACT,
  request: { ...ARTIFACT.request, preparationPolicy: "codec-probe-only" },
  preparation: undefined,
} as unknown as PreparedArtifact;

const NATIVE_ARTIFACT = {
  ...ARTIFACT,
  engine: {
    ...ARTIFACT.engine,
    engineId: "engine-native-typescript",
    location: "desktop-native",
    preparationPolicy: "aligned-gain-matched-v1",
    supportedPreparationPolicies: ["aligned-gain-matched-v1"],
  },
  measurements: { ...ARTIFACT.measurements, policy: "aligned-gain-matched-v1" },
} as unknown as PreparedArtifact;

const UNSUPPORTED_NATIVE_ARTIFACT = {
  ...NATIVE_ARTIFACT,
  request: { ...NATIVE_ARTIFACT.request, preparationPolicy: "unknown-policy-v0" as never },
} as unknown as PreparedArtifact;

function statistics(plan: ExperimentPlan, correct: number, scored: number): ExperimentSnapshot["statistics"] {
  return {
    scoredTrials: scored,
    correctTrials: correct,
    plannedTrials: plan.plannedTrials,
    requiredCorrect: plan.plannedTrials,
    pValue: 0.5 ** scored,
    ability: null,
    abilityCi95: [0.1, 0.9],
    significant: false,
    isFinal: false,
    significantVerdict: false,
  };
}

function baseSnapshot(plan: ExperimentPlan = PLAN): ExperimentSnapshot {
  return {
    version: 1,
    runId: "run-1",
    authority: "local-self-test",
    lifecycle: "configured",
    plan: { ...plan },
    lockedAtUtc: null,
    commitment: "a".repeat(64),
    prepared: null,
    pendingTrial: null,
    lastAnswer: null,
    gates: {
      nullStatus: "not-measured",
      preparationStatus: "not-measured",
      preparationClassification: null,
      preparationReason: null,
      preparationDisclosure: null,
      calibrationStatus: plan.calibrationEnabled ? "pending" : "not-configured",
      reasons: [],
    },
    statistics: statistics(plan, 0, 0),
    sealedReason: null,
    limitations: ["local custody test"],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface Behavior {
  configureError?: unknown;
  bindError?: unknown;
  bindCommits?: boolean;
  snapshotError?: unknown;
  nextError?: unknown;
  onAnswer?: (token: string, answer: "A" | "B") => Promise<AnswerReceipt> | AnswerReceipt;
  answerError?: unknown;
  answerCommits?: boolean;
}

class FakeClient implements ListeningClient {
  snapshotData: MutableSnapshot = baseSnapshot() as MutableSnapshot;
  plan: ExperimentPlan = PLAN;
  configureCalls = 0;
  bindCalls = 0;
  nextCalls = 0;
  answerCalls: { token: string; answer: "A" | "B" }[] = [];
  resetCalls = 0;
  disposeCalls = 0;
  sealed = false;
  behavior: Behavior = {};
  fatalListener: ((failure: DesktopRuntimeFailure) => void) | null = null;
  fatalSubscribes = 0;
  fatalUnsubscribes = 0;
  #sequence = 0;

  onFatal(listener: (failure: DesktopRuntimeFailure) => void): () => void {
    this.fatalSubscribes += 1;
    this.fatalListener = listener;
    return () => {
      this.fatalUnsubscribes += 1;
      if (this.fatalListener === listener) this.fatalListener = null;
    };
  }

  emitFatal(failure: DesktopRuntimeFailure): void {
    this.fatalListener?.(failure);
  }

  async configure(plan: ExperimentPlan): Promise<ExperimentSnapshot> {
    this.configureCalls += 1;
    if (this.behavior.configureError) throw this.behavior.configureError;
    this.plan = clone(plan);
    this.snapshotData.plan = clone(plan);
    this.snapshotData.gates.calibrationStatus = plan.calibrationEnabled
      ? "pending"
      : "not-configured";
    this.snapshotData.statistics = statistics(plan, 0, 0);
    return clone(this.snapshotData) as ExperimentSnapshot;
  }

  async bindPrepared(artifact: PreparedArtifact): Promise<ExperimentSnapshot> {
    this.bindCalls += 1;
    if (this.behavior.bindError) {
      if (this.behavior.bindCommits) this.#commitPrepared(artifact);
      throw this.behavior.bindError;
    }
    this.#commitPrepared(artifact);
    return clone(this.snapshotData) as ExperimentSnapshot;
  }

  #commitPrepared(artifact: PreparedArtifact): void {
    this.snapshotData.prepared = {
      artifactId: artifact.id,
      aWavSha256: artifact.a.delivered.wavSha256,
      bWavSha256: artifact.b.delivered.wavSha256,
      sourceSha256: artifact.sourceSha256,
      engineId: artifact.engine.engineId,
      engineBuild: artifact.engine.build,
      request: clone(artifact.request),
      preparationLocation: artifact.engine.location,
    };
    const preparationGate = artifact.validity?.policy === "delivered-validity-v2"
      ? artifact.validity.preparationGate
      : null;
    this.snapshotData.gates = {
      nullStatus: artifact.validity?.nullGate.status === "passed" ? "passed" : "not-applicable",
      preparationStatus: preparationGate?.status ?? "not-measured",
      preparationClassification: preparationGate?.classification ?? null,
      preparationReason: preparationGate?.reason ?? null,
      preparationDisclosure: preparationGate?.disclosure ?? null,
      calibrationStatus: this.plan.calibrationEnabled ? "pending" : "not-configured",
      reasons: [],
    };
  }

  async snapshot(): Promise<ExperimentSnapshot> {
    if (this.behavior.snapshotError) throw this.behavior.snapshotError;
    return clone(this.snapshotData) as ExperimentSnapshot;
  }

  async nextTrial(): Promise<PublicTrial> {
    this.nextCalls += 1;
    if (this.behavior.nextError) throw this.behavior.nextError;
    this.#sequence += 1;
    const trial: PublicTrial = {
      runId: this.snapshotData.runId,
      token: `token-${this.#sequence}`,
      trialIndex: this.nextCalls,
      kind: this.plan.calibrationEnabled && this.nextCalls === 1 ? "calibration" : "scored",
    };
    this.snapshotData.pendingTrial = trial;
    this.snapshotData.lifecycle = "running";
    this.snapshotData.lockedAtUtc = "2026-01-01T00:00:00.000Z";
    return clone(trial);
  }

  async answer(token: string, answer: "A" | "B"): Promise<AnswerReceipt> {
    this.answerCalls.push({ token, answer });
    if (this.behavior.answerError) {
      const error = this.behavior.answerError;
      this.behavior.answerError = undefined;
      if (this.behavior.answerCommits) this.#commitAnswer(token, answer);
      throw error;
    }
    if (this.behavior.onAnswer) return await this.behavior.onAnswer(token, answer);
    return this.#commitAnswer(token, answer);
  }

  #commitAnswer(token: string, answer: "A" | "B"): AnswerReceipt {
    const pending = this.snapshotData.pendingTrial;
    if (pending === null || pending.token !== token) throw new Error("fake: wrong token");
    const receipt: AnswerReceipt = {
      runId: pending.runId,
      token,
      trialIndex: pending.trialIndex,
      kind: pending.kind,
      answer,
      correct: true,
      answeredAtUtc: "2026-01-01T00:00:01.000Z",
    };
    this.snapshotData.lastAnswer = receipt;
    this.snapshotData.gates.calibrationStatus = pending.kind === "calibration"
      ? "passed"
      : this.snapshotData.gates.calibrationStatus;
    const scored = this.snapshotData.statistics.scoredTrials + (pending.kind === "scored" ? 1 : 0);
    const correct = this.snapshotData.statistics.correctTrials + (pending.kind === "scored" ? 1 : 0);
    this.snapshotData.statistics = statistics(this.plan, correct, scored);
    this.snapshotData.statistics.isFinal = this.plan.plannedTrials !== null &&
      scored >= this.plan.plannedTrials;
    if (this.snapshotData.statistics.isFinal) this.snapshotData.lifecycle = "completed";
    return receipt;
  }

  async readAudio(): Promise<ArrayBuffer> {
    return new ArrayBuffer(8);
  }

  async seal(): Promise<ExperimentSnapshot> {
    this.sealed = true;
    this.snapshotData.lifecycle = "sealed";
    this.snapshotData.sealedReason = "test";
    return clone(this.snapshotData) as ExperimentSnapshot;
  }

  async reset(): Promise<ExperimentSnapshot> {
    this.resetCalls += 1;
    const prepared = this.snapshotData.prepared;
    this.snapshotData = baseSnapshot(this.plan) as MutableSnapshot;
    this.snapshotData.runId = `run-${this.resetCalls + 1}`;
    this.snapshotData.prepared = prepared;
    this.snapshotData.gates = {
      nullStatus: "passed",
      preparationStatus: "passed",
      preparationClassification: "same-polarity-unique",
      preparationReason: "test fixture",
      preparationDisclosure: null,
      calibrationStatus: this.plan.calibrationEnabled ? "pending" : "not-configured",
      reasons: [],
    };
    this.#sequence = 0;
    this.nextCalls = 0;
    return clone(this.snapshotData) as ExperimentSnapshot;
  }

  async export(): Promise<ExperimentExport> {
    return {
      schema: "codec-abx-experiment-v1",
      snapshot: clone(this.snapshotData),
      trials: [],
      reveal: {
        commitment: this.snapshotData.commitment,
        secretHex: null,
        xSequence: [],
        redacted: true,
        verifiable: true,
      },
    };
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
    return Promise.resolve();
  }
}

const EMPTY_PLAYBACK: PlaybackSnapshot = {
  phase: "empty",
  trial: null,
  playing: false,
  selected: "X",
  positionSeconds: 0,
  durationSeconds: 0,
  loop: { enabled: false, startSeconds: 0, endSeconds: 0 },
  deliveredSampleRate: null,
  outputSampleRate: null,
  channels: null,
  error: null,
};

const OUTPUT: PlaybackOutputState = {
  support: "supported",
  canRequest: true,
  devices: [
    { deviceId: "", label: "System default output" },
    { deviceId: "device-secret-1", label: "Listener speaker" },
  ],
  pending: null,
  requestedDeviceId: null,
  selectedDeviceId: null,
  observedDeviceId: "",
  change: "none",
  error: null,
};

class FakePlayer implements TrialPlayer {
  current: PlaybackSnapshot = { ...EMPTY_PLAYBACK, output: structuredClone(OUTPUT) };
  output: PlaybackOutputState = structuredClone(OUTPUT);
  loadCalls: PublicTrial[] = [];
  playCalls = 0;
  pauseCalls = 0;
  resetCalls = 0;
  disposeCalls = 0;
  refreshOutputCalls = 0;
  requestOutputCalls = 0;
  selectOutputCalls: string[] = [];
  failOutputSelection = false;
  failNextLoad = false;
  deferNextLoad = false;
  #deferred: ((snapshot: PlaybackSnapshot) => void) | null = null;
  #deferredReject: ((error: unknown) => void) | null = null;
  #deferredGeneration = 0;
  #deferredContinuation = false;
  #listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  #loop: PlaybackLoop = { enabled: false, startSeconds: 0, endSeconds: 0 };
  #generation = 0;

  async loadTrial(
    trial: PublicTrial,
    _read?: unknown,
    options: { readonly carryPrevious?: boolean } = {},
  ): Promise<PlaybackSnapshot> {
    this.loadCalls.push(trial);
    const generation = ++this.#generation;
    const continuation = options.carryPrevious === true;
    if (this.deferNextLoad) {
      this.deferNextLoad = false;
      this.#deferredGeneration = generation;
      this.#deferredContinuation = continuation;
      this.current = { ...this.current, phase: "loading", trial };
      this.#emit();
      return await new Promise<PlaybackSnapshot>((resolve, reject) => {
        this.#deferred = (snapshot) => resolve(snapshot);
        this.#deferredReject = reject;
      });
    }
    if (this.failNextLoad) {
      this.failNextLoad = false;
      this.current = {
        ...this.current,
        phase: "error",
        trial,
        playing: continuation ? this.current.playing : false,
        selectionRequired: continuation,
        carryingPreviousTrial: continuation ? this.current.playing : false,
        error: "test load failure",
        output: structuredClone(this.output),
      };
      this.#emit();
      return this.current;
    }
    const sounding = continuation && this.current.playing;
    this.current = {
      ...EMPTY_PLAYBACK,
      phase: "ready",
      trial,
      selected: this.current.selected,
      playing: sounding,
      selectionRequired: continuation,
      carryingPreviousTrial: sounding,
      durationSeconds: 1,
      loop: this.#loop,
      output: structuredClone(this.output),
    };
    this.#emit();
    return this.current;
  }

  async refreshOutputDevices(): Promise<PlaybackSnapshot> {
    this.refreshOutputCalls += 1;
    this.#publishOutput({ pending: null, error: null });
    return this.snapshot();
  }

  async selectOutputDevice(deviceId: string): Promise<PlaybackSnapshot> {
    this.selectOutputCalls.push(deviceId);
    if (this.failOutputSelection) {
      this.#publishOutput({
        pending: null,
        requestedDeviceId: deviceId,
        error: "output-device-unavailable: the requested output device is not available",
      });
      return this.snapshot();
    }
    this.#publishOutput({
      pending: null,
      requestedDeviceId: deviceId,
      selectedDeviceId: deviceId,
      observedDeviceId: deviceId,
      change: "none",
      error: null,
    });
    return this.snapshot();
  }

  async requestOutputDevice(): Promise<PlaybackSnapshot> {
    this.requestOutputCalls += 1;
    this.#publishOutput({
      pending: null,
      requestedDeviceId: "device-secret-1",
      selectedDeviceId: "device-secret-1",
      observedDeviceId: "device-secret-1",
      change: "none",
      error: null,
    });
    return this.snapshot();
  }

  changeOutputRoute(change: "changed" | "lost"): void {
    this.#publishOutput({ change });
  }

  finishOutputRefresh(): void {
    this.#publishOutput({ pending: null });
  }

  #publishOutput(patch: Partial<PlaybackOutputState>): void {
    this.output = structuredClone({ ...this.output, ...patch });
    this.current = { ...this.current, output: structuredClone(this.output) };
    this.#emit();
  }

  releaseDeferred(): void {
    const resolve = this.#deferred;
    this.#deferred = null;
    this.#deferredReject = null;
    if (resolve) {
      if (this.#deferredGeneration !== this.#generation) {
        resolve(this.current);
        return;
      }
      const trial = this.current.trial;
      const sounding = this.#deferredContinuation && this.current.playing;
      const snapshot: PlaybackSnapshot = {
        ...EMPTY_PLAYBACK,
        phase: "ready",
        trial,
        playing: sounding,
        selectionRequired: this.#deferredContinuation,
        carryingPreviousTrial: sounding,
        durationSeconds: 1,
        output: structuredClone(this.output),
      };
      this.#deferredContinuation = false;
      this.current = snapshot;
      this.#emit();
      resolve(snapshot);
    }
  }

  rejectDeferred(error: unknown): void {
    const reject = this.#deferredReject;
    this.#deferred = null;
    this.#deferredReject = null;
    reject?.(error);
  }

  async play(): Promise<PlaybackSnapshot> {
    this.playCalls += 1;
    this.current = { ...this.current, playing: true };
    this.#emit();
    return this.current;
  }

  pause(): PlaybackSnapshot {
    this.pauseCalls += 1;
    this.current = {
      ...this.current,
      playing: false,
      carryingPreviousTrial: false,
    };
    this.#emit();
    return this.current;
  }

  select(label: PlaybackLabel): PlaybackSnapshot {
    this.current = {
      ...this.current,
      selected: label,
      selectionRequired: false,
      carryingPreviousTrial: false,
    };
    this.#emit();
    return this.current;
  }

  seek(positionSeconds: number): PlaybackSnapshot {
    this.current = { ...this.current, positionSeconds };
    this.#emit();
    return this.current;
  }

  setLoop(loop: PlaybackLoop): PlaybackSnapshot {
    this.#loop = loop;
    this.current = { ...this.current, loop };
    this.#emit();
    return this.current;
  }

  snapshot(): PlaybackSnapshot {
    return { ...this.current };
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): PlaybackSnapshot {
    this.resetCalls += 1;
    this.#generation += 1;
    this.output = structuredClone({ ...this.output, pending: null, change: "none", error: null });
    this.current = { ...EMPTY_PLAYBACK, output: structuredClone(this.output) };
    this.#emit();
    return this.current;
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
    return Promise.resolve();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener({ ...this.current });
  }
}

const READERS: ListeningReaders = {
  readAudio: () => Promise.resolve(new ArrayBuffer(0)),
};

function makeController(): {
  client: FakeClient;
  player: FakePlayer;
  controller: ListeningController;
} {
  const client = new FakeClient();
  const player = new FakePlayer();
  const controller = new ListeningController({
    createClient: () => client,
    createPlayer: () => player,
  });
  return { client, player, controller };
}

test("concurrent listening disposals await the same player and service cleanup", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  player.dispose = () => gate;
  const first = controller.dispose();
  const second = controller.dispose();
  assert.equal(first, second);
  assert.equal(client.disposeCalls, 0, "artifact cleanup must wait until playback and binding cleanup finish");
  finish();
  await second;
  assert.equal(client.disposeCalls, 1);
});

test("listening controller refuses raw artifacts before creating a Worker", async () => {
  let clients = 0;
  const player = new FakePlayer();
  const controller = new ListeningController({
    createClient: () => {
      clients += 1;
      return new FakeClient();
    },
    createPlayer: () => player,
  });
  await controller.prepareSession(PLAN, RAW_ARTIFACT, READERS);
  assert.equal(clients, 0);
  assert.equal(controller.state.session, "idle");
  assert.equal(controller.state.error?.code, "artifact-invalid");
  assert.match(controller.state.error?.message ?? "", /aligned-gain-matched-v1/);
});

test("listening controller accepts the shared native engine and refuses unsupported native artifacts", async () => {
  const accepted = makeController();
  await accepted.controller.prepareSession(PLAN, NATIVE_ARTIFACT, READERS);
  assert.equal(accepted.client.bindCalls, 1);
  assert.equal(accepted.controller.state.session, "configured");
  assert.equal(
    accepted.controller.state.snapshot?.prepared?.preparationLocation,
    "desktop-native",
  );

  let clients = 0;
  const refused = new ListeningController({
    createClient: () => {
      clients += 1;
      return new FakeClient();
    },
    createPlayer: () => new FakePlayer(),
  });
  await refused.prepareSession(PLAN, UNSUPPORTED_NATIVE_ARTIFACT, READERS);
  assert.equal(clients, 0);
  assert.equal(refused.state.error?.code, "artifact-invalid");
  assert.match(refused.state.error?.message ?? "", /engine-native-typescript/);
});

test("confirmed answers auto-advance continuously, then require an explicit new-trial pick", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(client.configureCalls, 1);
  assert.equal(client.bindCalls, 1);
  assert.equal(controller.state.session, "configured");
  assert.equal(controller.state.snapshot?.commitment, "a".repeat(64));
  assert.equal(controller.state.planLocked, false);

  await controller.start();
  assert.equal(client.nextCalls, 1);
  assert.equal(player.loadCalls.length, 1);
  assert.equal(controller.state.trial?.kind, "calibration");
  assert.equal(controller.state.playback?.playing, false);
  assert.equal(controller.state.playback?.selectionRequired, false);
  assert.equal(controller.state.planLocked, true);
  const firstToken = controller.state.trial?.token;

  const transitions: Array<{ answered: boolean; playing: boolean; token: string | null }> = [];
  controller.subscribe((state) => {
    transitions.push({
      answered: state.answered,
      playing: state.playback?.playing ?? false,
      token: state.trial?.token ?? null,
    });
  });

  await controller.play();
  assert.equal(controller.state.playback?.playing, true);
  const playCalls = player.playCalls;
  const pauseCalls = player.pauseCalls;
  await controller.answer("A");

  // Answer submission never pauses and the confirmed receipt advances without
  // a separate Next command; the old graph remains the audible source.
  assert.equal(client.answerCalls[0]?.token, firstToken);
  assert.equal(client.answerCalls[0]?.answer, "A");
  assert.equal(client.nextCalls, 2);
  assert.equal(player.pauseCalls, pauseCalls, "routine answer submission must not pause");
  assert.equal(player.playCalls, playCalls, "continuation must not restart or resume playback");
  const secondToken = controller.state.trial?.token;
  assert.ok(secondToken && secondToken !== firstToken);
  assert.equal(controller.state.answered, false);
  assert.equal(controller.state.playback?.playing, true);
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, true);
  assert.ok(
    transitions.some((entry) => entry.answered && entry.playing && entry.token === firstToken),
    "the accepted-answer state must remain audible before the next set is staged",
  );
  assert.equal(
    transitions.some((entry) => entry.token === secondToken && entry.answered),
    false,
    "the new token must not inherit answer authority from the old one",
  );

  // No answer is possible until the listener explicitly picks a new label.
  const answerCalls = client.answerCalls.length;
  await controller.answer("B");
  assert.equal(client.answerCalls.length, answerCalls);

  controller.select("B");
  assert.equal(controller.state.playback?.selected, "B");
  assert.equal(controller.state.playback?.selectionRequired, false);
  assert.equal(controller.state.playback?.carryingPreviousTrial, false);
  assert.equal(controller.state.playback?.playing, true);
  await controller.answer("B");
  assert.equal(client.answerCalls.length, answerCalls + 1);
  assert.equal(client.answerCalls.at(-1)?.token, secondToken);
  assert.equal(client.answerCalls.at(-1)?.answer, "B");
});

test("the final accepted answer stops audio and draws no further token", async () => {
  const plan: ExperimentPlan = { ...PLAN, plannedTrials: 1, calibrationEnabled: false };
  const { client, player, controller } = makeController();
  await controller.prepareSession(plan, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const pauseCalls = player.pauseCalls;
  await controller.answer("A");
  assert.equal(client.nextCalls, 1, "completion must not draw a token past planned N");
  assert.equal(player.pauseCalls, pauseCalls + 1, "completion stops the last sounding trial");
  assert.equal(controller.state.session, "completed");
  assert.equal(controller.state.answered, true);
  assert.equal(controller.state.playback?.playing, false);
  assert.match(controller.state.notice ?? "", /Pre-registered N reached/);
});

test("a paused answer stays paused across auto-advance and needs an explicit pick and Play", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  const playCalls = player.playCalls;
  const pauseCalls = player.pauseCalls;
  await controller.answer("A");
  assert.equal(client.nextCalls, 2);
  assert.equal(player.playCalls, playCalls, "continuation must not start audio");
  assert.equal(player.pauseCalls, pauseCalls, "there was no sounding graph to pause");
  assert.equal(controller.state.playback?.playing, false);
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, false);
  await controller.answer("B");
  assert.equal(client.answerCalls.length, 1, "the new token cannot be answered before a pick");
  controller.select("A");
  await controller.play();
  assert.equal(controller.state.playback?.playing, true);
});

test("a failed continuation keeps retired sound, blocks answers, and retries the same pending token", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const firstToken = controller.state.trial!.token;
  const playCalls = player.playCalls;
  player.failNextLoad = true;
  const pauseCalls = player.pauseCalls;
  await controller.answer("A");
  const secondToken = controller.state.trial?.token;
  assert.ok(secondToken && secondToken !== firstToken);
  assert.equal(client.nextCalls, 2);
  assert.equal(controller.state.playback?.phase, "error");
  assert.equal(controller.state.playback?.playing, true, "the old graph remains retired monitoring");
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, true);
  assert.equal(controller.state.answered, false);
  assert.equal(controller.state.error?.retry, "load");
  assert.equal(player.pauseCalls, pauseCalls);
  const answers = client.answerCalls.length;
  await controller.answer("B");
  assert.equal(client.answerCalls.length, answers, "a failed pending set enables no answer authority");

  await controller.retryLoad();
  assert.equal(client.nextCalls, 2, "retry must not redraw the pending token");
  assert.equal(player.loadCalls.at(-1)?.token, secondToken);
  assert.equal(controller.state.playback?.phase, "ready");
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, true);
  assert.equal(player.playCalls, playCalls, "continuation retry never auto-starts audio");
  controller.select("B");
  assert.equal(controller.state.playback?.selectionRequired, false);
  assert.equal(controller.state.playback?.carryingPreviousTrial, false);
});

test("failed atomic load keeps the pending token and retry never redraws", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  player.failNextLoad = true;
  await controller.start();
  assert.equal(controller.state.playback?.phase, "error");
  assert.equal(controller.state.error?.retry, "load");
  const failed = controller.state.trial;
  assert.equal(controller.state.answered, false);
  assert.equal(client.nextCalls, 1);
  assert.equal(player.loadCalls.length, 1);
  await controller.retryLoad();
  assert.equal(client.nextCalls, 1);
  assert.equal(player.loadCalls.length, 2);
  assert.equal(player.loadCalls[1]?.token, failed?.token);
  assert.equal(controller.state.playback?.phase, "ready");
});

test("uncertain answer reconciles from lastAnswer exactly once before one auto-advance", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const token = controller.state.trial?.token;
  const feedbacks: AnswerReceipt[] = [];
  controller.subscribe((state) => {
    if (state.feedback !== null && !feedbacks.some((entry) => entry.token === state.feedback?.token)) {
      feedbacks.push(state.feedback);
    }
  });
  client.behavior.answerError = { code: "request-timeout", message: "timeout", uncertain: true };
  client.behavior.answerCommits = true;
  const pauseCalls = player.pauseCalls;
  await controller.answer("B");
  assert.equal(client.answerCalls.length, 1, "the committed timeout must not resubmit");
  assert.equal(client.answerCalls[0]?.token, token);
  assert.equal(feedbacks.length, 1);
  assert.equal(feedbacks[0]?.token, token);
  assert.equal(feedbacks[0]?.answer, "B");
  assert.equal(client.nextCalls, 2, "exactly one next token is drawn after reconciliation");
  assert.notEqual(controller.state.trial?.token, token);
  assert.equal(controller.state.answered, false);
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, true);
  assert.equal(player.pauseCalls, pauseCalls, "reconciliation keeps the sounding clock");
});

test("uncertain answer retries only the same token and answer, then advances once", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const token = controller.state.trial?.token;
  client.behavior.answerError = { code: "request-timeout", message: "lost reply", uncertain: true };
  client.behavior.answerCommits = false;
  await controller.answer("A");
  assert.equal(client.answerCalls.length, 2);
  assert.deepEqual(client.answerCalls.map((call) => call.token), [token, token]);
  assert.deepEqual(client.answerCalls.map((call) => call.answer), ["A", "A"]);
  assert.equal(client.nextCalls, 2);
  assert.notEqual(controller.state.trial?.token, token);
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, true);
  assert.equal(player.snapshot().playing, true, "the retired graph keeps sounding through retry");
});

test("reset during a held load invalidates late audio and preserves the prepared pair", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  player.deferNextLoad = true;
  const starting = controller.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(player.loadCalls.length, 1);
  await controller.reset();
  assert.equal(player.resetCalls, 1);
  assert.equal(client.resetCalls, 1);
  player.releaseDeferred();
  await starting;
  assert.equal(controller.state.session, "configured");
  assert.equal(controller.state.trial, null);
  assert.equal(controller.state.playback?.phase, "empty");
  assert.equal(controller.state.snapshot?.prepared?.artifactId, ARTIFACT.id);
});

test("bind timeout is reconciled by prepared hashes without rebinding", async () => {
  const { client, controller } = makeController();
  client.behavior.bindError = { code: "request-timeout", message: "bind timeout" };
  client.behavior.bindCommits = true;
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(client.bindCalls, 1);
  assert.equal(controller.state.session, "configured");
  assert.equal(controller.state.snapshot?.prepared?.aWavSha256, ARTIFACT.a.delivered.wavSha256);
  assert.match(controller.state.notice ?? "", /timed out/);
});

test("unconfirmed bind timeout publishes no run and does not auto-rebind", async () => {
  const { client, controller } = makeController();
  client.behavior.bindError = { code: "request-timeout", message: "bind timeout" };
  client.behavior.bindCommits = false;
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(client.bindCalls, 1);
  assert.equal(controller.state.error?.code, "request-timeout");
  assert.equal(controller.state.canExport, false);
  assert.equal(controller.state.planLocked, false);
});

test("seal is terminal, disables advancement, and export keeps the wrapper version", async () => {
  const { controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.answer("A");
  await controller.seal();
  assert.equal(controller.state.session, "sealed");
  const nextCallsBefore = controller.state.snapshot?.statistics.scoredTrials;
  await controller.next();
  assert.equal(controller.state.snapshot?.statistics.scoredTrials, nextCallsBefore);
  const payload = await controller.exportPayload();
  assert.equal(payload?.schema, LISTENING_EXPORT_SCHEMA);
  assert.equal(payload?.prepared.purpose, "diagnostic-only");
  assert.equal(payload?.experiment.reveal.redacted, true);
  await controller.select("A");
  assert.equal(controller.state.playback?.selected, "X");
});

test("fatal Worker errors never recreate the run or pretend an export exists", async () => {
  const { client, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  client.behavior.answerError = { code: "worker-fatal", message: "worker died" };
  await controller.answer("A");
  assert.equal(controller.state.session, "fatal");
  assert.equal(controller.state.canExport, false);
  assert.equal(client.configureCalls, 1);
  assert.equal(await controller.exportPayload(), null);
});

test("idle fatal notification stops playing audio, blocks answers/export and invalidates queued work", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  assert.equal(controller.state.playback?.playing, true);
  const nextCalls = client.nextCalls;
  const resetCalls = player.resetCalls;

  client.emitFatal({
    code: "worker-fatal",
    message: "Desktop worker stopped. Close and restart the application.",
    reasons: ["worker exited"],
    uncertain: false,
  });

  assert.equal(controller.state.session, "fatal");
  assert.equal(controller.state.busy, null);
  assert.equal(controller.state.playback?.playing, false);
  assert.equal(player.resetCalls, resetCalls + 1);
  assert.equal(controller.state.canExport, false);
  assert.equal(controller.state.error?.code, "worker-fatal");
  assert.match(controller.state.notice ?? "", /no run is recreated automatically/);

  await controller.answer("A");
  await controller.next();
  await controller.play();
  assert.equal(client.answerCalls.length, 0);
  assert.equal(client.nextCalls, nextCalls);
  assert.equal(await controller.exportPayload(), null);
  assert.equal(client.configureCalls, 1, "no replacement run is configured");

  await controller.closeSession();
  assert.equal(client.fatalUnsubscribes, 1);
});

test("fatal notification during a held trial load supersedes the late result", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  player.deferNextLoad = true;
  const starting = controller.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(player.loadCalls.length, 1);
  client.emitFatal({
    code: "protocol-error",
    message: "Desktop worker protocol failed.",
    reasons: [],
    uncertain: false,
  });
  player.releaseDeferred();
  await starting;
  assert.equal(controller.state.session, "fatal");
  assert.equal(controller.state.trial, null);
  assert.equal(controller.state.playback?.playing, false);
  await controller.dispose();
  assert.equal(client.fatalUnsubscribes, 1);
});

test("full ordered request identity rebinds a different chain prefix but not an identical chain", async () => {
  const { client, controller } = makeController();
  const chain = (a: readonly { codecId: CodecId; bitrateKbps: number }[]): PreparedArtifact => {
    const artifact = structuredClone(ARTIFACT) as PreparedArtifact & {
      request: PreparationRequest;
    };
    (artifact as { request: PreparationRequest }).request = {
      version: 2,
      preparationPolicy: "aligned-gain-matched-v1",
      canaryEnabled: true,
      sampleRateMode: "native",
      a,
      b: [{ codecId: "opus", bitrateKbps: 128 }],
    };
    (artifact.a as { stages?: readonly StageProvenance[] }).stages = a.map((stage, index) => ({
      stageIndex: index + 1,
      requested: stage,
      encoder: stage.codecId,
      decoder: stage.codecId,
      actualBitrateKbps: null,
      encodedSampleRate: 48_000,
    }));
    return artifact;
  };
  const first = chain([
    { codecId: "opus", bitrateKbps: 64 },
    { codecId: "mp3", bitrateKbps: 128 },
  ]);
  await controller.prepareSession(PLAN, first, READERS);
  assert.equal(client.bindCalls, 1);

  await controller.prepareSession(PLAN, structuredClone(first), READERS);
  assert.equal(client.bindCalls, 1, "the same frozen request must not rebind");

  // Same terminal stage, different earlier stage: only full request identity
  // catches this. Comparing final-only fields would incorrectly reuse it.
  const changed = chain([
    { codecId: "aac", bitrateKbps: 96 },
    { codecId: "mp3", bitrateKbps: 128 },
  ]);
  await controller.prepareSession(PLAN, changed, READERS);
  assert.equal(client.bindCalls, 2, "a changed chain prefix must trigger a fresh bind");
});

test("dispose releases player and client exactly once", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.dispose();
  await controller.dispose();
  assert.equal(player.disposeCalls, 1);
  assert.equal(client.disposeCalls, 1);
});

test("unresolved answers lock the original label and keep the old graph until manual reconciliation advances once", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const token = controller.state.trial!.token;
  client.behavior.onAnswer = async () => {
    throw { code: "request-timeout", message: "lost response", uncertain: true };
  };
  const pauseCalls = player.pauseCalls;
  await controller.answer("A");
  assert.equal(client.answerCalls.length, 2);
  assert.equal(controller.state.error?.uncertain, true);
  assert.equal(controller.state.pendingAnswer, "A");
  assert.equal(controller.state.playback?.playing, true, "an unresolved answer must not stop the clock");
  assert.equal(player.pauseCalls, pauseCalls);
  assert.equal(client.nextCalls, 1, "an unresolved answer must not draw a new token");

  const count = client.answerCalls.length;
  await controller.answer("B");
  controller.select("A");
  await controller.play();
  await controller.next();
  assert.equal(client.answerCalls.length, count);
  assert.equal(controller.state.pendingAnswer, "A");
  assert.equal(controller.state.error?.uncertain, true);

  delete client.behavior.onAnswer;
  await controller.retryAnswer();
  assert.equal(client.nextCalls, 2, "manual reconciliation advances exactly once");
  assert.notEqual(controller.state.trial?.token, token);
  assert.equal(controller.state.answered, false);
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, true);
  assert.ok(client.answerCalls.every((call) => call.token === token && call.answer === "A"));
  assert.equal(player.pauseCalls, pauseCalls, "reconciliation must not pause the prior audio");
});

test("listening provenance is captured before configure awaits and remains immutable for export", async () => {
  const { client, controller } = makeController();
  const artifact = structuredClone(ARTIFACT);
  const configure = client.configure.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  client.configure = async (plan) => { await gate; return configure(plan); };
  const preparing = controller.prepareSession(PLAN, artifact, READERS);
  (artifact.engine as { build: string }).build = "mutated while configuring";
  release();
  await preparing;
  (artifact.a as { actualBitrateKbps: number }).actualBitrateKbps = 999;
  const payload = await controller.exportPayload();
  assert.equal((payload!.prepared.engine as { build: string }).build, ARTIFACT.engine.build);
  assert.equal((payload!.prepared.tracks as { a: { actualBitrateKbps: number | null } }).a.actualBitrateKbps, ARTIFACT.a.actualBitrateKbps);
});

test("failed initial binds leave visible recovery state and unconfirmed retries do not bind again", async () => {
  const { client, controller } = makeController();
  client.behavior.bindError = { code: "request-timeout", message: "bind timeout" };
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(controller.state.session, "configured");
  assert.equal(controller.state.snapshot?.prepared, null);
  assert.equal(controller.state.canExport, false);
  delete client.behavior.bindError;
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(client.bindCalls, 1, "unconfirmed binding retries must reconcile instead of sending a second bind");
  assert.equal(controller.state.error?.retry, "prepare");
  await controller.start();
  assert.equal(client.nextCalls, 0);
  await controller.reset();
  assert.equal(controller.state.canExport, false);
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(client.bindCalls, 2);
  assert.equal(controller.state.error, null);
});

test("fatal export failure stops playing audio immediately", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  client.export = async () => { throw { code: "worker-fatal", message: "worker died" }; };
  assert.equal(await controller.exportPayload(), null);
  assert.equal(controller.state.session, "fatal");
  assert.equal(controller.state.canExport, false);
  assert.equal(player.resetCalls, 1);
  assert.equal(player.snapshot().playing, false);
});

test("late Play completion cannot overwrite a closed or replacement session", async () => {
  const player = new FakePlayer();
  let players = 0;
  const controller = new ListeningController({
    createClient: () => new FakeClient(),
    createPlayer: () => players++ === 0 ? player : new FakePlayer(),
  });
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  const stale = { ...player.snapshot(), playing: true };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  player.play = async () => { await gate; return stale; };
  const playing = controller.play();
  await controller.closeSession();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  release();
  await playing;
  assert.equal(controller.state.playback?.trial, null);
  assert.equal(controller.state.playback?.playing, false);
  assert.equal(controller.state.session, "configured");
});

test("same-byte artifacts with changed provenance require a fresh verified binding", async () => {
  const { client, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  const changed = structuredClone(ARTIFACT);
  (changed.engine as { build: string }).build = "new verified engine build";
  await controller.prepareSession(PLAN, changed, READERS);
  assert.equal(client.bindCalls, 2);
  const payload = await controller.exportPayload();
  assert.equal(payload?.experiment.snapshot.prepared?.engineBuild, changed.engine.build);
  assert.equal((payload?.prepared.engine as { build: string }).build, changed.engine.build);
});

test("ready-but-suspended audio failures are disclosed and recover on user Play", async () => {
  for (const path of ["explicit", "retry-load", "paused-continuation"] as const) {
    const { controller, player } = makeController();
    await controller.prepareSession(PLAN, ARTIFACT, READERS);
    const originalPlay = player.play.bind(player);
    if (path === "retry-load") {
      player.failNextLoad = true;
      await controller.start();
      await controller.retryLoad();
    } else {
      await controller.start();
    }
    if (path === "paused-continuation") {
      await controller.play();
      await controller.pause();
      await controller.answer("A");
      assert.equal(controller.state.playback?.playing, false, "a paused answer stays paused");
      assert.equal(controller.state.playback?.selectionRequired, true);
      controller.select("B");
    }
    const blocked = (): PlaybackSnapshot => {
      player.current = { ...player.current, phase: "ready", playing: false, error: "context-suspended: browser audio could not resume" };
      return player.snapshot();
    };
    player.play = async () => blocked();
    await controller.play();
    assert.equal(controller.state.playback?.phase, "ready", path);
    assert.equal(controller.state.error?.code, "audio-unavailable", path);
    assert.match(controller.state.error?.message ?? "", /context-suspended/, path);
    assert.equal(controller.state.playback?.playing, false, path);
    controller.select("B");
    assert.equal(controller.state.error?.code, "audio-unavailable", `${path}: selection must not hide a persistent audio error`);
    player.play = async () => {
      player.current = { ...player.current, error: null };
      return originalPlay();
    };
    await controller.play();
    assert.equal(controller.state.error, null, `${path}: successful retry clears the audio issue`);
    assert.equal(controller.state.playback?.playing, true, path);
  }
});

test("output selection is explicit before the plan lock and refused after first staging until reset", async () => {
  const { controller, player } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  assert.equal(controller.state.outputBlocked, false);
  assert.equal(controller.state.playback?.output?.support, "supported");

  await controller.refreshOutputDevices();
  assert.equal(player.refreshOutputCalls, 1);
  await controller.selectOutputDevice("device-secret-1");
  assert.deepEqual(player.selectOutputCalls, ["device-secret-1"]);
  assert.equal(controller.state.playback?.output?.selectedDeviceId, "device-secret-1");
  assert.doesNotMatch(controller.state.notice ?? "", /device-secret-1|Listener speaker/);

  await controller.start();
  assert.equal(controller.state.planLocked, true);
  await controller.selectOutputDevice("");
  assert.equal(controller.state.error?.code, "output-locked");
  assert.equal(controller.state.error?.retry, "reset");
  assert.deepEqual(player.selectOutputCalls, ["device-secret-1"], "no locked route change is attempted");

  await controller.reset();
  assert.equal(controller.state.outputBlocked, false);
  assert.equal(controller.state.planLocked, false);
  await controller.selectOutputDevice("");
  assert.deepEqual(player.selectOutputCalls, ["device-secret-1", ""]);
  assert.equal(controller.state.playback?.output?.selectedDeviceId, "");
  assert.equal(controller.state.error, null);
});

test("a route change after the plan lock pauses immediately and blocks Play/Next/answers until Reset", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  assert.equal(controller.state.playback?.playing, true);
  const playCalls = player.playCalls;
  const pauseCalls = player.pauseCalls;

  player.changeOutputRoute("changed");
  assert.equal(controller.state.outputBlocked, true);
  assert.equal(controller.state.playback?.playing, false);
  assert.ok(player.pauseCalls > pauseCalls, "route change must pause synchronously");
  assert.equal(controller.state.error?.code, "output-route-changed");
  assert.equal(controller.state.error?.retry, "reset");
  await controller.refreshOutputDevices();
  assert.equal(controller.state.error?.code, "output-route-changed",
    "a refresh must not clear the route block");

  await controller.play();
  await controller.answer("A");
  await controller.next();
  assert.equal(player.playCalls, playCalls, "Play is blocked after a locked route change");
  assert.equal(client.answerCalls.length, 0);
  assert.equal(client.nextCalls, 1, "Next is blocked after a locked route change");

  await controller.reset();
  assert.equal(controller.state.outputBlocked, false);
  assert.equal(controller.state.error, null);
  await controller.start();
  const afterResetPlay = player.playCalls;
  await controller.play();
  assert.equal(player.playCalls, afterResetPlay + 1, "Reset explicitly restores playback control");
  assert.equal(controller.state.playback?.playing, true);
});

test("route changes before the plan lock are visible without blocking setup", async () => {
  const { controller, player } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  player.changeOutputRoute("lost");
  assert.equal(controller.state.outputBlocked, false);
  assert.equal(controller.state.playback?.output?.change, "lost");
  await controller.selectOutputDevice("device-secret-1");
  assert.equal(controller.state.playback?.output?.change, "none");
});

test("a failed output selection is surfaced as an error and never claims success", async () => {
  const { controller, player } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  player.failOutputSelection = true;
  await controller.selectOutputDevice("device-secret-1");
  assert.equal(controller.state.error?.code, "output-selection-failed");
  assert.match(controller.state.error?.message ?? "", /output-device-unavailable/);
  assert.doesNotMatch(controller.state.error?.message ?? "", /device-secret-1|Listener speaker/);
  assert.doesNotMatch(controller.state.notice ?? "", /applied/);
  assert.equal(controller.state.playback?.output?.selectedDeviceId, null);
});

test("listening export redacts device ids/labels but records selection facts and the actual rate", async () => {
  const { controller, player } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.selectOutputDevice("device-secret-1");
  player.current = { ...player.current, outputSampleRate: 48_000 };
  controller.syncPlayback();
  const payload = await controller.exportPayload();
  assert.ok(payload);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /device-secret-1/);
  assert.doesNotMatch(serialized, /Listener speaker/);
  const outputSelection = (payload!.playback as {
    outputSelection: Record<string, unknown>;
  }).outputSelection;
  assert.equal(outputSelection.support, "supported");
  assert.equal(outputSelection.chooserAvailable, true);
  assert.equal(outputSelection.selectionRequested, true);
  assert.equal(outputSelection.selectionApplied, true);
  assert.equal(outputSelection.selectionObserved, true);
  assert.equal(outputSelection.observedRoute, "named");
  assert.equal(outputSelection.routeChange, "none");
  assert.equal(outputSelection.deviceIdsOrLabelsExported, false);
  assert.equal(outputSelection.actualContextSampleRate, 48_000);
  assert.equal((payload!.playback as { outputChannels: unknown }).outputChannels, null);
});

test("root regression: pending output operations cannot race first staging or scored controls", async () => {
  for (const operation of ["refresh", "select", "request"] as const) {
    const { client, player, controller } = makeController();
    await controller.prepareSession(PLAN, ARTIFACT, READERS);
    player.current = { ...player.current, output: { ...player.output, pending: operation } };
    controller.syncPlayback();
    await controller.start();
    assert.equal(client.nextCalls, 0, `${operation}: must not lock a plan on an unsettled route`);
    assert.equal(controller.state.planLocked, false);
    player.current = { ...player.current, output: player.output };
    controller.syncPlayback();
    await controller.start();
    const playCalls = player.playCalls;
    player.current = { ...player.current, output: { ...player.output, pending: operation } };
    controller.syncPlayback();
    await controller.play();
    await controller.answer("A");
    assert.equal(player.playCalls, playCalls, operation);
    assert.equal(client.answerCalls.length, 0, operation);
    await controller.dispose();
  }
});

test("root regression: route change during automatic continuation load prevents new audio and retains reset recovery", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  player.deferNextLoad = true;
  const answering = controller.answer("A");
  for (let i = 0; i < 20 && player.loadCalls.length < 2; i++) await Promise.resolve();
  assert.equal(player.loadCalls.length, 2);
  const playCalls = player.playCalls;
  player.changeOutputRoute("changed");
  player.releaseDeferred();
  await answering;
  assert.equal(controller.state.outputBlocked, true);
  assert.equal(controller.state.busy, null);
  assert.equal(controller.state.error?.retry, "reset");
  assert.equal(player.playCalls, playCalls, "a late continuation cannot resume across route loss");
  assert.equal(client.nextCalls, 2);
  await controller.dispose();
});

test("review regression: a route event during pending Reset cannot leave an invisible continuation block", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  const originalReset = client.reset.bind(client);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  client.reset = async () => { await gate; return originalReset(); };
  const resetting = controller.reset();
  player.changeOutputRoute("changed");
  finish();
  await resetting;
  assert.equal(controller.state.outputBlocked, false);
  assert.equal(controller.state.error, null);
  assert.equal(controller.state.playback?.output?.change, "none");
  await controller.start();
  assert.equal(client.nextCalls, 1);
  assert.equal(controller.state.planLocked, true);
  await controller.dispose();
});

test("review regression: a selection during refresh cannot claim it was applied", async () => {
  const { player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  player.current = { ...player.current, output: { ...player.output, pending: "refresh" } };
  controller.syncPlayback();
  player.selectOutputDevice = async () => player.snapshot();
  await controller.selectOutputDevice("device-secret-1");
  assert.doesNotMatch(controller.state.notice ?? "", /selection was applied/);
  assert.equal(controller.state.playback?.output?.selectedDeviceId, null);
  await controller.dispose();
});

test("review regression: discovery starting during load settles before token controls enable", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  const originalLoad = player.loadTrial.bind(player);
  player.loadTrial = async trial => {
    await originalLoad(trial);
    player.current = { ...player.current, output: { ...player.output, pending: "refresh" } };
    return player.snapshot();
  };
  const starting = controller.start();
  for (let i = 0; i < 30 && !controller.state.notice?.includes("Waiting for output"); i++) await Promise.resolve();
  assert.match(controller.state.notice ?? "", /Waiting for output/);
  assert.equal(controller.state.busy, "start");
  await controller.answer("A");
  assert.equal(client.answerCalls.length, 0);
  player.finishOutputRefresh();
  await starting;
  assert.equal(controller.state.busy, null);
  assert.equal(client.nextCalls, 1, "the already staged token is retained");
  await controller.play();
  assert.equal(player.snapshot().playing, true);
  await controller.dispose();
});

test("review regression: hung discovery after load has bounded Reset recovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  const originalLoad = player.loadTrial.bind(player);
  player.loadTrial = async trial => {
    await originalLoad(trial);
    player.current = { ...player.current, output: { ...player.output, pending: "refresh" } };
    return player.snapshot();
  };
  const starting = controller.start();
  for (let i = 0; i < 30 && !controller.state.notice?.includes("Waiting for output"); i++) await Promise.resolve();
  assert.match(controller.state.notice ?? "", /Waiting for output/);
  t.mock.timers.tick(5_001);
  await starting;
  assert.equal(controller.state.busy, null);
  assert.equal(controller.state.error?.code, "output-setup-timeout");
  assert.equal(controller.state.error?.retry, "reset");
  assert.equal(controller.state.outputBlocked, true);
  assert.equal(client.nextCalls, 1);
  await controller.reset();
  assert.equal(controller.state.outputBlocked, false);
  await controller.dispose();
});

test("mount output discovery refreshes on focus/visible return and cleanup removes every listener", () => {
  interface Target {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    dispatch(type: string): void;
    count(type: string): number;
    visibilityState: string;
  }
  const makeTarget = (visibilityState = "visible"): Target => {
    const listeners = new Map<string, Set<() => void>>();
    return {
      visibilityState,
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      dispatch(type) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      },
      count(type) {
        return listeners.get(type)?.size ?? 0;
      },
    };
  };
  const windowTarget = makeTarget();
  const documentTarget = makeTarget();
  let refreshes = 0;
  const controller = {
    refreshOutputDevices: async () => {
      refreshes += 1;
    },
  };
  const detach = attachOutputDiscovery(controller, {
    window: windowTarget,
    document: documentTarget,
  });
  assert.equal(refreshes, 1, "mount performs one permission-free enumeration");
  assert.equal(windowTarget.count("focus"), 1);
  assert.equal(documentTarget.count("visibilitychange"), 1);

  windowTarget.dispatch("focus");
  assert.equal(refreshes, 2, "focus return re-enumerates");
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");
  assert.equal(refreshes, 2, "a hidden tab does not re-enumerate");
  documentTarget.visibilityState = "visible";
  documentTarget.dispatch("visibilitychange");
  assert.equal(refreshes, 3, "visible return re-enumerates");

  detach();
  detach();
  assert.equal(windowTarget.count("focus"), 0);
  assert.equal(documentTarget.count("visibilitychange"), 0);
  windowTarget.dispatch("focus");
  documentTarget.dispatch("visibilitychange");
  assert.equal(refreshes, 3, "removed listeners must not leak refreshes");
});

test("pause during an in-flight answer stops audio without cancelling the receipt or auto-advance", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const token = controller.state.trial!.token;
  let release!: (receipt: AnswerReceipt) => void;
  const gate = new Promise<AnswerReceipt>((resolve) => { release = resolve; });
  client.behavior.onAnswer = async () => gate;
  const answering = controller.answer("A");
  for (let i = 0; i < 20 && controller.state.busy !== "answer"; i++) await Promise.resolve();
  assert.equal(controller.state.busy, "answer");
  const pauseCalls = player.pauseCalls;
  controller.pause();
  assert.equal(player.pauseCalls, pauseCalls + 1, "Pause must interrupt audible transport during submission");
  assert.equal(controller.state.playback?.playing, false);
  assert.equal(controller.state.pendingAnswer, "A", "the answer token and label stay latched");
  assert.equal(controller.state.busy, "answer", "pause must not cancel the in-flight receipt");

  release({
    runId: "run-1",
    token,
    trialIndex: 1,
    kind: "calibration",
    answer: "A",
    correct: true,
    answeredAtUtc: "2026-01-01T00:00:01.000Z",
  });
  await answering;
  assert.equal(client.answerCalls.length, 1);
  assert.equal(client.nextCalls, 2, "the accepted receipt still advances exactly once");
  assert.equal(controller.state.answered, false);
  assert.equal(controller.state.playback?.playing, false, "a paused submission stages the next trial paused");
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, false);
});

test("pause during a continuation load stops the retired graph and stages the next set paused", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  const playCalls = player.playCalls;
  player.deferNextLoad = true;
  const answering = controller.answer("A");
  for (let i = 0; i < 30 && !(controller.state.busy === "next" && player.loadCalls.length === 2); i++) {
    await Promise.resolve();
  }
  assert.equal(controller.state.busy, "next");
  assert.equal(player.loadCalls.length, 2);
  const pauseCalls = player.pauseCalls;
  controller.pause();
  assert.equal(player.pauseCalls, pauseCalls + 1, "Pause must interrupt transport during the next load");
  assert.equal(controller.state.answered, false);
  assert.ok(controller.state.trial, "the already-accepted next token stays staged");
  player.releaseDeferred();
  await answering;
  const token = controller.state.trial?.token;
  assert.ok(token);
  assert.equal(controller.state.playback?.trial?.token, token);
  assert.equal(controller.state.playback?.playing, false);
  assert.equal(controller.state.playback?.selectionRequired, true);
  assert.equal(controller.state.playback?.carryingPreviousTrial, false);
  assert.equal(player.playCalls, playCalls, "a paused continuation never restarts audio");
  assert.equal(client.nextCalls, 2);
});

test("end during an in-flight answer stops audio and close safely invalidates the pending receipt", async () => {
  const { client, player, controller } = makeController();
  await controller.prepareSession(PLAN, ARTIFACT, READERS);
  await controller.start();
  await controller.play();
  let release!: (receipt: AnswerReceipt) => void;
  const gate = new Promise<AnswerReceipt>((resolve) => { release = resolve; });
  client.behavior.onAnswer = async () => gate;
  const answering = controller.answer("A");
  for (let i = 0; i < 20 && controller.state.busy !== "answer"; i++) await Promise.resolve();
  const pauseCalls = player.pauseCalls;
  controller.pause();
  assert.equal(player.pauseCalls, pauseCalls + 1, "End stops audible transport before sealing");
  await controller.seal();
  assert.equal(controller.state.session, "running", "a busy run cannot claim to be sealed");
  await controller.closeSession();
  assert.equal(player.disposeCalls, 1);
  assert.equal(client.disposeCalls, 1);
  assert.equal(controller.state.session, "idle");
  assert.equal(controller.state.playback, null);

  release({
    runId: "run-1",
    token: controller.state.trial?.token ?? "token-1",
    trialIndex: 1,
    kind: "calibration",
    answer: "A",
    correct: true,
    answeredAtUtc: "2026-01-01T00:00:01.000Z",
  });
  await answering;
  assert.equal(client.answerCalls.length, 1);
  assert.equal(client.nextCalls, 1, "a closed session must ignore the late receipt");
  assert.equal(controller.state.session, "idle");
  assert.equal(controller.state.trial, null);
});
