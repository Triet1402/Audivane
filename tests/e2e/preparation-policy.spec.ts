import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type {
  DeliveredPairMeasurements,
  LevelMeasurement,
  PairPreparationReport,
  PreparedArtifact,
} from "@codec-abx/contracts";

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
  pcmPayload,
  prepare,
  prepareDelivered,
  sampleAt,
  sha256,
  type PreparationResult,
} from "./fixtures.js";

const PROBE_SAMPLES = 240_000;

function policyMaxLag(rate: number): number {
  return Math.floor(0.1 * rate);
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

function expectDeliveredParity(
  actual: DeliveredPairMeasurements,
  expected: DeliveredPairMeasurements,
): void {
  expect(actual.policy).toBe("delivered-pcm-measurements-v1");
  expect(expected.policy).toBe("delivered-pcm-measurements-v1");
  expect(actual.alignment).toMatchObject({
    lagSamples: expected.alignment.lagSamples,
    status: expected.alignment.status,
    maxLagSamples: expected.alignment.maxLagSamples,
    probeSamples: expected.alignment.probeSamples,
  });
  expect(Math.abs(actual.alignment.confidence - expected.alignment.confidence))
    .toBeLessThanOrEqual(1e-9);
  for (const side of ["a", "b"] as const) {
    expect(actual[side].sampleRate).toBe(expected[side].sampleRate);
    expect(actual[side].channels).toBe(expected[side].channels);
    expect(actual[side].frames).toBe(expected[side].frames);
    expectLevelMatch(actual[side].integratedLufs, expected[side].integratedLufs,
      1e-5, `${side} integrated loudness`);
    expectLevelMatch(actual[side].samplePeakDbfs, expected[side].samplePeakDbfs,
      1e-9, `${side} sample peak`);
  }
  expectLevelMatch(actual.loudnessDeltaDb, expected.loudnessDeltaDb, 1e-5,
    "loudness delta");
  expect(actual.nullDepth.basis).toBe(expected.nullDepth.basis);
  expect(actual.nullDepth.comparedFrames).toBe(expected.nullDepth.comparedFrames);
  expectLevelMatch(actual.nullDepth.depthDb, expected.nullDepth.depthDb, 1e-9,
    "null depth");
}

function expectPreparationReportParity(
  actual: PairPreparationReport,
  expected: PreparationResult["report"],
): void {
  expect(actual.policy).toBe("aligned-gain-matched-v1");
  expect(expected.policy).toBe("aligned-gain-matched-v1");
  expect(actual.targetLufs).toBe(-16);
  expect(expected.targetLufs).toBe(-16);
  expect(actual.minimumDurationSeconds).toBe(0.4);
  expect(actual.minimumDurationSeconds).toBe(expected.minimumDurationSeconds);
  expect(actual.maxLagSeconds).toBe(0.1);
  expect(actual.maxLagSeconds).toBe(expected.maxLagSeconds);
  expect(actual.alignment).toMatchObject({
    lagSamples: expected.alignment.lagSamples,
    status: expected.alignment.status,
    maxLagSamples: expected.alignment.maxLagSamples,
    probeSamples: expected.alignment.probeSamples,
    inputFramesA: expected.alignment.inputFramesA,
    inputFramesB: expected.alignment.inputFramesB,
    startFrameA: expected.alignment.startFrameA,
    startFrameB: expected.alignment.startFrameB,
    outputFrames: expected.alignment.outputFrames,
  });
  expect(Math.abs(actual.alignment.confidence - expected.alignment.confidence))
    .toBeLessThanOrEqual(1e-9);
  expectLevelMatch(actual.loudness.preA, expected.loudness.preA, 1e-5,
    "pre-gain loudness A");
  expectLevelMatch(actual.loudness.preB, expected.loudness.preB, 1e-5,
    "pre-gain loudness B");
  expect(Math.abs(actual.loudness.gainADb - expected.loudness.gainADb))
    .toBeLessThanOrEqual(1e-9);
  expect(Math.abs(actual.loudness.gainBDb - expected.loudness.gainBDb))
    .toBeLessThanOrEqual(1e-9);
  expect(Math.abs(actual.loudness.commonTrimDb - expected.loudness.commonTrimDb))
    .toBeLessThanOrEqual(1e-9);
  expect(actual.peakCeiling).toBeCloseTo(expected.peakCeiling, 15);
  expect(actual.serialization).toMatchObject({
    format: "pcm16-le",
    rounding: "floor",
    floorBiasCodeSteps: 2 ** -17,
    dither: false,
  });
}

async function rawCodecPair(
  page: Page,
  options: {
    readonly a: "noop_passthrough" | "opus";
    readonly b: "noop_passthrough" | "opus";
    readonly bitrateB?: number;
    readonly mode: "native" | "force_48k";
  },
): Promise<{
  readonly artifact: PreparedArtifact;
  readonly aBytes: Uint8Array;
  readonly bBytes: Uint8Array;
}> {
  await configure(page, {
    a: options.a,
    b: options.b,
    ...(options.bitrateB === undefined ? {} : { bitrateB: options.bitrateB }),
    mode: options.mode,
    policy: "codec-probe-only",
  });
  await prepare(page);
  const exported = await downloadJson(page);
  const aBytes = await downloadWav(page, "a");
  const bBytes = await downloadWav(page, "b");
  return { artifact: exported.artifact, aBytes, bBytes };
}

async function prepareCorrected(
  page: Page,
  options: {
    readonly a: "noop_passthrough" | "opus";
    readonly b: "noop_passthrough" | "opus";
    readonly bitrateB?: number;
    readonly mode: "native" | "force_48k";
  },
): Promise<{
  readonly artifact: PreparedArtifact;
  readonly aBytes: Uint8Array;
  readonly bBytes: Uint8Array;
  readonly exported: Awaited<ReturnType<typeof downloadJson>>;
}> {
  await configure(page, {
    a: options.a,
    b: options.b,
    ...(options.bitrateB === undefined ? {} : { bitrateB: options.bitrateB }),
    mode: options.mode,
    policy: "aligned-gain-matched-v1",
  });
  await prepare(page);
  const exported = await downloadJson(page);
  const aBytes = await downloadWav(page, "a");
  const bBytes = await downloadWav(page, "b");
  return { artifact: exported.artifact, aBytes, bBytes, exported };
}

function requirePreparation(artifact: PreparedArtifact): PairPreparationReport {
  const preparation = artifact.preparation;
  if (!preparation) throw new Error("test: prepared artifact is missing its report");
  return preparation;
}

test("corrected mono native matches the shared preparation policy on the same decoded raw pair and remeasures final bytes", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const fixture = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 1 });
  await chooseWav(page, "policy-mono-44100.wav", fixture);

  const raw = await rawCodecPair(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native",
  });
  expect(raw.artifact.engine.preparationPolicy).toBe("codec-probe-only");
  expect(raw.artifact.request.preparationPolicy).toBeUndefined();
  expect(raw.artifact.preparation).toBeUndefined();

  const corrected = await prepareCorrected(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native",
  });
  const artifact = corrected.artifact;
  const preparation = requirePreparation(artifact);
  expect(artifact.request.preparationPolicy).toBe("aligned-gain-matched-v1");
  expect(artifact.engine.preparationPolicy).toBe("aligned-gain-matched-v1");
  expect(artifact.engine.supportedPreparationPolicies).toEqual([
    "codec-probe-only",
    "aligned-gain-matched-v1",
  ]);

  const reference = await prepareDelivered(raw.aBytes, raw.bBytes);
  expect(reference.schema).toBe("codec-abx-preparation-shared-v1");
  expectPreparationReportParity(preparation, reference.report);

  expect(pcmPayload(corrected.aBytes)).toEqual(pcmPayload(reference.aPrepared));
  expect(pcmPayload(corrected.bBytes)).toEqual(pcmPayload(reference.bPrepared));

  for (const side of ["a", "b"] as const) {
    const bytes = side === "a" ? corrected.aBytes : corrected.bBytes;
    const facts = inspectWav(bytes);
    const track = artifact[side];
    expect(facts.sampleRate).toBe(44100);
    expect(facts.channels).toBe(1);
    expect(facts.frames).toBe(preparation.alignment.outputFrames);
    expect(track.delivered).toEqual({
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      frames: facts.frames,
      wavSha256: sha256(bytes),
    });
    expect(track.delivered.frames).toBe(reference.report.alignment.outputFrames);
  }
  // Bitrate provenance remains the codec-stage duration, not the cropped length.
  expect(artifact.b.actualBitrateKbps).toBe(raw.artifact.b.actualBitrateKbps);
  expect(artifact.b.encodedSampleRate).toBe(48000);

  const finalMeasurements = await measureDelivered(corrected.aBytes, corrected.bBytes, {
    maxLagSamples: policyMaxLag(44100),
    probeSamples: PROBE_SAMPLES,
  });
  if (!artifact.measurements.delivered) throw new Error("test: delivered measurement missing");
  expectDeliveredParity(artifact.measurements.delivered, finalMeasurements);
  expectDeliveredParity(finalMeasurements, reference.delivered);

  const status = corrected.exported.scientificStatus;
  expect(corrected.exported.schema).toBe("codec-abx-browser-diagnostic-v4");
  expect(status.preparationPolicyExecuted).toBe(true);
  expect(status.alignmentApplied).toBe(preparation.alignment.lagSamples !== 0);
  expect(status.normalizationApplied).toBe(
    Math.abs(preparation.loudness.gainADb) > 1e-9 ||
      Math.abs(preparation.loudness.gainBDb) > 1e-9,
  );
  expect(status.gainMatchingApplied).toBe(
    Math.abs(preparation.loudness.gainADb - preparation.loudness.gainBDb) > 1e-9,
  );
  expect(status.commonPeakTrimApplied).toBe(preparation.loudness.commonTrimDb > 1e-9);
  expect(status.canaryGates).toBe(false);
  expect(status.scoredAbxRun).toBe(false);
  expect(corrected.exported.deliveredMeasurements).toEqual(artifact.measurements.delivered);
  expect(corrected.exported.preparation).toEqual(preparation);
  const serialized = JSON.stringify(corrected.exported);
  expect(serialized).not.toContain("Infinity");
  expect(serialized).not.toContain("NaN");

  await expect(page.locator(".measurements")).toContainText("Timing difference");
  await expect(page.locator(".measurements")).toContainText("Null depth");
  await expect(page.locator(".evidence-audio pre")).toHaveCount(0);

  console.log("[preparation observation] mono 44.1k: " + JSON.stringify({
    lag: preparation.alignment.lagSamples,
    status: preparation.alignment.status,
    outputFrames: preparation.alignment.outputFrames,
    gainADb: preparation.loudness.gainADb,
    gainBDb: preparation.loudness.gainBDb,
    commonTrimDb: preparation.loudness.commonTrimDb,
    residualLag: artifact.measurements.delivered.alignment.lagSamples,
    null: artifact.measurements.delivered.nullDepth.depthDb.status,
  }));
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("corrected anti-phase stereo no-op delivery keeps stereo, exact null and shared-policy PCM parity", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const fixture = makePcm16Wav({
    sampleRate: 48000,
    channels: 2,
    seconds: 0.6,
    antiPhase: true,
    amplitude: 0.3,
  });
  await chooseWav(page, "policy-antiphase-48000.wav", fixture);

  const raw = await rawCodecPair(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
  });
  const corrected = await prepareCorrected(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
  });
  const preparation = requirePreparation(corrected.artifact);
  const reference = await prepareDelivered(raw.aBytes, raw.bBytes);
  expectPreparationReportParity(preparation, reference.report);
  expect(pcmPayload(corrected.aBytes)).toEqual(pcmPayload(reference.aPrepared));
  expect(pcmPayload(corrected.bBytes)).toEqual(pcmPayload(reference.bPrepared));
  expect(corrected.aBytes).toEqual(corrected.bBytes);

  const aFacts = inspectWav(corrected.aBytes);
  expect(aFacts.sampleRate).toBe(48000);
  expect(aFacts.channels).toBe(2);
  expect(aFacts.frames).toBe(preparation.alignment.outputFrames);
  expect(corrected.artifact.a.delivered.wavSha256).toBe(sha256(corrected.aBytes));
  expect(corrected.artifact.b.delivered.wavSha256).toBe(sha256(corrected.bBytes));
  expect(corrected.artifact.a.delivered.frames).toBe(aFacts.frames);
  expect(corrected.artifact.b.delivered.frames).toBe(aFacts.frames);

  const delivered = corrected.artifact.measurements.delivered;
  if (!delivered) throw new Error("test: delivered measurement missing");
  expect(delivered.a.frames).toBe(aFacts.frames);
  expect(delivered.b.frames).toBe(aFacts.frames);
  expect(delivered.nullDepth.depthDb.status).toBe("negative-infinity");
  expect(corrected.artifact.measurements.nullDepthDb).toBeNull();
  expect(corrected.exported.scientificStatus.nullDepthMeasured).toBe(true);
  await expect(page.locator(".measurements")).toContainText("exact digital null");

  const finalMeasurements = await measureDelivered(corrected.aBytes, corrected.bBytes, {
    maxLagSamples: policyMaxLag(48000),
    probeSamples: PROBE_SAMPLES,
  });
  expect(finalMeasurements.nullDepth.depthDb.status).toBe("negative-infinity");
  expectDeliveredParity(delivered, finalMeasurements);

  // Channel anti-phase relation is preserved by the common gain/trim for this
  // fixture; a one-code-step serialization edge is tolerated.
  for (let frame = 100; frame < 200; frame += 1) {
    const left = sampleAt(corrected.aBytes, aFacts, frame, 0);
    const right = sampleAt(corrected.aBytes, aFacts, frame, 1);
    if (Math.abs(left) > 1) expect(Math.abs(left + right)).toBeLessThanOrEqual(1);
  }

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("corrected forced 48 kHz stereo follows rate policy and matches the shared policy on decoded raw bytes", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const fixture = makePcm16Wav({ sampleRate: 44100, channels: 2, seconds: 0.5 });
  await chooseWav(page, "policy-force48-stereo.wav", fixture);

  const raw = await rawCodecPair(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "force_48k",
  });
  expect(raw.artifact.a.delivered.sampleRate).toBe(48000);
  expect(raw.artifact.b.delivered.sampleRate).toBe(48000);
  const corrected = await prepareCorrected(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "force_48k",
  });
  const artifact = corrected.artifact;
  const preparation = requirePreparation(artifact);
  expect(artifact.request.sampleRateMode).toBe("force_48k");
  expect(artifact.a.delivered.sampleRate).toBe(48000);
  expect(artifact.b.delivered.sampleRate).toBe(48000);
  expect(artifact.a.delivered.channels).toBe(2);
  expect(artifact.b.delivered.channels).toBe(2);
  expect(artifact.b.actualBitrateKbps).toBe(raw.artifact.b.actualBitrateKbps);

  const reference = await prepareDelivered(raw.aBytes, raw.bBytes);
  expectPreparationReportParity(preparation, reference.report);
  expect(pcmPayload(corrected.aBytes)).toEqual(pcmPayload(reference.aPrepared));
  expect(pcmPayload(corrected.bBytes)).toEqual(pcmPayload(reference.bPrepared));
  const finalMeasurements = await measureDelivered(corrected.aBytes, corrected.bBytes, {
    maxLagSamples: policyMaxLag(48000),
    probeSamples: PROBE_SAMPLES,
  });
  if (!artifact.measurements.delivered) throw new Error("test: delivered measurement missing");
  expectDeliveredParity(artifact.measurements.delivered, finalMeasurements);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("corrected native 96 kHz mono matches the shared policy on decoded raw bytes", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const fixture = makePcm16Wav({ sampleRate: 96000, channels: 1, seconds: 0.6 });
  await chooseWav(page, "policy-native-96000.wav", fixture);

  const raw = await rawCodecPair(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "native",
  });
  const corrected = await prepareCorrected(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "native",
  });
  const preparation = requirePreparation(corrected.artifact);
  expect(corrected.artifact.a.delivered.sampleRate).toBe(96000);
  expect(corrected.artifact.b.delivered.sampleRate).toBe(96000);
  expect(corrected.artifact.b.encodedSampleRate).toBe(48000);
  expect(corrected.artifact.b.actualBitrateKbps).toBe(raw.artifact.b.actualBitrateKbps);

  const reference = await prepareDelivered(raw.aBytes, raw.bBytes);
  expectPreparationReportParity(preparation, reference.report);
  expect(pcmPayload(corrected.aBytes)).toEqual(pcmPayload(reference.aPrepared));
  expect(pcmPayload(corrected.bBytes)).toEqual(pcmPayload(reference.bPrepared));
  const finalMeasurements = await measureDelivered(corrected.aBytes, corrected.bBytes, {
    maxLagSamples: policyMaxLag(96000),
    probeSamples: PROBE_SAMPLES,
  });
  if (!corrected.artifact.measurements.delivered) {
    throw new Error("test: delivered measurement missing");
  }
  expectDeliveredParity(
    corrected.artifact.measurements.delivered,
    finalMeasurements,
  );

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("corrected mode refuses silence and short crops then retries cleanly", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  await configure(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
    policy: "aligned-gain-matched-v1",
  });

  await chooseWav(page, "policy-silence.wav", makePcm16Wav({
    sampleRate: 48000, channels: 1, seconds: 0.6, amplitude: 0,
  }));
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Preparation failed.");
  await expect(page.locator(".status-error")).toContainText(/preparation-gate-failed.*non-evidentiary/);
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" }))
    .toBeEnabled();

  await chooseWav(page, "policy-short.wav", makePcm16Wav({
    sampleRate: 48000, channels: 1, seconds: 0.2,
  }));
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Preparation failed.");
  await expect(page.locator(".status-error")).toContainText(/short-crop/);
  await expect(page.locator(".evidence-audio")).toHaveCount(0);

  await chooseWav(page, "policy-recovered.wav", makePcm16Wav({
    sampleRate: 48000, channels: 1, seconds: 0.6,
  }));
  await prepare(page);
  const artifact = (await downloadJson(page)).artifact;
  expect(artifact.preparation?.policy).toBe("aligned-gain-matched-v1");
  expect(artifact.a.delivered.frames).toBe(artifact.preparation?.alignment.outputFrames);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("corrected worker load failure fails closed and a fresh preparation retries", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "policy-worker-load.wav", makePcm16Wav({
    sampleRate: 44100, channels: 1, seconds: 0.6,
  }));
  await configure(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
    policy: "aligned-gain-matched-v1",
  });
  const workerURL = /measurement-worker(?:\.ts|-[^/]+\.js)(?:\?.*)?$/;
  await page.route(workerURL, (route) => route.abort());
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Preparation failed.");
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" }))
    .toBeEnabled();
  await page.unroute(workerURL);

  await prepare(page);
  const artifact = (await downloadJson(page)).artifact;
  expect(artifact.preparation?.policy).toBe("aligned-gain-matched-v1");
  expect(artifact.measurements.delivered?.policy).toBe("delivered-pcm-measurements-v1");
  expect(artifact.a.delivered.frames).toBe(artifact.preparation?.alignment.outputFrames);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("cancel and reset during the real corrected worker start terminate it and permit retry", async ({
  page,
  baseURL,
}) => {
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
          this.addEventListener = ((type: string,
            listener: EventListenerOrEventListenerObject | null,
            listenerOptions?: boolean | AddEventListenerOptions) => {
            if (type !== "message" || !listener) {
              if (listener) originalAdd(type, listener, listenerOptions);
              return;
            }
            const wrapper: EventListener = (event) => {
              const data = (event as MessageEvent).data as { type?: string; mode?: string } |
                undefined;
              if (data?.type === "started") tracker.started.push(name);
              if (typeof listener === "function") listener.call(this, event);
              else listener.handleEvent(event);
              const action = (window as unknown as { __preparationAction?: string | null })
                .__preparationAction;
              if (data?.type === "started" && data.mode === "prepare" &&
                  (action === "cancel" || action === "reset")) {
                (window as unknown as { __preparationAction?: string | null })
                  .__preparationAction = null;
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
    (window as unknown as { __preparationWorkerTracker: typeof tracker })
      .__preparationWorkerTracker = tracker;
  });
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const heavy = makePcm16Wav({ sampleRate: 96000, channels: 2, seconds: 5 });
  const small = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 0.5 });
  await configure(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
    policy: "aligned-gain-matched-v1",
  });

  await chooseWav(page, "policy-cancel-heavy.wav", heavy);
  await page.evaluate(() => {
    (window as unknown as { __preparationAction?: string | null })
      .__preparationAction = "cancel";
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Cancelled.", { timeout: 150_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);

  const afterCancel = await page.evaluate(() => (
    window as unknown as {
      __preparationWorkerTracker: { created: string[]; terminated: string[]; started: string[] };
    }
  ).__preparationWorkerTracker);
  expect(afterCancel.started.some((name) => name.includes("codec-abx-measurements"))).toBe(true);
  expect(afterCancel.terminated.some((name) => name.includes("codec-abx-measurements")))
    .toBe(true);

  await page.evaluate(() => {
    (window as unknown as { __preparationAction?: string | null })
      .__preparationAction = "reset";
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toBeEmpty({ timeout: 150_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.locator(".file-summary")).toHaveCount(0);
  await expect(page.locator("#source-file")).toHaveValue("");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  await chooseWav(page, "policy-after-cancel.wav", small);
  await prepare(page);
  const retry = (await downloadJson(page)).artifact;
  expect(retry.preparation?.policy).toBe("aligned-gain-matched-v1");
  expect(retry.a.delivered.frames).toBe(retry.preparation?.alignment.outputFrames);

  const finalTracker = await page.evaluate(() => (
    window as unknown as {
      __preparationWorkerTracker: { created: string[]; terminated: string[] };
    }
  ).__preparationWorkerTracker);
  const created = finalTracker.created.filter((name) =>
    name.includes("codec-abx-measurements"));
  const terminated = finalTracker.terminated.filter((name) =>
    name.includes("codec-abx-measurements"));
  expect(created.length).toBeGreaterThanOrEqual(3);
  expect(terminated.length).toBe(created.length);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("corrupted preparation reports reject without publication and permit a clean retry", async ({ page, baseURL }) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const state = { tamper: null as string | null, created: 0, terminated: 0 };
    Object.assign(window, { __preparationCorruption: state });
    class CorruptingWorker extends OriginalWorker {
      private readonly numerical: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.numerical = options?.name === "codec-abx-measurements";
        if (!this.numerical) return;
        state.created += 1;
        // Registered before the engine's listener. Mutate the actual cloned
        // response, preserving a real WASM/worker preparation underneath.
        super.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as {
            type: string;
            report: { peakCeiling: number; alignment: { maxLagSamples: number };
              loudness: { gainADb: number } };
          };
          if (data.type !== "prepare-result" || state.tamper === null) return;
          const mode = state.tamper;
          state.tamper = null;
          if (mode === "ceiling") data.report.peakCeiling = 2;
          else if (mode === "bounds") data.report.alignment.maxLagSamples += 1;
          else if (mode === "gain") data.report.loudness.gainADb += 1;
        });
      }
      override terminate(): void {
        if (this.numerical) state.terminated += 1;
        super.terminate();
      }
    }
    window.Worker = CorruptingWorker;
  });
  const guard = await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "corrupt-report.wav", makePcm16Wav({ channels: 1, seconds: 0.6 }));
  await configure(page, { a: "noop_passthrough", b: "opus", mode: "native",
    policy: "aligned-gain-matched-v1" });
  for (const mode of ["ceiling", "bounds", "gain"]) {
    await page.evaluate((selected) => {
      const state = (window as unknown as {
        __preparationCorruption: { tamper: string | null };
      }).__preparationCorruption;
      state.tamper = selected;
    }, mode);
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.getByRole("alert")).toContainText("Preparation worker returned");
    await expect(page.locator(".evidence-audio")).toHaveCount(0);
    expect(await page.evaluate(() => {
      const state = (window as unknown as {
        __preparationCorruption: { created: number; terminated: number };
      }).__preparationCorruption;
      return state.created === state.terminated;
    })).toBe(true);
  }
  await prepare(page);
  const exported = await downloadJson(page);
  expect(exported.artifact.preparation?.policy).toBe("aligned-gain-matched-v1");
  expect(await page.evaluate(() => {
    const state = (window as unknown as {
      __preparationCorruption: { created: number; terminated: number };
    }).__preparationCorruption;
    return { created: state.created, terminated: state.terminated };
  })).toEqual({ created: 4, terminated: 4 });
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});
