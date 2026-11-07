/**
 * Test-only browser harness for shared output-device controls.
 *
 * Bundled by Vite into a temporary module and served by a Playwright route. It
 * never ships in the app, creates no test route/global and does no network I/O.
 * The live AudioContext path runs after a real button click; no autoplay or
 * media-permission flags are used. Chromium may legitimately expose only the
 * default output and no chooser in headless Linux; those facts are recorded
 * rather than skipped or fabricated.
 */
import type { PlaybackLabel, PublicTrial } from "@codec-abx/contracts";
import { BrowserTrialPlayer } from "@codec-abx/playback";

export interface OutputHarnessResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly checks: Readonly<Record<string, boolean | string | number>>;
}

const TRIAL: PublicTrial = {
  runId: "output-harness-run",
  token: "output-harness-token",
  trialIndex: 1,
  kind: "scored",
};

const CONTINUATION_TRIAL: PublicTrial = {
  runId: TRIAL.runId,
  token: "output-harness-continuation",
  trialIndex: 2,
  kind: "scored",
};

function wav(): ArrayBuffer {
  const sampleRate = 48_000;
  const frames = 28_800;
  const dataSize = frames * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
    view.setInt16(44 + frame * 2, value, true);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function reader(): (token: string, label: PlaybackLabel) => Promise<ArrayBuffer> {
  return async () => wav();
}

function failingReader(): (token: string, label: PlaybackLabel) => Promise<ArrayBuffer> {
  return async (_token, label) => {
    if (label === "X") throw new Error("intentional harness continuation failure");
    return wav();
  };
}

export async function runHarness(): Promise<OutputHarnessResult> {
  const failures: string[] = [];
  const checks: Record<string, boolean | string | number> = {};
  const expect = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };

  const player = new BrowserTrialPlayer();
  const before = player.snapshot();
  expect(before.outputSampleRate === null, "context was created before the gesture");
  checks["pre-gesture-context"] = before.outputSampleRate === null;

  const button = document.createElement("button");
  button.id = "output-gesture";
  button.type = "button";
  button.textContent = "Check output devices";
  document.body.append(button);
  await new Promise<void>((resolve) => {
    button.addEventListener("click", () => resolve(), { once: true });
  });
  button.remove();

  try {
    const refreshed = await player.refreshOutputDevices();
    expect(refreshed.outputSampleRate === null, "refreshOutputDevices created an AudioContext");
    expect(refreshed.output?.support === "supported", `support was ${String(refreshed.output?.support)}`);
    expect((refreshed.output?.devices.length ?? 0) >= 1, "no output entry was exposed");
    expect(refreshed.output?.devices.some((device) => device.deviceId === "") ?? false,
      "default output entry missing");
    checks["refresh-without-context"] = refreshed.outputSampleRate === null;
    checks["support"] = refreshed.output?.support ?? "missing";
    checks["device-count"] = refreshed.output?.devices.length ?? 0;
    checks["chooser-available"] = refreshed.output?.canRequest ?? false;

    const applied = await player.selectOutputDevice("");
    expect(applied.output?.selectedDeviceId === "", "default selection was not applied");
    expect(applied.output?.observedDeviceId === "", "browser-observed sink was not reported");
    expect(applied.output?.pending === null, "selection left a pending operation");
    expect(applied.playing === false, "selection started playback");
    expect(typeof applied.outputSampleRate === "number" && applied.outputSampleRate > 0,
      "selection did not create a real AudioContext");
    checks["selection-applied"] = applied.output?.selectedDeviceId === "";
    checks["observed-default"] = applied.output?.observedDeviceId === "";
    checks["live-output-rate"] = applied.outputSampleRate ?? -1;

    const invalidId = "codec-abx-invalid-output-device-7";
    const failed = await player.selectOutputDevice(invalidId);
    expect(failed.output?.error !== null, "invalid device selection did not report an error");
    expect(!(failed.output?.error ?? "").includes(invalidId),
      "selection error leaked the raw device id");
    expect(failed.output?.selectedDeviceId === "", "failed selection overwrote the applied route");
    expect(failed.output?.observedDeviceId === "", "failed selection claimed a different observed route");
    checks["selection-failure"] = failed.output?.error ?? "missing";
    checks["failure-redacted"] = !(failed.output?.error ?? "").includes(invalidId);

    if (failed.output?.canRequest === true) {
      checks["chooser-unavailable"] = false;
    } else {
      const chooser = await player.requestOutputDevice();
      expect((chooser.output?.error ?? "").startsWith("output-chooser-unavailable:"),
        `unavailable chooser path was ${String(chooser.output?.error)}`);
      checks["chooser-unavailable"] = true;
    }
  } catch (error) {
    failures.push(`live output check threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await player.dispose();
  }
  expect(player.snapshot().phase === "disposed", "live player did not dispose");
  checks["live-disposed"] = player.snapshot().phase === "disposed";

  try {
    const offline = new OfflineAudioContext(1, 4_800, 48_000);
    const unsupported = new BrowserTrialPlayer({ audioContext: offline });
    const refreshed = await unsupported.refreshOutputDevices();
    expect(refreshed.output?.support === "unsupported",
      `context without setSinkId reported ${String(refreshed.output?.support)}`);
    const refused = await unsupported.selectOutputDevice("");
    expect((refused.output?.error ?? "").startsWith("output-unsupported:"),
      `unsupported selection was ${String(refused.output?.error)}`);
    const loaded = await unsupported.loadTrial(TRIAL, reader());
    expect(loaded.phase === "ready", `unsupported context load was ${loaded.phase}`);
    const played = await unsupported.play();
    expect(played.playing === true, "default playback did not remain usable without selection");
    checks["unsupported-default-usable"] = played.playing === true;
    checks["unsupported-support"] = refreshed.output?.support ?? "missing";

    // Real-Web-Audio continuation: stage a second verified set behind the
    // sounding graph, require an explicit pick, then switch without a reload.
    const staged = await unsupported.loadTrial(CONTINUATION_TRIAL, reader(), {
      carryPrevious: true,
    });
    expect(staged.phase === "ready", `continuation phase was ${staged.phase}`);
    expect(staged.selectionRequired === true, "continuation did not require a new pick");
    expect(staged.carryingPreviousTrial === true, "continuation did not retain the sounding graph");
    expect(staged.playing === true, "continuation paused the audible graph");
    checks["continuation-carries"] = staged.phase === "ready" &&
      staged.selectionRequired === true && staged.carryingPreviousTrial === true &&
      staged.playing === true;
    const switched = unsupported.select("A");
    expect(switched.selectionRequired === false, "explicit pick did not clear the selection gate");
    expect(switched.carryingPreviousTrial === false, "explicit pick did not retire the old graph");
    expect(switched.playing === true, "explicit pick did not continue the shared clock");
    checks["continuation-switch"] = switched.selectionRequired === false &&
      switched.carryingPreviousTrial === false && switched.playing === true;

    const failed = await unsupported.loadTrial(
      { ...CONTINUATION_TRIAL, token: "output-harness-failed", trialIndex: 3 },
      failingReader(),
      { carryPrevious: true },
    );
    expect(failed.phase === "error", `failed continuation phase was ${failed.phase}`);
    expect(failed.selectionRequired === true, "failed continuation enabled a selection");
    expect(failed.carryingPreviousTrial === true, "failed continuation lost the retired sound");
    expect(failed.playing === true, "failed continuation stopped the retired sound");
    let refusedPick = false;
    try {
      unsupported.select("B");
    } catch {
      refusedPick = true;
    }
    expect(refusedPick, "a failed staged set could be selected");
    checks["continuation-failure"] = failed.phase === "error" &&
      failed.selectionRequired === true && failed.carryingPreviousTrial === true &&
      failed.playing === true && refusedPick;
    await unsupported.dispose();
  } catch (error) {
    failures.push(`unsupported check threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ok: failures.length === 0, failures, checks };
}
