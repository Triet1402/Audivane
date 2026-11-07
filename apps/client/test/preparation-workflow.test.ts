import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AnswerReceipt,
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
  TrialPlayer,
} from "@codec-abx/contracts";

import {
  ListeningController,
  type ListeningClient,
  type ListeningReaders,
} from "../src/listening/controller.js";
import {
  PrepareTestWorkflow,
  type PrepareTestEngine,
  type PrepareTestInputs,
} from "../src/preparation/workflow.js";

const PLAN: ExperimentPlan = Object.freeze({
  version: 1,
  plannedTrials: 4,
  alpha: 0.05,
  labelMode: "blind_random",
  calibrationEnabled: false,
});

const INPUTS: PrepareTestInputs = Object.freeze({
  sourceIdentity: "file:source.wav:1024:1",
  stagesA: Object.freeze([Object.freeze({ codecId: "noop_passthrough" as const, bitrateKbps: 0 })]),
  stagesB: Object.freeze([Object.freeze({ codecId: "opus" as const, bitrateKbps: 128 })]),
  rateMode: "native",
  calibrationEnabled: false,
  diagnosticPolicy: "aligned-gain-matched-v1",
});

const READERS: ListeningReaders = Object.freeze({
  readAudio: async () => new ArrayBuffer(8),
});

const OUTPUT: PlaybackOutputState = {
  support: "supported",
  canRequest: false,
  devices: [],
  pending: null,
  requestedDeviceId: null,
  selectedDeviceId: null,
  observedDeviceId: null,
  change: "none",
  error: null,
};

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

/** A listening-eligible browser-local aligned pair; the authority checks gate it. */
function artifact(id: string): PreparedArtifact {
  return {
    id,
    purpose: "diagnostic-only",
    request: {
      version: 1,
      preparationPolicy: "aligned-gain-matched-v1",
      sampleRateMode: "native",
      a: { codecId: "noop_passthrough", bitrateKbps: 0 },
      b: { codecId: "opus", bitrateKbps: 128 },
    },
    engine: {
      engineId: "engine-ffmpeg-wasm",
      location: "browser-local",
      build: "test",
      codecs: [],
      channels: [1, 2],
      maxInputBytes: 1024,
      maxDurationSeconds: 600,
      preparationPolicy: "aligned-gain-matched-v1",
      limitations: [],
    },
    sourceSha256: "1".repeat(64),
    a: {
      requested: { codecId: "noop_passthrough", bitrateKbps: 0 },
      encoder: "pcm_s16le",
      decoder: "pcm_s16le",
      actualBitrateKbps: null,
      encodedSampleRate: 48_000,
      delivered: { sampleRate: 48_000, channels: 1, frames: 576_000, wavSha256: "2".repeat(64) },
    },
    b: {
      requested: { codecId: "opus", bitrateKbps: 128 },
      encoder: "libopus",
      decoder: "libopus",
      actualBitrateKbps: 128,
      encodedSampleRate: 48_000,
      delivered: { sampleRate: 48_000, channels: 1, frames: 576_000, wavSha256: "3".repeat(64) },
    },
    elapsedMs: 1,
    measurements: {
      policy: "aligned-gain-matched-v1",
      delivered: { policy: "delivered-validity-v2" },
    },
    preparation: { policy: "aligned-gain-matched-v1" },
    validity: {
      policy: "delivered-validity-v2",
      preparationGate: { policy: "preparation-validity-v2", status: "passed" },
    },
    disclosures: [],
  } as unknown as PreparedArtifact;
}

function snapshot(plan: ExperimentPlan): ExperimentSnapshot {
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
    statistics: {
      scoredTrials: 0,
      correctTrials: 0,
      plannedTrials: plan.plannedTrials,
      requiredCorrect: plan.plannedTrials,
      pValue: 1,
      ability: null,
      abilityCi95: [0.1, 0.9],
      significant: false,
      isFinal: false,
      significantVerdict: false,
    },
    sealedReason: null,
    limitations: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Controlled experiment service adapter. It commits or refuses the exact-byte
 * bind, can hold the reply open, and can report a timeout with or without a
 * committed pair so the controller's uncertainty reconciliation is exercised.
 */
class FakeClient implements ListeningClient {
  data: Mutable<ExperimentSnapshot> = snapshot(PLAN) as Mutable<ExperimentSnapshot>;
  configureCalls = 0;
  bindCalls = 0;
  nextCalls = 0;
  disposeCalls = 0;
  bindError: unknown = null;
  bindCommits = true;
  bindGate: Deferred<void> | null = null;
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async configure(plan: ExperimentPlan): Promise<ExperimentSnapshot> {
    this.configureCalls += 1;
    this.data.plan = clone(plan);
    return clone(this.data);
  }

  async bindPrepared(artifact: PreparedArtifact): Promise<ExperimentSnapshot> {
    this.bindCalls += 1;
    if (this.bindGate !== null) await this.bindGate.promise;
    const error = this.bindError;
    if (error !== null) {
      if (this.bindCommits) this.#commit(artifact);
      this.bindError = null;
      throw error;
    }
    this.#commit(artifact);
    return clone(this.data);
  }

  #commit(artifact: PreparedArtifact): void {
    this.data.prepared = {
      artifactId: artifact.id,
      aWavSha256: artifact.a.delivered.wavSha256,
      bWavSha256: artifact.b.delivered.wavSha256,
      sourceSha256: artifact.sourceSha256,
      engineId: artifact.engine.engineId,
      engineBuild: artifact.engine.build,
      request: clone(artifact.request),
      preparationLocation: artifact.engine.location,
    };
    this.data.gates = {
      nullStatus: "not-applicable",
      preparationStatus: "passed",
      preparationClassification: "same-polarity-unique",
      preparationReason: "workflow fixture",
      preparationDisclosure: null,
      calibrationStatus: this.data.plan.calibrationEnabled ? "pending" : "not-configured",
      reasons: [],
    };
  }

  async snapshot(): Promise<ExperimentSnapshot> {
    return clone(this.data);
  }

  async nextTrial(): Promise<PublicTrial> {
    this.nextCalls += 1;
    const trial: PublicTrial = {
      runId: this.data.runId,
      token: `token-${this.nextCalls}`,
      trialIndex: this.nextCalls,
      kind: "scored",
    };
    this.data.pendingTrial = trial;
    this.data.lifecycle = "running";
    this.data.lockedAtUtc = "2026-01-01T00:00:00.000Z";
    return clone(trial);
  }

  async answer(): Promise<AnswerReceipt> {
    throw new Error("not used");
  }

  async readAudio(): Promise<ArrayBuffer> {
    return new ArrayBuffer(8);
  }

  async seal(): Promise<ExperimentSnapshot> {
    return clone(this.data);
  }

  async reset(): Promise<ExperimentSnapshot> {
    return clone(this.data);
  }

  async export(): Promise<ExperimentExport> {
    throw new Error("not used");
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.events.push("controller:client");
    // A closed session ends the service/Worker; the next configure starts a
    // fresh configured run, exactly as a new client instance would.
    this.nextCalls = 0;
    this.data = snapshot(PLAN) as Mutable<ExperimentSnapshot>;
  }
}

class FakePlayer implements TrialPlayer {
  current: PlaybackSnapshot = { ...EMPTY_PLAYBACK, output: clone(OUTPUT) };
  loadCalls: PublicTrial[] = [];
  playCalls = 0;
  pauseCalls = 0;
  disposeCalls = 0;
  loadGate: Deferred<void> | null = null;
  readonly #listeners = new Set<(value: PlaybackSnapshot) => void>();
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  async loadTrial(trial: PublicTrial): Promise<PlaybackSnapshot> {
    this.loadCalls.push(trial);
    if (this.loadGate !== null) await this.loadGate.promise;
    this.current = {
      ...EMPTY_PLAYBACK,
      phase: "ready",
      trial,
      durationSeconds: 12,
      output: clone(OUTPUT),
    };
    this.#emit();
    return this.current;
  }

  async play(): Promise<PlaybackSnapshot> {
    this.playCalls += 1;
    this.current = { ...this.current, playing: true };
    this.#emit();
    return this.current;
  }

  pause(): PlaybackSnapshot {
    this.pauseCalls += 1;
    this.current = { ...this.current, playing: false };
    this.#emit();
    return this.current;
  }

  select(label: PlaybackLabel): PlaybackSnapshot {
    this.current = { ...this.current, selected: label };
    return this.current;
  }

  seek(positionSeconds: number): PlaybackSnapshot {
    this.current = { ...this.current, positionSeconds };
    return this.current;
  }

  setLoop(loop: PlaybackLoop): PlaybackSnapshot {
    this.current = { ...this.current, loop };
    return this.current;
  }

  snapshot(): PlaybackSnapshot {
    return this.current;
  }

  subscribe(listener: (value: PlaybackSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  reset(): PlaybackSnapshot {
    this.current = { ...EMPTY_PLAYBACK, output: clone(OUTPUT) };
    return this.current;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.#events.push("controller:player");
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener(this.current);
  }
}

interface Harness {
  readonly workflow: PrepareTestWorkflow<string, PreparedArtifact>;
  readonly controller: ListeningController;
  readonly engine: PrepareTestEngine<string, PreparedArtifact>;
  readonly client: FakeClient;
  readonly player: FakePlayer;
  readonly releases: string[];
  readonly requests: PreparationRequest[];
  readonly published: (string | null)[];
  readonly cleanupFailures: string[];
  readonly events: string[];
  prepareCount(): number;
  setPrepareHook(hook: ((signal: AbortSignal | undefined) => Promise<PreparedArtifact>) | null): void;
  setFailRelease(fail: boolean): void;
  setFailEngineDispose(fail: boolean): void;
}

async function harness(): Promise<Harness> {
  const events: string[] = [];
  const releases: string[] = [];
  const requests: PreparationRequest[] = [];
  const published: (string | null)[] = [];
  const cleanupFailures: string[] = [];
  let prepareCalls = 0;
  let prepareHook: ((signal: AbortSignal | undefined) => Promise<PreparedArtifact>) | null = null;
  let failRelease = false;
  let failEngineDispose = false;
  const engine: PrepareTestEngine<string, PreparedArtifact> = {
    async prepare(_source, request, options) {
      prepareCalls += 1;
      requests.push(clone(request));
      if (prepareHook !== null) return await prepareHook(options.signal);
      return artifact(`artifact-${prepareCalls}`);
    },
    async release(artifactId) {
      releases.push(artifactId);
      if (failRelease) throw new Error("release acknowledgement missing");
    },
    async dispose() {
      events.push("engine");
      if (failEngineDispose) throw new Error("engine dispose failed");
    },
  };
  const client = new FakeClient(events);
  const player = new FakePlayer(events);
  const controller = new ListeningController({
    createClient: () => client,
    createPlayer: () => player,
  });
  const workflow = new PrepareTestWorkflow<string, PreparedArtifact>({
    desktop: false,
    engine,
    controller,
    readers: READERS,
    isListeningLocked: () => controller.state.session !== "idle",
    buildRequest: (inputs, mode) => ({
      version: 1,
      sampleRateMode: inputs.rateMode,
      ...(mode === "prepare-test" || inputs.diagnosticPolicy === "aligned-gain-matched-v1"
        ? { preparationPolicy: "aligned-gain-matched-v1" as const }
        : {}),
      ...(inputs.calibrationEnabled ? { canaryEnabled: true } : {}),
      a: inputs.stagesA[0]!,
      b: inputs.stagesB[0]!,
    }),
    publishError: (message) => published.push(message),
    reportCleanupFailure: (message) => cleanupFailures.push(message),
  });
  assert.equal(await workflow.chooseSource("source.wav"), true);
  return {
    workflow,
    controller,
    engine,
    client,
    player,
    releases,
    requests,
    published,
    cleanupFailures,
    events,
    prepareCount: () => prepareCalls,
    setPrepareHook: (hook) => {
      prepareHook = hook;
    },
    setFailRelease: (fail) => {
      failRelease = fail;
    },
    setFailEngineDispose: (fail) => {
      failEngineDispose = fail;
    },
  };
}

function assertPausedFirstTrial(h: Harness): void {
  assert.equal(h.workflow.state.phase, "ready");
  assert.notEqual(h.controller.state.trial, null);
  assert.equal(h.controller.state.playback?.playing, false);
  assert.equal(h.player.playCalls, 0, "staging must never start playback");
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

for (const action of ["cancel", "prepareDiagnostic"] as const) {
  test(`settled listening is preserved when setup-only ${action} is invoked`, async (t) => {
    const h = await harness();
    t.after(() => h.workflow.dispose());
    await h.workflow.prepareTest(INPUTS, PLAN);
    const trial = h.controller.state.trial;
    if (action === "cancel") await h.workflow.cancel();
    else await h.workflow.prepareDiagnostic(INPUTS);
    assert.equal(h.controller.state.session, "running");
    assert.equal(h.controller.state.trial, trial);
    assert.equal(h.workflow.state.phase, "ready");
    assert.equal(h.prepareCount(), 1);
  });
}

test("one command prepares, binds the exact pair and stages trial 1 paused", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, PLAN);

  assertPausedFirstTrial(h);
  assert.equal(h.controller.state.trial?.trialIndex, 1);
  assert.equal(h.client.nextCalls, 1);
  assert.equal(h.prepareCount(), 1);
  assert.equal(h.client.bindCalls, 1);
  assert.deepEqual(h.requests[0], {
    version: 1,
    sampleRateMode: "native",
    preparationPolicy: "aligned-gain-matched-v1",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "opus", bitrateKbps: 128 },
  });
  assert.equal(h.workflow.state.message, "Trial 1 is paused. Press Play when ready.");
  assert.equal(h.workflow.state.error, null);
  assert.equal(h.workflow.isPairReady(INPUTS), true);
  await h.workflow.dispose();
});

test("same captured inputs reuse the retained pair and re-bind without re-encoding", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, PLAN);
  await h.controller.closeSession();
  assert.equal(h.workflow.isPairReady(INPUTS), true);

  await h.workflow.prepareTest(INPUTS, PLAN);

  assertPausedFirstTrial(h);
  assert.equal(h.prepareCount(), 1, "an unchanged input set must not prepare again");
  assert.equal(h.client.bindCalls, 2, "the explicit retry binds the retained pair again");
  assert.deepEqual(h.releases, []);
  await h.workflow.dispose();
});

test("a changed source, codec, rate or readiness opt-in invalidates reuse", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, PLAN);
  await h.controller.closeSession();

  assert.equal(h.workflow.isPairReady({ ...INPUTS, sourceIdentity: "file:other.wav:1:2" }), false);
  assert.equal(h.workflow.isPairReady({
    ...INPUTS,
    stagesB: [{ codecId: "opus", bitrateKbps: 96 }],
  }), false);
  assert.equal(h.workflow.isPairReady({ ...INPUTS, rateMode: "force_48k" }), false);
  assert.equal(h.workflow.isPairReady({ ...INPUTS, calibrationEnabled: true }), false);

  await h.workflow.prepareTest({
    ...INPUTS,
    stagesB: [{ codecId: "opus", bitrateKbps: 96 }],
  }, PLAN);

  assert.equal(h.prepareCount(), 2, "changed inputs prepare a new pair");
  assert.deepEqual(h.releases, ["artifact-1"], "the replaced artifact is released");
  assert.equal(h.controller.state.trial?.trialIndex, 1);
  assert.equal(h.player.playCalls, 0);
  await h.workflow.dispose();
});

test("a failed release is reported, retains cleanup-only ownership and is not reusable", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, PLAN);
  await h.controller.closeSession();

  h.setFailRelease(true);
  await h.workflow.prepareTest({
    ...INPUTS,
    stagesB: [{ codecId: "opus", bitrateKbps: 96 }],
  }, PLAN);

  assert.equal(h.workflow.state.phase, "error");
  assert.equal(h.workflow.state.message, "Test preparation failed. No trial was staged.");
  assert.match(
    h.published.filter((entry): entry is string => entry !== null).join(" | "),
    /Artifact release was not confirmed; the retained artifact stays owned for retry: release acknowledgement missing/,
  );
  assert.equal(h.prepareCount(), 1, "no new preparation starts while the old artifact is owned");
  assert.equal(h.workflow.lifecycle.state.artifact?.id, "artifact-1");
  assert.equal(h.workflow.isPairReady(INPUTS), false, "cleanup-only ownership cannot be reused");
  assert.equal(h.controller.state.session, "idle");

  h.setFailRelease(false);
  await h.workflow.prepareTest({
    ...INPUTS,
    stagesB: [{ codecId: "opus", bitrateKbps: 96 }],
  }, PLAN);
  assert.equal(h.prepareCount(), 2);
  assert.equal(h.workflow.state.phase, "ready");
  await h.workflow.dispose();
});

test("a refused bind stages nothing and the explicit retry binds the same retained pair", async () => {
  const h = await harness();
  h.client.bindError = { code: "bind-rejected", message: "exact-byte verification failed" };
  h.client.bindCommits = false;

  await h.workflow.prepareTest(INPUTS, PLAN);

  assert.equal(h.workflow.state.phase, "error");
  assert.match(h.workflow.state.message ?? "", /could not be verified and bound/);
  assert.equal(h.controller.state.trial, null);
  assert.deepEqual(h.player.loadCalls, []);
  assert.equal(h.workflow.isPairReady(INPUTS), true, "the completed pair stays registered for retry");
  assert.equal(h.prepareCount(), 1);

  await h.workflow.prepareTest(INPUTS, PLAN);

  assertPausedFirstTrial(h);
  assert.equal(h.prepareCount(), 1, "the explicit retry must reuse the same pair");
  assert.equal(h.client.bindCalls, 2);
  await h.workflow.dispose();
});

test("an uncertain bind that committed is reconciled once and staged without a second bind", async () => {
  const h = await harness();
  h.client.bindError = { code: "request-timeout", message: "bind reply timed out" };
  h.client.bindCommits = true;

  await h.workflow.prepareTest(INPUTS, PLAN);

  assertPausedFirstTrial(h);
  assert.equal(h.client.bindCalls, 1, "a committed uncertain bind is never re-sent");
  await h.workflow.dispose();
});

test("an uncertain bind that did not commit blocks a second bind until reset", async () => {
  const h = await harness();
  h.client.bindError = { code: "request-timeout", message: "bind reply timed out" };
  h.client.bindCommits = false;

  await h.workflow.prepareTest(INPUTS, PLAN);

  assert.equal(h.workflow.state.phase, "error");
  assert.equal(h.controller.state.error?.code, "request-timeout");
  assert.equal(h.client.bindCalls, 1);

  await h.workflow.prepareTest(INPUTS, PLAN);

  assert.equal(h.workflow.state.phase, "error");
  assert.equal(h.client.bindCalls, 1, "an unconfirmed binding is not silently re-sent");
  assert.equal(h.controller.state.trial, null);
  await h.workflow.dispose();
});

test("cancelling preparation publishes cancellation, never a late pair, and stages nothing", async () => {
  const h = await harness();
  const late = deferred<PreparedArtifact>();
  h.setPrepareHook(async () => await late.promise);

  const run = h.workflow.prepareTest(INPUTS, PLAN);
  await waitUntil(() => h.prepareCount() === 1, "preparation start");
  assert.equal(h.workflow.state.phase, "preparing");
  const cancelling = h.workflow.cancel();
  late.resolve(artifact("late-artifact"));
  await cancelling;
  await run;

  assert.equal(h.workflow.state.phase, "cancelled");
  assert.equal(h.workflow.state.message, "Test preparation was cancelled. No trial was staged.");
  assert.deepEqual(h.releases, ["late-artifact"], "the late artifact is cleaned up, not published");
  assert.equal(h.workflow.lifecycle.state.artifact, null);
  assert.equal(h.workflow.isPairReady(INPUTS), false);
  assert.equal(h.client.bindCalls, 0);
  assert.equal(h.controller.state.session, "idle");
  assert.deepEqual(h.player.loadCalls, []);
  await h.workflow.dispose();
});

test("cancelling during exact-byte binding closes the session and drops the late bind", async () => {
  const h = await harness();
  const bindGate = deferred<void>();
  h.client.bindGate = bindGate;

  const run = h.workflow.prepareTest(INPUTS, PLAN);
  await waitUntil(() => h.client.bindCalls === 1, "bind start");
  assert.equal(h.workflow.state.phase, "binding");
  await h.workflow.cancel();
  bindGate.resolve();
  await run;

  assert.equal(h.workflow.state.phase, "cancelled");
  assert.equal(h.controller.state.session, "idle");
  assert.equal(h.controller.state.trial, null);
  assert.equal(h.client.nextCalls, 0, "no trial is drawn for a cancelled setup");
  assert.equal(h.client.disposeCalls, 1);
  await h.workflow.dispose();
});

test("cancelling a held trial read leaves no staged trial and no playback", async () => {
  const h = await harness();
  const loadGate = deferred<void>();
  h.player.loadGate = loadGate;

  const run = h.workflow.prepareTest(INPUTS, PLAN);
  await waitUntil(() => h.player.loadCalls.length === 1, "held trial read");
  assert.equal(h.workflow.state.phase, "staging");
  assert.equal(h.player.loadCalls.length, 1, "the trial read is genuinely held");
  await h.workflow.cancel();
  loadGate.resolve();
  await run;

  assert.equal(h.workflow.state.phase, "cancelled");
  assert.equal(h.controller.state.session, "idle");
  assert.equal(h.controller.state.trial, null);
  assert.equal(h.player.playCalls, 0);
  assert.equal(h.controller.state.playback, null);
  await h.workflow.dispose();
});

test("advanced manual preparation registers aligned pairs only and never binds", async () => {
  const h = await harness();

  await h.workflow.prepareDiagnostic(INPUTS);

  assert.equal(h.prepareCount(), 1);
  assert.equal(h.requests[0]?.preparationPolicy, "aligned-gain-matched-v1");
  assert.equal(h.workflow.lifecycle.state.status, "complete");
  assert.equal(h.workflow.isPairReady(INPUTS), true);
  assert.equal(h.client.configureCalls, 0);
  assert.equal(h.controller.state.session, "idle");

  const raw: PrepareTestInputs = { ...INPUTS, diagnosticPolicy: "codec-probe-only" };
  await h.workflow.prepareDiagnostic(raw);

  assert.equal(h.prepareCount(), 2);
  assert.equal(h.requests[1]?.preparationPolicy, undefined);
  assert.deepEqual(h.releases, ["artifact-1"]);
  assert.equal(h.workflow.isPairReady(raw), false, "raw diagnostics never authorize listening reuse");
  assert.equal(h.controller.state.session, "idle");
  await h.workflow.dispose();
});

test("failed reset during preparation settles setup and keeps cleanup retryable", async (t) => {
  const h = await harness();
  t.after(() => h.workflow.dispose());
  const late = deferred<PreparedArtifact>();
  h.setPrepareHook(async () => late.promise);
  const run = h.workflow.prepareTest(INPUTS, PLAN);
  await waitUntil(() => h.prepareCount() === 1, "preparation start");
  h.setFailRelease(true);
  const resetting = h.workflow.reset();
  late.resolve(artifact("reset-release-failure"));
  assert.equal(await resetting, false);
  await run;
  assert.equal(h.workflow.state.phase, "error");
  assert.equal(h.workflow.state.busy, false);
  assert.equal(h.workflow.isPairReady(INPUTS), false);
  assert.equal(h.workflow.lifecycle.state.source, "source.wav");
  h.setFailRelease(false);
  assert.equal(await h.workflow.reset(), true);
  assert.equal(h.workflow.state.phase, "idle");
});

test("a source change releases the retained pair and reset clears setup state", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, PLAN);
  await h.controller.closeSession();

  assert.equal(await h.workflow.chooseSource("other.wav"), true);
  assert.equal(h.workflow.state.phase, "idle");
  assert.equal(h.workflow.lifecycle.state.source, "other.wav");
  assert.deepEqual(h.releases, ["artifact-1"]);
  assert.equal(h.workflow.isPairReady(INPUTS), false);

  await h.workflow.prepareTest({ ...INPUTS, sourceIdentity: "file:other.wav:2:2" }, PLAN);
  await h.controller.closeSession();
  assert.equal(h.prepareCount(), 2);

  assert.equal(await h.workflow.reset(), true);
  assert.equal(h.workflow.state.phase, "idle");
  assert.equal(h.workflow.lifecycle.state.source, null);
  assert.equal(h.workflow.lifecycle.state.artifact, null);
  assert.deepEqual(h.releases, ["artifact-1", "artifact-2"]);
  assert.equal(h.workflow.isPairReady({ ...INPUTS, sourceIdentity: "file:other.wav:2:2" }), false);
  await h.workflow.dispose();
});

test("dispose attempts controller, lifecycle and engine in order and reports failures", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, PLAN);

  h.setFailEngineDispose(true);
  await h.workflow.dispose();

  assert.deepEqual(h.events, ["controller:player", "controller:client", "engine"]);
  assert.equal(h.cleanupFailures.length, 1);
  assert.match(h.cleanupFailures[0] ?? "", /engine dispose failed/);
});

test("dispose joins an in-flight preparation before disposing the engine", async () => {
  const h = await harness();
  const late = deferred<PreparedArtifact>();
  h.setPrepareHook(async () => await late.promise);

  const run = h.workflow.prepareTest(INPUTS, PLAN);
  await waitUntil(() => h.prepareCount() === 1, "preparation start");
  const disposing = h.workflow.dispose();
  assert.deepEqual(h.events, [], "the engine is not disposed while preparation is running");

  late.resolve(artifact("late-dispose-artifact"));
  await disposing;
  await run;

  assert.deepEqual(h.events, ["engine"]);
  assert.deepEqual(h.releases, ["late-dispose-artifact"]);
  assert.equal(h.workflow.state.phase, "preparing", "disposal stops publishing workflow state");
});
