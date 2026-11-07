import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "vite";

import { collectPageErrors, guardNetwork, type NetworkGuard } from "../e2e/fixtures.js";
import {
  assertAntiPhase,
  assertChannelIsolation,
  assertSilence,
  assertControlSilence,
  assertSoftwareSinkRouting,
  peakMeasurement,
  assertTone,
  findActiveSegments,
  readWav,
  rms,
  toneAmplitude,
  type PcmCapture,
} from "../../tools/virtual-audio/analysis.mjs";
import {
  assertNoSourceOutputs,
  captureScenario,
  moveOnlyBrowserStream,
  reportDirectory,
  stopAllRecorders,
} from "./capture.js";

let bundleDirectory: string | null = null;
let bundleSource = "";

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-audio-capture-"));
  await build({
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
    build: {
      target: "es2022",
      minify: false,
      emptyOutDir: true,
      outDir: bundleDirectory,
      lib: {
        entry: path.join(process.cwd(), "tests", "audio-output", "browser-capture-harness.ts"),
        formats: ["es"],
        fileName: () => "capture-harness.js",
      },
      rollupOptions: { output: { entryFileNames: "capture-harness.js" } },
    },
  });
  bundleSource = await readFile(path.join(bundleDirectory, "capture-harness.js"), "utf8");
  expect(bundleSource.length).toBeGreaterThan(1000);
});

test.afterAll(async () => {
  await stopAllRecorders().catch(() => undefined);
  await assertNoSourceOutputs().catch(() => undefined);
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
    bundleDirectory = null;
  }
});

async function writeAnalysis(name: string, value: unknown): Promise<void> {
  await writeFile(path.join(reportDirectory(), `${name}.analysis.json`), JSON.stringify(value, null, 2) + "\n");
}

async function clickAction(page: import("@playwright/test").Page, id: string, action: string): Promise<Record<string, unknown>> {
  await page.click(`#${id}`);
  await expect.poll(async () => page.locator("#capture-status").getAttribute("data-action")).toBe(action);
  const text = await page.locator("#capture-status").textContent();
  const state = JSON.parse(text ?? "{}") as Record<string, unknown>;
  if (typeof state.failure === "string") throw new Error(`${action}: ${state.failure}`);
  return state;
}

function outputOf(state: Record<string, unknown>): Record<string, unknown> {
  const output = state.output;
  if (typeof output !== "object" || output === null) throw new Error("capture harness did not publish output state");
  return output as Record<string, unknown>;
}

function last(segments: ReturnType<typeof findActiveSegments>): ReturnType<typeof findActiveSegments>[number] {
  const value = segments[segments.length - 1];
  if (!value) throw new Error("capture contained no active audio segment");
  return value;
}

function first(segments: ReturnType<typeof findActiveSegments>): ReturnType<typeof findActiveSegments>[number] {
  const value = segments[0];
  if (!value) throw new Error("capture contained no active audio segment");
  return value;
}

function duration(capture: PcmCapture): number {
  return capture.frames / capture.sampleRate;
}

function minimumWindowRms(capture: PcmCapture, startSeconds: number, endSeconds: number): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let start = startSeconds; start + 0.02 <= endSeconds; start += 0.01) {
    minimum = Math.min(minimum, rms(capture, 0, start, start + 0.02));
  }
  return minimum;
}

test("live Chromium AudioContext through the private Pulse sink is captured and analyzed", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const guard: NetworkGuard = await guardNetwork(page, origin);
  const pageErrors = collectPageErrors(page);
  await page.route("**/capture-harness.js", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/javascript", body: bundleSource });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    // @ts-expect-error This module is supplied by the route above, not by the app.
    await import(/* @vite-ignore */ "/capture-harness.js");
  });
  await page.waitForSelector("#capture-play", { state: "attached" });

  // Real browser output capability and explicit default-sink application.
  await clickAction(page, "capture-refresh", "refresh");
  const refreshed = await clickAction(page, "capture-select-default", "select-default");
  const output = outputOf(refreshed);
  expect(output.support).toBe("supported");
  expect(Number(output.deviceCount)).toBeGreaterThanOrEqual(1);
  expect(output.deviceCategories).toContain("default");
  expect(output.selected).toBe("default");
  expect(output.error).toBeNull();
  await writeAnalysis("browser-output-capability", {
    support: output.support,
    canRequest: output.canRequest,
    deviceCount: output.deviceCount,
    deviceCategories: output.deviceCategories,
    pending: output.pending,
    requested: output.requested,
    selected: output.selected,
    observed: output.observed,
    change: output.change,
    error: output.error,
    note: "Browser-reported routing only; ids/labels are not exported. No microphone or chooser permission was used.",
  });

  // Fixture: 440 Hz left-only, 660 Hz right-only, anti-phase 880 Hz, then 1 kHz.
  await clickAction(page, "capture-load-channels", "load-channels");
  const channels = await captureScenario("browser-channels", ["codec_capture_a.monitor"], async (mark) => {
    mark("play");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(6000);
    mark("pause");
    await clickAction(page, "capture-pause", "pause");
    await page.waitForTimeout(2000);
  });
  const channelCapture = readWav(channels.recorders[0]!.wavPath);
  const channelSegments = findActiveSegments(channelCapture);
  expect(channelSegments.length).toBeGreaterThanOrEqual(2);
  const onset = first(channelSegments).startSeconds;
  // The first 150 ms of recording precedes the Play click by construction.
  const prePlaySilencePeak = assertSilence(channelCapture, 0, 0.15, { label: "pre-play monitor silence", maxDbfs: -55 });
  const left = assertChannelIsolation(channelCapture, onset + 0.08, onset + 0.32, {
    activeChannel: 0, otherChannel: 1, frequency: 440, label: "left-only fixture",
  });
  const right = assertChannelIsolation(channelCapture, onset + 0.48, onset + 0.72, {
    activeChannel: 1, otherChannel: 0, frequency: 660, label: "right-only fixture",
  });
  const anti = assertAntiPhase(channelCapture, onset + 0.88, onset + 1.12, { label: "anti-phase fixture" });
  const tone = last(channelSegments);
  const tailTone = assertTone(channelCapture, 0, tone.startSeconds + 0.12, tone.startSeconds + 0.55, 1000, {
    label: "1 kHz fixture tail",
  });
  const lastActive = last(channelSegments).endSeconds;
  expect(duration(channelCapture) - lastActive).toBeGreaterThan(0.55);
  const pauseSilence = assertControlSilence(channelCapture, {
    firstDataAtMs: channels.recorders[0]!.firstDataAtMs, afterAtMs: channels.events.pause!,
  }, { label: "pause buffered-tail silence" });
  await writeAnalysis("browser-channels", {
    capture: "browser-channels",
    tolerances: {
      silenceMaxDbfs: -55,
      channelLeakMaxRms: 0.01,
      antiPhaseMaxCorrelation: -0.85,
      minimumStableWindowSeconds: 0.24,
      pauseTailGuardSeconds: 0.25,
    },
    metrics: {
      captureSeconds: duration(channelCapture),
      onsetSeconds: onset,
      activeSegments: channelSegments,
      leftAmplitude: left.amplitude,
      leftLeakRms: left.leak,
      rightAmplitude: right.amplitude,
      rightLeakRms: right.leak,
      antiPhase: anti,
      tailToneAmplitude: tailTone,
      pauseSilence,
      prePlaySilence: peakMeasurement(prePlaySilencePeak),
    },
    note: "Digital monitor PCM only. OS mixing/resampling and startup latency are absorbed by relative windows. Not physical wiring or hearing evidence.",
  });

  // Complementary A/B/X switching with identical fixture content must stay continuous.
  await clickAction(page, "capture-load-continuous", "load-continuous");
  const switching = await captureScenario("browser-switching", ["codec_capture_a.monitor"], async (mark) => {
    mark("play");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(1200);
    mark("select-a");
    await clickAction(page, "capture-select-a", "select-a");
    await page.waitForTimeout(1200);
    mark("select-b");
    await clickAction(page, "capture-select-b", "select-b");
    await page.waitForTimeout(1200);
    mark("select-x");
    await clickAction(page, "capture-select-x", "select-x");
    await page.waitForTimeout(1200);
    mark("pause");
    await clickAction(page, "capture-pause", "pause");
    await page.waitForTimeout(800);
  });
  const switchCapture = readWav(switching.recorders[0]!.wavPath);
  const switchSegments = findActiveSegments(switchCapture);
  expect(switchSegments.length).toBe(1);
  const switchSegment = first(switchSegments);
  expect(switchSegment.durationSeconds).toBeGreaterThan(3);
  const switchWindow = [switchSegment.startSeconds + 0.2, switchSegment.endSeconds - 0.1] as const;
  const minimumSwitchRms = minimumWindowRms(switchCapture, ...switchWindow);
  expect(minimumSwitchRms).toBeGreaterThan(0.18);
  const switchToneStart = assertTone(switchCapture, 0, switchSegment.startSeconds + 0.25, switchSegment.startSeconds + 0.5, 440);
  const switchToneEnd = assertTone(switchCapture, 0, switchSegment.endSeconds - 0.5, switchSegment.endSeconds - 0.2, 440);
  const switchPauseSilence = assertControlSilence(switchCapture, {
    firstDataAtMs: switching.recorders[0]!.firstDataAtMs, afterAtMs: switching.events.pause!,
  }, { label: "post-switch pause silence" });
  await writeAnalysis("browser-switching", {
    capture: "browser-switching",
    tolerances: { minimumWindowRms: 0.18, silenceMaxDbfs: -55, windowSeconds: 0.02, hopSeconds: 0.01 },
    metrics: {
      captureSeconds: duration(switchCapture),
      segment: switchSegment,
      minimumSwitchRms,
      switchPauseSilence,
      switchToneStart,
      switchToneEnd,
      actionOffsetsFromPlaySeconds: {
        selectA: (switching.events["select-a"]! - switching.events.play!) / 1000,
        selectB: (switching.events["select-b"]! - switching.events.play!) / 1000,
        selectX: (switching.events["select-x"]! - switching.events.play!) / 1000,
        pause: (switching.events.pause! - switching.events.play!) / 1000,
      },
    },
    note: "Real click-driven A/B/X switches of identical fixtures. A complementary gain error would create a dropout rejected by the minimum 20 ms RMS window.",
  });

  // Continuous trial handoff: the confirmed-answer path keeps the retired
  // 440 Hz graph sounding while delayed reads stage a distinct 880 Hz token,
  // then an explicit A pick switches at the shared clock without a silent gap.
  await clickAction(page, "capture-load-continuous", "load-continuous");
  const handoff = await captureScenario("browser-handoff", ["codec_capture_a.monitor"], async (mark) => {
    mark("play");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(900);
    mark("carry");
    const staged = await clickAction(page, "capture-carry-next", "carry-next");
    expect(staged.trialToken).toBe("audio-output-capture-next");
    expect(staged.selectionRequired).toBe(true);
    expect(staged.carryingPreviousTrial).toBe(true);
    expect(staged.playing).toBe(true);
    mark("carry-ready");
    await page.waitForTimeout(500);
    mark("select");
    const selected = await clickAction(page, "capture-select-a", "select-a");
    expect(selected.selectionRequired).toBe(false);
    expect(selected.selected).toBe("A");
    expect(selected.playing).toBe(true);
    await page.waitForTimeout(1200);
    mark("pause");
    await clickAction(page, "capture-pause", "pause");
    await page.waitForTimeout(700);
    mark("reset");
    await clickAction(page, "capture-reset", "reset");
    await page.waitForTimeout(900);
  });
  const handoffCapture = readWav(handoff.recorders[0]!.wavPath);
  const handoffSegments = findActiveSegments(handoffCapture);
  expect(handoffSegments.length).toBe(1);
  const handoffSegment = first(handoffSegments);
  const handoffFirstData = handoff.recorders[0]!.firstDataAtMs;
  const handoffAt = (event: string, offset = 0): number =>
    (handoff.events[event]! - handoffFirstData) / 1000 + offset;
  const handoffGuard = 0.25;
  const handoffEarly440 = assertTone(
    handoffCapture, 0, handoffAt("play", handoffGuard), handoffAt("carry", -0.05), 440,
    { label: "initial 440 Hz token before carry" },
  );
  const duringLoad = [handoffAt("carry", handoffGuard), handoffAt("carry-ready", -handoffGuard)] as const;
  const duringLoad440 = assertTone(handoffCapture, 0, ...duringLoad, 440, {
    label: "retired 440 Hz token during delayed next-token reads",
  });
  const duringLoad880 = toneAmplitude(handoffCapture, 0, ...duringLoad, 880);
  const beforeSelect = [handoffAt("carry-ready", 0.12), handoffAt("select", -0.08)] as const;
  const ready440 = assertTone(handoffCapture, 0, ...beforeSelect, 440, {
    label: "retired 440 Hz token while the new token awaits a label",
  });
  const ready880 = toneAmplitude(handoffCapture, 0, ...beforeSelect, 880);
  const afterSelect = [handoffAt("select", 0.35), handoffAt("pause", -0.12)] as const;
  const selected880 = assertTone(handoffCapture, 0, ...afterSelect, 880, {
    label: "new 880 Hz token after explicit A selection",
  });
  const selectedStale440 = toneAmplitude(handoffCapture, 0, ...afterSelect, 440);
  const minimumHandoffRms = minimumWindowRms(
    handoffCapture, handoffAt("carry", handoffGuard), handoffAt("pause", -0.12),
  );
  expect(minimumHandoffRms).toBeGreaterThan(0.18);
  expect(duringLoad880).toBeLessThan(0.05);
  expect(ready880).toBeLessThan(0.05);
  expect(selectedStale440).toBeLessThan(0.05);
  expect(handoff.events["carry-ready"]! - handoff.events.carry!).toBeGreaterThanOrEqual(900);
  const handoffPauseSilence = assertControlSilence(handoffCapture, {
    firstDataAtMs: handoff.recorders[0]!.firstDataAtMs, afterAtMs: handoff.events.pause!,
  }, { label: "post-handoff pause silence" });
  const handoffResetSilence = assertControlSilence(handoffCapture, {
    firstDataAtMs: handoff.recorders[0]!.firstDataAtMs, afterAtMs: handoff.events.reset!,
  }, { label: "post-handoff reset silence" });
  await writeAnalysis("browser-handoff", {
    capture: "browser-handoff",
    tolerances: {
      minimumWindowRms: 0.18,
      silenceMaxDbfs: -55,
      nextReadDelayMs: 900,
      toneMinAmplitude: 0.05,
      staleToneMaxAmplitude: 0.05,
    },
    metrics: {
      captureSeconds: duration(handoffCapture),
      segment: handoffSegment,
      minimumHandoffRms,
      early440: handoffEarly440,
      duringLoad440,
      duringLoad880,
      ready440,
      ready880,
      selected880,
      selectedStale440,
      nextReadDelayMs: handoff.events["carry-ready"]! - handoff.events.carry!,
      handoffPauseSilence,
      handoffResetSilence,
    },
    note: "The distinct 440 Hz retired fixture and 880 Hz next fixture prove the old token keeps sounding through a real delayed A/B/X load and while the new token awaits an explicit label. A single detected segment plus a minimum 20 ms RMS window reject a silent handoff gap. Pause and reset then stop output.",
  });

  // Seek to the 1 kHz marker, then loop that marker and confirm the tone is sustained.
  await clickAction(page, "capture-load-markers", "load-markers");
  const markers = await captureScenario("browser-seek-loop", ["codec_capture_a.monitor"], async (mark) => {
    mark("play");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(1000);
    mark("seek");
    await clickAction(page, "capture-seek-marker", "seek-marker");
    await page.waitForTimeout(1000);
    mark("loop");
    await clickAction(page, "capture-loop-marker", "loop-marker");
    await page.waitForTimeout(3000);
    mark("pause");
    await clickAction(page, "capture-pause", "pause");
    await page.waitForTimeout(800);
  });
  const markerCapture = readWav(markers.recorders[0]!.wavPath);
  const markerSegments = findActiveSegments(markerCapture);
  expect(markerSegments.length).toBeGreaterThanOrEqual(1);
  const markerOnset = first(markerSegments).startSeconds;
  const early440 = assertTone(markerCapture, 0, markerOnset + 0.08, markerOnset + 0.30, 440, {
    label: "pre-seek 440 Hz fixture",
  });
  const markerEnd = last(markerSegments).endSeconds;
  const sustained = {
    amplitude1000: toneAmplitude(markerCapture, 0, markerEnd - 0.45, markerEnd - 0.08, 1000),
    amplitude440: toneAmplitude(markerCapture, 0, markerEnd - 0.45, markerEnd - 0.08, 440),
    amplitude1000Right: toneAmplitude(markerCapture, 1, markerEnd - 0.45, markerEnd - 0.08, 1000),
  };
  expect(sustained.amplitude1000).toBeGreaterThan(0.12);
  expect(sustained.amplitude1000Right).toBeGreaterThan(0.12);
  expect(sustained.amplitude440).toBeLessThan(0.05);
  expect(markerEnd - markerOnset).toBeGreaterThan(0.9);
  const loopPauseSilence = assertControlSilence(markerCapture, {
    firstDataAtMs: markers.recorders[0]!.firstDataAtMs, afterAtMs: markers.events.pause!,
  }, { label: "post-loop pause silence" });
  await writeAnalysis("browser-seek-loop", {
    capture: "browser-seek-loop",
    tolerances: { sustainedToneMinAmplitude: 0.12, stale440MaxAmplitude: 0.05, silenceMaxDbfs: -55 },
    metrics: { captureSeconds: duration(markerCapture), onsetSeconds: markerOnset, segments: markerSegments, early440, sustained, loopPauseSilence },
    note: "The 0.3 s marker is sustained beyond its unlooped length, attributable to the clicked seek and loop actions.",
  });

  // Reset and dispose must stop live output; a second load proves the same path still works.
  await clickAction(page, "capture-load-continuous", "load-continuous");
  const lifecycle = await captureScenario("browser-reset-dispose", ["codec_capture_a.monitor"], async (mark) => {
    mark("play-1");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(1000);
    mark("reset");
    await clickAction(page, "capture-reset", "reset");
    await page.waitForTimeout(1500);
    mark("load-2");
    await clickAction(page, "capture-load-continuous", "load-continuous");
    mark("play-2");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(1000);
    mark("dispose");
    await clickAction(page, "capture-dispose", "dispose");
    await page.waitForTimeout(1500);
  });
  const lifecycleCapture = readWav(lifecycle.recorders[0]!.wavPath);
  const lifecycleSegments = findActiveSegments(lifecycleCapture);
  expect(lifecycleSegments.length).toBeGreaterThanOrEqual(2);
  const lifecycleFirst = first(lifecycleSegments);
  const lifecycleSecond = lifecycleSegments[1]!;
  const firstTone = assertTone(lifecycleCapture, 0, lifecycleFirst.startSeconds + 0.1, lifecycleFirst.endSeconds - 0.1, 440);
  const secondTone = assertTone(lifecycleCapture, 0, lifecycleSecond.startSeconds + 0.1, lifecycleSecond.endSeconds - 0.1, 440);
  const resetSilence = assertControlSilence(lifecycleCapture, {
    firstDataAtMs: lifecycle.recorders[0]!.firstDataAtMs,
    afterAtMs: lifecycle.events.reset!, beforeAtMs: lifecycle.events["play-2"]!,
  }, { label: "reset silence" });
  const disposeSilence = assertControlSilence(lifecycleCapture, {
    firstDataAtMs: lifecycle.recorders[0]!.firstDataAtMs, afterAtMs: lifecycle.events.dispose!,
  }, { label: "dispose silence" });
  await writeAnalysis("browser-reset-dispose", {
    capture: "browser-reset-dispose",
    tolerances: { silenceMaxDbfs: -55, bufferedTailGuardSeconds: 0.25 },
    metrics: {
      captureSeconds: duration(lifecycleCapture),
      segments: lifecycleSegments,
      resetSilence, disposeSilence,
      firstTone,
      secondTone,
    },
    note: "Reset/dispose stop the live graph; bounded buffered tails are excluded before silence analysis.",
  });

  // Host/software sink routing, not a browser UI chooser acceptance claim.
  await clickAction(page, "capture-load-continuous", "load-continuous");
  let streamCount = 0;
  const routing = await captureScenario("browser-routing", [
    "codec_capture_a.monitor",
    "codec_capture_b.monitor",
  ], async (mark) => {
    mark("play");
    await clickAction(page, "capture-play", "play");
    await page.waitForTimeout(1500);
    mark("move");
    streamCount = (await moveOnlyBrowserStream("codec_capture_a", "codec_capture_b")).streamCount;
    mark("move-confirmed");
    await page.waitForTimeout(2000);
    mark("pause");
    await clickAction(page, "capture-pause", "pause");
    await page.waitForTimeout(800);
  });
  expect(streamCount).toBe(1);
  const captureA = readWav(routing.recorders[0]!.wavPath);
  const captureB = readWav(routing.recorders[1]!.wavPath);
  const measured = assertSoftwareSinkRouting(captureA, captureB, {
    playAtMs: routing.events.play!,
    moveRequestedAtMs: routing.events.move!,
    moveConfirmedAtMs: routing.events["move-confirmed"]!,
    pauseAtMs: routing.events.pause!,
    firstDataAtMsA: routing.recorders[0]!.firstDataAtMs,
    firstDataAtMsB: routing.recorders[1]!.firstDataAtMs,
  });
  await writeAnalysis("browser-routing", {
    capture: "browser-routing",
    routeKind: "host-software-move-only-private-browser-stream",
    tolerances: { minimumActiveSeconds: 0.35, silenceMaxDbfs: -55 },
    metrics: {
      streamCount,
      captureASeconds: duration(captureA),
      captureBSeconds: duration(captureB),
      ...measured,
      recorderStartSkewMs: routing.recorders[1]!.startedAtMs - routing.recorders[0]!.startedAtMs,
    },
    note: "pactl moved only this private server's browser stream. Positive/negative windows are fixed by recorded Play/move-request/move-confirmation/Pause events and each monitor’s first PCM delivery, with a 250 ms buffered-delivery guard; signal boundaries cannot move those windows. This does not prove a UI/device-chooser route or physical channel wiring.",
  });

  // A deliberately wrong-channel read must fail; this makes the negative control explicit.
  const wrongChannelRms = rms(channelCapture, 1, onset + 0.08, onset + 0.32);
  expect(wrongChannelRms).toBeLessThan(0.01);

  expect(pageErrors).toEqual([]);
  expect(guard.disallowed, "capture harness attempted an external/upload request").toEqual([]);
});
