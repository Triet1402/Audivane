import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  chooseWav,
  collectPageErrors,
  configure,
  downloadJson,
  downloadWav,
  expectNoRemoteOrUpload,
  inspectWav,
  makePcm16Wav,
  measureDelivered,
  openLab,
  prepare,
  sampleAt,
  sha256,
} from "./fixtures.js";
import type { DeliveredPairMeasurements, LevelMeasurement } from "@codec-abx/contracts";

async function origin(page: Page, baseURL: string | undefined): Promise<string> {
  const resolved = baseURL ?? page.url();
  return new URL(resolved).origin;
}

function expectLevelMatch(
  actual: LevelMeasurement,
  expected: LevelMeasurement,
  tolerance: number,
  label: string,
): void {
  expect(actual.status, `${label} status`).toBe(expected.status);
  expect(actual.reason === null, `${label} reason nullity`).toBe(expected.reason === null);
  if (actual.status === "finite" && expected.status === "finite") {
    expect(Math.abs(actual.value - expected.value), `${label} numeric error`)
      .toBeLessThanOrEqual(tolerance);
  }
}

/**
 * Compares the browser detailed report with the shared TypeScript measurement
 * from the exact same downloaded WAV bytes. This fails if the worker
 * substitutes zeros or fabricated metrics.
 */
function expectOracleParity(
  actual: DeliveredPairMeasurements,
  expected: DeliveredPairMeasurements,
): { confidenceError: number; loudnessError: number; peakError: number; nullError: number } {
  expect(actual.policy).toBe("delivered-pcm-measurements-v1");
  expect(expected.policy).toBe("delivered-pcm-measurements-v1");
  expect(actual.alignment).toMatchObject({
    lagSamples: expected.alignment.lagSamples,
    status: expected.alignment.status,
    maxLagSamples: expected.alignment.maxLagSamples,
    probeSamples: expected.alignment.probeSamples,
  });
  const confidenceError = Math.abs(actual.alignment.confidence - expected.alignment.confidence);
  expect(confidenceError, "alignment confidence error").toBeLessThanOrEqual(1e-9);

  let loudnessError = 0;
  let peakError = 0;
  for (const side of ["a", "b"] as const) {
    expect(actual[side].sampleRate).toBe(expected[side].sampleRate);
    expect(actual[side].channels).toBe(expected[side].channels);
    expect(actual[side].frames).toBe(expected[side].frames);
    expectLevelMatch(actual[side].integratedLufs, expected[side].integratedLufs,
      1e-5, `${side} integrated loudness`);
    expectLevelMatch(actual[side].samplePeakDbfs, expected[side].samplePeakDbfs,
      1e-9, `${side} sample peak`);
    if (actual[side].integratedLufs.status === "finite" &&
        expected[side].integratedLufs.status === "finite") {
      loudnessError = Math.max(loudnessError,
        Math.abs(actual[side].integratedLufs.value - expected[side].integratedLufs.value));
    }
    if (actual[side].samplePeakDbfs.status === "finite" &&
        expected[side].samplePeakDbfs.status === "finite") {
      peakError = Math.max(peakError,
        Math.abs(actual[side].samplePeakDbfs.value - expected[side].samplePeakDbfs.value));
    }
  }
  expectLevelMatch(actual.loudnessDeltaDb, expected.loudnessDeltaDb, 1e-5, "loudness delta");
  if (actual.loudnessDeltaDb.status === "finite" && expected.loudnessDeltaDb.status === "finite") {
    loudnessError = Math.max(loudnessError,
      Math.abs(actual.loudnessDeltaDb.value - expected.loudnessDeltaDb.value));
  }
  expect(actual.nullDepth.basis).toBe(expected.nullDepth.basis);
  expect(actual.nullDepth.comparedFrames).toBe(expected.nullDepth.comparedFrames);
  expectLevelMatch(actual.nullDepth.depthDb, expected.nullDepth.depthDb, 1e-9, "null depth");
  const nullError =
    actual.nullDepth.depthDb.status === "finite" && expected.nullDepth.depthDb.status === "finite"
      ? Math.abs(actual.nullDepth.depthDb.value - expected.nullDepth.depthDb.value)
      : 0;
  return { confidenceError, loudnessError, peakError, nullError };
}

function expectLevelStatus(
  level: LevelMeasurement,
  status: LevelMeasurement["status"],
  label: string,
): void {
  expect(level.status, label).toBe(status);
}

test("real capabilities and same-origin WASM assets load with no CDN or upload", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const started = Date.now();
  const guard = await openLab(page, await origin(page, baseURL));
  const capabilityMs = Date.now() - started;
  console.log(`[observation] capability probe + core load: ${capabilityMs} ms`);

  // openLab already proved the real Opus/no-op probe succeeded. This test owns
  // the security boundary: the core arrives from the page origin and nothing is
  // uploaded or fetched from a CDN. Codec availability is asserted from the
  // exported artifact elsewhere, not from presentation text.
  expect(guard.wasmAssets.length, "the real codec WASM asset must be requested").toBeGreaterThan(0);
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("mono native 44.1 kHz no-op vs Opus reports honest provenance and delivered measurements", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const fixture = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 1 });
  const fixtureHash = sha256(fixture);
  await chooseWav(page, "mono-44100.wav", fixture);
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native" });

  const elapsed = await prepare(page);
  console.log(`[observation] mono 44.1k no-op+Opus preparation: ${elapsed} ms`);
  const exported = await downloadJson(page);
  const artifact = exported.artifact;

  expect(exported.schema).toBe("codec-abx-browser-diagnostic-v4");
  expect(exported.purpose).toBe("diagnostic-only");
  expect(exported.engineLocation).toBe("browser-local");
  expect(exported.preparationPolicy).toBe("codec-probe-only");
  expect(exported.runAuthority).toContain("none");
  expect(exported.scientificStatus.scoredAbxRun).toBe(false);
  expect(exported.scientificStatus.experimentParity).toBe(false);
  expect(exported.scientificStatus.alignmentApplied).toBe(false);
  expect(exported.scientificStatus.preparationPolicyExecuted).toBe(false);
  expect(exported.scientificStatus.normalizationApplied).toBe(false);
  expect(exported.scientificStatus.canaryGates).toBe(false);
  expect(exported.deliveredMeasurements).toEqual(artifact.measurements.delivered);

  expect(artifact.id).toMatch(/^[0-9a-f]{36}$/);
  expect(artifact.purpose).toBe("diagnostic-only");
  expect(artifact.sourceSha256).toBe(fixtureHash);
  expect(artifact.request).toEqual({
    version: 1,
    sampleRateMode: "native",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "opus", bitrateKbps: 128 },
  });
  expect(artifact.engine.location).toBe("browser-local");
  expect(artifact.engine.preparationPolicy).toBe("codec-probe-only");
  expect(artifact.engine.build).toContain("@ffmpeg/core 0.12.10");
  expect(artifact.engine.build).toMatch(/FFmpeg \S+/);
  const implemented = [
    "noop_passthrough", "opus", "aac", "ogg_vorbis", "mp3", "mp2", "sbc", "aptx", "aptx_hd",
    "lc3", "ldac",
  ];
  // The app bundle serves the supplemental LC3/LDAC WASM builds, so all eleven
  // catalog codecs are available in the real client; no codec stays unavailable.
  expect(artifact.engine.codecs).toHaveLength(11);
  for (const codecId of implemented) {
    expect(artifact.engine.codecs.find((codec) => codec.codecId === codecId)?.availability,
      `pinned local WASM build round trip ${codecId}`).toBe("available");
  }
  expect(artifact.engine.build).toContain("supplemental: LC3 supplemental WASM (liblc3 1.1.3), " +
    "LDAC supplemental WASM (AOSP libldac 2.00.02 + hegdi/libldacdec)");

  expect(artifact.measurements.policy).toBe("delivered-pcm-measurements-v1");
  const detailed = artifact.measurements.delivered;
  expect(detailed).toBeDefined();
  if (!detailed) throw new Error("test: detailed measurements are missing");
  expect(detailed.policy).toBe("delivered-pcm-measurements-v1");
  expect(detailed.alignment.maxLagSamples).toBe(96000);
  expect(detailed.alignment.probeSamples).toBe(240000);
  expect(detailed.a.sampleRate).toBe(44100);
  expect(detailed.a.channels).toBe(1);
  expect(detailed.a.frames).toBe(artifact.a.delivered.frames);
  expect(detailed.b.sampleRate).toBe(44100);
  expect(detailed.b.channels).toBe(1);
  expect(detailed.b.frames).toBe(artifact.b.delivered.frames);
  expectLevelStatus(detailed.a.integratedLufs, "finite", "A integrated loudness");
  expectLevelStatus(detailed.b.integratedLufs, "finite", "B integrated loudness");
  expectLevelStatus(detailed.a.samplePeakDbfs, "finite", "A sample peak");
  expectLevelStatus(detailed.b.samplePeakDbfs, "finite", "B sample peak");
  expect(artifact.measurements.alignmentLagSamples).toBe(detailed.alignment.lagSamples);
  expect(artifact.measurements.alignmentConfidence).toBe(detailed.alignment.confidence);
  expect(artifact.measurements.loudnessDeltaDb).toBe(detailed.loudnessDeltaDb.value);
  // Identical/re-encoded nonzero PCM does not reach an exact unshifted null.
  expect(detailed.nullDepth.depthDb.status).toBe("finite");
  expect(artifact.measurements.nullDepthDb).toBe(detailed.nullDepth.depthDb.value);
  expect(artifact.measurements.notes.join(" ")).toMatch(/not applied/i);
  expect(exported.scientificStatus.alignmentEstimated)
    .toBe(detailed.alignment.status === "estimated");
  expect(exported.scientificStatus.deliveredLoudnessMeasured).toBe(true);
  expect(exported.scientificStatus.nullDepthMeasured).toBe(true);

  expect(artifact.a.requested).toEqual({ codecId: "noop_passthrough", bitrateKbps: 0 });
  expect(artifact.a.encoder).toBe("pcm_s16le");
  expect(artifact.a.decoder).toBe("pcm_s16le");
  expect(artifact.a.actualBitrateKbps).toBeNull();
  expect(artifact.a.encodedSampleRate).toBe(44100);
  expect(artifact.a.delivered.sampleRate).toBe(44100);
  expect(artifact.a.delivered.channels).toBe(1);
  expect(artifact.a.delivered.frames).toBe(44100);
  expect(artifact.a.delivered.wavSha256).toMatch(/^[0-9a-f]{64}$/);

  expect(artifact.b.requested).toEqual({ codecId: "opus", bitrateKbps: 128 });
  expect(artifact.b.encoder).toBe("libopus");
  expect(artifact.b.decoder).toBe("opus");
  expect(artifact.b.encodedSampleRate).toBe(48000);
  expect(artifact.b.actualBitrateKbps).not.toBeNull();
  expect(artifact.b.actualBitrateKbps ?? 0).toBeGreaterThan(32);
  expect(artifact.b.actualBitrateKbps ?? 0).toBeLessThan(500);
  expect(artifact.b.delivered.sampleRate).toBe(44100);
  expect(artifact.b.delivered.channels).toBe(1);
  expect(Math.abs(artifact.b.delivered.frames - artifact.a.delivered.frames)).toBeLessThanOrEqual(1);
  console.log(
    `[observation] Opus 128k actual container bitrate: ` +
    `${artifact.b.actualBitrateKbps ?? "null"} kbps`,
  );

  const serialized = JSON.stringify(exported);
  expect(serialized).not.toContain("Infinity");
  expect(serialized).not.toContain("NaN");

  const aBytes = await downloadWav(page, "a");
  const aFacts = inspectWav(aBytes);
  expect(aFacts.sampleRate).toBe(44100);
  expect(aFacts.channels).toBe(1);
  expect(aFacts.frames).toBe(artifact.a.delivered.frames);
  expect(sha256(aBytes)).toBe(artifact.a.delivered.wavSha256);

  const bBytes = await downloadWav(page, "b");
  const bFacts = inspectWav(bBytes);
  expect(bFacts.sampleRate).toBe(44100);
  expect(bFacts.channels).toBe(1);
  expect(bFacts.frames).toBe(artifact.b.delivered.frames);
  expect(sha256(bBytes)).toBe(artifact.b.delivered.wavSha256);

  const reference = await measureDelivered(aBytes, bBytes);
  const measurementErrors = expectOracleParity(detailed, reference);
  console.log(
    `[measurement observation] mono 44.1k delivered pair errors: ` +
    `confidence ${measurementErrors.confidenceError.toExponential(3)}, ` +
    `loudness ${measurementErrors.loudnessError.toExponential(3)} dB, ` +
    `peak ${measurementErrors.peakError.toExponential(3)} dB, ` +
    `null ${measurementErrors.nullError.toExponential(3)} dB; ` +
    `lag ${detailed.alignment.lagSamples}, status ${detailed.alignment.status}`,
  );

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("anti-phase stereo is preserved by PCM passthrough and Opus stays stereo", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const fixture = makePcm16Wav({
    sampleRate: 48000,
    channels: 2,
    seconds: 0.5,
    antiPhase: true,
  });
  await chooseWav(page, "anti-phase-stereo-48000.wav", fixture);
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 96, mode: "native" });

  const elapsed = await prepare(page);
  console.log(`[observation] anti-phase stereo 48k preparation: ${elapsed} ms`);
  const { artifact } = await downloadJson(page);

  expect(artifact.a.delivered.sampleRate).toBe(48000);
  expect(artifact.a.delivered.channels).toBe(2);
  expect(artifact.a.delivered.frames).toBe(24000);
  expect(artifact.b.delivered.sampleRate).toBe(48000);
  expect(artifact.b.delivered.channels).toBe(2);
  expect(Math.abs(artifact.b.delivered.frames - 24000)).toBeLessThanOrEqual(1);
  expect(artifact.b.encodedSampleRate).toBe(48000);

  const aBytes = await downloadWav(page, "a");
  const aFacts = inspectWav(aBytes);
  expect(aFacts.channels).toBe(2);
  expect(aFacts.frames).toBe(24000);
  let antiPhasePairs = 0;
  for (let frame = 100; frame < 200; frame += 1) {
    const left = sampleAt(aBytes, aFacts, frame, 0);
    const right = sampleAt(aBytes, aFacts, frame, 1);
    if (left !== 0) {
      expect(right).toBe(-left);
      antiPhasePairs += 1;
    }
  }
  expect(antiPhasePairs).toBeGreaterThan(90);

  const bBytes = await downloadWav(page, "b");
  const bFacts = inspectWav(bBytes);
  expect(bFacts.channels).toBe(2);
  let antiPhaseProducts = 0;
  for (let frame = 100; frame < 200; frame += 1) {
    antiPhaseProducts +=
      sampleAt(bBytes, bFacts, frame, 0) * sampleAt(bBytes, bFacts, frame, 1);
  }
  expect(antiPhaseProducts).toBeLessThan(0);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("nonzero identical no-op delivery reports an exact negative-infinity null", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const fixture = makePcm16Wav({ sampleRate: 48000, channels: 1, seconds: 0.6 });
  await chooseWav(page, "exact-noop.wav", fixture);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const { artifact, scientificStatus } = await downloadJson(page);
  const detailed = artifact.measurements.delivered;
  if (!detailed) throw new Error("test: detailed measurements are missing");

  expect(detailed.alignment.status).toBe("estimated");
  expect(detailed.alignment.lagSamples).toBe(0);
  expect(detailed.nullDepth.depthDb.status).toBe("negative-infinity");
  const nullNote = artifact.measurements.notes.find((note) =>
    note.startsWith("Unshifted common-prefix null depth"));
  expect(nullNote).toContain("negative infinity dB (exact null:");
  expect(nullNote).not.toContain("silence/below-gate");
  expect(artifact.measurements.nullDepthDb).toBeNull();
  expect(detailed.a.integratedLufs.status).toBe("finite");
  expect(detailed.loudnessDeltaDb.status).toBe("finite");
  expect(detailed.loudnessDeltaDb.status === "finite" ? detailed.loudnessDeltaDb.value : -1)
    .toBe(0);
  expect(scientificStatus.nullDepthMeasured).toBe(true);
  expect(scientificStatus.alignmentEstimated).toBe(true);
  expect(scientificStatus.deliveredLoudnessMeasured).toBe(true);

  const aBytes = await downloadWav(page, "a");
  const bBytes = await downloadWav(page, "b");
  const reference = await measureDelivered(aBytes, bBytes);
  expect(reference.nullDepth.depthDb.status).toBe("negative-infinity");
  expectOracleParity(detailed, reference);

  expect(JSON.stringify(artifact)).not.toContain("Infinity");
  expect(JSON.stringify(artifact)).not.toContain("NaN");
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("silent delivery reports distinct no-evidence, negative-infinity and undefined meanings", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const fixture = makePcm16Wav({
    sampleRate: 44100,
    channels: 1,
    seconds: 0.6,
    amplitude: 0,
  });
  await chooseWav(page, "silence.wav", fixture);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const { artifact, scientificStatus } = await downloadJson(page);
  const detailed = artifact.measurements.delivered;
  if (!detailed) throw new Error("test: detailed measurements are missing");

  expect(detailed.alignment.status).toBe("no-evidence");
  expect(detailed.alignment.lagSamples).toBe(0);
  expect(detailed.alignment.confidence).toBe(0);
  expectLevelStatus(detailed.a.integratedLufs, "negative-infinity", "A integrated loudness");
  const levelNote = artifact.measurements.notes.find((note) =>
    note.startsWith("Side A integrated loudness"));
  expect(levelNote).toContain("no 400 ms block passed the absolute and relative gates");
  expect(levelNote).toContain("silent input: sample peak is negative infinity");
  expect(levelNote).not.toContain("exact digital null");
  expectLevelStatus(detailed.b.integratedLufs, "negative-infinity", "B integrated loudness");
  expectLevelStatus(detailed.a.samplePeakDbfs, "negative-infinity", "A sample peak");
  expect(detailed.nullDepth.depthDb.status).toBe("undefined");
  expect(detailed.loudnessDeltaDb.status).toBe("unavailable");
  expect(artifact.measurements.nullDepthDb).toBeNull();
  expect(artifact.measurements.loudnessDeltaDb).toBeNull();
  expect(scientificStatus.alignmentEstimated).toBe(false);
  expect(scientificStatus.deliveredLoudnessMeasured).toBe(false);
  expect(scientificStatus.nullDepthMeasured).toBe(false);

  const aBytes = await downloadWav(page, "a");
  const bBytes = await downloadWav(page, "b");
  const reference = await measureDelivered(aBytes, bBytes);
  expect(reference.nullDepth.depthDb.status).toBe("undefined");
  expectOracleParity(detailed, reference);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("clips shorter than 400 ms keep peak/lag but report unavailable loudness", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const fixture = makePcm16Wav({ sampleRate: 48000, channels: 1, seconds: 0.2 });
  await chooseWav(page, "short.wav", fixture);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const { artifact, scientificStatus } = await downloadJson(page);
  const detailed = artifact.measurements.delivered;
  if (!detailed) throw new Error("test: detailed measurements are missing");

  expectLevelStatus(detailed.a.integratedLufs, "unavailable", "short integrated loudness");
  expectLevelStatus(detailed.b.integratedLufs, "unavailable", "short integrated loudness");
  expectLevelStatus(detailed.a.samplePeakDbfs, "finite", "short sample peak");
  expect(detailed.alignment.status).toBe("estimated");
  expect(detailed.alignment.lagSamples).toBeGreaterThanOrEqual(0);
  expect(detailed.nullDepth.depthDb.status).toBe("negative-infinity");
  expect(detailed.loudnessDeltaDb.status).toBe("unavailable");
  expect(artifact.measurements.loudnessDeltaDb).toBeNull();
  expect(scientificStatus.deliveredLoudnessMeasured).toBe(false);
  expect(scientificStatus.nullDepthMeasured).toBe(true);

  const aBytes = await downloadWav(page, "a");
  const bBytes = await downloadWav(page, "b");
  const reference = await measureDelivered(aBytes, bBytes);
  expect(reference.a.integratedLufs.status).toBe("unavailable");
  expectOracleParity(detailed, reference);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("DC delivery matches the shared measurement instead of being forced undefined", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const fixture = makePcm16Wav({
    sampleRate: 48000,
    channels: 1,
    seconds: 0.6,
    amplitude: 0,
    dc: 0.2,
  });
  await chooseWav(page, "dc.wav", fixture);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const { artifact } = await downloadJson(page);
  const detailed = artifact.measurements.delivered;
  if (!detailed) throw new Error("test: detailed measurements are missing");

  expect(detailed.alignment.status).toBe("no-evidence");
  expect(detailed.nullDepth.depthDb.status).toBe("negative-infinity");
  expectLevelStatus(detailed.a.integratedLufs, "finite", "DC integrated loudness");
  const aBytes = await downloadWav(page, "a");
  const bBytes = await downloadWav(page, "b");
  const reference = await measureDelivered(aBytes, bBytes);
  expectOracleParity(detailed, reference);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("forced 48 kHz and native 96 kHz delivery follow the rate policy", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));

  const source44 = makePcm16Wav({ sampleRate: 44100, channels: 2, seconds: 0.4 });
  await chooseWav(page, "stereo-44100-force48.wav", source44);
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "force_48k" });
  const forcedMs = await prepare(page);
  console.log(`[observation] forced-48k resample + Opus preparation: ${forcedMs} ms`);
  const forced = (await downloadJson(page)).artifact;
  expect(forced.request.sampleRateMode).toBe("force_48k");
  expect(forced.a.delivered.sampleRate).toBe(48000);
  expect(forced.b.delivered.sampleRate).toBe(48000);
  expect(forced.a.delivered.channels).toBe(2);
  expect(forced.b.delivered.channels).toBe(2);
  expect(forced.a.encodedSampleRate).toBe(48000);
  expect(forced.b.encodedSampleRate).toBe(48000);
  expect(forced.a.delivered.frames).toBe(19200);
  expect(Math.abs(forced.b.delivered.frames - 19200)).toBeLessThanOrEqual(1);
  const forcedBytes = await downloadWav(page, "a");
  expect(inspectWav(forcedBytes).sampleRate).toBe(48000);

  const source96 = makePcm16Wav({ sampleRate: 96000, channels: 1, seconds: 0.25 });
  await chooseWav(page, "mono-96000.wav", source96);
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "native" });
  const nativeMs = await prepare(page);
  console.log(`[observation] 96k native no-op+Opus preparation: ${nativeMs} ms`);
  const native = (await downloadJson(page)).artifact;
  expect(native.request.sampleRateMode).toBe("native");
  expect(native.a.delivered.sampleRate).toBe(96000);
  expect(native.b.delivered.sampleRate).toBe(96000);
  expect(native.a.delivered.frames).toBe(24000);
  expect(native.a.encodedSampleRate).toBe(96000);
  expect(native.b.encodedSampleRate).toBe(48000);
  expect(Math.abs(native.b.delivered.frames - 24000)).toBeLessThanOrEqual(1);
  const nativeBytes = await downloadWav(page, "a");
  expect(inspectWav(nativeBytes).sampleRate).toBe(96000);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("disposing during capability loading leaves no uncaught page error", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  // Hold the real core request open so navigation is guaranteed to dispose a
  // capability load that has actually started, without matching UI copy.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/*.wasm", async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  const coreRequest = page.waitForRequest(/\.wasm(?:\?|$)/);
  await page.goto(await origin(page, baseURL));
  await coreRequest;
  await page.goto("about:blank");
  release();
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});

test("invalid, truncated and unsupported WAV sources fail closed and allow retry", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const valid = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 0.1 });

  const cases: ReadonlyArray<{ name: string; bytes: Uint8Array; pattern: RegExp }> = [
    {
      name: "not-audio.wav",
      bytes: new TextEncoder().encode("this is not a WAV file"),
      pattern: /Unsupported audio source signature/i,
    },
    {
      name: "truncated.wav",
      bytes: valid.slice(0, valid.length - 500),
      pattern: /truncated|exceeds/i,
    },
    {
      name: "unsupported-rate.wav",
      bytes: makePcm16Wav({ sampleRate: 32000, channels: 1, seconds: 0.1 }),
      pattern: /unsupported in native mode/i,
    },
    {
      name: "too-long.wav",
      bytes: makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 1801 }),
      pattern: /refused rather than silently cropped/i,
    },
  ];

  const directory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-invalid-import-"));
  try {
    for (const entry of cases) {
      if (entry.bytes.byteLength > 50 * 1024 * 1024) {
        const filename = path.join(directory, entry.name);
        await writeFile(filename, entry.bytes);
        await page.locator("#source-file").setInputFiles(filename);
      } else {
        await chooseWav(page, entry.name, entry.bytes);
      }
      await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
      await expect(page.locator(".run-status")).toContainText("Preparation failed.");
      await expect(page.getByRole("alert").filter({ hasText: entry.pattern })).toBeVisible();
      await expect(page.locator(".evidence-audio")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" }))
        .toBeEnabled();
    }

    await chooseWav(page, "recovered.wav", valid);
    await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
    await prepare(page);
    const recovered = (await downloadJson(page)).artifact;
    expect(recovered.a.delivered.frames).toBe(4410);
    expect(recovered.b.delivered.frames).toBe(4410);

    expectNoRemoteOrUpload(guard);
    expect(errors).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel and reset terminate the worker, block stale results, and permit retry", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, await origin(page, baseURL));
  const heavy = makePcm16Wav({ sampleRate: 96000, channels: 2, seconds: 10 });
  const small = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 0.2 });
  const cdp = await page.context().newCDPSession(page);

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 3 });
  await chooseWav(page, "heavy-96000-stereo.wav", heavy);
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 320, mode: "native" });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Side B: encoding Opus", {
    timeout: 150_000,
  });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".run-status")).toContainText("Cancelled.", { timeout: 120_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" }))
    .toBeEnabled();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  // A fresh job after cancellation must start a clean worker and succeed.
  await chooseWav(page, "retry-small.wav", small);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const retry = (await downloadJson(page)).artifact;
  expect(retry.a.delivered.frames).toBe(8820);
  expect(retry.b.delivered.frames).toBe(8820);

  await page.getByRole("button", { name: "Preview A" }).click();
  await expect(page.locator("audio")).toHaveCount(1);
  await expect(page.locator("audio")).toHaveAttribute("src", /^blob:/);

  // Reset releases the artifact and revokes the diagnostic object URL.
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".run-status")).toBeEmpty();
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(page.locator("#source-file")).toHaveValue("");

  // Reset while the core/worker is loading must cancel and clear the file.
  await chooseWav(page, "heavy-reset-loading.wav", heavy);
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native" });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Preparing.");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".run-status")).toBeEmpty({ timeout: 120_000 });
  await expect(page.locator("#source-file")).toHaveValue("");
  await page.waitForTimeout(750);
  await expect(page.locator(".evidence-audio")).toHaveCount(0);

  // Retry after reset uses a new file and publishes only its own result.
  await chooseWav(page, "after-reset.wav", small);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const afterReset = (await downloadJson(page)).artifact;
  expect(afterReset.a.delivered.frames).toBe(8820);
  await expect(page.locator("audio")).toHaveCount(0);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("cancel and reset during active measurement computation terminate the real measurement worker and retry cleanly", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const tracker: { created: string[]; terminated: string[]; started: string[] } = {
      created: [],
      terminated: [],
      started: [],
    };
    class TrackedWorker extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const name = options?.name ?? String(url);
        tracker.created.push(name);
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          tracker.terminated.push(name);
          terminate();
        };
        if (name.includes("codec-abx-measurements")) {
          const originalAdd = this.addEventListener.bind(this) as (
            type: string,
            listener: EventListenerOrEventListenerObject,
            listenerOptions?: boolean | AddEventListenerOptions,
          ) => void;
          const originalRemove = this.removeEventListener.bind(this) as (
            type: string,
            listener: EventListenerOrEventListenerObject,
            listenerOptions?: boolean | EventListenerOptions,
          ) => void;
          const wrapped = new WeakMap<object, EventListener>();
          this.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null,
            listenerOptions?: boolean | AddEventListenerOptions) => {
            if (type !== "message" || !listener) {
              if (listener) originalAdd(type, listener, listenerOptions);
              return;
            }
            const wrapper: EventListener = (event) => {
              const data = (event as MessageEvent).data as { type?: string } | undefined;
              if (data?.type === "started") {
                tracker.started.push(name);
              }
              if (typeof listener === "function") listener.call(this, event);
              else listener.handleEvent(event);
              const action = (window as unknown as { __measurementAction?: string | null })
                .__measurementAction;
              if (data?.type === "started" && (action === "cancel" || action === "reset")) {
                (window as unknown as { __measurementAction?: string | null })
                  .__measurementAction = null;
                queueMicrotask(() => {
                  const button = [...document.querySelectorAll("button")].find(
                    (candidate) => candidate.textContent?.trim().toLowerCase() === action,
                  );
                  button?.click();
                });
              }
            };
            wrapped.set(listener, wrapper);
            originalAdd(type, wrapper, listenerOptions);
          }) as typeof this.addEventListener;
          this.removeEventListener = ((type: string,
            listener: EventListenerOrEventListenerObject | null,
            listenerOptions?: boolean | EventListenerOptions) => {
            if (!listener) return;
            const wrapper = wrapped.get(listener);
            if (wrapper) {
              wrapped.delete(listener);
              originalRemove(type, wrapper, listenerOptions);
            } else {
              originalRemove(type, listener, listenerOptions);
            }
          }) as typeof this.removeEventListener;
        }
      }
    }
    Object.defineProperty(window, "Worker", { value: TrackedWorker, configurable: true });
    (window as unknown as { __measurementWorkerTracker: typeof tracker })
      .__measurementWorkerTracker = tracker;
  });
  const guard = await openLab(page, await origin(page, baseURL));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const heavy = makePcm16Wav({ sampleRate: 96000, channels: 2, seconds: 10 });
  const small = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 0.2 });
  await chooseWav(page, "measurement-cancel.wav", heavy);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });

  await page.evaluate(() => {
    (window as unknown as { __measurementAction?: string | null }).__measurementAction = "cancel";
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Cancelled.", { timeout: 150_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);

  const afterCancel = await page.evaluate(() => (
    window as unknown as {
      __measurementWorkerTracker: { created: string[]; terminated: string[]; started: string[] };
    }
  ).__measurementWorkerTracker);
  expect(afterCancel.started.some((name) => name.includes("codec-abx-measurements"))).toBe(true);
  expect(afterCancel.created.some((name) => name.includes("codec-abx-measurements"))).toBe(true);
  expect(afterCancel.terminated.some((name) => name.includes("codec-abx-measurements"))).toBe(true);

  // Reset during the next active computation must not publish the stale artifact.
  await page.evaluate(() => {
    (window as unknown as { __measurementAction?: string | null }).__measurementAction = "reset";
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toBeEmpty({ timeout: 150_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.locator("#source-file")).toHaveValue("");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  // Retry with a fresh file/run. No stale result or measurement worker survives.
  await chooseWav(page, "measurement-retry.wav", small);
  await configure(page, { a: "noop_passthrough", b: "noop_passthrough", mode: "native" });
  await prepare(page);
  const retry = (await downloadJson(page)).artifact;
  expect(retry.measurements.delivered?.policy).toBe("delivered-pcm-measurements-v1");
  expect(retry.a.delivered.frames).toBe(8820);
  expect(retry.b.delivered.frames).toBe(8820);

  const finalTracker = await page.evaluate(() => (
    window as unknown as {
      __measurementWorkerTracker: { created: string[]; terminated: string[] };
    }
  ).__measurementWorkerTracker);
  const created = finalTracker.created.filter((name) => name.includes("codec-abx-measurements"));
  const terminated = finalTracker.terminated.filter((name) =>
    name.includes("codec-abx-measurements"));
  expect(created.length).toBeGreaterThanOrEqual(3);
  expect(terminated.length).toBe(created.length);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});
