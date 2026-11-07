/**
 * Test-only live BrowserTrialPlayer harness for OS-level output capture.
 *
 * The bundle is served by a Playwright route from the real application origin.
 * It is never imported by the app, exposes no production route/global and only
 * reads local fixture bytes. Every transport action is a real button click.
 */
import type { PlaybackLabel, PublicTrial } from "@codec-abx/contracts";
import { BrowserTrialPlayer } from "@codec-abx/playback";
import {
  LOOP_END_SECONDS,
  LOOP_START_SECONDS,
  MARKER_SEEK_SECONDS,
  makeCaptureWav,
  type CaptureFixture,
} from "./fixtures";

const TRIAL: PublicTrial = {
  runId: "audio-output-capture",
  token: "audio-output-capture",
  trialIndex: 1,
  kind: "scored",
};

const NEXT_TRIAL: PublicTrial = {
  runId: "audio-output-capture",
  token: "audio-output-capture-next",
  trialIndex: 2,
  kind: "scored",
};

/** Longer than any playback scheduling lead so the old graph must be audible. */
const NEXT_READ_DELAY_MS = 1_200;

const categories = (value: string | null): string | null =>
  value === null ? null : value === "" ? "default" : "named";

let player = new BrowserTrialPlayer();
let loaded: CaptureFixture | null = null;

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function state(): Record<string, unknown> {
  const snapshot = player.snapshot();
  const output = snapshot.output;
  return {
    phase: snapshot.phase,
    playing: snapshot.playing,
    selected: snapshot.selected,
    selectionRequired: snapshot.selectionRequired === true,
    carryingPreviousTrial: snapshot.carryingPreviousTrial === true,
    trialToken: snapshot.trial?.token ?? null,
    positionSeconds: snapshot.positionSeconds,
    durationSeconds: snapshot.durationSeconds,
    deliveredSampleRate: snapshot.deliveredSampleRate,
    outputSampleRate: snapshot.outputSampleRate,
    channels: snapshot.channels,
    error: snapshot.error,
    loaded,
    output: output === undefined
      ? null
      : {
          support: output.support,
          canRequest: output.canRequest,
          deviceCount: output.devices.length,
          deviceCategories: output.devices.map((device) => device.deviceId === "" ? "default" : "named"),
          pending: output.pending,
          requested: categories(output.requestedDeviceId),
          selected: categories(output.selectedDeviceId),
          observed: categories(output.observedDeviceId),
          change: output.change,
          error: output.error,
        },
  };
}

const button = (id: string, text: string): HTMLButtonElement => {
  const element = document.createElement("button");
  element.id = id;
  element.type = "button";
  element.textContent = text;
  document.body.append(element);
  return element;
};

const status = document.createElement("pre");
status.id = "capture-status";
status.dataset.phase = "idle";
status.dataset.action = "none";
status.textContent = JSON.stringify(state());
document.body.append(status);

function publish(action: string): void {
  status.dataset.action = action;
  status.dataset.phase = String(state().phase);
  status.textContent = JSON.stringify(state());
}

async function perform(action: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    publish(action);
  } catch (error) {
    status.dataset.action = `${action}-error`;
    status.textContent = JSON.stringify({
      ...state(),
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

async function load(kind: CaptureFixture): Promise<void> {
  await player.dispose();
  player = new BrowserTrialPlayer();
  await player.loadTrial(TRIAL, async (_token, _label: PlaybackLabel) => bufferOf(makeCaptureWav(kind)));
  loaded = kind;
}

/**
 * Stage a second token exactly as the listening controller does after a
 * confirmed answer. The retired graph keeps sounding while every new A/B/X
 * read is deliberately delayed; the new set is staged with selectionRequired.
 */
async function carryNext(): Promise<void> {
  await player.loadTrial(
    NEXT_TRIAL,
    async (_token, _label: PlaybackLabel) => {
      await new Promise<void>((resolve) => setTimeout(resolve, NEXT_READ_DELAY_MS));
      return bufferOf(makeCaptureWav("continuousNext"));
    },
    { carryPrevious: true },
  );
}

button("capture-load-channels", "Load channel fixture").addEventListener("click", () => {
  void perform("load-channels", () => load("channels"));
});
button("capture-load-markers", "Load marker fixture").addEventListener("click", () => {
  void perform("load-markers", () => load("markers"));
});
button("capture-load-continuous", "Load continuous fixture").addEventListener("click", () => {
  void perform("load-continuous", () => load("continuous"));
});
button("capture-carry-next", "Carry next trial").addEventListener("click", () => {
  void perform("carry-next", () => carryNext());
});
button("capture-refresh", "Refresh outputs").addEventListener("click", () => {
  void perform("refresh", async () => { await player.refreshOutputDevices(); });
});
button("capture-select-default", "Select default output").addEventListener("click", () => {
  void perform("select-default", async () => { await player.selectOutputDevice(""); });
});
button("capture-play", "Play").addEventListener("click", () => {
  void perform("play", async () => { await player.play(); });
});
button("capture-pause", "Pause").addEventListener("click", () => {
  void perform("pause", () => { player.pause(); });
});
button("capture-select-a", "Select A").addEventListener("click", () => {
  void perform("select-a", () => { player.select("A"); });
});
button("capture-select-b", "Select B").addEventListener("click", () => {
  void perform("select-b", () => { player.select("B"); });
});
button("capture-select-x", "Select X").addEventListener("click", () => {
  void perform("select-x", () => { player.select("X"); });
});
button("capture-seek-marker", "Seek to 1 kHz marker").addEventListener("click", () => {
  void perform("seek-marker", () => { player.seek(MARKER_SEEK_SECONDS); });
});
button("capture-loop-marker", "Loop 1 kHz marker").addEventListener("click", () => {
  void perform("loop-marker", () => {
    player.setLoop({ enabled: true, startSeconds: LOOP_START_SECONDS, endSeconds: LOOP_END_SECONDS });
  });
});
button("capture-reset", "Reset").addEventListener("click", () => {
  void perform("reset", () => { player.reset(); });
});
button("capture-dispose", "Dispose").addEventListener("click", () => {
  void perform("dispose", async () => { await player.dispose(); });
});

(globalThis as unknown as {
  __audioCapture: { state: () => Record<string, unknown> };
}).__audioCapture = { state };
