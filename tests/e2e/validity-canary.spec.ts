import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CanaryMaterialReport, LevelMeasurement, PreparedArtifact } from "@codec-abx/contracts";

import {
  buildCanaryMaterial,
  chooseWav,
  collectPageErrors,
  configure,
  downloadCanaryWav,
  downloadJson,
  downloadWav,
  expectNoRemoteOrUpload,
  inspectWav,
  makePcm16Wav,
  measureDelivered,
  openLab,
  pcmPayload,
  prepare,
  sha256,
} from "./fixtures.js";

function expectLevelMatch(
  actual: LevelMeasurement,
  expected: LevelMeasurement,
  tolerance: number,
  label: string,
): void {
  expect(actual.status, `${label} status`).toBe(expected.status);
  if (actual.status === "finite" && expected.status === "finite") {
    expect(Math.abs(actual.value - expected.value), `${label} numeric error`)
      .toBeLessThanOrEqual(tolerance);
  }
}

function expectCanaryReportParity(
  actual: PreparedArtifact["canary"],
  expected: CanaryMaterialReport,
): void {
  if (!actual) throw new Error("test: artifact canary material is missing");
  const report = actual.report;
  expect(report.policy).toBe("delivered-canary-v1");
  expect(report.status).toBe(expected.status);
  expect(report.usable).toBe(expected.usable);
  expect(report.minimumResidualDb).toBe(expected.minimumResidualDb);
  expectLevelMatch(report.depthDb, expected.depthDb, 1e-9, "canary depth");
  expect(report.cutoffHz).toBe(expected.cutoffHz);
  expect(report.frequencyGrid).toBe(expected.frequencyGrid);
  expect(report.drive).toBe(expected.drive);
  expect(report.clipLevel).toBe(expected.clipLevel);
  expect(report.sampleRate).toBe(expected.sampleRate);
  expect(report.channels).toBe(expected.channels);
  expect(report.frames).toBe(expected.frames);
}

async function prepareCanary(
  page: Page,
  options: {
    readonly a: "noop_passthrough" | "opus";
    readonly b: "noop_passthrough" | "opus";
    readonly bitrateB?: number;
    readonly mode: "native" | "force_48k";
  },
): Promise<{ artifact: PreparedArtifact; exported: Awaited<ReturnType<typeof downloadJson>> }> {
  await configure(page, {
    a: options.a,
    b: options.b,
    ...(options.bitrateB === undefined ? {} : { bitrateB: options.bitrateB }),
    mode: options.mode,
    policy: "aligned-gain-matched-v1",
    canary: true,
  });
  await prepare(page);
  const exported = await downloadJson(page);
  return { artifact: exported.artifact, exported };
}

async function assertCanaryMaterialAgainstReference(
  page: Page,
  artifact: PreparedArtifact,
  finalA: Uint8Array,
): Promise<void> {
  const canary = artifact.canary;
  if (!canary?.audio) throw new Error("test: usable canary material is missing");
  const pristine = await downloadCanaryWav(page, "pristine");
  const degraded = await downloadCanaryWav(page, "degraded");
  expect(sha256(pristine)).toBe(canary.audio.pristine.wavSha256);
  expect(sha256(degraded)).toBe(canary.audio.degraded.wavSha256);

  const finalAFacts = inspectWav(finalA);
  const pristineFacts = inspectWav(pristine);
  const degradedFacts = inspectWav(degraded);
  for (const facts of [pristineFacts, degradedFacts]) {
    expect(facts.sampleRate).toBe(canary.report.sampleRate);
    expect(facts.channels).toBe(canary.report.channels);
    expect(facts.frames).toBe(canary.report.frames);
  }
  expect(pristineFacts.sampleRate).toBe(finalAFacts.sampleRate);
  expect(pristineFacts.channels).toBe(finalAFacts.channels);
  expect(pristineFacts.frames).toBe(finalAFacts.frames);
  expect(pcmPayload(pristine)).toEqual(pcmPayload(finalA));

  const reference = await buildCanaryMaterial(finalA);
  expect(reference.schema).toBe("codec-abx-validity-canary-shared-v1");
  expectCanaryReportParity(artifact.canary, reference.canary);
  expect(pcmPayload(pristine)).toEqual(pcmPayload(reference.pristineBytes));
  expect(pcmPayload(degraded)).toEqual(pcmPayload(reference.degradedBytes));
  expect(reference.pristine.sha256).toBe(sha256(reference.pristineBytes));
  expect(reference.degraded.sha256).toBe(sha256(reference.degradedBytes));

  const independent = await measureDelivered(pristine, degraded);
  expect(independent.a.frames).toBeGreaterThanOrEqual(0.4 * canary.report.sampleRate);
  expect(canary.report.frames).toBeGreaterThanOrEqual(0.4 * canary.report.sampleRate);
  expectLevelMatch(
    independent.nullDepth.depthDb,
    canary.report.depthDb,
    1e-9,
    "independently measured canary depth",
  );
}

test("prepared null gate passes identical pipelines, is not-applicable for different configurations, and raw publishes no validity", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "validity-mono-44100.wav", makePcm16Wav({
    sampleRate: 44100, channels: 1, seconds: 0.6,
  }));

  await configure(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
    policy: "codec-probe-only", canary: false,
  });
  await prepare(page);
  const raw = await downloadJson(page);
  expect(raw.schema).toBe("codec-abx-browser-diagnostic-v4");
  expect(raw.artifact.validity).toBeUndefined();
  expect(raw.validity).toBeNull();
  expect(raw.artifact.canary).toBeUndefined();
  expect(raw.canary).toBeNull();
  expect(raw.scientificStatus.nullGateEvaluated).toBe(false);
  expect(raw.scientificStatus.nullGateStatus).toBeNull();
  expect(raw.scientificStatus.canaryMaterialChecked).toBe(false);
  expect(raw.scientificStatus.canaryMaterialGenerated).toBe(false);
  expect(raw.scientificStatus.canaryAudioRetained).toBe(false);
  await expect(page.locator(".canary")).toHaveCount(0);

  await configure(page, {
    a: "noop_passthrough", b: "noop_passthrough", mode: "native",
    policy: "aligned-gain-matched-v1", canary: false,
  });
  await prepare(page);
  const identical = await downloadJson(page);
  const identicalValidity = identical.artifact.validity;
  expect(identicalValidity?.policy).toBe("delivered-validity-v2");
  if (identicalValidity?.policy !== "delivered-validity-v2") {
    throw new Error("test: identical artifact did not publish delivered-validity-v2");
  }
  expect(identicalValidity.nullGate).toMatchObject({
    policy: "identical-pipeline-null-v1",
    expectedIdentical: true,
    thresholdDb: -60,
    status: "passed",
  });
  expect(identicalValidity.nullGate.depthDb.status).toBe("negative-infinity");
  expect(identicalValidity.preparationGate.status).toBe("passed");
  expect(identicalValidity.preparationGate.classification).toBe(
    "same-polarity-periodic-ambiguous",
  );
  expect(identicalValidity.preparationGate.disclosure).toContain("no unique lag");
  expect(identical.scientificStatus.nullGateEvaluated).toBe(true);
  expect(identical.scientificStatus.nullGateStatus).toBe("passed");
  expect(identical.scientificStatus.listenerCalibrationRun).toBe(false);
  expect(identical.scientificStatus.scoringRun).toBe(false);
  expect(identical.scientificStatus.canaryGates).toBe(false);
  expect(identical.scientificStatus.canaryMaterialChecked).toBe(false);
  expect(identical.artifact.canary).toBeUndefined();
  await expect(page.locator(".canary")).toHaveCount(0);

  await configure(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native",
    policy: "aligned-gain-matched-v1", canary: false,
  });
  await prepare(page);
  const different = await downloadJson(page);
  expect(different.artifact.validity?.nullGate).toMatchObject({
    expectedIdentical: false,
    status: "not-applicable",
  });
  expect(different.scientificStatus.nullGateStatus).toBe("not-applicable");
  expect(JSON.stringify(different)).not.toContain("Infinity");
  expect(JSON.stringify(different)).not.toContain("NaN");

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("real WASM canary material matches the shared policy and independent measurement across layouts and rates", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const cases = [
    {
      name: "canary-mono-44100-rounded-cutoff.wav",
      bytes: makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 22197 / 44100 }),
      a: "noop_passthrough", b: "noop_passthrough", mode: "native",
      expectedRate: 44100, expectedChannels: 1, expectedFrames: 22197,
    },
    {
      name: "canary-antiphase-stereo-48000.wav",
      bytes: makePcm16Wav({
        sampleRate: 48000, channels: 2, seconds: 0.6, antiPhase: true, amplitude: 0.3,
      }),
      a: "noop_passthrough", b: "opus", bitrateB: 96, mode: "native",
      expectedRate: 48000, expectedChannels: 2,
    },
    {
      name: "canary-force48-stereo.wav",
      bytes: makePcm16Wav({ sampleRate: 44100, channels: 2, seconds: 0.5 }),
      a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "force_48k",
      expectedRate: 48000, expectedChannels: 2,
    },
    {
      name: "canary-mono-96000.wav",
      bytes: makePcm16Wav({ sampleRate: 96000, channels: 1, seconds: 0.6 }),
      a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "native",
      expectedRate: 96000, expectedChannels: 1,
    },
  ] as const;

  for (const entry of cases) {
    await chooseWav(page, entry.name, entry.bytes);
    const { artifact, exported } = await prepareCanary(page, {
      a: entry.a, b: entry.b, mode: entry.mode,
      ...("bitrateB" in entry ? { bitrateB: entry.bitrateB } : {}),
    });
    expect(artifact.request.canaryEnabled).toBe(true);
    if ("expectedFrames" in entry) {
      expect(artifact.a.delivered.frames).toBe(entry.expectedFrames);
    }
    const canary = artifact.canary;
    if (!canary?.audio) throw new Error(`test: ${entry.name} did not serve usable canary material`);
    expect(canary.report.status).toBe("usable");
    expect(canary.report.usable).toBe(true);
    expect(canary.report.policy).toBe("delivered-canary-v1");
    expect(canary.report.frequencyGrid).toBe("numpy-rfftfreq-v1");
    expect(canary.report.cutoffHz).toBe(3000);
    expect(canary.report.drive).toBe(10);
    expect(canary.report.clipLevel).toBe(0.45);
    expect(canary.report.sampleRate).toBe(entry.expectedRate);
    expect(canary.report.channels).toBe(entry.expectedChannels);
    expect(canary.report.frames).toBe(artifact.a.delivered.frames);
    expect(canary.audio.pristine).toMatchObject({
      sampleRate: entry.expectedRate,
      channels: entry.expectedChannels,
      frames: artifact.a.delivered.frames,
    });
    expect(canary.audio.degraded).toMatchObject({
      sampleRate: entry.expectedRate,
      channels: entry.expectedChannels,
      frames: artifact.a.delivered.frames,
    });
    expect(exported.canary).toEqual(canary);
    expect(exported.scientificStatus).toMatchObject({
      nullGateEvaluated: true,
      canaryMaterialChecked: true,
      canaryMaterialGenerated: true,
      canaryAudioRetained: true,
      canaryMaterialUsable: true,
      listenerCalibrationRun: false,
      listenerCalibrationTrial: "not-run",
      scoringRun: false,
      canaryGates: false,
      scoredAbxRun: false,
    });

    const finalA = await downloadWav(page, "a");
    await assertCanaryMaterialAgainstReference(page, artifact, finalA);
    await expect(page.locator(".canary")).toContainText("usable");
    await expect(page.locator(".canary")).toContainText("numpy-rfftfreq-v1");
    await expect(page.locator(".canary")).toContainText("Pristine WAV SHA-256");
    await expect(page.getByRole("button", { name: "Download canary WAV pristine" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Download canary WAV degraded" }))
      .toBeVisible();
    expect(JSON.stringify(exported)).not.toContain("Infinity");
    expect(JSON.stringify(exported)).not.toContain("NaN");
  }

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("the single readiness-check switch stays explicit and blocks manual raw diagnostics", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "canary-mode-switch.wav", makePcm16Wav({ seconds: 0.6 }));
  const checkbox = page.locator("#canary-enabled");
  const manualPrepare = page.getByRole("button", { name: "Prepare diagnostic artifacts" });

  // Default OFF; the switch is the one opt-in for both canary generation and
  // the listening plan, and it is not tied to the manual diagnostic policy.
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeEnabled();
  await configure(page, { policy: "aligned-gain-matched-v1" });
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  // Raw manual diagnostics cannot generate the readiness check. The switch is
  // never cleared silently; the conflict is disclosed and manual prepare is
  // blocked while Prepare test keeps its aligned request.
  await configure(page, { policy: "codec-probe-only" });
  await expect(checkbox).toBeChecked();
  await expect(page.getByText(/Manual raw preparation cannot generate the readiness check/))
    .toBeVisible();
  await expect(manualPrepare).toBeDisabled();
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeEnabled();

  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await expect(manualPrepare).toBeEnabled();

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("cancel and reset during the real canary stage terminate the worker and permit clean retry", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const tracker: { created: string[]; terminated: string[]; stages: string[] } = {
      created: [],
      terminated: [],
      stages: [],
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
              const data = (event as MessageEvent).data as { type?: string; stage?: string } |
                undefined;
              if (data?.type === "stage" && data.stage === "canary") {
                tracker.stages.push("canary");
              }
              if (typeof listener === "function") listener.call(this, event);
              else listener.handleEvent(event);
              const action = (window as unknown as { __canaryAction?: string | null })
                .__canaryAction;
              if (data?.type === "stage" && data.stage === "canary" &&
                  (action === "cancel" || action === "reset")) {
                (window as unknown as { __canaryAction?: string | null }).__canaryAction = null;
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
    (window as unknown as { __canaryWorkerTracker: typeof tracker })
      .__canaryWorkerTracker = tracker;
  });
  const errors = collectPageErrors(page);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 3 });
  const heavy = makePcm16Wav({ sampleRate: 96000, channels: 2, seconds: 4 });
  const small = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 0.6 });
  await chooseWav(page, "canary-cancel-heavy.wav", heavy);
  await configure(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native",
    policy: "aligned-gain-matched-v1", canary: true,
  });

  await page.evaluate(() => {
    (window as unknown as { __canaryAction?: string | null }).__canaryAction = "cancel";
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toContainText("Cancelled.", { timeout: 150_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);

  const afterCancel = await page.evaluate(() => (
    window as unknown as {
      __canaryWorkerTracker: { created: string[]; terminated: string[]; stages: string[] };
    }
  ).__canaryWorkerTracker);
  expect(afterCancel.stages).toContain("canary");
  expect(afterCancel.terminated.some((name) => name.includes("codec-abx-measurements")))
    .toBe(true);

  await page.evaluate(() => {
    (window as unknown as { __canaryAction?: string | null }).__canaryAction = "reset";
  });
  await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
  await expect(page.locator(".run-status")).toBeEmpty({ timeout: 150_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);
  await expect(page.locator(".file-summary")).toHaveCount(0);
  await expect(page.locator("#source-file")).toHaveValue("");
  await expect(page.locator("#canary-enabled")).toBeChecked();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  await chooseWav(page, "canary-after-reset.wav", small);
  await prepare(page);
  const retry = (await downloadJson(page)).artifact;
  expect(retry.canary?.report.usable).toBe(true);
  expect(retry.canary?.audio).not.toBeNull();

  const finalTracker = await page.evaluate(() => (
    window as unknown as {
      __canaryWorkerTracker: { created: string[]; terminated: string[]; stages: string[] };
    }
  ).__canaryWorkerTracker);
  const created = finalTracker.created.filter((name) =>
    name.includes("codec-abx-measurements"));
  const terminated = finalTracker.terminated.filter((name) =>
    name.includes("codec-abx-measurements"));
  expect(created.length).toBeGreaterThanOrEqual(3);
  expect(terminated.length).toBe(created.length);
  expect(finalTracker.stages.length).toBeGreaterThanOrEqual(3);

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});

test("tampered null/canary decisions and canary WAV layouts reject without publication and retry cleanly", async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const state = { tamper: null as string | null, created: 0, terminated: 0 };
    Object.assign(window, { __canaryCorruption: state });
    class CorruptingWorker extends OriginalWorker {
      private readonly numerical: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.numerical = options?.name === "codec-abx-measurements";
        if (!this.numerical) return;
        state.created += 1;
        super.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as {
            type: string;
            b?: ArrayBuffer;
            validity?: { nullGate: { status: string; reason: string } };
            canary?: {
              report: { frames: number; usable: boolean; status: string };
              pristine?: ArrayBuffer | null;
            };
          };
          if (data.type !== "prepare-result" || state.tamper === null) return;
          const mode = state.tamper;
          state.tamper = null;
          if (mode === "null") {
            if (!data.validity) throw new Error("test: missing validity to tamper");
            data.validity.nullGate.status = "failed";
            data.validity.nullGate.reason = "tampered null decision";
          } else if (mode === "delivered-pcm") {
            if (!data.b) throw new Error("test: missing delivered B to tamper");
            // Canonical policy WAV: change a sample while keeping every header
            // and reported measurement/decision intact. Layout checks alone
            // cannot catch this stale measurement.
            const view = new DataView(data.b);
            view.setInt16(44, (view.getInt16(44, true) + 8000) % 32767, true);
          } else if (mode === "canary-decision") {
            if (!data.canary) throw new Error("test: missing canary to tamper");
            data.canary.report.frames += 1;
          } else if (mode === "canary-status") {
            if (!data.canary) throw new Error("test: missing canary status to tamper");
            data.canary.report.usable = false;
            data.canary.report.status = "not-usable";
          } else if (mode === "canary-missing") {
            delete data.canary;
          } else if (mode === "canary-wav") {
            if (!data.canary?.pristine) throw new Error("test: missing canary WAV to tamper");
            const bytes = new Uint8Array(data.canary.pristine);
            const view = new DataView(bytes.buffer);
            view.setUint16(22, 2, true);
          }
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
  await chooseWav(page, "canary-corrupt.wav", makePcm16Wav({ channels: 1, seconds: 0.6 }));
  await configure(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 128, mode: "native",
    policy: "aligned-gain-matched-v1", canary: true,
  });
  for (const mode of ["null", "delivered-pcm", "canary-decision", "canary-status", "canary-missing", "canary-wav"]) {
    await page.evaluate((selected) => {
      const state = (window as unknown as {
        __canaryCorruption: { tamper: string | null };
      }).__canaryCorruption;
      state.tamper = selected;
    }, mode);
    await page.getByRole("button", { name: "Prepare diagnostic artifacts" }).click();
    await expect(page.getByRole("alert").first())
      .toContainText(/Preparation worker returned|Preparation worker omitted|Canary report|WAV/i);
    await expect(page.locator(".evidence-audio")).toHaveCount(0);
    expect(await page.evaluate(() => {
      const state = (window as unknown as {
        __canaryCorruption: { created: number; terminated: number };
      }).__canaryCorruption;
      return state.created === state.terminated;
    })).toBe(true);
  }

  await prepare(page);
  const exported = await downloadJson(page);
  expect(exported.artifact.validity?.nullGate.status).toBe("not-applicable");
  expect(exported.artifact.canary?.report.usable).toBe(true);
  expect(exported.artifact.canary?.audio).not.toBeNull();
  expect(await page.evaluate(() => {
    const state = (window as unknown as {
      __canaryCorruption: { created: number; terminated: number };
    }).__canaryCorruption;
    return { created: state.created, terminated: state.terminated };
  })).toEqual({ created: 7, terminated: 7 });

  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});
