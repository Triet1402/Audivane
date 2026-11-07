import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  collectPageErrors, configure, downloadCanaryWav, downloadJson, downloadWav,
  expectNoRemoteOrUpload, inspectWav, makePcm16Wav, openLab, sampleAt, sha256,
} from "./fixtures.js";

const execute = promisify(execFile);
const ffmpeg = path.resolve("third_party/ffmpeg/bin/ffmpeg");

interface Pcm32Fixture {
  readonly format: "int" | "float";
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly values: readonly (readonly number[])[];
}

/** Independent 32-bit WAV writer for analytical source-import fixtures. */
function makePcm32Wav(fixture: Pcm32Fixture): Buffer {
  const dataSize = fixture.frames * fixture.channels * 4;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(fixture.format === "float" ? 3 : 1, 20);
  bytes.writeUInt16LE(fixture.channels, 22);
  bytes.writeUInt32LE(fixture.sampleRate, 24);
  bytes.writeUInt32LE(fixture.sampleRate * fixture.channels * 4, 28);
  bytes.writeUInt16LE(fixture.channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < fixture.frames; frame += 1) {
    for (let channel = 0; channel < fixture.channels; channel += 1) {
      const value = fixture.values[frame]?.[channel] ?? 0;
      const offset = 44 + (frame * fixture.channels + channel) * 4;
      if (fixture.format === "float") bytes.writeFloatLE(value, offset);
      else bytes.writeInt32LE(value, offset);
    }
  }
  return bytes;
}

const formats = [
  { extension: "flac", encoder: "flac", mime: "audio/flac" },
  { extension: "mp3", encoder: "libmp3lame", mime: "audio/mpeg" },
  { extension: "m4a", encoder: "aac", mime: "audio/mp4" },
  { extension: "aac", encoder: "aac", mime: "audio/aac" },
  { extension: "ogg", encoder: "libvorbis", mime: "audio/ogg" },
  { extension: "opus", encoder: "libopus", mime: "audio/ogg" },
  { extension: "wav", encoder: "pcm_s24le", mime: "audio/wav" },
  { extension: "wav", encoder: "pcm_f32le", mime: "audio/wav" },
  { extension: "flac", encoder: "flac", mime: "audio/flac", tagged: true },
] as const;

for (const format of formats) {
  test(`real ${format.extension} ${format.encoder}${"tagged" in format ? " ID3-tagged" : ""} import feeds the same decoded source to both chains`, async ({ page, baseURL }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-import-"));
    try {
      const original = makePcm16Wav({ channels: 2, seconds: 1.2 });
      const input = path.join(directory, "source.wav");
      const encoded = path.join(directory, `source.${format.extension}`);
      await writeFile(input, original);
      await execute(ffmpeg, ["-nostdin", "-v", "error", "-i", input,
        "-c:a", format.encoder, encoded], { timeout: 30_000 });
      const compressed = await readFile(encoded);
      const source = "tagged" in format
        ? Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), compressed])
        : compressed;
      const errors = collectPageErrors(page);
      const guard = await openLab(page, new URL(baseURL!).origin);
      // Misleading extension and MIME must not override the actual media bytes.
      await page.locator("#source-file").setInputFiles({
        name: "renamed-audio.wav", mimeType: "audio/wav", buffer: source,
      });
      await configure(page, { a: "noop_passthrough", b: "noop_passthrough" });
      await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
      await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
      const { artifact } = await downloadJson(page);
      expect(artifact.sourceSha256).toBe(sha256(source));
      expect(artifact.a.delivered.channels).toBe(2);
      expect(artifact.a.delivered.sampleRate).toBe(48_000);
      expect(artifact.a.delivered.wavSha256).toBe(artifact.b.delivered.wavSha256);
      const delivery = await downloadWav(page, "a");
      expect(sha256(delivery)).toBe(artifact.a.delivered.wavSha256);
      const facts = inspectWav(delivery);
      expect(facts.frames).toBeGreaterThan(48_000);
      if (format.extension === "flac") {
        const before = inspectWav(original);
        expect(facts.frames).toBe(before.frames);
        expect(delivery.subarray(facts.dataOffset)).toEqual(original.subarray(before.dataOffset));
      }
      expect(sampleAt(delivery, facts, 101, 0)).not.toBe(sampleAt(delivery, facts, 101, 1));
      expectNoRemoteOrUpload(guard);
      expect(errors).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("32-bit integer WAV source is quantized once to canonical PCM16 with exact layout and hash", async ({ page, baseURL }) => {
  const frames = 24_000;
  const values = [
    [0, 0],
    [32_768, -32_768],
    [98_304, -98_304],
    [1_073_741_824, -1_073_741_824],
    [2_147_483_647, -2_147_483_648],
  ];
  const source = makePcm32Wav({ format: "int", sampleRate: 48_000, channels: 2, frames, values });
  const guard = await openLab(page, new URL(baseURL!).origin);
  const errors = collectPageErrors(page);
  await page.locator("#source-file").setInputFiles({
    name: "source-s32.wav", mimeType: "audio/wav", buffer: source,
  });
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough" });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
  const { artifact } = await downloadJson(page);
  expect(artifact.sourceSha256).toBe(sha256(source));
  expect(artifact.a.delivered).toMatchObject({ sampleRate: 48_000, channels: 2, frames });
  expect(artifact.b.delivered.frames).toBe(frames);
  expect(artifact.a.delivered.wavSha256).toBe(artifact.b.delivered.wavSha256);
  const delivery = await downloadWav(page, "a");
  expect(sha256(delivery)).toBe(artifact.a.delivered.wavSha256);
  const facts = inspectWav(delivery);
  expect(facts.frames).toBe(frames);
  // FFmpeg's canonical integer conversion is an arithmetic 16-bit downshift;
  // the delivered policy remains PCM16 and no source precision is restored.
  const expected = [
    [0, 0],
    [0, -1],
    [1, -2],
    [16_384, -16_384],
    [32_767, -32_768],
  ];
  expected.forEach((pair, frame) => {
    expect(sampleAt(delivery, facts, frame, 0)).toBe(pair[0]);
    expect(sampleAt(delivery, facts, frame, 1)).toBe(pair[1]);
  });
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("32-bit float WAV source preserves low-level fractions then clamps to canonical PCM16", async ({ page, baseURL }) => {
  const frames = 24_000;
  const values = [
    [0, 0],
    [1 / 1_048_576, -1 / 1_048_576],
    [2 / 32_768, -2 / 32_768],
    [0.5, -0.5],
    [1, -1],
    [1.5, -1.5],
  ];
  const source = makePcm32Wav({ format: "float", sampleRate: 48_000, channels: 2, frames, values });
  const guard = await openLab(page, new URL(baseURL!).origin);
  const errors = collectPageErrors(page);
  await page.locator("#source-file").setInputFiles({
    name: "source-f32.wav", mimeType: "audio/wav", buffer: source,
  });
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough" });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
  const { artifact } = await downloadJson(page);
  expect(artifact.sourceSha256).toBe(sha256(source));
  expect(artifact.a.delivered).toMatchObject({ sampleRate: 48_000, channels: 2, frames });
  expect(artifact.b.delivered.frames).toBe(frames);
  expect(artifact.a.delivered.wavSha256).toBe(artifact.b.delivered.wavSha256);
  const delivery = await downloadWav(page, "a");
  expect(sha256(delivery)).toBe(artifact.a.delivered.wavSha256);
  const facts = inspectWav(delivery);
  expect(facts.frames).toBe(frames);
  const expected = [
    [0, 0],
    [0, 0],
    [2, -2],
    [16_384, -16_384],
    [32_767, -32_768],
    [32_767, -32_768],
  ];
  expected.forEach((pair, frame) => {
    expect(sampleAt(delivery, facts, frame, 0)).toBe(pair[0]);
    expect(sampleAt(delivery, facts, frame, 1)).toBe(pair[1]);
  });
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("lossy MP3 source can be transcoded into distinct AAC and Opus sides", async ({ page, baseURL }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-transcode-"));
  try {
    const input = path.join(directory, "source.wav");
    const output = path.join(directory, "source.mp3");
    await writeFile(input, makePcm16Wav({ channels: 2, seconds: 1.2 }));
    await execute(ffmpeg, ["-nostdin", "-v", "error", "-i", input,
      "-c:a", "libmp3lame", "-b:a", "128k", output], { timeout: 30_000 });
    const source = await readFile(output);
    const guard = await openLab(page, new URL(baseURL!).origin);
    await page.locator("#source-file").setInputFiles({
      name: "source.mp3", mimeType: "audio/mpeg", buffer: source,
    });
    await configure(page, { policy: "aligned-gain-matched-v1", b: "opus", bitrateB: 96 });
    await page.selectOption("#codec-a", "aac");
    await page.selectOption("#bitrate-a", "128");
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
    const { artifact } = await downloadJson(page);
    expect(artifact.sourceSha256).toBe(sha256(source));
    expect(artifact.a.requested.codecId).toBe("aac");
    expect(artifact.b.requested.codecId).toBe("opus");
    expect(artifact.a.delivered.wavSha256).not.toBe(artifact.b.delivered.wavSha256);
    expect(artifact.validity?.policy).toBe("delivered-validity-v2");
    expectNoRemoteOrUpload(guard);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ten-minute AAC decoder padding survives preparation, binding and full playback staging", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-padded-aac-"));
  try {
    const source = path.join(directory, "padded-ten-minutes.aac");
    await execute(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi",
      "-i", "sine=frequency=997:sample_rate=44100", "-t", "600", "-c:a", "aac", source],
    { timeout: 60_000 });
    const guard = await openLab(page, new URL(baseURL!).origin);
    await page.locator("#source-file").setInputFiles(source);
    await configure(page, { a: "noop_passthrough", b: "noop_passthrough", policy: "aligned-gain-matched-v1" });
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.locator(".results")).toBeVisible({ timeout: 150_000 });
    const { artifact } = await downloadJson(page);
    const duration = artifact.a.delivered.frames / artifact.a.delivered.sampleRate;
    expect(duration).toBeGreaterThan(600);
    expect(duration).toBeLessThanOrEqual(600.1);
    await page.locator("#canary-enabled").uncheck();
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    await expect(page.locator(".listening-trial")).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".time-readout")).toContainText(`${duration.toFixed(3)} s`, { timeout: 120_000 });
    expectNoRemoteOrUpload(guard);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 96 kHz stereo track above 16 MiB retains its full length and an exact calibration prefix", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const source = makePcm16Wav({ sampleRate: 96_000, channels: 2, seconds: 45 });
  expect(source.byteLength).toBeGreaterThan(16 * 1024 * 1024);
  const guard = await openLab(page, new URL(baseURL!).origin);
  await page.locator("#source-file").setInputFiles({
    name: "full-track.wav", mimeType: "audio/wav", buffer: Buffer.from(source),
  });
  await configure(page, {
    a: "noop_passthrough", b: "noop_passthrough", policy: "aligned-gain-matched-v1", canary: true,
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".results")).toBeVisible({ timeout: 240_000 });
  const { artifact } = await downloadJson(page);
  expect(artifact.a.delivered).toMatchObject({ sampleRate: 96_000, channels: 2, frames: 45 * 96_000 });
  expect(artifact.b.delivered.frames).toBe(45 * 96_000);
  expect(artifact.canary?.report.frames).toBe(10 * 96_000);
  const full = await downloadWav(page, "a");
  const pristine = await downloadCanaryWav(page, "pristine");
  const fullFacts = inspectWav(full);
  const canaryFacts = inspectWav(pristine);
  expect(pristine.subarray(canaryFacts.dataOffset)).toEqual(
    full.subarray(fullFacts.dataOffset, fullFacts.dataOffset + canaryFacts.dataSize),
  );
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await expect(page.locator(".listening-trial")).toBeVisible({ timeout: 180_000 });
  expectNoRemoteOrUpload(guard);
});

test("a 601 s source beyond the former 600 s ceiling is prepared and staged without excerpting", async ({ page, baseURL }) => {
  test.setTimeout(900_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-beyond-ten-minutes-"));
  try {
    const guard = await openLab(page, new URL(baseURL!).origin);
    // The normal run keeps memory bounded. The explicit capacity lane uses
    // 96 kHz stereo while retaining the same full-track binding assertions.
    const maximumLayout = process.env.CODEC_ABX_TEST_MAXIMUM_AUDIO === "1";
    const sampleRate = maximumLayout ? 96_000 : 48_000;
    const channels = maximumLayout ? 2 : 1;
    const source = path.join(directory, "beyond-ten-minutes.wav");
    await writeFile(source, makePcm16Wav({ sampleRate, channels, seconds: 601 }));
    await page.locator("#source-file").setInputFiles(source);
    await configure(page, { a: "noop_passthrough", b: "noop_passthrough", policy: "aligned-gain-matched-v1" });
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.locator(".results")).toBeVisible({ timeout: 600_000 });
    const { artifact } = await downloadJson(page);
    expect(artifact.a.delivered).toMatchObject({ sampleRate, channels, frames: 601 * sampleRate });
    expect(artifact.b.delivered.frames).toBe(601 * sampleRate);
    expect(artifact.a.delivered.wavSha256).toBe(artifact.b.delivered.wavSha256);
    expect(artifact.validity?.policy).toBe("delivered-validity-v2");
    await page.locator("#canary-enabled").uncheck();
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    await expect(page.locator(".listening-trial")).toBeVisible({ timeout: 240_000 });
    await expect(page.locator(".time-readout")).toContainText("601.000 s", { timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Monitor playback label X" })).toBeEnabled();
    expectNoRemoteOrUpload(guard);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
