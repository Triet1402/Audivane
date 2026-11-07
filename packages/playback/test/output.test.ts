import assert from "node:assert/strict";
import test from "node:test";

import type { PlaybackLabel, TrialAudioReader } from "@codec-abx/contracts";

import { BrowserTrialPlayer } from "../src/player.js";
import {
  FakeAudioContext,
  bufferOf,
  deferred,
  makeWav,
} from "./fixtures.js";

const TRIAL = Object.freeze({
  runId: "run-output",
  token: "token-output",
  trialIndex: 1,
  kind: "scored" as const,
});

function reader(): TrialAudioReader {
  const bytes = makeWav({ seconds: 1, channels: 1, sampleRate: 48_000 });
  return async (_token: string, _label: PlaybackLabel) => bufferOf(bytes);
}

interface FakeDevice {
  readonly kind: string;
  readonly deviceId: string;
  readonly label: string;
}

function device(deviceId: string, label: string): MediaDeviceInfo {
  return {
    kind: "audiooutput",
    deviceId,
    label,
    groupId: "",
    toJSON() {
      return { kind: "audiooutput", deviceId, label, groupId: "" };
    },
  } as unknown as MediaDeviceInfo;
}

interface MediaBehavior {
  devices?: readonly MediaDeviceInfo[];
  enumerateError?: unknown;
  selectError?: unknown;
  selectedDevice?: string;
  enumerateGate?: Promise<void>;
  selectGate?: Promise<void>;
  enumerations?: number;
  getUserMediaCalls?: number;
  listener?: ((type: string) => void) | null;
}

function mediaDevices(behavior: MediaBehavior = {}): {
  readonly media: Record<string, unknown>;
  readonly behavior: MediaBehavior;
} {
  const state = behavior;
  const media: Record<string, unknown> = {
    async enumerateDevices() {
      state.enumerations = (state.enumerations ?? 0) + 1;
      if (state.enumerateGate) await state.enumerateGate;
      if (state.enumerateError) throw state.enumerateError;
      return state.devices ?? [];
    },
    async getUserMedia() {
      state.getUserMediaCalls = (state.getUserMediaCalls ?? 0) + 1;
      throw new Error("test must not capture media");
    },
    addEventListener(type: string, listener: () => void) {
      if (type === "devicechange") state.listener = () => listener();
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "devicechange" && state.listener) state.listener = null;
      void listener;
    },
  };
  if (state.selectError !== undefined) {
    media.selectAudioOutput = async () => {
      throw state.selectError;
    };
  } else if (state.selectedDevice !== undefined) {
    media.selectAudioOutput = async () => {
      if (state.selectGate) await state.selectGate;
      return { deviceId: state.selectedDevice };
    };
  }
  return { media, behavior: state };
}

async function withMedia<T>(media: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: media },
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

class FakeOutputContext extends FakeAudioContext {
  sinkId = "";
  readonly sinkCalls: string[] = [];
  setSinkError: unknown = null;
  setSinkGate: Promise<void> | null = null;
  readonly sinkListeners = new Set<() => void>();

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkCalls.push(sinkId);
    if (this.setSinkGate) await this.setSinkGate;
    if (this.setSinkError) throw this.setSinkError;
    this.sinkId = sinkId;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "sinkchange") this.sinkListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "sinkchange") this.sinkListeners.delete(listener);
  }

  dispatchSinkChange(next: string): void {
    this.sinkId = next;
    for (const listener of [...this.sinkListeners]) listener();
  }
}

function outputPlayer(context: FakeAudioContext): BrowserTrialPlayer {
  return new BrowserTrialPlayer({ audioContext: context.asBase() });
}

test("unsupported sink API keeps the default output usable and never captures media", async () => {
  const { media, behavior } = mediaDevices({
    devices: [device("unused", "Unused")],
  });
  await withMedia(media, async () => {
    const context = new FakeAudioContext();
    const player = outputPlayer(context);
    assert.equal(player.snapshot().output?.support, "unsupported");
    const refreshed = await player.refreshOutputDevices();
    assert.equal(refreshed.output?.support, "unsupported");
    assert.deepEqual(refreshed.output?.devices, []);
    const refused = await player.selectOutputDevice("speaker");
    assert.equal(refused.output?.support, "unsupported");
    assert.match(refused.output?.error ?? "", /^output-unsupported:/);
    assert.equal(refused.output?.selectedDeviceId, null);
    assert.equal(refused.output?.observedDeviceId, null);
    assert.equal(behavior.getUserMediaCalls ?? 0, 0);

    const loaded = await player.loadTrial(TRIAL, reader());
    assert.equal(loaded.phase, "ready");
    await player.play();
    assert.equal(player.snapshot().playing, true);
    await player.dispose();
  });
});

test("real selection pauses first, preserves position/side/loop, and never auto-resumes", async () => {
  const first = device("", "Default output");
  const { media } = mediaDevices({ devices: [first, device("speaker-2", "Speaker two")] });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    const refreshed = await player.refreshOutputDevices();
    assert.equal(refreshed.output?.support, "supported");
    assert.deepEqual(
      refreshed.output?.devices.map((entry) => entry.deviceId),
      ["", "speaker-2"],
    );
    assert.equal(refreshed.output?.pending, null);

    await player.loadTrial(TRIAL, reader());
    player.setLoop({ enabled: true, startSeconds: 0.1, endSeconds: 0.8 });
    player.select("B");
    await player.play();
    context.currentTime = 0.25;
    const before = player.snapshot();
    assert.equal(before.playing, true);

    const selected = await player.selectOutputDevice("speaker-2");
    assert.equal(selected.playing, false, "selection must not resume playback");
    assert.equal(selected.selected, "B");
    assert.equal(selected.loop.enabled, true);
    assert.equal(selected.loop.startSeconds, 0.1);
    assert.ok(Math.abs(selected.positionSeconds - before.positionSeconds) < 1e-9);
    assert.equal(selected.output?.requestedDeviceId, "speaker-2");
    assert.equal(selected.output?.selectedDeviceId, "speaker-2");
    assert.equal(selected.output?.observedDeviceId, "speaker-2");
    assert.equal(selected.output?.pending, null);
    assert.equal(selected.output?.change, "none");
    assert.equal(selected.output?.error, null);
    assert.deepEqual(context.sinkCalls, ["speaker-2"]);
    await player.dispose();
  });
});

test("selection failure never claims success or an observed route and leaks no device id", async () => {
  const { media } = mediaDevices({
    devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    const applied = await player.selectOutputDevice("speaker-2");
    assert.equal(applied.output?.selectedDeviceId, "speaker-2");
    context.setSinkError = Object.assign(new Error("device speaker-2 vanished"), {
      name: "NotFoundError",
    });
    const failed = await player.selectOutputDevice("missing-secret-device");
    assert.equal(failed.output?.selectedDeviceId, "speaker-2");
    assert.equal(failed.output?.observedDeviceId, "speaker-2");
    assert.equal(failed.output?.change, "none");
    assert.match(failed.output?.error ?? "", /^output-device-unavailable:/);
    assert.doesNotMatch(failed.output?.error ?? "", /missing-secret-device|speaker-2/);
    assert.equal(failed.output?.pending, null);
    await player.dispose();
  });
});

test("concurrent output operations are serialised", async () => {
  const { media } = mediaDevices({
    devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const gate = deferred<void>();
    context.setSinkGate = gate.promise;
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    const first = player.selectOutputDevice("speaker-2");
    await Promise.resolve();
    const second = await player.selectOutputDevice("");
    assert.equal(second.output?.pending, "select");
    assert.equal(second.output?.requestedDeviceId, "speaker-2");
    assert.equal(context.sinkCalls.length, 1, "a concurrent operation must not start a second route change");
    gate.resolve(undefined);
    const applied = await first;
    assert.equal(applied.output?.selectedDeviceId, "speaker-2");
    assert.equal(context.sinkCalls.length, 1);
    await player.dispose();
  });
});

test("reset during a late selection publishes no success and reconciles the actual sink", async () => {
  const { media } = mediaDevices({
    devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const gate = deferred<void>();
    context.setSinkGate = gate.promise;
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    const pending = player.selectOutputDevice("speaker-2");
    await Promise.resolve();
    const reset = player.reset();
    assert.equal(reset.output?.pending, null);
    gate.resolve(undefined);
    const late = await pending;
    assert.equal(late.phase, "empty");
    assert.equal(late.output?.selectedDeviceId, null, "late success must not claim an applied selection");
    assert.equal(late.output?.observedDeviceId, "speaker-2");
    assert.equal(late.output?.change, "changed");
    await player.dispose();
  });
});

test("dispose invalidates a late selection and removes sink/device listeners", async () => {
  const { media, behavior } = mediaDevices({
    devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const gate = deferred<void>();
    context.setSinkGate = gate.promise;
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    const pending = player.selectOutputDevice("speaker-2");
    await Promise.resolve();
    await player.dispose();
    assert.equal(context.sinkListeners.size, 0);
    assert.equal(behavior.listener ?? null, null);
    const enumerations = behavior.enumerations ?? 0;
    behavior.listener?.("devicechange");
    await Promise.resolve();
    assert.equal(behavior.enumerations ?? 0, enumerations, "devicechange after dispose must not refresh");
    gate.resolve(undefined);
    const late = await pending;
    assert.equal(late.phase, "disposed");
    assert.equal(late.output?.selectedDeviceId, null);
  });
});

test("enumeration denial is unavailable, sanitised and never requests media permission", async () => {
  const { media, behavior } = mediaDevices({
    enumerateError: Object.assign(new Error("user denied for group secret-7"), {
      name: "NotAllowedError",
    }),
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    const snapshot = await player.refreshOutputDevices();
    assert.equal(snapshot.output?.support, "unavailable");
    assert.match(snapshot.output?.error ?? "", /^output-enumeration-failed:/);
    assert.doesNotMatch(snapshot.output?.error ?? "", /secret-7/);
    assert.deepEqual(snapshot.output?.devices, []);
    assert.equal(behavior.getUserMediaCalls ?? 0, 0);
    await player.dispose();
  });
});

test("explicit chooser request applies the chosen device, and denial stays honest", async () => {
  const success = mediaDevices({
    devices: [device("", "Default output")],
    selectedDevice: "chosen-device",
  });
  await withMedia(success.media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    assert.equal(player.snapshot().output?.canRequest, true);
    await player.loadTrial(TRIAL, reader());
    await player.play();
    const requested = await player.requestOutputDevice();
    assert.equal(requested.playing, false, "chooser must pause before prompting");
    assert.equal(requested.output?.requestedDeviceId, "chosen-device");
    assert.equal(requested.output?.selectedDeviceId, "chosen-device");
    assert.equal(requested.output?.observedDeviceId, "chosen-device");
    await player.dispose();
  });

  const denied = mediaDevices({
    devices: [device("", "Default output")],
    selectError: Object.assign(new Error("permission denied for secret-device"), {
      name: "NotAllowedError",
    }),
  });
  await withMedia(denied.media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    const refused = await player.requestOutputDevice();
    assert.match(refused.output?.error ?? "", /^output-permission-denied:/);
    assert.doesNotMatch(refused.output?.error ?? "", /secret-device/);
    assert.equal(refused.output?.selectedDeviceId, null);
    await player.dispose();
  });

  const absent = mediaDevices({ devices: [device("", "Default output")] });
  await withMedia(absent.media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    assert.equal(player.snapshot().output?.canRequest, false);
    const refused = await player.requestOutputDevice();
    assert.match(refused.output?.error ?? "", /^output-chooser-unavailable:/);
    await player.dispose();
  });
});

test("unsolicited sink changes pause synchronously, including a default-route change", async () => {
  const { media } = mediaDevices({
    devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    await player.loadTrial(TRIAL, reader());
    await player.play();
    assert.equal(player.snapshot().playing, true);
    context.dispatchSinkChange("");
    const snapshot = player.snapshot();
    assert.equal(snapshot.output?.change, "changed");
    assert.equal(snapshot.playing, false, "an unexpected route change must pause immediately");
    assert.equal(snapshot.output?.observedDeviceId, "");
    await player.dispose();
  });
});

test("unplugging the selected device is reported as lost and pauses playback", async () => {
  const { media, behavior } = mediaDevices({
    devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    await player.selectOutputDevice("speaker-2");
    await player.loadTrial(TRIAL, reader());
    await player.play();
    assert.equal(player.snapshot().playing, true);
    behavior.devices = [
      device("", "Default output"),
      device("speaker-3", "Speaker three"),
    ];
    const refreshed = await player.refreshOutputDevices();
    assert.equal(refreshed.output?.change, "lost");
    assert.equal(refreshed.playing, false);
    assert.equal(refreshed.output?.selectedDeviceId, "speaker-2");
    await player.dispose();
  });
});

test("devicechange triggers a bounded refresh without selecting anything", async () => {
  const { media, behavior } = mediaDevices({
    devices: [device("", "Default output")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    assert.equal(behavior.enumerations ?? 0, 0);
    behavior.listener?.("devicechange");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(behavior.enumerations ?? 0, 1);
    assert.equal(player.snapshot().output?.selectedDeviceId, null);
    await player.dispose();
  });
});

test("late enumeration after reset or dispose cannot republish a stale device list", async () => {
  for (const action of ["reset", "dispose"] as const) {
    const gate = deferred<void>();
    const { media } = mediaDevices({
      devices: [device("", "Default output"), device("speaker-2", "Speaker two")],
      enumerateGate: gate.promise,
    });
    await withMedia(media, async () => {
      const context = new FakeOutputContext();
      const player = outputPlayer(context);
      const pending = player.refreshOutputDevices();
      await Promise.resolve();
      if (action === "reset") player.reset();
      else await player.dispose();
      gate.resolve(undefined);
      const late = await pending;
      assert.deepEqual(late.output?.devices, [], `${action}: stale enumeration was published`);
      assert.equal(late.output?.pending, null);
      if (action === "reset") await player.dispose();
    });
  }
});

test("late chooser selection after reset publishes neither success nor a selected device", async () => {
  const gate = deferred<void>();
  const { media } = mediaDevices({
    devices: [device("", "Default output")],
    selectedDevice: "chosen-device",
    selectGate: gate.promise,
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    const pending = player.requestOutputDevice();
    await Promise.resolve();
    player.reset();
    gate.resolve(undefined);
    const late = await pending;
    assert.equal(late.phase, "empty");
    assert.equal(late.output?.pending, null);
    assert.equal(late.output?.selectedDeviceId, null);
    assert.equal(late.output?.requestedDeviceId, null);
    await player.dispose();
  });
});

test("root regression: sinkchange during held enumeration pauses before enumeration settles", async () => {
  const { media, behavior } = mediaDevices({ devices: [device("", "Default")] });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    await player.loadTrial(TRIAL, reader());
    await player.play();
    const gate = deferred<void>();
    behavior.enumerateGate = gate.promise;
    const pending = player.refreshOutputDevices();
    context.dispatchSinkChange("");
    const changed = player.snapshot();
    gate.resolve(undefined);
    await pending;
    await player.dispose();
    assert.equal(changed.playing, false, "a refresh cannot mask a route-change stop");
    assert.equal(changed.output?.change, "changed");
  });
});

test("root regression: disappearance of a selected named route pauses even with only default remaining", async () => {
  const { media, behavior } = mediaDevices({ devices: [device("", "Default"), device("named", "Speaker")] });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    await player.selectOutputDevice("named");
    await player.loadTrial(TRIAL, reader());
    await player.play();
    behavior.devices = [device("", "Default")];
    const missing = await player.refreshOutputDevices();
    await player.dispose();
    assert.equal(missing.playing, false);
    assert.equal(missing.output?.change, "lost");
  });
});

test("root regression: a late route change after reset pauses a newly playing trial", async () => {
  const { media } = mediaDevices({ devices: [device("", "Default"), device("named", "Speaker")] });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    const gate = deferred<void>();
    context.setSinkGate = gate.promise;
    const pending = player.selectOutputDevice("named");
    player.reset();
    await player.loadTrial(TRIAL, reader());
    await player.play();
    gate.resolve(undefined);
    const late = await pending;
    await player.dispose();
    assert.equal(late.playing, false);
    assert.equal(late.output?.change, "changed");
  });
});

test("review regression: one matching sinkchange is expected after selection resolves, then later changes pause", async () => {
  const { media } = mediaDevices({ devices: [device("", "Default"), device("named", "Speaker")] });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.selectOutputDevice("named");
    await player.loadTrial(TRIAL, reader());
    context.dispatchSinkChange("named");
    const expected = player.snapshot();
    await player.play();
    context.dispatchSinkChange("named");
    const unsolicited = player.snapshot();
    await player.dispose();
    assert.equal(expected.output?.change, "none");
    assert.equal(unsolicited.output?.change, "changed");
    assert.equal(unsolicited.playing, false);
  });
});

test("review regression: selecting the existing default cannot hide a later default route change", async () => {
  const { media } = mediaDevices({ devices: [device("", "Default")] });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.selectOutputDevice("");
    await player.loadTrial(TRIAL, reader());
    await player.play();
    context.dispatchSinkChange("");
    const changed = player.snapshot();
    await player.dispose();
    assert.equal(changed.output?.change, "changed");
    assert.equal(changed.playing, false);
  });
});

test("devicechange during a held load is deferred and replayed after the set settles", async () => {
  const { media, behavior } = mediaDevices({
    devices: [device("", "Default output")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    const gate = deferred<void>();
    const read: TrialAudioReader = async () => {
      await gate.promise;
      return bufferOf(makeWav({ seconds: 1 }));
    };
    const loading = player.loadTrial(TRIAL, read);
    await Promise.resolve();
    behavior.listener?.("devicechange");
    await Promise.resolve();
    assert.equal(behavior.enumerations ?? 0, 0, "automatic enumeration must not interleave the load");
    gate.resolve(undefined);
    const loaded = await loading;
    assert.equal(loaded.phase, "ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(behavior.enumerations ?? 0, 1, "the deferred devicechange is replayed once");
    assert.equal(player.snapshot().output?.pending, null);
    await player.dispose();
  });
});

test("devicechange during continuation never stops or relabels the retired sounding graph", async () => {
  const { media, behavior } = mediaDevices({
    devices: [device("", "Default output")],
  });
  await withMedia(media, async () => {
    const context = new FakeOutputContext();
    const player = outputPlayer(context);
    await player.refreshOutputDevices();
    await player.loadTrial(TRIAL, reader());
    await player.play();
    context.currentTime = 0.1;
    const gate = deferred<void>();
    const read: TrialAudioReader = async () => {
      await gate.promise;
      return bufferOf(makeWav({ seconds: 0.5 }));
    };
    const next = Object.freeze({
      runId: TRIAL.runId,
      token: "token-output-next",
      trialIndex: 2,
      kind: "scored" as const,
    });
    const loading = player.loadTrial(next, read, { carryPrevious: true });
    await Promise.resolve();
    behavior.devices = [
      device("", "Default output"),
      device("speaker-new", "New speaker"),
    ];
    behavior.listener?.("devicechange");
    await Promise.resolve();
    assert.equal(behavior.enumerations ?? 0, 1, "no enumeration while the continuation is reading");
    gate.resolve(undefined);
    const staged = await loading;
    assert.equal(staged.phase, "ready");
    assert.equal(staged.playing, true);
    assert.equal(staged.carryingPreviousTrial, true);
    assert.equal(staged.selectionRequired, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(behavior.enumerations ?? 0, 2, "the deferred discovery runs after the staged set is ready");
    const after = player.snapshot();
    assert.equal(after.playing, true, "mere enumeration must not pause an active run");
    assert.equal(after.carryingPreviousTrial, true);
    assert.deepEqual(
      after.output?.devices.map((entry) => entry.deviceId),
      ["", "speaker-new"],
    );
    await player.dispose();
  });
});
