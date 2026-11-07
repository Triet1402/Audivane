import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import type { PreparedArtifact, PreparationRequest, StageProvenance } from "@codec-abx/contracts";

import {
  chooseWav,
  collectPageErrors,
  configure,
  downloadJson,
  expectNoRemoteOrUpload,
  makePcm16Wav,
  openLab,
} from "./fixtures.js";

function origin(page: Page, baseURL: string | undefined): string {
  return new URL(baseURL ?? page.url()).origin;
}

async function addStage(page: Page, side: "a" | "b"): Promise<void> {
  await page.getByRole("button", { name: `Add side ${side.toUpperCase()} stage` }).click();
}

async function setStage(
  page: Page,
  side: "a" | "b",
  index: number,
  codec: string,
  bitrate?: number,
): Promise<void> {
  const codecId = index === 1 ? `#codec-${side}` : `#codec-${side}-${index}`;
  const bitrateId = index === 1 ? `#bitrate-${side}` : `#bitrate-${side}-${index}`;
  await page.selectOption(codecId, codec);
  if (bitrate !== undefined) await page.selectOption(bitrateId, String(bitrate));
}

function stageArray(artifact: PreparedArtifact, side: "a" | "b"): readonly StageProvenance[] {
  const stages = artifact[side].stages;
  expect(stages, `${side} must carry per-stage provenance`).toBeTruthy();
  return stages!;
}

function expectStageFacts(
  artifact: PreparedArtifact,
  side: "a" | "b",
  expected: readonly { codecId: string; bitrateKbps: number; noop?: boolean }[],
): void {
  const stages = stageArray(artifact, side);
  expect(stages).toHaveLength(expected.length);
  for (const [index, request] of expected.entries()) {
    const stage = stages[index]!;
    expect(stage.stageIndex).toBe(index + 1);
    expect(stage.requested).toEqual({ codecId: request.codecId, bitrateKbps: request.bitrateKbps });
    expect(stage.encoder.length).toBeGreaterThan(0);
    expect(stage.decoder.length).toBeGreaterThan(0);
    if (request.noop) {
      expect(stage.actualBitrateKbps).toBeNull();
    } else {
      expect(stage.actualBitrateKbps).not.toBeNull();
      expect(stage.actualBitrateKbps!).toBeGreaterThan(0);
      expect(stage.encodedSampleRate).not.toBeNull();
    }
  }
  // The final top-level facts are the final stage, not an alias for the first.
  const final = stages[stages.length - 1]!;
  expect(artifact[side].requested).toEqual(final.requested);
  expect(artifact[side].encoder).toBe(final.encoder);
  expect(artifact[side].decoder).toBe(final.decoder);
  expect(artifact[side].actualBitrateKbps).toBe(final.actualBitrateKbps);
  expect(artifact[side].encodedSampleRate).toBe(final.encodedSampleRate);
}

test("mixed two-stage browser chain exposes all stage facts, exports them and locks controls", async ({ page, baseURL }) => {
  const guard = await openLab(page, origin(page, baseURL));
  const pageErrors = collectPageErrors(page);
  await chooseWav(page, "chain-mixed-96k-stereo.wav", makePcm16Wav({
    sampleRate: 96_000,
    channels: 2,
    seconds: 0.6,
  }));

  await configure(page, { mode: "native", policy: "aligned-gain-matched-v1", canary: true });
  await setStage(page, "a", 1, "aac", 128);
  await addStage(page, "a");
  await setStage(page, "a", 2, "mp3", 128);
  // Side B stays the default one-stage Opus 128 request.

  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });

  const diagnostic = await downloadJson(page) as unknown as {
    artifact: PreparedArtifact;
    stageProvenance: { a: StageProvenance[] | null; b: StageProvenance[] | null; perStageFallback: boolean };
  };
  const artifact = diagnostic.artifact;
  expect(artifact.request.version).toBe(2);
  const request = artifact.request as PreparationRequest;
  expect(request.version).toBe(2);
  if (request.version === 2) {
    expect(request.a.map((stage) => stage.codecId)).toEqual(["aac", "mp3"]);
    expect(request.b.map((stage) => stage.codecId)).toEqual(["opus"]);
  }
  expectStageFacts(artifact, "a", [
    { codecId: "aac", bitrateKbps: 128 },
    { codecId: "mp3", bitrateKbps: 128 },
  ]);
  expectStageFacts(artifact, "b", [{ codecId: "opus", bitrateKbps: 128 }]);
  expect(diagnostic.stageProvenance.a).toHaveLength(2);
  expect(diagnostic.stageProvenance.b).toHaveLength(1);
  expect(diagnostic.stageProvenance.perStageFallback).toBe(false);

  // Binding a listening run freezes the entire stage editor, not only the final row.
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await expect(page.locator(".listening-trial")).toBeVisible({
    timeout: 150_000,
  });
  await expect(page.locator("#codec-a")).toBeDisabled();
  await expect(page.locator("#codec-a-2")).toBeDisabled();
  await expect(page.locator("#bitrate-a-2")).toBeDisabled();
  await expect(page.locator("#codec-b")).toBeDisabled();
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add side A stage" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove side A stage 2" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move side A stage 2 up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" })).toBeDisabled();

  await page.getByRole("button", { name: "Listen", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download listening export" }).click(),
  ]);
  const file = await download.path();
  if (!file) throw new Error("test: listening export had no local path");
  const exported = JSON.parse(await readFile(file, "utf8")) as {
    schema: string;
    prepared: {
      request: PreparationRequest;
      tracks: {
        a: { stages: StageProvenance[] | null; stageCount: number; perStageFallback: boolean; delivered: unknown };
        b: { stages: StageProvenance[] | null; stageCount: number; perStageFallback: boolean; delivered: unknown };
      };
    };
  };
  expect(exported.schema).toBe("codec-abx-browser-listening-v1");
  expect(exported.prepared.request.version).toBe(2);
  expect(exported.prepared.tracks.a.stageCount).toBe(2);
  expect(exported.prepared.tracks.a.perStageFallback).toBe(false);
  expect(exported.prepared.tracks.a.stages!.map((stage) => stage.requested.codecId))
    .toEqual(["aac", "mp3"]);
  expect(exported.prepared.tracks.a.stages!.map((stage) => stage.requested.bitrateKbps))
    .toEqual([128, 128]);
  expect(exported.prepared.tracks.a.stages!.map((stage) => stage.actualBitrateKbps))
    .toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
  expect(exported.prepared.tracks.a.delivered).toBeTruthy();
  expect(exported.prepared.tracks.b.stageCount).toBe(1);

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("four-stage reorder is preserved and a differing ordered prefix is not applicable", async ({ page, baseURL }) => {
  const guard = await openLab(page, origin(page, baseURL));
  const pageErrors = collectPageErrors(page);
  await chooseWav(page, "chain-four-stage-48k-stereo.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 2,
    seconds: 0.5,
  }));
  await configure(page, { mode: "native", policy: "aligned-gain-matched-v1" });
  const stages = [["mp3", 128], ["aac", 128], ["opus", 64], ["ogg_vorbis", 128]] as const;
  for (const side of ["a", "b"] as const) {
    for (let index = 0; index < stages.length; index += 1) {
      if (index > 0) await addStage(page, side);
      await setStage(page, side, index + 1, stages[index]![0], stages[index]![1]);
    }
  }

  // Reorder A explicitly while keeping the terminal Vorbis stage fixed:
  // move stage 1 down so AAC precedes MP3.
  await page.getByRole("button", { name: "Move side A stage 1 down" }).click();
  const expectedA = ["aac", "mp3", "opus", "ogg_vorbis"];

  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
  const reordered = (await downloadJson(page)).artifact;
  expect(reordered.request.version).toBe(2);
  const reorderedRequest = reordered.request as PreparationRequest;
  if (reorderedRequest.version === 2) {
    expect(reorderedRequest.a.map((stage) => stage.codecId)).toEqual(expectedA);
    expect(reorderedRequest.b.map((stage) => stage.codecId)).toEqual(["mp3", "aac", "opus", "ogg_vorbis"]);
    // Same terminal stage (Vorbis) but a different ordered prefix.
    expect(reorderedRequest.a.at(-1)).toEqual(reorderedRequest.b.at(-1));
    expect(reorderedRequest.a).not.toEqual(reorderedRequest.b);
  }
  expect(reordered.validity?.nullGate.status).toBe("not-applicable");
  expect(reordered.validity?.nullGate.expectedIdentical).toBe(false);
  expectStageFacts(reordered, "a", expectedA.map((codecId) => ({
    codecId, bitrateKbps: codecId === "opus" ? 64 : 128,
  })));
  expectStageFacts(reordered, "b", [
    { codecId: "mp3", bitrateKbps: 128 },
    { codecId: "aac", bitrateKbps: 128 },
    { codecId: "opus", bitrateKbps: 64 },
    { codecId: "ogg_vorbis", bitrateKbps: 128 },
  ]);

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("96 kHz mono and stereo MP3 inputs keep honest stage rates and bitrates", async ({ page, baseURL }) => {
  const guard = await openLab(page, origin(page, baseURL));
  const pageErrors = collectPageErrors(page);
  await configure(page, { mode: "native", policy: "codec-probe-only" });
  await setStage(page, "a", 1, "mp3", 128);
  await setStage(page, "b", 1, "mp3", 128);

  for (const channels of [1, 2] as const) {
    await chooseWav(page, `chain-mp3-96k-${channels === 1 ? "mono" : "stereo"}.wav`, makePcm16Wav({
      sampleRate: 96_000,
      channels,
      seconds: 0.5,
    }));
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
    const artifact = (await downloadJson(page)).artifact;
    expect(artifact.a.delivered.channels).toBe(channels);
    expect(artifact.b.delivered.channels).toBe(channels);
    expectStageFacts(artifact, "a", [{ codecId: "mp3", bitrateKbps: 128 }]);
    expectStageFacts(artifact, "b", [{ codecId: "mp3", bitrateKbps: 128 }]);
    expect(artifact.a.stages![0]!.encodedSampleRate).not.toBeNull();
  }

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("an intermediate-stage abort cancels cleanly and an explicit retry succeeds", async ({ page, baseURL }) => {
  const guard = await openLab(page, origin(page, baseURL));
  const pageErrors = collectPageErrors(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    await chooseWav(page, "chain-abort-96k-stereo.wav", makePcm16Wav({
      sampleRate: 96_000,
      channels: 2,
      seconds: 6,
    }));
    await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native" });
    await setStage(page, "a", 1, "mp3", 128);
    await addStage(page, "a");
    await setStage(page, "a", 2, "aac", 128);
    await addStage(page, "b");
    await setStage(page, "b", 2, "mp3", 128);

    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.locator(".run-status")).toContainText(/stage 2/i, { timeout: 150_000 });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".run-status")).toContainText("Cancelled.", { timeout: 150_000 });
    await expect(page.locator(".results")).toHaveCount(0);

    // Retry is an explicit new run; no stale artifact is published.
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.locator(".results")).toBeVisible({ timeout: 180_000 });
    const artifact = (await downloadJson(page)).artifact;
    expect(artifact.request.version).toBe(2);
    expect(artifact.a.stages).toHaveLength(2);

    await expectNoRemoteOrUpload(guard);
    expect(pageErrors).toEqual([]);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
});
