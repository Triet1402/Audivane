import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ExperimentPlan,
  ExperimentSnapshot,
  PlaybackLabel,
  PlaybackLoop,
  PlaybackOutputState,
  PlaybackSnapshot,
  PublicTrial,
  TrialPlayer,
} from "@codec-abx/contracts";
import { ExperimentService } from "@codec-abx/experiment";
import type { PcmAudio } from "@codec-abx/measurements";

import {
  buildArtifact,
  deterministicOptions,
  makeReaders,
  makeRequest,
  sine,
  type BuiltArtifact,
} from "../../../packages/experiment/test/fixtures.js";
import {
  ListeningController,
  type ListeningClient,
  type ListeningReaders,
} from "../src/listening/controller.js";
import {
  ListeningSection,
  type ListeningPrimary,
} from "../src/listening/ListeningSection.js";
import { trialStartGateBlocker } from "../src/listening/readiness.js";

/** Shared plan for the rendered gate-recovery scenarios. */
const PLAN: ExperimentPlan = Object.freeze({
  version: 1,
  plannedTrials: 8,
  alpha: 0.05,
  labelMode: "blind_random",
  calibrationEnabled: false,
});

function noisySine(noiseDb: number): PcmAudio {
  const sampleRate = 48_000;
  const seconds = 0.6;
  const frames = Math.round(seconds * sampleRate);
  const base = sine(440, { seconds });
  const samples = new Float64Array(frames);
  const noiseAmplitude = 0.25 * 10 ** (-noiseDb / 20);
  let seed = 123456789;
  const random = (): number => {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const source = base.channels[0]!;
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame] = Math.round(
      (source[frame]! + noiseAmplitude * random()) * 32767,
    ) / 32768;
  }
  return { sampleRate, channels: [samples] };
}

const FIXTURES = new Map<string, BuiltArtifact>();

// Synthetic content exercises the real served-byte validators. These fixtures
// do not establish that current codecs emit a failed-gate pair from one source.
function fixture(kind: "passed" | "failed-preparation" | "failed-null"): BuiltArtifact {
  const cached = FIXTURES.get(kind);
  if (cached !== undefined) return cached;
  const built = kind === "passed"
    ? buildArtifact()
    : kind === "failed-preparation"
      ? buildArtifact({ a: sine(440), b: sine(660) })
      : buildArtifact({
          a: sine(440),
          b: noisySine(40),
          request: makeRequest({
            aCodec: "opus",
            aBitrate: 64,
            bCodec: "opus",
            bBitrate: 64,
          }),
        });
  FIXTURES.set(kind, built);
  return built;
}

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
  output: OUTPUT,
};

class MinimalPlayer implements TrialPlayer {
  current: PlaybackSnapshot = { ...EMPTY_PLAYBACK, output: structuredClone(OUTPUT) };
  loadCalls: PublicTrial[] = [];
  #listeners = new Set<(snapshot: PlaybackSnapshot) => void>();

  async loadTrial(trial: PublicTrial): Promise<PlaybackSnapshot> {
    this.loadCalls.push(trial);
    this.current = {
      ...EMPTY_PLAYBACK,
      phase: "ready",
      trial,
      durationSeconds: 1,
      output: structuredClone(OUTPUT),
    };
    this.#emit();
    return this.snapshot();
  }

  async play(): Promise<PlaybackSnapshot> {
    this.current = { ...this.current, playing: true };
    this.#emit();
    return this.snapshot();
  }

  pause(): PlaybackSnapshot {
    this.current = { ...this.current, playing: false };
    this.#emit();
    return this.snapshot();
  }

  select(label: PlaybackLabel): PlaybackSnapshot {
    this.current = { ...this.current, selected: label };
    this.#emit();
    return this.snapshot();
  }

  seek(positionSeconds: number): PlaybackSnapshot {
    this.current = { ...this.current, positionSeconds };
    this.#emit();
    return this.snapshot();
  }

  setLoop(loop: PlaybackLoop): PlaybackSnapshot {
    this.current = { ...this.current, loop };
    this.#emit();
    return this.snapshot();
  }

  snapshot(): PlaybackSnapshot {
    return { ...this.current, output: structuredClone(this.current.output ?? OUTPUT) };
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): PlaybackSnapshot {
    this.current = { ...EMPTY_PLAYBACK, output: structuredClone(OUTPUT) };
    this.#emit();
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    this.#listeners.clear();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener(this.snapshot());
  }
}

class CountingClient implements ListeningClient {
  nextTrialCalls = 0;
  bindCalls = 0;
  readonly service: ExperimentService;

  constructor(service: ExperimentService) {
    this.service = service;
  }

  configure(plan: ExperimentPlan) {
    return this.service.configure(plan);
  }

  snapshot() {
    return this.service.snapshot();
  }

  nextTrial() {
    this.nextTrialCalls += 1;
    return this.service.nextTrial();
  }

  answer(token: string, answer: "A" | "B") {
    return this.service.answer(token, answer);
  }

  readAudio(token: string, label: PlaybackLabel) {
    return this.service.readAudio(token, label);
  }

  seal(reason?: string) {
    return this.service.seal(reason);
  }

  reset() {
    return this.service.reset();
  }

  export() {
    return this.service.export();
  }

  dispose() {
    return this.service.dispose();
  }

  bindPrepared(artifact: Parameters<ExperimentService["bindPrepared"]>[0], readers: ListeningReaders) {
    this.bindCalls += 1;
    return this.service.bindPrepared(artifact, readers);
  }
}

interface Harness {
  readonly controller: ListeningController;
  readonly player: MinimalPlayer;
  readonly client: CountingClient;
  readonly readers: ListeningReaders;
  readonly artifact: BuiltArtifact["artifact"];
}

async function harness(kind: "passed" | "failed-preparation" | "failed-null"): Promise<Harness> {
  const built = fixture(kind);
  const player = new MinimalPlayer();
  const client = new CountingClient(new ExperimentService(deterministicOptions()));
  const controller = new ListeningController({
    createClient: () => client,
    createPlayer: () => player,
  });
  const readers = makeReaders(built);
  await controller.prepareSession(PLAN, built.artifact, readers);
  assert.equal(client.bindCalls, 1, "the authority must verify the genuine fixture bytes");
  assert.equal(controller.state.session, "configured");
  assert.equal(controller.state.error, null);
  assert.equal(
    controller.state.snapshot?.prepared?.aWavSha256,
    built.artifact.a.delivered.wavSha256,
  );
  return { controller, player, client, readers, artifact: built.artifact };
}

function configuredView(state: Harness["controller"]["state"], harnessed: Harness): {
  readonly html: string;
} {
  const primary: ListeningPrimary = {
    phase: "idle",
    busy: false,
    message: null,
    canPrepare: true,
    pairReady: true,
    onPrepare: async () => {},
    onCancel: async () => {},
  };
  const html = renderToStaticMarkup(createElement(ListeningSection, {
    artifact: harnessed.artifact,
    listening: { controller: harnessed.controller, state },
    runtimeKind: "browser",
    onEnd: () => {},
    onReset: () => {},
    onDisableCalibration: () => {},
    primary,
  }));
  assert.doesNotMatch(html, /Start trial 1 \(paused\)|No trial is staged|View results/);
  return { html };
}

async function refuseAfterRecovery(harnessed: Harness, recovery: "reset" | "retry" | "plan-change"): Promise<void> {
  const { controller, client } = harnessed;
  // The primary action always attempts to stage trial 1. The gate refusal is
  // the real controller transition that leaves the run configured.
  await controller.start();
  assert.equal(client.nextTrialCalls, 0, "gate refusal happens before any trial is drawn");
  assert.equal(controller.state.error?.retry, "prepare");

  if (recovery === "reset") {
    // This is a controller recovery transition. The current view does not
    // offer Reset directly on a configured run with only a failed gate.
    await controller.reset();
  } else if (recovery === "retry") {
    await controller.prepareSession(PLAN, harnessed.artifact, harnessed.readers);
  } else {
    // Apply plan and re-check gates reparses the form plan through
    // prepareSession; it never stages a trial by itself.
    await controller.prepareSession(
      { ...PLAN, plannedTrials: 4 },
      harnessed.artifact,
      harnessed.readers,
    );
  }

  assert.equal(controller.state.session, "configured", recovery);
  assert.equal(controller.state.error, null, recovery);
  assert.equal(controller.state.busy, null, recovery);
  assert.notEqual(controller.state.snapshot?.prepared, null, recovery);
}

function genuineValidity(built: BuiltArtifact) {
  const validity = built.validity;
  assert.equal(validity.policy, "delivered-validity-v2");
  if (validity.policy !== "delivered-validity-v2") {
    throw new Error("genuine delivered-validity-v2 fixture expected");
  }
  return validity;
}

test("synthetic content carries failed gates computed by the real evaluators", () => {
  const failedPreparation = genuineValidity(fixture("failed-preparation"));
  assert.equal(failedPreparation.preparationGate.status, "failed");
  assert.equal(failedPreparation.preparationGate.classification, "weak-or-unrelated");
  assert.equal(failedPreparation.nullGate.status, "not-applicable");

  const failedNull = genuineValidity(fixture("failed-null"));
  assert.equal(failedNull.preparationGate.status, "passed");
  assert.equal(failedNull.nullGate.status, "failed");

  const passed = genuineValidity(fixture("passed"));
  assert.equal(passed.preparationGate.status, "passed");
  assert.equal(passed.nullGate.status, "not-applicable");
});

test("reset retains and displays a failed preparation gate", async () => {
  const harnessed = await harness("failed-preparation");
  await refuseAfterRecovery(harnessed, "reset");

  assert.equal(harnessed.controller.state.snapshot?.gates.preparationStatus, "failed");
  const start = configuredView(harnessed.controller.state, harnessed);
  assert.match(start.html, /Preparation validity/);
  assert.match(start.html, /The bound pair failed the frozen preparation-validity gate/);
  assert.doesNotMatch(start.html, /Start trial 1 paused when you are ready/);
  assert.match(start.html, /failed the frozen preparation-validity gate/);
});

test("retrying the configured binding keeps the failed preparation gate visible", async () => {
  const harnessed = await harness("failed-preparation");
  await refuseAfterRecovery(harnessed, "retry");

  assert.equal(harnessed.controller.state.snapshot?.gates.preparationStatus, "failed");
  const start = configuredView(harnessed.controller.state, harnessed);
  assert.match(start.html, /The bound pair failed the frozen preparation-validity gate/);
});

test("a plan re-check retains the failed preparation gate and renders its blocker", async () => {
  const harnessed = await harness("failed-preparation");
  await refuseAfterRecovery(harnessed, "plan-change");

  assert.equal(harnessed.controller.state.snapshot?.gates.preparationStatus, "failed");
  // The same gate decision governs staging and the visible recovery message.
  assert.equal(
    trialStartGateBlocker(
      harnessed.controller.state.snapshot!,
      harnessed.artifact,
    )?.code,
    "preparation-gate-failed",
  );
  assert.match(
    configuredView(harnessed.controller.state, harnessed).html,
    /The bound pair failed the frozen preparation-validity gate/,
  );
});

test("reset retains and displays a failed null gate", async () => {
  const harnessed = await harness("failed-null");
  await refuseAfterRecovery(harnessed, "reset");

  assert.equal(harnessed.controller.state.snapshot?.gates.preparationStatus, "passed");
  assert.equal(harnessed.controller.state.snapshot?.gates.nullStatus, "failed");
  const start = configuredView(harnessed.controller.state, harnessed);
  assert.match(start.html, /failed the identical-pipeline null gate/);
});

test("the controller still refuses the shared gate itself when Start is invoked programmatically", async () => {
  const preparation = await harness("failed-preparation");
  await refuseAfterRecovery(preparation, "reset");
  await preparation.controller.start();
  assert.equal(preparation.controller.state.error?.code, "preparation-gate-failed");
  assert.equal(preparation.client.nextTrialCalls, 0);
  assert.equal((await preparation.client.snapshot()).pendingTrial, null);

  const nullGate = await harness("failed-null");
  await refuseAfterRecovery(nullGate, "reset");
  await nullGate.controller.start();
  assert.equal(nullGate.controller.state.error?.code, "null-gate-failed");
  assert.equal(nullGate.client.nextTrialCalls, 0);
  assert.equal((await nullGate.client.snapshot()).pendingTrial, null);
});

test("a passed preparation gate and applicable null outcome still stage trial 1", async () => {
  const harnessed = await harness("passed");
  assert.doesNotMatch(configuredView(harnessed.controller.state, harnessed).html, /Start trial 1/);
  await harnessed.controller.start();
  assert.equal(harnessed.client.nextTrialCalls, 1);
  assert.equal(harnessed.controller.state.error, null);
  assert.notEqual(harnessed.controller.state.trial, null);
  assert.equal(harnessed.player.loadCalls.length, 1);
  assert.equal(harnessed.controller.state.session, "running");
});

test("the shared decision covers real bound states and the defensive unmeasured branch", async () => {
  const built = fixture("passed");
  const unboundService = new ExperimentService(deterministicOptions());
  const unbound = await unboundService.configure(PLAN);
  assert.equal(
    trialStartGateBlocker(unbound, built.artifact)?.code,
    "artifact-unbound",
  );
  await unboundService.dispose();

  const passed = await harness("passed");
  assert.equal(
    trialStartGateBlocker(passed.controller.state.snapshot!, passed.artifact),
    null,
  );

  for (const [kind, code] of [
    ["failed-preparation", "preparation-gate-failed"],
    ["failed-null", "null-gate-failed"],
  ] as const) {
    const harnessed = await harness(kind);
    assert.equal(
      trialStartGateBlocker(harnessed.controller.state.snapshot!, harnessed.artifact)?.code,
      code,
    );
  }

  const calibrated = new ExperimentService(deterministicOptions());
  const calibratedController = new ListeningController({
    createClient: () => calibrated,
    createPlayer: () => new MinimalPlayer(),
  });
  await calibratedController.prepareSession(
    { ...PLAN, calibrationEnabled: true },
    built.artifact,
    makeReaders(built),
  );
  assert.equal(calibratedController.state.snapshot?.gates.calibrationStatus, "unavailable");
  assert.equal(
    trialStartGateBlocker(
      calibratedController.state.snapshot!,
      built.artifact,
    )?.code,
    "calibration-unavailable",
  );

  // No current binding produces an unmeasured preparation gate; this clone only
  // locks the controller's existing defensive refusal into the shared decision.
  const unmeasured = structuredClone(passed.controller.state.snapshot!) as unknown as {
    gates: ExperimentSnapshot["gates"];
  };
  unmeasured.gates = {
    ...unmeasured.gates,
    preparationStatus: "not-measured",
    preparationClassification: null,
    preparationReason: null,
    preparationDisclosure: null,
  };
  assert.equal(
    trialStartGateBlocker(
      unmeasured as unknown as ExperimentSnapshot,
      passed.artifact,
    )?.code,
    "preparation-gate-not-measured",
  );
});

test("UI restart clears the previous run and stages trial 1 paused without an extra Start step", async () => {
  const harnessed = await harness("passed");
  await harnessed.controller.start();
  const previousRun = harnessed.controller.state.snapshot!.runId;
  await harnessed.controller.restart();
  assert.notEqual(harnessed.controller.state.snapshot!.runId, previousRun);
  assert.equal(harnessed.controller.state.session, "running");
  assert.equal(harnessed.controller.state.trial!.trialIndex, 1);
  assert.equal(harnessed.controller.state.playback!.playing, false);
  assert.equal(harnessed.controller.state.feedback, null);
  const exported = await harnessed.controller.exportPayload();
  assert.equal((exported!.diagnostics.artifact as { readonly id: string }).id, harnessed.artifact.id);
  assert.equal(exported!.experiment.snapshot.runId, harnessed.controller.state.snapshot!.runId);
  assert.equal(exported!.experiment.reveal.redacted, true);
});
