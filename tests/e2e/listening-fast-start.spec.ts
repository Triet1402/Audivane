import { clickRunAction } from "../ui/run-actions.js";
import { expect, test, type Page } from "@playwright/test";

import type { PreparedArtifact } from "@codec-abx/contracts";

import {
  chooseWav,
  collectPageErrors,
  configure,
  downloadJson,
  expectNoRemoteOrUpload,
  guardNetwork,
  makePcm16Wav,
  type NetworkGuard,
} from "./fixtures.js";

/**
 * Test-only Worker instrumentation. It counts real experiment Workers and can
 * corrupt one bind request to exercise failure without changing production.
 */
function installFastStartInstrumentation(): void {
  const NativeWorker = window.Worker;
  const state = {
    corruptNextBind: false,
    experimentWorkers: 0,
    active: 0,
    terminated: 0,
  };

  class InstrumentedExperimentWorker {
    readonly inner: Worker;

    constructor(inner: Worker) {
      this.inner = inner;
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (state.corruptNextBind && message !== null && typeof message === "object") {
        const entry = message as { operation?: unknown; a?: unknown };
        if (entry.operation === "bindPrepared" && entry.a instanceof ArrayBuffer) {
          state.corruptNextBind = false;
          const bytes = new Uint8Array(entry.a);
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        }
      }
      if (transfer) this.inner.postMessage(message, transfer);
      else this.inner.postMessage(message);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.inner.addEventListener(type, listener as EventListener);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.inner.removeEventListener(type, listener as EventListener);
    }

    terminate(): void {
      state.terminated += 1;
      state.active = Math.max(0, state.active - 1);
      this.inner.terminate();
    }
  }

  // Only the experiment Worker is wrapped. Preparation and measurement
  // Workers stay native so the capability probe and WASM codecs are untouched.
  const WrappedWorker = function (
    this: unknown,
    url: string | URL,
    options?: WorkerOptions,
  ): Worker {
    const worker = new NativeWorker(url, options);
    if (options?.name === "codec-abx-experiment") {
      state.experimentWorkers += 1;
      state.active += 1;
      return new InstrumentedExperimentWorker(worker) as unknown as Worker;
    }
    return worker;
  } as unknown as typeof Worker;
  WrappedWorker.prototype = NativeWorker.prototype;
  window.Worker = WrappedWorker;

  (window as typeof window & {
    __fastStart?: Record<string, unknown>;
  }).__fastStart = {
    experimentWorkers: () => state.experimentWorkers,
    activeExperimentWorkers: () => state.active,
    terminatedExperimentWorkers: () => state.terminated,
    armCorruptNextBind: () => { state.corruptNextBind = true; },
  };
}

async function workerCount(page: Page, method: string): Promise<number> {
  return await page.evaluate((name) => {
    const api = (window as typeof window & {
      __fastStart?: Record<string, () => number>;
    }).__fastStart;
    return api?.[name]?.() ?? -1;
  }, method);
}

async function openFastStart(page: Page, origin: string): Promise<NetworkGuard> {
  const guard = await guardNetwork(page, origin);
  await page.goto(origin);
  await expect(page.locator("#capabilities-heading")).toBeVisible();
  await expect(page.locator("#codec-a option[value=opus]")).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeVisible();
  return guard;
}

function clockSeconds(text: string): number | null {
  const parts = text.split(":").map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    return parts[0]! * 60 + parts[1]!;
  }
  const seconds = Number(text);
  return Number.isFinite(seconds) ? seconds : null;
}

async function playbackDurationSeconds(page: Page): Promise<number> {
  const readout = page.locator(".time-readout");
  const exact = await readout.getAttribute("data-duration-seconds");
  if (exact !== null && Number.isFinite(Number(exact))) return Number(exact);
  const text = await readout.innerText();
  const duration = text.split("/")[1]?.trim() ?? "";
  const value = clockSeconds(duration);
  if (value === null) throw new Error(`test: unreadable time readout: ${text}`);
  return value;
}

async function armCorruptNextBind(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as typeof window & {
      __fastStart?: { armCorruptNextBind: () => void };
    }).__fastStart;
    api?.armCorruptNextBind();
  });
}

async function startPrimaryTest(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
}

for (const appearance of [
  { theme: "light", width: 320 },
] as const) {
  test(`${appearance.theme} ${appearance.width}px keeps playback in place without page overflow`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: appearance.width, height: 900 });
    await page.emulateMedia({ colorScheme: appearance.theme });
    await openFastStart(page, new URL(baseURL!).origin);
    const filename = `${"recording".repeat(16)}.wav`;
    await chooseWav(page, filename, makePcm16Wav({ seconds: 0.6 }));
    await startPrimaryTest(page);
    await expect(page.locator("#listen-view")).toBeVisible();
    const stage = page.locator(".listening-stage");
    const documentTop = async () => (await stage.boundingBox())!.y + await page.evaluate(() => window.scrollY);
    const before = await documentTop();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 60_000 });
    expect(Math.abs(await documentTop() - before)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(appearance.width);
  });
}

test("one Prepare test click prepares, binds and stages a paused full-length trial", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installFastStartInstrumentation);
  const guard = await openFastStart(page, new URL(baseURL!).origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "fast-start-full-12s.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    seconds: 12,
    amplitude: 0.22,
  }));
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 96 });

  // Defaults: the single readiness-check opt-in is OFF, and no experiment
  // Worker exists before the explicit primary action.
  await expect(page.locator("#canary-enabled")).not.toBeChecked();
  expect(await workerCount(page, "experimentWorkers")).toBe(0);
  expect(await workerCount(page, "activeExperimentWorkers")).toBe(0);

  await startPrimaryTest(page);
  const stage = page.locator(".listening-stage");
  await expect(stage).toBeVisible();
  const stageBefore = (await stage.boundingBox())!.y + await page.evaluate(() => window.scrollY);

  const trial = page.locator(".listening-trial");
  await expect(trial).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("heading", { name: "Trial 1 of 8", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await expect(page.locator(".stage-status")).toContainText("Paused");
  const stageAfter = (await stage.boundingBox())!.y + await page.evaluate(() => window.scrollY);
  expect(Math.abs(stageAfter - stageBefore)).toBeLessThanOrEqual(2);

  expect(await workerCount(page, "experimentWorkers")).toBe(1);
  expect(await workerCount(page, "activeExperimentWorkers")).toBe(1);

  // The scored trial keeps the full prepared track, not a 10 s prefix.
  expect(await playbackDurationSeconds(page)).toBeGreaterThan(10);

  await page.getByRole("button", { name: "Evidence", exact: true }).click();

  const diagnostic = await downloadJson(page);
  const artifact = diagnostic.artifact as PreparedArtifact;
  expect(artifact.request.canaryEnabled).not.toBe(true);
  expect(diagnostic.canary ?? null).toBeNull();
  expect(artifact.validity?.policy).toBe("delivered-validity-v2");
  expect(artifact.preparation?.policy).toBe("aligned-gain-matched-v1");

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("cancelling preparation stages nothing and leaves the primary action retryable", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installFastStartInstrumentation);
  const guard = await openFastStart(page, new URL(baseURL!).origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "fast-start-cancel-120s.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 2,
    seconds: 120,
    amplitude: 0.18,
  }));
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 128 });

  await startPrimaryTest(page);
  const cancel = page.getByRole("button", { name: "Cancel preparation", exact: true });
  await expect(cancel).toBeVisible({ timeout: 30_000 });
  await cancel.click();

  // Cancellation must finish before the primary action becomes retryable.
  await expect(cancel).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(".listening-trial")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  expect(await workerCount(page, "activeExperimentWorkers")).toBe(0);
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Prepare test", exact: true }))
    .toBeEnabled({ timeout: 60_000 });
  await expect(page.locator(".evidence-audio")).toHaveCount(0);

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("a failed bind stages nothing and the explicit retry binds the same prepared pair", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installFastStartInstrumentation);
  const guard = await openFastStart(page, new URL(baseURL!).origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "fast-start-bind-failure.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    seconds: 0.8,
  }));
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 64 });

  await armCorruptNextBind(page);
  await startPrimaryTest(page);

  const retry = page.getByRole("button", { name: "Retry prepare test", exact: true });
  await expect(retry).toBeVisible({ timeout: 180_000 });
  await expect(page.locator(".listening-trial")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();

  await retry.click();
  await expect(page.locator(".listening-trial")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("source and codec changes keep the listening stage in place and start no Worker", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installFastStartInstrumentation);
  const guard = await openFastStart(page, new URL(baseURL!).origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "fast-start-layout-a.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    seconds: 0.6,
  }));
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 96 });

  await page.getByRole("button", { name: "Listen", exact: true }).click();
  const stage = page.locator(".listening-stage");
  await expect(stage).toBeVisible();
  const documentTop = async () => {
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    return box!.y + await page.evaluate(() => window.scrollY);
  };
  const before = await documentTop();

  await page.locator(".listening-test-plan > summary").click();
  await page.getByLabel("Planned scored trials N (1–1000)").fill("9");
  expect(Math.abs(await documentTop() - before)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await chooseWav(page, "fast-start-layout-b.wav", makePcm16Wav({
    sampleRate: 44_100,
    channels: 1,
    seconds: 0.5,
  }));
  expect(Math.abs(await documentTop() - before)).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await page.selectOption("#bitrate-b", "64");
  await expect(page.locator("#bitrate-b")).toHaveValue("64");
  await page.locator("#codec-a").focus();
  await page.selectOption("#codec-a", "opus");
  await expect(page.locator("#codec-a")).toHaveValue("opus");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("codec-a");
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  expect(Math.abs(await documentTop() - before)).toBeLessThanOrEqual(2);

  expect(await workerCount(page, "experimentWorkers")).toBe(0);
  expect(await workerCount(page, "activeExperimentWorkers")).toBe(0);

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});

test("the single readiness-check opt-in adds a first-10 s calibration trial and keeps full A/B", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installFastStartInstrumentation);
  const guard = await openFastStart(page, new URL(baseURL!).origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "fast-start-calibration-12s.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    seconds: 12,
    amplitude: 0.22,
  }));
  await configure(page, { a: "noop_passthrough", b: "opus", bitrateB: 96 });

  const optIn = page.locator("#canary-enabled");
  await expect(optIn).not.toBeChecked();
  await optIn.check();
  await expect(optIn).toBeChecked();

  await startPrimaryTest(page);

  const trial = page.locator(".listening-trial");
  await expect(trial).toBeVisible({ timeout: 180_000 });
  await expect(page.locator("#listen-view")).toContainText(/calibration/i);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();

  // Calibration material is the FIRST min(10 s, prepared Side A) prefix.
  const calibrationDuration = await playbackDurationSeconds(page);
  expect(calibrationDuration).toBeGreaterThan(9.5);
  expect(calibrationDuration).toBeLessThanOrEqual(10.5);

  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  const diagnostic = await downloadJson(page);
  const artifact = diagnostic.artifact as PreparedArtifact;
  expect(artifact.request.canaryEnabled).toBe(true);
  expect(artifact.canary?.report.usable).toBe(true);
  if (artifact.canary) {
    expect(artifact.canary.report.frames / artifact.canary.report.sampleRate)
      .toBeLessThanOrEqual(10.001);
  }

  await clickRunAction(page, "Close listening run");
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("#source-file")).toBeEnabled({ timeout: 60_000 });

  expectNoRemoteOrUpload(guard);
  expect(pageErrors).toEqual([]);
});
