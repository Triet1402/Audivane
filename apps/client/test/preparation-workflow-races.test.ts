import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AnswerReceipt,
  DisplayAnswer,
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
import { ExperimentService } from "@codec-abx/experiment";

import {
  buildArtifact,
  deterministicOptions,
  makeReaders,
  makeRequest,
  type BuiltArtifact,
} from "../../../packages/experiment/test/fixtures.js";
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

/*
 * Controlled race regressions for the client preparation workflow.
 *
 * These cross the real `PrepareTestWorkflow` interface, the real
 * `PreparationLifecycle` it constructs internally, and a real
 * `ListeningController`. The authority side is a real `ExperimentService` bound
 * to genuine delivered-validity-v2 fixture bytes, so binding refusals and
 * snapshot facts come from production validation rather than forged snapshots.
 * Only the player and the preparation engine (which stand in for the browser
 * Worker/native process) are adapters.
 *
 * Expectations describe intended workflow semantics. Where the current module
 * differs, the workflow owner should fix production; these cases should not be
 * relaxed to mirror a race that drops a run, strands `busy` or closes a
 * replacement session.
 *
 * Unreachable combinations are not simulated. In particular, a preparation
 * cannot be in flight while a listening run owns the retained artifact:
 * `PreparationLifecycle` refuses while the listening lock is held. The disposal
 * case therefore holds preparation while the controller owns a player created
 * through idle output discovery, which is the reachable controller→lifecycle→
 * engine ordering.
 */

const SOURCE = "fixture-source-1";

const BUILT: BuiltArtifact = buildArtifact({
  request: makeRequest({
    aCodec: "noop_passthrough",
    bCodec: "opus",
    bBitrate: 128,
  }),
});

const REQUEST: PreparationRequest = BUILT.artifact.request;

const INPUTS: PrepareTestInputs = Object.freeze({
  sourceIdentity: SOURCE,
  stagesA: Object.freeze([Object.freeze({ codecId: "noop_passthrough" as const, bitrateKbps: 0 })]),
  stagesB: Object.freeze([Object.freeze({ codecId: "opus" as const, bitrateKbps: 128 })]),
  rateMode: "native",
  calibrationEnabled: false,
  diagnosticPolicy: "aligned-gain-matched-v1",
});

function plan(plannedTrials = 8): ExperimentPlan {
  return {
    version: 1,
    plannedTrials,
    alpha: 0.05,
    labelMode: "blind_random",
    calibrationEnabled: false,
  };
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
};

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

interface ControlledReaders {
  readonly readers: ListeningReaders;
  /** Hold the authority's next Side A read open; a later bind reads normally. */
  holdNextA(): { readonly started: Promise<void>; release(): void };
  /** Corrupt exactly one Side A read so the real binder refuses that attempt. */
  corruptNextA(): void;
}

function controlledReaders(built: BuiltArtifact): ControlledReaders {
  const base = makeReaders(built);
  let hold: Deferred<void> | null = null;
  let started: Deferred<void> | null = null;
  let corrupt = false;
  const readers: ListeningReaders = {
    readAudio: async (artifactId, side) => {
      if (side === "a") {
        if (corrupt) {
          corrupt = false;
          const copy = new Uint8Array(built.bytes.a);
          copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
          return copy.buffer;
        }
        if (hold !== null) {
          const gate = hold;
          hold = null;
          started?.resolve();
          started = null;
          await gate.promise;
        }
      }
      return base.readAudio(artifactId, side);
    },
    readCanaryAudio: async (artifactId, side) =>
      base.readCanaryAudio!(artifactId, side),
  };
  return {
    readers,
    holdNextA() {
      const gate = deferred<void>();
      const begin = deferred<void>();
      hold = gate;
      started = begin;
      return { started: begin.promise, release: () => gate.resolve() };
    },
    corruptNextA() {
      corrupt = true;
    },
  };
}

/** Real authority client; only counters/events are adapter behaviour. */
class CountingClient implements ListeningClient {
  configureCalls = 0;
  bindCalls = 0;
  nextTrialCalls = 0;
  disposeCalls = 0;

  constructor(
    readonly service: ExperimentService,
    private readonly events: string[],
  ) {}

  configure(value: ExperimentPlan): Promise<ExperimentSnapshot> {
    this.configureCalls += 1;
    return this.service.configure(value);
  }

  snapshot(): Promise<ExperimentSnapshot> {
    return this.service.snapshot();
  }

  nextTrial(): Promise<PublicTrial> {
    this.nextTrialCalls += 1;
    return this.service.nextTrial();
  }

  answer(token: string, answer: DisplayAnswer): Promise<AnswerReceipt> {
    return this.service.answer(token, answer);
  }

  readAudio(token: string, label: PlaybackLabel): Promise<ArrayBuffer> {
    return this.service.readAudio(token, label);
  }

  seal(reason?: string): Promise<ExperimentSnapshot> {
    return this.service.seal(reason);
  }

  reset(): Promise<ExperimentSnapshot> {
    return this.service.reset();
  }

  export(): Promise<ExperimentExport> {
    return this.service.export();
  }

  bindPrepared(
    artifact: PreparedArtifact,
    readers: ListeningReaders,
  ): Promise<ExperimentSnapshot> {
    this.bindCalls += 1;
    return this.service.bindPrepared(artifact, readers);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.events.push("controller:client");
    await this.service.dispose();
  }
}

class RacePlayer implements TrialPlayer {
  loadCalls: PublicTrial[] = [];
  playCalls = 0;
  pauseCalls = 0;
  disposeCalls = 0;
  pending: PlaybackOutputState["pending"] = null;
  change: PlaybackOutputState["change"] = "none";
  current: PlaybackSnapshot = { ...EMPTY_PLAYBACK };
  readonly #listeners = new Set<(snapshot: PlaybackSnapshot) => void>();

  constructor(private readonly events: string[]) {}

  async loadTrial(trial: PublicTrial): Promise<PlaybackSnapshot> {
    this.loadCalls.push(trial);
    this.current = {
      ...EMPTY_PLAYBACK,
      phase: "ready",
      trial,
      durationSeconds: 12,
    };
    this.#emit();
    return this.snapshot();
  }

  async play(): Promise<PlaybackSnapshot> {
    this.playCalls += 1;
    this.current = { ...this.current, playing: true };
    this.#emit();
    return this.snapshot();
  }

  pause(): PlaybackSnapshot {
    this.pauseCalls += 1;
    this.current = { ...this.current, playing: false };
    this.#emit();
    return this.snapshot();
  }

  select(label: PlaybackLabel): PlaybackSnapshot {
    this.current = { ...this.current, selected: label };
    return this.snapshot();
  }

  seek(positionSeconds: number): PlaybackSnapshot {
    this.current = { ...this.current, positionSeconds };
    return this.snapshot();
  }

  setLoop(loop: PlaybackLoop): PlaybackSnapshot {
    this.current = { ...this.current, loop };
    return this.snapshot();
  }

  snapshot(): PlaybackSnapshot {
    return {
      ...this.current,
      output: { ...OUTPUT, pending: this.pending, change: this.change },
    };
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  reset(): PlaybackSnapshot {
    this.current = { ...EMPTY_PLAYBACK };
    this.#emit();
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.events.push("controller:player");
    this.#listeners.clear();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener(this.snapshot());
  }
}

interface Harness {
  readonly workflow: PrepareTestWorkflow<string, PreparedArtifact>;
  readonly controller: ListeningController;
  readonly engine: PrepareTestEngine<string, PreparedArtifact>;
  readonly readers: ControlledReaders;
  readonly clients: CountingClient[];
  readonly players: RacePlayer[];
  readonly requests: PreparationRequest[];
  readonly releases: string[];
  readonly published: (string | null)[];
  readonly cleanupFailures: string[];
  readonly events: string[];
  readonly player: RacePlayer;
  prepareCalls(): number;
  holdNextPrepare(): Deferred<void>;
  setFailRelease(fail: boolean): void;
  setFailEngineDispose(fail: boolean): void;
}

async function harness(): Promise<Harness> {
  const events: string[] = [];
  const requests: PreparationRequest[] = [];
  const releases: string[] = [];
  const published: (string | null)[] = [];
  const cleanupFailures: string[] = [];
  const clients: CountingClient[] = [];
  const players: RacePlayer[] = [];
  const readers = controlledReaders(BUILT);
  let prepares = 0;
  let prepareGate: Deferred<void> | null = null;
  let failRelease = false;
  let failEngineDispose = false;

  const engine: PrepareTestEngine<string, PreparedArtifact> = {
    async prepare(_source, request) {
      prepares += 1;
      requests.push(structuredClone(request));
      if (prepareGate !== null) {
        const gate = prepareGate;
        prepareGate = null;
        await gate.promise;
      }
      return BUILT.artifact;
    },
    async release(artifactId) {
      releases.push(artifactId);
      events.push(`release:${artifactId}`);
      if (failRelease) throw new Error("release acknowledgement missing");
    },
    async dispose() {
      events.push("engine");
      if (failEngineDispose) throw new Error("engine dispose failed");
    },
  };

  const controller = new ListeningController({
    createClient: () => {
      const client = new CountingClient(
        new ExperimentService(deterministicOptions()),
        events,
      );
      clients.push(client);
      return client;
    },
    createPlayer: () => {
      const player = new RacePlayer(events);
      players.push(player);
      return player;
    },
  });

  const workflow = new PrepareTestWorkflow<string, PreparedArtifact>({
    desktop: false,
    engine,
    controller,
    readers: readers.readers,
    isListeningLocked: () => controller.state.session !== "idle",
    buildRequest: (inputs, mode) => ({
      version: 1,
      sampleRateMode: inputs.rateMode,
      ...(mode === "prepare-test" ||
          inputs.diagnosticPolicy === "aligned-gain-matched-v1"
        ? { preparationPolicy: "aligned-gain-matched-v1" as const }
        : {}),
      ...(inputs.calibrationEnabled ? { canaryEnabled: true } : {}),
      a: inputs.stagesA[0]!,
      b: inputs.stagesB[0]!,
    }),
    publishError: (message) => published.push(message),
    reportCleanupFailure: (message) => cleanupFailures.push(message),
  });
  assert.equal(await workflow.chooseSource(SOURCE), true);

  return {
    workflow,
    controller,
    engine,
    readers,
    clients,
    players,
    requests,
    releases,
    published,
    cleanupFailures,
    events,
    get player() {
      const player = players[players.length - 1];
      if (player === undefined) throw new Error("no player was created");
      return player;
    },
    prepareCalls: () => prepares,
    holdNextPrepare: () => {
      const gate = deferred<void>();
      prepareGate = gate;
      return gate;
    },
    setFailRelease: (fail) => {
      failRelease = fail;
    },
    setFailEngineDispose: (fail) => {
      failEngineDispose = fail;
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the captured plan stays stable when the caller mutates it during held preparation", async () => {
  const h = await harness();
  const gate = h.holdNextPrepare();
  const submitted = plan(8);

  const run = h.workflow.prepareTest(INPUTS, submitted);
  await waitUntil(() => h.prepareCalls() === 1, "held preparation");
  assert.equal(h.workflow.state.phase, "preparing");
  // The plan object the caller handed over changes before the bind is reached.
  (submitted as { plannedTrials: number }).plannedTrials = 12;
  (submitted as { alpha: number }).alpha = 0.2;
  gate.resolve();
  await run;

  assert.equal(h.workflow.state.phase, "ready");
  const bound = h.controller.state.snapshot;
  assert.notEqual(bound, null);
  assert.equal(
    bound?.plan.plannedTrials,
    8,
    "binding must use the plan captured at command entry, not a later mutation",
  );
  assert.equal(bound?.plan.alpha, 0.05);
  assert.equal(bound?.statistics.plannedTrials, 8);
  await h.workflow.dispose();
});

test("a rejected chooseSource during preparation leaves the active run to finish and never strands busy", async () => {
  const h = await harness();
  const gate = h.holdNextPrepare();
  const run = h.workflow.prepareTest(INPUTS, plan());
  await waitUntil(() => h.prepareCalls() === 1, "held preparation");

  const adopted = await h.workflow.chooseSource("replacement-source");
  assert.equal(adopted, false, "the lifecycle must refuse while preparation owns the transition");
  gate.resolve();
  await run;

  assert.equal(
    h.workflow.lifecycle.state.source,
    SOURCE,
    "a refused source change must not replace the active source",
  );
  assert.equal(h.workflow.state.phase, "ready");
  assert.equal(h.workflow.state.busy, false, "the completed run must not stay busy");
  assert.equal(h.workflow.state.error, null);
  assert.notEqual(h.controller.state.trial, null, "the held run still binds and stages");
  assert.equal(h.controller.state.session, "running");
  assert.equal(h.player.playCalls, 0, "staging remains paused");
  await h.workflow.dispose();
});

test("a rejected chooseSource while listening is locked preserves the active pair and trial", async () => {
  const h = await harness();
  await h.workflow.prepareTest(INPUTS, plan());
  assert.equal(h.workflow.state.phase, "ready");
  const artifactId = h.workflow.lifecycle.state.artifact?.id;
  const token = h.controller.state.trial?.token;

  const adopted = await h.workflow.chooseSource("replacement-source");
  assert.equal(adopted, false, "the listening owner holds the artifact release lock");

  assert.equal(h.workflow.state.phase, "ready");
  assert.equal(h.workflow.state.busy, false);
  assert.equal(h.workflow.isPairReady(INPUTS), true);
  assert.equal(h.workflow.lifecycle.state.artifact?.id, artifactId);
  assert.equal(h.controller.state.trial?.token, token);
  await h.workflow.dispose();
});

test("a late bind from a cancelled run cannot close the explicitly started replacement", async () => {
  const h = await harness();
  const hold = h.readers.holdNextA();
  const cancelled = h.workflow.prepareTest(INPUTS, plan());
  await hold.started;
  assert.equal(h.workflow.state.phase, "binding");
  const oldClient = h.clients[0]!;

  await h.workflow.cancel();
  assert.equal(h.workflow.state.phase, "cancelled");
  assert.equal(oldClient.disposeCalls, 1);

  // Explicit replacement: same captured inputs reuse the retained pair and bind
  // through a fresh authority/player pair.
  const replacement = h.workflow.prepareTest(INPUTS, plan());
  await waitUntil(
    () => h.controller.state.session === "running" &&
      h.controller.state.trial !== null,
    "replacement trial staged",
  );
  const replacementToken = h.controller.state.trial!.token;
  const replacementRun = h.controller.state.snapshot!.runId;

  hold.release();
  await cancelled;
  await replacement;

  assert.equal(
    h.controller.state.session,
    "running",
    "the late old bind must not close the replacement session",
  );
  assert.notEqual(
    h.controller.state.trial,
    null,
    "the late old bind must not erase the replacement trial",
  );
  assert.equal(h.controller.state.trial?.token, replacementToken);
  assert.equal(h.controller.state.snapshot?.runId, replacementRun);
  assert.equal(h.workflow.state.phase, "ready");
  assert.equal(h.player.playCalls, 0);
  await h.workflow.dispose();
});

test("concurrent dispose calls both join ordered cleanup, report failures and never double dispose", async () => {
  const h = await harness();
  // Idle output discovery creates the controller's player without locking a run.
  await h.controller.refreshOutputDevices();
  assert.equal(h.controller.state.session, "idle");
  assert.equal(h.players.length, 1);

  const gate = h.holdNextPrepare();
  h.setFailEngineDispose(true);
  const run = h.workflow.prepareTest(INPUTS, plan());
  await waitUntil(() => h.prepareCalls() === 1, "held preparation");

  const first = h.workflow.dispose();
  const second = h.workflow.dispose();
  let firstDone = false;
  let secondDone = false;
  void first.then(() => {
    firstDone = true;
  });
  void second.then(() => {
    secondDone = true;
  });
  await tick();

  assert.equal(firstDone, false, "dispose must wait for the held preparation to settle");
  assert.equal(
    secondDone,
    false,
    "a concurrent dispose call must join the first cleanup rather than resolve early",
  );

  gate.resolve();
  await Promise.all([first, second]);
  await run;

  assert.deepEqual(
    h.events,
    [
      "controller:player",
      `release:${BUILT.artifact.id}`,
      "engine",
    ],
    "controller disposal precedes the lifecycle join and engine disposal",
  );
  assert.equal(h.player.disposeCalls, 1);
  assert.equal(h.cleanupFailures.length, 1);
  assert.match(h.cleanupFailures[0] ?? "", /engine dispose failed/);

  // An extra explicit call must not run cleanup again.
  await h.workflow.dispose();
  assert.equal(h.events.filter((event) => event === "engine").length, 1);
  assert.equal(h.player.disposeCalls, 1);
});

test("binding retry and plan reconfiguration configure without bypassing output readiness or auto-staging", async () => {
  const h = await harness();
  h.readers.corruptNextA();

  await h.workflow.prepareTest(INPUTS, plan());
  assert.equal(h.workflow.state.phase, "error");
  assert.match(h.workflow.state.message ?? "", /could not be verified and bound/);
  assert.equal(h.controller.state.error?.code, "artifact-bytes-mismatch");
  assert.equal(h.controller.state.trial, null);
  assert.equal(h.workflow.isPairReady(INPUTS), true);
  assert.equal(h.prepareCalls(), 1);
  const client = h.clients[0]!;
  assert.equal(client.nextTrialCalls, 0);

  // A pending output operation must block explicit staging even though the same
  // retained pair re-binds successfully.
  h.player.pending = "refresh";
  await h.workflow.prepareTest(INPUTS, plan());
  assert.equal(h.workflow.state.phase, "error");
  assert.match(h.workflow.state.message ?? "", /Trial 1 was not staged/);
  assert.doesNotMatch(h.workflow.state.message ?? "", /gate status/);
  assert.equal(h.controller.state.session, "configured");
  assert.equal(h.controller.state.trial, null);
  assert.equal(client.nextTrialCalls, 0, "no trial is drawn while output is pending");
  assert.equal(h.player.loadCalls.length, 0);
  assert.equal(h.player.playCalls, 0);
  assert.equal(h.workflow.isPairReady(INPUTS), true);
  assert.equal(h.prepareCalls(), 1, "the retry reuses the retained exact pair");

  // The real plan-reconfiguration path (ListeningSection submitPlan) goes through
  // the controller: it configures the changed plan and never stages a trial.
  h.player.pending = null;
  await h.controller.prepareSession(plan(4), BUILT.artifact, h.readers.readers);
  assert.equal(h.controller.state.snapshot?.plan.plannedTrials, 4);
  assert.equal(h.controller.state.session, "configured");
  assert.equal(h.controller.state.busy, null);
  assert.equal(h.controller.state.trial, null);
  assert.equal(client.nextTrialCalls, 0, "plan reconfiguration never auto-stages");
  await h.workflow.dispose();
});
