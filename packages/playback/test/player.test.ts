import assert from "node:assert/strict";
import test from "node:test";

import type { PlaybackLabel, PublicTrial, TrialAudioReader } from "@codec-abx/contracts";

import { PlaybackError } from "../src/errors.js";
import { BrowserTrialPlayer, LIVE_SCHEDULE_LEAD_SECONDS } from "../src/player.js";
import {
  FakeAudioContext,
  bufferOf,
  deferred,
  makeWav,
} from "./fixtures.js";

interface MutableTrial {
  runId: string;
  token: string;
  trialIndex: number;
  kind: "calibration" | "scored";
}

function trial(token = "token-1", index = 1): MutableTrial {
  return { runId: "run-1", token, trialIndex: index, kind: "scored" };
}

function goodReader(options: {
  readonly seconds?: number;
  readonly channels?: 1 | 2;
  readonly sampleRate?: number;
  readonly calls?: Array<[string, PlaybackLabel]>;
  readonly returned?: ArrayBuffer[];
} = {}): TrialAudioReader {
  const bytes = makeWav({
    seconds: options.seconds ?? 1,
    channels: options.channels ?? 1,
    sampleRate: options.sampleRate ?? 48_000,
  });
  return async (tokenValue, label) => {
    options.calls?.push([tokenValue, label]);
    const buffer = bufferOf(bytes);
    options.returned?.push(buffer);
    return buffer;
  };
}

function playerWith(context: FakeAudioContext): BrowserTrialPlayer {
  return new BrowserTrialPlayer({ audioContext: context.asBase() });
}

test("load reads A/B/X concurrently from the frozen token and publishes paused", async () => {
  const context = new FakeAudioContext(44_100);
  const player = playerWith(context);
  const calls: Array<[string, PlaybackLabel]> = [];
  const returned: ArrayBuffer[] = [];
  const gate = deferred<void>();
  const bytes = makeWav({ seconds: 1, channels: 2, sampleRate: 44_100 });
  const read: TrialAudioReader = async (tokenValue, label) => {
    calls.push([tokenValue, label]);
    await gate.promise;
    const buffer = bufferOf(bytes);
    returned.push(buffer);
    return buffer;
  };
  const input = trial("frozen-token");
  const loading = player.loadTrial(input, read);
  input.token = "mutated-token";
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.map((call) => call[1]).sort(), ["A", "B", "X"]);
  assert.ok(calls.every((call) => call[0] === "frozen-token"));
  gate.resolve(undefined);
  const snapshot = await loading;

  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.playing, false);
  assert.equal(snapshot.selected, "X");
  assert.equal(snapshot.positionSeconds, 0);
  assert.equal(snapshot.durationSeconds, 1);
  assert.equal(snapshot.deliveredSampleRate, 44_100);
  assert.equal(snapshot.outputSampleRate, 44_100);
  assert.equal(snapshot.channels, 2);
  assert.deepEqual(snapshot.loop, { enabled: false, startSeconds: 0, endSeconds: 1 });
  assert.equal(snapshot.trial?.token, "frozen-token");
  assert.equal(snapshot.trial?.kind, "scored");
  assert.equal(snapshot.error, null);

  assert.equal(context.sources.length, 0);
  assert.equal(context.gains.length, 0);
  assert.equal(returned.length, 3);
  assert.equal(context.buffers.length, 3);
  const firstPcm = context.buffers[0]?.channelData[0]?.[100] ?? 0;
  assert.notEqual(firstPcm, 0);
  new Uint8Array(returned[0]!).fill(0);
  assert.equal(context.buffers[0]?.channelData[0]?.[100], firstPcm);
  assert.equal(player.snapshot().phase, "ready");
});

test("a partial load clears old playback and a same-token retry keeps intent", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  const readGood = goodReader();
  const first = await player.loadTrial(trial("first"), readGood);
  assert.equal(first.phase, "ready");
  await player.play();
  context.currentTime = LIVE_SCHEDULE_LEAD_SECONDS + 0.2;
  player.select("B");

  const failing: TrialAudioReader = async (tokenValue, label) => {
    if (label === "X") throw new Error("private reader detail");
    return goodReader()(tokenValue, label);
  };
  const failed = await player.loadTrial(trial("second", 2), failing);
  assert.equal(failed.phase, "error");
  assert.equal(failed.playing, false);
  assert.equal(failed.durationSeconds, 0);
  assert.equal(failed.deliveredSampleRate, null);
  assert.equal(failed.channels, null);
  assert.equal(failed.selected, "B");
  assert.match(failed.error ?? "", /^load-failed:/);
  assert.doesNotMatch(failed.error ?? "", /private reader detail/);
  const oldSources = context.sources.slice(-3);
  assert.ok(oldSources.every((source) => source.stopAt !== null));
  oldSources[0]?.fireEnded();
  assert.equal(player.snapshot().phase, "error");

  const retried = await player.loadTrial(trial("second", 2), readGood);
  assert.equal(retried.phase, "ready");
  assert.equal(retried.playing, true);
  assert.equal(retried.selected, "B");
  assert.ok(Math.abs(retried.positionSeconds - 0.2) < 1e-9);
  assert.equal(retried.error, null);
});

test("late reads from a superseded load cannot publish over the new trial", async () => {
  const player = playerWith(new FakeAudioContext());
  const gate = deferred<void>();
  const slow: TrialAudioReader = async () => {
    await gate.promise;
    return bufferOf(makeWav({ seconds: 0.5 }));
  };
  const slowLoad = player.loadTrial(trial("slow"), slow);
  const fastLoad = player.loadTrial(trial("fast"), goodReader({ seconds: 1 }));
  const fast = await fastLoad;
  assert.equal(fast.trial?.token, "fast");
  assert.equal(fast.durationSeconds, 1);
  gate.resolve(undefined);
  const late = await slowLoad;
  assert.equal(late.trial?.token, "fast");
  assert.equal(late.phase, "ready");
  assert.equal(late.durationSeconds, 1);
});

test("reset invalidates pending reads and clears all controls", async () => {
  const player = playerWith(new FakeAudioContext());
  const gate = deferred<void>();
  const read: TrialAudioReader = async () => {
    await gate.promise;
    return bufferOf(makeWav({ seconds: 1 }));
  };
  let notifications = 0;
  const unsubscribe = player.subscribe(() => {
    notifications += 1;
  });
  const pending = player.loadTrial(trial("late"), read);
  await Promise.resolve();
  await Promise.resolve();
  player.select("A");
  player.setLoop({ enabled: false, startSeconds: 0, endSeconds: 0 });
  const reset = player.reset();
  assert.equal(reset.phase, "empty");
  gate.resolve(undefined);
  const final = await pending;
  assert.equal(final.phase, "empty");
  assert.equal(final.trial, null);
  assert.equal(final.selected, "X");
  assert.equal(final.positionSeconds, 0);
  assert.deepEqual(final.loop, { enabled: false, startSeconds: 0, endSeconds: 0 });
  assert.equal(final.deliveredSampleRate, null);
  assert.ok(notifications >= 3);
  unsubscribe();
});

test("dispose closes only the context the player owns", async () => {
  const injected = new FakeAudioContext();
  const injectedPlayer = playerWith(injected);
  await injectedPlayer.loadTrial(trial(), goodReader());
  await injectedPlayer.play();
  await injectedPlayer.dispose();
  assert.equal(injected.closeCalls, 0);
  assert.equal(injected.state, "running");
  assert.equal(injectedPlayer.snapshot().phase, "disposed");
  await assert.rejects(
    injectedPlayer.play(),
    (error: unknown) => error instanceof PlaybackError && error.code === "disposed",
  );

  const globalObject = globalThis as { AudioContext?: unknown };
  const original = globalObject.AudioContext;
  const ownedContext = new FakeAudioContext(48_000);
  globalObject.AudioContext = function FakeAudioContextConstructor() {
    return ownedContext;
  };
  try {
    const player = new BrowserTrialPlayer();
    const loaded = await player.loadTrial(trial(), goodReader());
    assert.equal(loaded.outputSampleRate, null);
    const playing = await player.play();
    assert.equal(playing.playing, true);
    assert.equal(playing.outputSampleRate, 48_000);
    await player.dispose();
    assert.equal(ownedContext.closeCalls, 1);
    assert.equal(ownedContext.state, "closed");
  } finally {
    globalObject.AudioContext = original;
  }
});

test("subscribers receive fresh DTOs, cannot mutate intent, and cannot break cleanup", async () => {
  const player = playerWith(new FakeAudioContext());
  await player.loadTrial(trial(), goodReader());
  let notifications = 0;
  const unsubscribe = player.subscribe((snapshot) => {
    notifications += 1;
    assert.throws(() => {
      (snapshot as { positionSeconds: number }).positionSeconds = 99;
    });
    assert.throws(() => {
      (snapshot.loop as { enabled: boolean }).enabled = true;
    });
    assert.throws(() => {
      (snapshot.trial as { token: string }).token = "evil";
    });
    throw new Error("subscriber failure");
  });
  const selected = player.select("A");
  assert.equal(selected.selected, "A");
  assert.equal(notifications, 1);
  assert.equal(player.snapshot().positionSeconds, 0);
  assert.equal(player.snapshot().loop.enabled, false);
  assert.equal(player.snapshot().trial?.token, "token-1");
  unsubscribe();
  player.select("B");
  assert.equal(notifications, 1);
});

test("nonloop end stops once and stale source events cannot resurrect a new trial", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("old"), goodReader({ seconds: 1 }));
  await player.play();
  const sources = context.sources.slice(-3);
  assert.equal(sources.length, 3);
  context.currentTime = 1.2;
  let notifications = 0;
  player.subscribe(() => {
    notifications += 1;
  });
  sources[0]?.fireEnded();
  const ended = player.snapshot();
  assert.equal(ended.playing, false);
  assert.equal(ended.positionSeconds, 1);
  assert.equal(notifications, 1);
  sources[1]?.fireEnded();
  sources[2]?.fireEnded();
  assert.equal(player.snapshot().playing, false);
  assert.equal(notifications, 1);

  const next = await player.loadTrial(trial("new", 2), goodReader({ seconds: 0.5 }));
  assert.equal(next.phase, "ready");
  sources[0]?.fireEnded();
  sources[1]?.fireEnded();
  assert.equal(player.snapshot().trial?.token, "new");
  assert.equal(player.snapshot().playing, false);
});

test("resume failure is disclosed, clears on retry, and never flips play intent permanently", async () => {
  const context = new FakeAudioContext();
  context.state = "suspended";
  context.resumeError = new Error("autoplay blocked");
  const player = playerWith(context);
  await player.loadTrial(trial(), goodReader());
  const blocked = await player.play();
  assert.equal(blocked.phase, "ready");
  assert.equal(blocked.playing, false);
  assert.match(blocked.error ?? "", /^context-suspended:/);
  assert.equal(context.resumeCalls, 1);

  context.resumeError = null;
  const resumed = await player.play();
  assert.equal(resumed.playing, true);
  assert.equal(resumed.error, null);
  assert.equal(context.resumeCalls, 2);
});

test("seek/loop controls clamp, validate, and preserve play intent", async () => {
  const context = new FakeAudioContext();
  context.currentTime = 0.1;
  const player = playerWith(context);
  await player.loadTrial(trial(), goodReader({ seconds: 1 }));
  await player.play();
  assert.equal(player.snapshot().playing, true);

  assert.equal(player.seek(2).positionSeconds, 1);
  assert.equal(player.seek(0.5).positionSeconds, 0.5);
  assert.equal(player.snapshot().playing, true);
  const before = player.snapshot();
  assert.throws(
    () => player.seek(Number.NaN),
    (error: unknown) => error instanceof PlaybackError && error.code === "invalid-position",
  );
  assert.equal(player.snapshot().positionSeconds, before.positionSeconds);
  assert.throws(
    () => player.select("Q" as PlaybackLabel),
    (error: unknown) => error instanceof PlaybackError && error.code === "invalid-label",
  );
  assert.throws(
    () => player.setLoop({ enabled: true, startSeconds: 0.2, endSeconds: 0.209 }),
    (error: unknown) => error instanceof PlaybackError && error.code === "invalid-loop",
  );

  const looped = player.setLoop({ enabled: true, startSeconds: 0.2, endSeconds: 0.4 });
  assert.deepEqual(looped.loop, { enabled: true, startSeconds: 0.2, endSeconds: 0.4 });
  assert.ok(Math.abs(looped.positionSeconds - 0.3) < 1e-9);
  assert.equal(looped.playing, true);

  const paused = player.pause();
  assert.equal(paused.playing, false);
  assert.ok(Math.abs(paused.positionSeconds - 0.3) < 1e-9);
  assert.deepEqual(paused.loop, { enabled: true, startSeconds: 0.2, endSeconds: 0.4 });
  const after = await player.play();
  assert.equal(after.playing, true);
  assert.ok(Math.abs(after.positionSeconds - 0.3) < 1e-9);

  const reset = player.reset();
  assert.equal(reset.phase, "empty");
  assert.equal(reset.selected, "X");
  assert.equal(reset.positionSeconds, 0);
  assert.deepEqual(reset.loop, { enabled: false, startSeconds: 0, endSeconds: 0 });
});

test("rapid selection reversal preserves in-flight complementary gain values", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial(), goodReader());
  await player.play();
  assert.equal(context.gains.length, 4);
  const [, gainA, gainB, gainX] = context.gains;
  assert.ok(gainA && gainB && gainX);

  player.select("B");
  context.currentTime = 0.002;
  player.select("A");
  context.currentTime = 0.003;
  player.select("B");

  const sets = (param: typeof gainA.gain): number[] =>
    param.events.filter((event) => event.type === "set").map((event) => event.value);
  const a = sets(gainA.gain);
  const b = sets(gainB.gain);
  const x = sets(gainX.gain);
  assert.ok(Math.abs(a[1]! - 0) < 1e-9);
  assert.ok(Math.abs(b[1]! - 0.4) < 1e-9);
  assert.ok(Math.abs(x[1]! - 0.6) < 1e-9);
  assert.ok(Math.abs(a[2]! - 0.2) < 1e-9);
  assert.ok(Math.abs(b[2]! - 0.32) < 1e-9);
  assert.ok(Math.abs(x[2]! - 0.48) < 1e-9);
  for (let index = 1; index < 3; index += 1) {
    assert.ok(Math.abs(a[index]! + b[index]! + x[index]! - 1) < 1e-9);
  }
  const targets = [gainA, gainB, gainX].map((gain) =>
    gain.gain.events.filter((event) => event.type === "ramp").at(-1)?.value,
  );
  assert.deepEqual(targets, [0, 1, 0]);
});

test("layout or reader-shape failures reject the whole atomic load", async () => {
  for (const failure of ["layout", "shape"] as const) {
    const player = playerWith(new FakeAudioContext());
    const read: TrialAudioReader = async (_token, label) => {
      if (failure === "shape") return "not an arraybuffer" as unknown as ArrayBuffer;
      if (label === "B") {
        return bufferOf(makeWav({ seconds: 1, channels: 2 }));
      }
      return bufferOf(makeWav({ seconds: 1, channels: 1 }));
    };
    const snapshot = await player.loadTrial(trial(), read);
    assert.equal(snapshot.phase, "error");
    assert.equal(snapshot.durationSeconds, 0);
    assert.match(snapshot.error ?? "", /^load-failed:/);
  }
});

test("subsequent load clamps preserved loop, position and play intent", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("one"), goodReader({ seconds: 1 }));
  await player.play();
  context.currentTime = LIVE_SCHEDULE_LEAD_SECONDS + 0.3;
  player.select("B");
  player.setLoop({ enabled: true, startSeconds: 0.2, endSeconds: 0.8 });

  const next = await player.loadTrial(trial("two", 2), goodReader({ seconds: 0.5 }));
  assert.equal(next.phase, "ready");
  assert.equal(next.selected, "B");
  assert.equal(next.playing, true);
  assert.deepEqual(next.loop, { enabled: true, startSeconds: 0.2, endSeconds: 0.5 });
  assert.ok(Math.abs(next.positionSeconds - 0.3) < 1e-9);

  const paused = player.pause();
  assert.equal(paused.playing, false);
  const nextPaused = await player.loadTrial(trial("three", 3), goodReader({ seconds: 0.5 }));
  assert.equal(nextPaused.playing, false);
  assert.equal(nextPaused.selected, "B");
  assert.equal(nextPaused.loop.enabled, true);
});

test("clear coded errors guard unloaded and invalid controls", async () => {
  const player = new BrowserTrialPlayer({ audioContext: new FakeAudioContext().asBase() });
  await assert.rejects(
    player.play(),
    (error: unknown) => error instanceof PlaybackError && error.code === "not-loaded",
  );
  assert.throws(
    () => player.seek(0),
    (error: unknown) => error instanceof PlaybackError && error.code === "not-loaded",
  );
  assert.throws(
    () => player.setLoop({ enabled: true, startSeconds: 0, endSeconds: 0.1 }),
    (error: unknown) => error instanceof PlaybackError && error.code === "not-loaded",
  );
});

test("Pause cancels play and next-load autoplay while context resume is pending", async () => {
  for (const operation of ["play", "next-load"] as const) {
    const context = new FakeAudioContext();
    const player = playerWith(context);
    await player.loadTrial(trial(), goodReader());
    if (operation === "next-load") await player.play();
    const started = deferred<void>();
    const resumed = deferred<void>();
    context.state = "suspended";
    context.resume = async () => {
      started.resolve(undefined);
      await resumed.promise;
      context.state = "running";
    };
    const pending = operation === "play" ? player.play()
      : player.loadTrial(trial("next", 2), goodReader());
    await started.promise;
    const count = context.sources.length;
    player.pause();
    resumed.resolve(undefined);
    await pending;
    assert.equal(context.sources.length, count, "late resume must not create audible sources after Pause");
    assert.equal(player.snapshot().playing, false);
  }
});

test("Reset and dispose immediately silence every retiring fade graph", async () => {
  for (const action of ["reset", "dispose"] as const) {
    const context = new FakeAudioContext();
    const player = playerWith(context);
    await player.loadTrial(trial(), goodReader());
    await player.play();
    context.currentTime = 0.1;
    player.seek(0.4);
    player.pause();
    assert.ok(context.sources.some((source) => (source.stopAt ?? 0) > context.currentTime));
    if (action === "reset") player.reset();
    else await player.dispose();
    assert.ok(context.sources.every((source) => source.stopAt === context.currentTime),
      "all current and retiring groups must stop immediately");
    assert.ok(context.sources.every((source) => source.disconnected));
    assert.ok(context.gains.every((gain) => gain.disconnected));
  }
});

test("live source groups share a future timestamp despite graph construction time", async () => {
  const context = new FakeAudioContext();
  const create = context.createBufferSource.bind(context);
  context.createBufferSource = () => { context.currentTime += 0.001; return create(); };
  const player = playerWith(context);
  await player.loadTrial(trial(), goodReader());
  await player.play();
  const times = context.sources.map((source) => source.started!.when);
  assert.equal(new Set(times).size, 1);
  assert.ok(times[0]! > context.currentTime, "a shared timestamp in the past can start live sources in different quanta");
});

function stagedReader(
  seconds: number,
  gate?: Promise<void>,
): TrialAudioReader {
  const bytes = makeWav({ seconds, channels: 1, sampleRate: 48_000 });
  return async () => {
    if (gate) await gate;
    return bufferOf(bytes);
  };
}

test("continuation keeps the sounding graph and clock, stages atomically, then switches at the shared position", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("first"), goodReader({ seconds: 1 }));
  await player.play();
  context.currentTime = LIVE_SCHEDULE_LEAD_SECONDS + 0.2;
  player.select("B");
  const oldSources = context.sources.slice();
  const oldBuffers = context.buffers.slice();
  const gate = deferred<void>();

  const staging = player.loadTrial(trial("second", 2), stagedReader(0.5, gate.promise), {
    carryPrevious: true,
  });
  const during = player.snapshot();
  assert.equal(during.phase, "loading");
  assert.equal(during.trial?.token, "second");
  assert.equal(during.playing, true);
  assert.equal(during.carryingPreviousTrial, true);
  assert.equal(during.selectionRequired, true);
  assert.equal(during.selected, "B", "the retired label stays available only behind the flag");
  assert.ok(Math.abs(during.positionSeconds - 0.2) < 1e-9);
  assert.ok(oldSources.every((source) => source.stopAt === null), "staging must not stop the sounding graph");
  assert.equal(context.buffers.length, 3, "no new buffer is published before all reads settle");

  gate.resolve(undefined);
  const staged = await staging;
  assert.equal(staged.phase, "ready");
  assert.equal(staged.trial?.token, "second");
  assert.equal(staged.playing, true);
  assert.equal(staged.carryingPreviousTrial, true);
  assert.equal(staged.selectionRequired, true);
  assert.equal(staged.selected, "B");
  assert.equal(staged.durationSeconds, 1, "while carrying, duration describes the audible retired graph");
  assert.ok(Math.abs(staged.positionSeconds - 0.2) < 1e-9);
  assert.ok(oldSources.every((source) => source.stopAt === null));
  assert.equal(context.buffers.length, 6, "exactly one pending A/B/X set is retained");
  const newBuffers = context.buffers.slice(3);
  assert.deepEqual(newBuffers.map((buffer) => buffer.length), oldBuffers.map(() => 24_000));

  const switched = player.select("A");
  assert.equal(switched.selected, "A");
  assert.equal(switched.selectionRequired, false);
  assert.equal(switched.carryingPreviousTrial, false);
  assert.equal(switched.playing, true);
  assert.equal(switched.durationSeconds, 0.5);
  assert.ok(Math.abs(switched.positionSeconds - (0.2 + LIVE_SCHEDULE_LEAD_SECONDS)) < 1e-9);
  assert.ok(oldSources.every((source) => (source.stopAt ?? 0) > context.currentTime),
    "the retired graph fades out at the click-safe switch time");
  const newSources = context.sources.slice(3);
  assert.equal(newSources.length, 3);
  assert.ok(newSources.every((source) => source.started !== null));
  const start = newSources[0]!.started!;
  assert.ok(Math.abs(start.offset - (0.2 + start.when - context.currentTime)) < 1e-9,
    "the new token joins the live clock at its scheduled start");
  assert.ok(oldSources.every((source) => source.stopAt === start.when),
    "the live scheduling lead must not create silence between graphs");
  const oldMaster = context.gains[0]!;
  assert.ok(oldMaster.gain.events.some((event) => event.type === "set" && event.value === 1 &&
    Math.abs(event.time - (start.when - 0.005)) < 1e-9),
  "the old graph holds steady until its five millisecond fade");
  assert.equal(newSources[0]!.buffer, newBuffers[0]);
  assert.equal(newSources[1]!.buffer, newBuffers[1]);
  assert.equal(newSources[2]!.buffer, newBuffers[2]);
});

test("failed continuation publishes no partial set, keeps only retired sound, and retries the same token", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("first"), goodReader({ seconds: 1 }));
  await player.play();
  context.currentTime = LIVE_SCHEDULE_LEAD_SECONDS + 0.1;
  const oldSources = context.sources.slice();
  const failing: TrialAudioReader = async (token, label) => {
    if (label === "X") throw new Error("private continuation detail");
    return goodReader()(token, label);
  };
  const failed = await player.loadTrial(trial("second", 2), failing, { carryPrevious: true });
  assert.equal(failed.phase, "error");
  assert.equal(failed.trial?.token, "second");
  assert.equal(failed.playing, true, "the old graph remains audible as retired monitoring");
  assert.equal(failed.carryingPreviousTrial, true);
  assert.equal(failed.selectionRequired, true);
  assert.equal(failed.durationSeconds, 1);
  assert.match(failed.error ?? "", /^load-failed:/);
  assert.doesNotMatch(failed.error ?? "", /private continuation detail/);
  assert.equal(context.buffers.length, 3, "a failed read publishes no new buffers");
  assert.ok(oldSources.every((source) => source.stopAt === null));
  assert.throws(
    () => player.select("A"),
    (error: unknown) => error instanceof PlaybackError && error.code === "not-loaded",
    "a failed staged set cannot be selected",
  );

  const retried = await player.loadTrial(trial("second", 2), stagedReader(0.5), {
    carryPrevious: true,
  });
  assert.equal(retried.phase, "ready");
  assert.equal(retried.selectionRequired, true);
  assert.equal(retried.carryingPreviousTrial, true);
  assert.equal(context.buffers.length, 6);
  const switched = player.select("B");
  assert.equal(switched.selectionRequired, false);
  assert.equal(switched.carryingPreviousTrial, false);
  assert.equal(switched.durationSeconds, 0.5);
  assert.ok(oldSources.every((source) => (source.stopAt ?? 0) > context.currentTime));

  player.reset();
  const cleared = player.snapshot();
  assert.equal(cleared.phase, "empty");
  assert.equal(cleared.selectionRequired, false);
  assert.equal(cleared.carryingPreviousTrial, false);
  assert.equal(cleared.durationSeconds, 0);
});

test("paused answers stay paused across continuation and require an explicit pick before Play", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("first"), goodReader({ seconds: 1 }));
  player.seek(0.3);
  assert.equal(player.snapshot().playing, false);
  const staged = await player.loadTrial(trial("second", 2), stagedReader(0.5), {
    carryPrevious: true,
  });
  assert.equal(staged.phase, "ready");
  assert.equal(staged.playing, false, "a paused trial must not resume on continuation");
  assert.equal(staged.carryingPreviousTrial, false);
  assert.equal(staged.selectionRequired, true);
  assert.equal(staged.durationSeconds, 0.5);
  assert.ok(Math.abs(staged.positionSeconds - 0.3) < 1e-9);
  assert.equal(context.sources.length, 0);
  await assert.rejects(
    player.play(),
    (error: unknown) => error instanceof PlaybackError && error.code === "not-loaded",
    "playing an unselected staged trial would mislabel the audio",
  );

  const selected = player.select("A");
  assert.equal(selected.selectionRequired, false);
  assert.equal(selected.playing, false);
  assert.ok(Math.abs(selected.positionSeconds - 0.3) < 1e-9);
  const playing = await player.play();
  assert.equal(playing.playing, true);
  const sources = context.sources.slice(-3);
  assert.equal(sources.length, 3);
  assert.ok(Math.abs(sources[0]!.started!.offset - 0.3) < 1e-9);
});

test("retired track end disables carry monitoring but keeps the verified staged set ready", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("first"), goodReader({ seconds: 1 }));
  await player.play();
  context.currentTime = LIVE_SCHEDULE_LEAD_SECONDS + 0.1;
  const oldSources = context.sources.slice();
  await player.loadTrial(trial("second", 2), stagedReader(0.5), { carryPrevious: true });
  oldSources[0]!.fireEnded();
  const ended = player.snapshot();
  assert.equal(ended.playing, false);
  assert.equal(ended.carryingPreviousTrial, false);
  assert.equal(ended.selectionRequired, true);
  assert.equal(ended.durationSeconds, 0.5);
  assert.ok(Math.abs(ended.positionSeconds - 0.5) < 1e-9);

  const selected = player.select("A");
  assert.equal(selected.selectionRequired, false);
  assert.equal(selected.playing, false);
  const played = await player.play();
  assert.equal(played.playing, true);
  const sources = context.sources.slice(-3);
  assert.equal(sources[0]!.started!.offset, 0, "a finished track restarts explicitly from zero");
});

test("continuation retains the shared loop, clamped to the new pair, through the switch", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("first"), goodReader({ seconds: 1 }));
  player.setLoop({ enabled: true, startSeconds: 0.1, endSeconds: 0.8 });
  await player.play();
  context.currentTime = LIVE_SCHEDULE_LEAD_SECONDS + 0.3;
  const staged = await player.loadTrial(trial("second", 2), stagedReader(0.5), {
    carryPrevious: true,
  });
  assert.equal(staged.loop.enabled, true);
  assert.equal(staged.loop.startSeconds, 0.1);
  assert.equal(staged.loop.endSeconds, 0.5);
  assert.ok(Math.abs(staged.positionSeconds - 0.3) < 1e-9);

  const switched = player.select("X");
  assert.equal(switched.loop.enabled, true);
  assert.equal(switched.loop.startSeconds, 0.1);
  assert.equal(switched.loop.endSeconds, 0.5);
  const sources = context.sources.slice(-3);
  assert.ok(sources.every((source) => source.loop === true));
  assert.ok(Math.abs(sources[0]!.loopStart - 0.1) < 1e-9);
  assert.ok(Math.abs(sources[0]!.loopEnd - 0.5) < 1e-9);
  assert.ok(Math.abs(sources[0]!.started!.offset - (0.3 + LIVE_SCHEDULE_LEAD_SECONDS)) < 1e-9);
});

test("a superseded continuation cannot publish its late set over the newer staged token", async () => {
  const context = new FakeAudioContext();
  const player = playerWith(context);
  await player.loadTrial(trial("first"), goodReader({ seconds: 1 }));
  await player.play();
  const gate = deferred<void>();
  const slow = player.loadTrial(trial("slow", 2), stagedReader(0.5, gate.promise), {
    carryPrevious: true,
  });
  // (kept as a named promise so the newer continuation can win first)
  const fast = await player.loadTrial(trial("fast", 3), stagedReader(0.5), {
    carryPrevious: true,
  });
  assert.equal(fast.trial?.token, "fast");
  assert.equal(fast.selectionRequired, true);
  assert.equal(context.buffers.length, 6, "only one pending set may be retained");
  gate.resolve(undefined);
  const late = await slow;
  assert.equal(late.trial?.token, "fast");
  assert.equal(late.selectionRequired, true);
  assert.equal(late.playing, true);
  assert.equal(context.buffers.length, 6, "a superseded set never allocates a second pending copy");
  player.select("A");
  assert.equal(player.snapshot().trial?.token, "fast");
});
