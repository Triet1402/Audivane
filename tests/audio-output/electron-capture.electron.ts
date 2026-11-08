import { clickRunAction } from "../ui/run-actions.js";
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAntiPhase,
  assertChannelIsolation,
  assertControlSilence,
  assertTone,
  findActiveSegments,
  readWav,
  rms,
  type PcmCapture,
} from "../../tools/virtual-audio/analysis.mjs";
import { captureScenario, reportDirectory } from "./capture.js";
import { makeCaptureWav } from "./fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function minimumWindowRms(capture: PcmCapture, startSeconds: number, endSeconds: number): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let start = startSeconds; start + 0.02 <= endSeconds; start += 0.01) {
    minimum = Math.min(minimum, rms(capture, 0, start, start + 0.02));
  }
  return minimum;
}

test("real sandboxed Electron app routes live TrialPlayer audio into the private monitor", async () => {
  test.setTimeout(300_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-audio-electron-"));
  const sourcePath = path.join(directory, "capture-fixture.wav");
  await fs.writeFile(sourcePath, makeCaptureWav("channels"));

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.CODEC_ABX_FFMPEG = path.join(root, "third_party/ffmpeg/bin/ffmpeg");
  environment.CODEC_ABX_FFPROBE = path.join(root, "third_party/ffmpeg/bin/ffprobe");
  environment.CODEC_ABX_LDAC_HELPER = path.join(root, "third_party/ldac/bin/ldac_helper");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [path.join(root, "apps/desktop")],
      cwd: root,
      env: environment,
      chromiumSandbox: true,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toBe("codec-abx://app/index.html");
    await expect(page.locator("main.app")).toHaveAttribute("data-runtime", "desktop");

    // Test-only OS-dialog seam, matching the existing trusted Electron test.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, sourcePath);

    await page.getByRole("button", { name: "Choose local audio…" }).click();
    await expect(page.locator(".file-summary")).toContainText("capture-fixture.wav");
    await page.locator(".advanced-preparation").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByRole("button", { name: "Prepare native artifacts" }).click();
    await expect(page.getByText("Native artifacts ready.")).toBeVisible({ timeout: 120_000 });

    // This is a real app/player capture, not a scored run: no answer is submitted.
    await page.locator(".listening-test-plan").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.locator("#canary-enabled").uncheck();
    await page.getByLabel("Planned scored trials N (1–1000)").fill("2");
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    const trial = page.locator("article.listening-trial");
    await expect(trial).toBeVisible({ timeout: 180_000 });
    await page.getByRole("button", { name: "Monitor playback label A" }).click();

    const capture = await captureScenario("electron-channels", ["codec_capture_a.monitor"], async (mark) => {
      mark("play");
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForTimeout(6000);
      mark("pause");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.waitForTimeout(1000);
      mark("play-again");
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForTimeout(1200);
      mark("reset");
      await clickRunAction(page, "Reset listening run");
      await page.waitForTimeout(1500);
    });
    const pcm = readWav(capture.recorders[0]!.wavPath);
    const segments = findActiveSegments(pcm);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const onset = segments[0]!.startSeconds;
    const left = assertChannelIsolation(pcm, onset + 0.08, onset + 0.30, {
      activeChannel: 0, otherChannel: 1, frequency: 440, label: "Electron left-only fixture",
    });
    const right = assertChannelIsolation(pcm, onset + 0.48, onset + 0.70, {
      activeChannel: 1, otherChannel: 0, frequency: 660, label: "Electron right-only fixture",
    });
    const anti = assertAntiPhase(pcm, onset + 0.88, onset + 1.10, { label: "Electron anti-phase fixture" });
    const captureSeconds = pcm.frames / pcm.sampleRate;
    const pauseSilence = assertControlSilence(pcm, {
      firstDataAtMs: capture.recorders[0]!.firstDataAtMs,
      afterAtMs: capture.events.pause!, beforeAtMs: capture.events["play-again"]!,
    }, { label: "Electron pause buffered-tail silence" });
    const resetSilence = assertControlSilence(pcm, {
      firstDataAtMs: capture.recorders[0]!.firstDataAtMs, afterAtMs: capture.events.reset!,
    }, { label: "Electron reset buffered-tail silence" });
    await fs.writeFile(path.join(reportDirectory(), "electron-channels.analysis.json"), JSON.stringify({
      capture: "electron-channels",
      boundary: "real sandboxed developer Electron app, native preparation and the shared listening TrialPlayer; no answer/scored result claimed",
      tolerances: { silenceMaxDbfs: -55, channelLeakMaxRms: 0.01, antiPhaseMaxCorrelation: -0.85 },
      metrics: {
        captureSeconds,
        onsetSeconds: onset,
        segments,
        left,
        right,
        antiPhase: anti,
        pauseSilence,
        resetSilence,
      },
      limitations: [
        "Digital monitor PCM only; physical wiring, output device identity, exclusive/bit-perfect mode and human audibility remain unverified.",
        "Electron still denies all permission requests/checks; only default playback was used.",
      ],
    }, null, 2) + "\n");
    expect(left.amplitude).toBeGreaterThan(0.05);
    expect(right.amplitude).toBeGreaterThan(0.05);

    // Second scenario: answer the 1 kHz tail while it is playing, let the
    // confirmed receipt auto-advance, and require the old token to cover the
    // staging/handoff until an explicit A repick selects the new token.
    await page.locator('button[data-tab="setup"]').click();
    await expect(page.getByRole("heading", { name: "Codec chains", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    await expect(page.locator("#listen-view")).toBeVisible();
    await expect(trial).toBeVisible({ timeout: 180_000 });
    const labelA = page.getByRole("button", { name: "Monitor playback label A" });
    await labelA.click();
    await expect(labelA).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Shared timeline position").evaluate((element) => {
      const input = element as HTMLInputElement;
      // Bypass React's per-element value tracker so this simulates a real
      // input event rather than pre-marking the new value as already handled.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(input, "6");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator(".time-readout")).toContainText("0:06 /");
    const play = page.getByRole("button", { name: "Play", exact: true });
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(play).toBeEnabled();
    await expect(pause).toHaveCount(0);
    const answerFor = async (token: string): Promise<"A" | "B"> =>
      page.evaluate(async (current) => {
        const bridge = (window as unknown as {
          codecAbxDesktop: {
            experiment: { readAudio(token: string, label: "A" | "B" | "X"): Promise<ArrayBuffer> };
          };
        }).codecAbxDesktop;
        const read = async (label: "A" | "B" | "X"): Promise<Uint8Array> =>
          new Uint8Array(await bridge.experiment.readAudio(current, label));
        const [a, b, x] = await Promise.all([read("A"), read("B"), read("X")]);
        const equal = (left: Uint8Array, right: Uint8Array): boolean =>
          left.length === right.length && left.every((value, index) => value === right[index]);
        if (equal(x, a)) return "A";
        if (equal(x, b)) return "B";
        throw new Error("X bytes match neither display A nor B");
      }, token);
    const tokenNow = async (): Promise<string> => {
      const value = await trial.getAttribute("data-token");
      if (!value) throw new Error("No loaded trial token");
      return value;
    };
    const tokenAfter = async (previous: string): Promise<string> => {
      await expect.poll(async () => {
        const value = await trial.getAttribute("data-token");
        return value !== null && value !== previous ? value : null;
      }, { timeout: 120_000 }).not.toBeNull();
      return tokenNow();
    };
    const answeredToken = await tokenNow();
    const handoff = await captureScenario("electron-handoff", ["codec_capture_a.monitor"], async (mark) => {
      mark("play");
      await play.click();
      await expect(pause).toBeEnabled();
      await page.waitForTimeout(600);
      mark("answer");
      const label = await answerFor(answeredToken);
      const answerButton = page.getByRole("button", { name: `Answer ${label}`, exact: true });
      await expect(answerButton).toBeEnabled();
      await answerButton.click();
      const nextToken = await tokenAfter(answeredToken);
      expect(nextToken).not.toBe(answeredToken);
      await expect(page.locator(".stage-status")).not.toContainText("Previous trial audio");
      for (const current of ["A", "B", "X"] as const) {
        await expect(page.getByRole("button", { name: `Monitor playback label ${current}` }))
          .toHaveAttribute("aria-pressed", "false");
      }
      await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeDisabled();
      mark("carry-ready");
      await page.waitForTimeout(250);
      mark("select");
      await expect(labelA).toBeEnabled();
      await labelA.click();
      await expect(labelA).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(1300);
      mark("pause");
      await pause.click();
      await page.waitForTimeout(700);
      mark("reset");
      await clickRunAction(page, "Reset listening run");
      await page.waitForTimeout(900);
    });
    const handoffPcm = readWav(handoff.recorders[0]!.wavPath);
    const handoffSegments = findActiveSegments(handoffPcm);
    expect(handoffSegments.length).toBe(1);
    const handoffSegment = handoffSegments[0]!;
    const handoffFirstData = handoff.recorders[0]!.firstDataAtMs;
    const handoffAt = (event: string, offset = 0): number =>
      (handoff.events[event]! - handoffFirstData) / 1000 + offset;
    const beforeAnswer = assertTone(
      handoffPcm, 0, handoffAt("play", 0.25), handoffAt("answer", -0.05), 1000,
      { label: "1 kHz tail before the answer" },
    );
    const afterHandoff = assertTone(
      handoffPcm, 0, handoffAt("select", 0.35), handoffAt("pause", -0.12), 1000,
      { label: "1 kHz tail after the handoff and repick" },
    );
    const minimumHandoffRms = minimumWindowRms(
      handoffPcm, handoffAt("answer", 0.25), handoffAt("pause", -0.12),
    );
    // Native gain matching changes the fixture's absolute level. Compare the
    // steady 1 kHz tail to itself across the handoff. Two 5 ms linear fades in
    // a 20 ms window ideally retain sqrt(2/3) ≈ 0.816 of steady-tone RMS; 0.75
    // allows capture/scheduling edges while rejecting an inserted silence gap.
    const baselineRms = rms(handoffPcm, 0, handoffAt("play", 0.25), handoffAt("answer", -0.05));
    expect(baselineRms).toBeGreaterThan(0.05);
    expect(minimumHandoffRms).toBeGreaterThan(baselineRms * 0.75);
    expect(minimumHandoffRms).toBeGreaterThan(0.05);
    const handoffPauseSilence = assertControlSilence(handoffPcm, {
      firstDataAtMs: handoff.recorders[0]!.firstDataAtMs, afterAtMs: handoff.events.pause!,
    }, { label: "Electron handoff pause silence" });
    const handoffResetSilence = assertControlSilence(handoffPcm, {
      firstDataAtMs: handoff.recorders[0]!.firstDataAtMs, afterAtMs: handoff.events.reset!,
    }, { label: "Electron handoff reset silence" });
    await fs.writeFile(path.join(reportDirectory(), "electron-handoff.analysis.json"), JSON.stringify({
      capture: "electron-handoff",
      boundary: "real sandboxed developer Electron app, native preparation, real served A/B/X bytes and the shared listening TrialPlayer; one scored answer per token, no final verdict claimed",
      tolerances: {
        silenceMaxDbfs: -55, minimumWindowRms: 0.05,
        minimumRelativeWindowRms: 0.75, windowSeconds: 0.02, hopSeconds: 0.01,
      },
      metrics: {
        captureSeconds: handoffPcm.frames / handoffPcm.sampleRate,
        segment: handoffSegment,
        beforeAnswer,
        afterHandoff,
        minimumHandoffRms,
        baselineRms,
        handoffPauseSilence,
        handoffResetSilence,
        carryReadyOffsetSeconds: (handoff.events["carry-ready"]! - handoff.events.answer!) / 1000,
      },
      note: "A single detected segment and a minimum 20 ms RMS window prove the 1 kHz tail did not stop during answer, next-token staging or the explicit A repick. Label selection was independently verified through aria-pressed state, not a snapshot claim alone.",
      limitations: [
        "Digital monitor PCM only; physical wiring, output device identity, exclusive/bit-perfect mode and human audibility remain unverified.",
        "The 1 kHz marker is the fixture tail, not a claim about codec quality or scored correctness.",
      ],
    }, null, 2) + "\n");
  } finally {
    await app?.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
