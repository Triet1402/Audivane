import { clickRunAction } from "../ui/run-actions.js";
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

test("an incomplete desktop bridge refuses startup without selecting the browser engine", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "codecAbxDesktop", { value: { version: 2 } });
    const scope = window as typeof window & { __startupWorkers?: number };
    scope.__startupWorkers = 0;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        scope.__startupWorkers = (scope.__startupWorkers ?? 0) + 1;
        super(url, options);
      }
    };
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Desktop unavailable" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("no browser fallback was started");
  await expect(page.locator("#source-file")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __startupWorkers: number }).__startupWorkers)).toBe(0);
  expect(await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("ffmpeg-core")).length)).toBe(0);
  expect(errors).toEqual([]);
});

import {
  chooseWav,
  collectPageErrors,
  configure,
  downloadJson,
  expectNoRemoteOrUpload,
  guardNetwork,
  makePcm16Wav,
  openLab,
  prepare,
} from "./fixtures.js";

/**
 * Test-only instrumentation around the native Worker constructor. It observes
 * the real module Worker bytes for the perfect-listener simulation, and can
 * corrupt or hold one read reply to exercise atomic load failure and reset.
 * Nothing is added to the production bundle or a production global.
 */
function installListeningInstrumentation(): void {
  const NativeWorker = window.Worker;
  const globalWindow = window as typeof window & {
    __codecAbxListeningTest?: Record<string, unknown>;
  };
  const requests = new Map<string, { operation?: string; token?: string; label?: string }>();
  const reads: { token: string; label: string; bytes: Uint8Array }[] = [];
  const responseJson: string[] = [];
  const held: unknown[] = [];
  const state = {
    corruptNextBind: false,
    corruptNextRead: false,
    holdNextRead: false,
    unusableNextCanary: false,
  };
  let created = 0;
  let experimentWorkers = 0;
  let terminated = 0;
  let active = 0;
  let currentWorker: InstrumentedExperimentWorker | null = null;
  let mediaPauses = 0;
  const nativePause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement): void {
    mediaPauses += 1;
    nativePause.call(this);
  };

  type Listener = (event: unknown) => void;
  class InstrumentedExperimentWorker {
    readonly inner: Worker;
    readonly messageListeners = new Set<Listener>();
    readonly errorListeners = new Set<Listener>();

    constructor(url: string | URL, options?: WorkerOptions) {
      this.inner = new NativeWorker(url, options);
      this.inner.addEventListener("message", (event) => this.onMessage(event));
      this.inner.addEventListener("error", (event) => {
        for (const listener of [...this.errorListeners]) listener(event);
      });
      this.inner.addEventListener("messageerror", (event) => {
        for (const listener of [...this.errorListeners]) listener(event);
      });
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (message !== null && typeof message === "object") {
        const entry = message as { requestId?: unknown; operation?: unknown; token?: unknown; label?: unknown; a?: unknown };
        if (state.corruptNextBind && entry.operation === "bindPrepared" && entry.a instanceof ArrayBuffer) {
          state.corruptNextBind = false;
          const bytes = new Uint8Array(entry.a);
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        }
        if (typeof entry.requestId === "string") {
          requests.set(entry.requestId, {
            ...(typeof entry.operation === "string" ? { operation: entry.operation } : {}),
            ...(typeof entry.token === "string" ? { token: entry.token } : {}),
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
          });
        }
      }
      if (transfer) this.inner.postMessage(message, transfer);
      else this.inner.postMessage(message);
    }

    addEventListener(type: string, listener: Listener): void {
      if (type === "message") this.messageListeners.add(listener);
      else if (type === "error" || type === "messageerror") this.errorListeners.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      if (type === "message") this.messageListeners.delete(listener);
      else if (type === "error" || type === "messageerror") this.errorListeners.delete(listener);
    }

    terminate(): void {
      terminated += 1;
      active = Math.max(0, active - 1);
      this.inner.terminate();
    }

    dispatch(event: unknown): void {
      for (const listener of [...this.messageListeners]) listener(event);
    }

    onMessage(event: MessageEvent): void {
      const data = event.data as {
        operation?: unknown;
        ok?: unknown;
        requestId?: unknown;
        result?: unknown;
      } | null;
      if (data && typeof data === "object") {
        try {
          responseJson.push(JSON.stringify(data, (_key, value) =>
            value instanceof ArrayBuffer ? "<binary>" : value));
        } catch {
          responseJson.push("<unserializable>");
        }
      }
      if (data && data.ok === true && data.operation === "readAudio") {
        const request = typeof data.requestId === "string" ? requests.get(data.requestId) : undefined;
        if (request && typeof request.token === "string" && typeof request.label === "string" &&
            data.result instanceof ArrayBuffer) {
          let bytes = new Uint8Array(data.result.slice(0));
          let outgoing: unknown = data;
          if (state.corruptNextRead) {
            state.corruptNextRead = false;
            bytes = bytes.slice();
            bytes[0] = 0;
            outgoing = { ...data, result: bytes.buffer };
          }
          reads.push({ token: request.token, label: request.label, bytes: bytes.slice(0) });
          if (state.holdNextRead) {
            state.holdNextRead = false;
            held.push(outgoing);
            return;
          }
          this.dispatch({ data: outgoing });
          return;
        }
      }
      this.dispatch(event);
    }
  }

  /**
   * Test-only fault at the real measurement-worker boundary: turn the next
   * generated canary report into an internally consistent, explicitly unusable
   * one and drop its served bytes. This exercises fail-closed calibration
   * without weakening the primary action's canary opt-in.
   */
  class InstrumentedMeasurementWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", (event: MessageEvent) => {
        if (!state.unusableNextCanary) return;
        const data = event.data as {
          type?: unknown;
          canary?: {
            report?: Record<string, unknown>;
            pristine?: unknown;
            degraded?: unknown;
          };
        } | null;
        if (!data || typeof data !== "object" || data.type !== "prepare-result" ||
            !data.canary?.report) {
          return;
        }
        state.unusableNextCanary = false;
        data.canary.report.depthDb = { status: "finite", value: -60, reason: null };
        data.canary.report.status = "not-usable";
        data.canary.report.usable = false;
        data.canary.report.minimumResidualDb = -30;
        data.canary.report.reason =
          "measured material differs by only -60.00 dB residual, at or below the -30.0 dB floor: too subtle to gate a run";
        data.canary.pristine = null;
        data.canary.degraded = null;
      });
    }
  }

  const WrappedWorker = function (
    this: unknown,
    url: string | URL,
    options?: WorkerOptions,
  ): Worker {
    created += 1;
    if (options?.name === "codec-abx-experiment") {
      experimentWorkers += 1;
      active += 1;
      const worker = new InstrumentedExperimentWorker(url, options);
      currentWorker = worker;
      return worker as unknown as Worker;
    }
    if (options?.name === "codec-abx-measurements") {
      return new InstrumentedMeasurementWorker(url, options) as unknown as Worker;
    }
    const worker = new NativeWorker(url, options);
    return worker;
  } as unknown as typeof Worker;
  WrappedWorker.prototype = NativeWorker.prototype;
  window.Worker = WrappedWorker;

  globalWindow.__codecAbxListeningTest = {
    armCorruptNextBind: (): void => { state.corruptNextBind = true; },
    armUnusableNextCanary: (): void => { state.unusableNextCanary = true; },
    matchingLabel(): { token: string; label: "A" | "B"; aEqualsB: boolean } | null {
      const latest = reads.at(-1);
      if (!latest) return null;
      const token = latest.token;
      const byLabel = new Map<string, Uint8Array>();
      for (const read of reads) {
        if (read.token === token) byLabel.set(read.label, read.bytes);
      }
      const a = byLabel.get("A");
      const b = byLabel.get("B");
      const x = byLabel.get("X");
      if (!a || !b || !x) return null;
      const equal = (left: Uint8Array, right: Uint8Array): boolean => {
        if (left.byteLength !== right.byteLength) return false;
        for (let index = 0; index < left.byteLength; index += 1) {
          if (left[index] !== right[index]) return false;
        }
        return true;
      };
      const aEqualsB = equal(a, b);
      if (aEqualsB) return { token, label: "A", aEqualsB };
      if (equal(x, a)) return { token, label: "A", aEqualsB };
      if (equal(x, b)) return { token, label: "B", aEqualsB };
      return { token, label: "A", aEqualsB: true };
    },
    readCount: (): number => reads.length,
    lastReadToken: (): string | null => reads.at(-1)?.token ?? null,
    heldCount: (): number => held.length,
    releaseHeld: (): void => {
      for (const data of held.splice(0)) {
        currentWorker?.dispatch({ data });
      }
    },
    armCorruptNextRead: (): void => {
      state.corruptNextRead = true;
    },
    armHoldNextRead: (): void => {
      state.holdNextRead = true;
    },
    activeExperimentWorkers: (): number => active,
    experimentWorkersCreated: (): number => experimentWorkers,
    workersCreated: (): number => created,
    terminatedWorkers: (): number => terminated,
    mediaPauses: (): number => mediaPauses,
    secretLeaks: (): string[] =>
      responseJson.filter((json) => /"secretHex":"[0-9a-f]{2,}/i.test(json)),
    readTokenSummary: (): { token: string; labels: string[] } | null => {
      const latest = reads.at(-1);
      if (!latest) return null;
      return {
        token: latest.token,
        labels: [...new Set(reads.filter((read) => read.token === latest.token)
          .map((read) => read.label))],
      };
    },
  };
}

async function matching(page: Page): Promise<{ token: string; label: "A" | "B"; aEqualsB: boolean } | null> {
  return await page.evaluate(() => {
    const api = (window as typeof window & {
      __codecAbxListeningTest?: {
        matchingLabel(): { token: string; label: "A" | "B"; aEqualsB: boolean } | null;
      };
    }).__codecAbxListeningTest;
    return api?.matchingLabel() ?? null;
  });
}

async function testApi(page: Page, method: string, ...args: unknown[]): Promise<unknown> {
  return await page.evaluate(({ method, args }) => {
    const api = (window as typeof window & Record<string, unknown>).__codecAbxListeningTest as
      | Record<string, (...values: unknown[]) => unknown>
      | undefined;
    return api?.[method]?.(...args) ?? null;
  }, { method, args });
}

async function currentToken(page: Page): Promise<string | null> {
  const trial = page.locator(".listening-trial");
  if (await trial.count() === 0) return null;
  return await trial.first().getAttribute("data-token");
}

async function answerMatching(page: Page, wrong = false): Promise<"A" | "B"> {
  const trial = page.locator(".listening-trial");
  const token = await trial.getAttribute("data-token");
  expect(token, "trial token").not.toBeNull();
  await expect.poll(async () => (await matching(page))?.token ?? null).toBe(token);
  const match = await matching(page);
  expect(match?.aEqualsB, "test fixture A/B bytes must differ").toBe(false);
  const label = wrong ? (match?.label === "A" ? "B" : "A") : match?.label;
  if (!label) throw new Error("test: no byte-consistent display label");
  const monitorX = page.getByRole("button", { name: "Monitor playback label X" });
  if (await monitorX.isEnabled()) await monitorX.click();
  const button = page.getByRole("button", { name: `Answer ${label}`, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  return label;
}

async function downloadListeningExport(page: Page): Promise<Record<string, unknown>> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    clickRunAction(page, "Download results"),
  ]);
  expect(download.suggestedFilename()).toMatch(/^codec-abx-listening-.*\.json$/);
  const file = await download.path();
  if (!file) throw new Error("test: listening export had no path");
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function showView(page: Page, name: "Setup" | "Listen" | "Evidence"): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(`#${name.toLowerCase()}-view`)).toBeVisible();
}

async function waitForReadyTrial(page: Page, previousToken?: string): Promise<string> {
  const trial = page.locator(".listening-trial");
  await expect(trial).toBeVisible({ timeout: 60_000 });
  if (previousToken) {
    await expect.poll(async () => await currentToken(page), { timeout: 60_000 })
      .not.toBe(previousToken);
  }
  // A carried previous trial starts with no A/B/X selected. Choosing a label is
  // explicit and is what enables answers for the new token.
  const monitorX = page.getByRole("button", { name: "Monitor playback label X" });
  await expect(monitorX).toBeEnabled({ timeout: 60_000 });
  await monitorX.click();
  const token = await currentToken(page);
  if (!token) throw new Error("test: trial token missing");
  await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  return token;
}

test("fixed and blind perfect-listener runs freeze the plan, stay paused first, reconcile bytes, and export honestly", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(installListeningInstrumentation);
  const guard = await openLab(page, origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "listening-canary-source.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 2,
    seconds: 0.7,
    amplitude: 0.25,
  }));
  await configure(page, {
    a: "noop_passthrough",
    b: "opus",
    bitrateB: 96,
    mode: "native",
    policy: "aligned-gain-matched-v1",
    canary: true,
  });
  await prepare(page);

  // Start a real diagnostic HTML audio output, then prove the listening start
  // pauses it (not merely unmounts/revokes) and removes the competing path.
  await page.getByRole("button", { name: "Preview A" }).click();
  await expect(page.locator("audio")).toHaveCount(1);
  const diagnosticPlaying = await page.locator("audio").first().evaluate(async (element) => {
    const media = element as HTMLAudioElement;
    media.muted = true;
    try {
      await media.play();
      return !media.paused && !media.ended;
    } catch {
      return false;
    }
  });
  expect(diagnosticPlaying, "diagnostic HTML audio should start before listening").toBe(true);
  const pausesBeforeListening = Number(await testApi(page, "mediaPauses"));

  // --- Plan + bind: default N=8, alpha=.05, blind_random; the single
  // readiness-check switch is explicitly ON for this calibrated run. ---
  await expect(page.getByLabel("Planned scored trials N (1–1000)")).toHaveValue("8");
  await expect(page.getByLabel("Alpha (strict p < alpha)")).toHaveValue("0.05");
  await expect(page.getByLabel("Label mode", { exact: true })).toHaveValue("blind_random");
  await expect(page.locator("#canary-enabled")).toBeChecked();
  await page.getByLabel("Planned scored trials N (1–1000)").fill("8");
  await page.getByLabel("Label mode", { exact: true }).selectOption("fixed");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await expect(page.locator(".listening-trial")).toBeVisible({
    timeout: 120_000,
  });
  await showView(page, "Evidence");
  await expect(page.locator(".evidence-metrics")).toContainText("p-value");
  await expect(page.locator(".run-record")).toContainText("Required correct");
  await expect(page.locator(".run-record")).toContainText("Readiness check");
  await expect(page.getByRole("button", { name: "Preview A" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Clear prepared audio" })).toBeDisabled();
  await expect(page.locator(".diagnostic-audio")).toHaveCount(0);
  await showView(page, "Listen");
  // Parent diagnostic controls are disabled and guarded while the artifact is held.
  await expect(page.locator("audio")).toHaveCount(0);
  expect(Number(await testApi(page, "mediaPauses"))).toBeGreaterThan(pausesBeforeListening);
  await expect(page.locator("#source-file")).toBeDisabled();
  await showView(page, "Setup");
  await expect(page.getByRole("button", { name: "Prepare diagnostic artifacts" })).toBeDisabled();
  await expect(page.locator("#preparation-policy")).toBeDisabled();
  await showView(page, "Listen");

  const calibrationToken = await waitForReadyTrial(page);
  await expect(page.locator(".listening-trial")).toHaveAttribute("data-kind", "calibration");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await expect(page.locator(".stage-status")).toContainText("Paused");

  // Play controls: gesture play, pause, select, seek and loop.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Monitor playback label B" }).click();
  await expect(page.getByRole("button", { name: "Monitor playback label B" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Enable loop", exact: true }).click();
  await page.getByLabel("Loop start (s)").fill("0.1");
  await page.getByLabel("Loop end (s)").fill("0.4");
  await page.getByRole("button", { name: "Apply loop range", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable loop", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const position = page.getByLabel("Shared timeline position");
  await position.evaluate((element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "0.2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(position).toHaveValue("0.2");

  const calibrationMatch = await matching(page);
  expect(calibrationMatch?.token).toBe(calibrationToken);
  expect(calibrationMatch?.aEqualsB).toBe(false);
  await answerMatching(page);
  await expect(page.locator(".answer-status")).toHaveText(/^(Correct|Incorrect)$/);
  await expect(page.getByText(/Calibration passed/)).toBeVisible();

  // Scored 1: the run auto-advances after an accepted answer. The user paused
  // before calibration submission, so the staged trial must not autoplay.
  let previousScoredToken = await waitForReadyTrial(page, calibrationToken);
  await expect(page.locator(".listening-trial")).toHaveAttribute("data-kind", "scored");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await answerMatching(page);

  // Export while running is redacted; no secret or pending/future rows.
  const runningExport = await downloadListeningExport(page);
  expect(runningExport.schema).toBe("codec-abx-browser-listening-v1");
  const runningExperiment = runningExport.experiment as {
    reveal: { secretHex: string | null; redacted: boolean; xSequence: string[] };
    trials: { token: string }[];
    snapshot: { lifecycle: string; pendingTrial: { token: string } | null };
  };
  expect(runningExperiment.reveal.redacted).toBe(true);
  expect(runningExperiment.reveal.secretHex).toBeNull();
  expect(runningExperiment.snapshot.lifecycle).toBe("running");
  expect(runningExperiment.reveal.xSequence.length).toBe(runningExperiment.trials.length);
  expect(await testApi(page, "secretLeaks")).toEqual([]);

  // Complete the remaining scored trials. Intent restored after auto-advance is
  // visible through the Pause button being enabled before the next answer.
  for (let index = 2; index <= 8; index += 1) {
    previousScoredToken = await waitForReadyTrial(page, previousScoredToken);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    await answerMatching(page);
  }
  await expect(page.locator('.run-results[data-lifecycle="completed"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Next trial" })).toHaveCount(0);
  await showView(page, "Evidence");
  await expect(page.locator(".evidence-metrics")).toContainText("Accuracy");
  await expect(page.locator(".evidence-metrics")).toContainText("100%");

  const completedExport = await downloadListeningExport(page);
  const completedExperiment = completedExport.experiment as {
    reveal: { secretHex: string | null; redacted: boolean; verifiable: boolean };
    snapshot: { lifecycle: string; statistics: { isFinal: boolean; significantVerdict: boolean } };
  };
  expect(completedExperiment.reveal.redacted).toBe(false);
  expect(completedExperiment.reveal.secretHex).toMatch(/^[0-9a-f]{64}$/);
  expect(completedExperiment.reveal.verifiable).toBe(true);
  expect(completedExperiment.snapshot.lifecycle).toBe("completed");
  expect(completedExperiment.snapshot.statistics.isFinal).toBe(true);
  expect(completedExperiment.snapshot.statistics.significantVerdict).toBe(true);

  // --- Close the finished run to edit the plan; reuse the prepared pair. ---
  await showView(page, "Listen");
  await clickRunAction(page, "Close listening run");
  await showView(page, "Setup");
  await page.getByLabel("Planned scored trials N (1–1000)").fill("1");
  await page.getByLabel("Label mode", { exact: true }).selectOption("blind_random");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await waitForReadyTrial(page);
  await showView(page, "Evidence");
  await expect(page.locator(".run-record")).toContainText("Randomized");
  await expect(page.locator(".run-record")).toContainText("Required correct");
  await showView(page, "Listen");
  const blindCalibrationToken = await waitForReadyTrial(page);
  await answerMatching(page);
  await expect(page.getByText(/Calibration passed/)).toBeVisible();
  await waitForReadyTrial(page, blindCalibrationToken);
  await answerMatching(page);
  await expect(page.locator('.run-results[data-lifecycle="completed"]')).toBeVisible();

  // --- Seal a partially answered run: auditable, terminal, never a final result. ---
  await clickRunAction(page, "Close listening run");
  await showView(page, "Setup");
  await page.getByLabel("Planned scored trials N (1–1000)").fill("2");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await waitForReadyTrial(page);
  await waitForReadyTrial(page);
  await answerMatching(page);
  await expect(page.getByText(/Calibration passed/)).toBeVisible();
  await page.getByRole("button", { name: "End test", exact: true }).click();
  await expect(page.locator(".run-record h2")).toContainText("Test ended early", {
    timeout: 60_000,
  });
  await showView(page, "Listen");
  const sealedExport = await downloadListeningExport(page);
  const sealedExperiment = sealedExport.experiment as {
    reveal: { redacted: boolean; secretHex: string | null };
    snapshot: { lifecycle: string; statistics: { isFinal: boolean; significantVerdict: boolean } };
  };
  expect(sealedExperiment.snapshot.lifecycle).toBe("sealed");
  expect(sealedExperiment.reveal.redacted).toBe(false);
  expect(sealedExperiment.reveal.secretHex).toMatch(/^[0-9a-f]{64}$/);
  expect(sealedExperiment.snapshot.statistics.isFinal).toBe(false);
  expect(sealedExperiment.snapshot.statistics.significantVerdict).toBe(false);
  await expect(page.getByRole("button", { name: "Next trial" })).toHaveCount(0);

  // --- Reset + fail calibration -> terminal void, then release to new source. ---
  await clickRunAction(page, "Close listening run");
  await showView(page, "Setup");
  await page.getByLabel("Planned scored trials N (1–1000)").fill("1");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await waitForReadyTrial(page);
  await waitForReadyTrial(page);
  await answerMatching(page, true);
  await expect(page.locator('.run-results[data-lifecycle="void"]')).toBeVisible();
  await expect(page.getByText(/Calibration failed/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Next trial" })).toHaveCount(0);
  const voidExport = await downloadListeningExport(page);
  const voidExperiment = voidExport.experiment as {
    reveal: { redacted: boolean; secretHex: string | null };
    snapshot: { lifecycle: string; statistics: { significantVerdict: boolean } };
  };
  expect(voidExperiment.snapshot.lifecycle).toBe("void");
  expect(voidExperiment.reveal.redacted).toBe(false);
  expect(voidExperiment.reveal.secretHex).toMatch(/^[0-9a-f]{64}$/);
  expect(voidExperiment.snapshot.statistics.significantVerdict).toBe(false);

  await clickRunAction(page, "Reset listening run");
  await waitForReadyTrial(page);
  await expect(page.locator("#source-file")).toBeDisabled();
  await clickRunAction(page, "Close listening run");
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("#source-file")).toBeEnabled();
  expect(Number(await testApi(page, "terminatedWorkers"))).toBeGreaterThanOrEqual(1);
  expect(Number(await testApi(page, "activeExperimentWorkers"))).toBe(0);

  // A changed source after the explicit release is accepted (no automatic run).
  await chooseWav(page, "listening-new-source.wav", makePcm16Wav({
    sampleRate: 44_100,
    channels: 1,
    seconds: 0.6,
  }));
  await expect(page.locator(".file-summary")).toContainText("listening-new-source.wav");
  await showView(page, "Listen");
  await expect(page.locator(".listening-stage-placeholder"))
    .toContainText("Prepare the test to load trial 1.");
  await expect(page.locator(".listening-trial")).toHaveCount(0);

  expectNoRemoteOrUpload(guard);
  expect(pageErrors, "uncaught page error").toEqual([]);
});

test("an unusable canary blocks calibration, explicit disable works, load failure retries same token, reset interrupts a held load", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(installListeningInstrumentation);
  const guard = await openLab(page, origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "listening-no-canary.wav", makePcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    seconds: 0.7,
  }));
  await configure(page, {
    a: "noop_passthrough",
    b: "opus",
    bitrateB: 64,
    mode: "native",
    policy: "aligned-gain-matched-v1",
    canary: true,
  });

  await page.getByLabel("Planned scored trials N (1–1000)").fill("4");
  // Test-only fault at the real measurement-worker boundary: the requested
  // canary report is retained but explicitly unusable. The primary action must
  // fail closed rather than silently turning calibration off.
  await testApi(page, "armUnusableNextCanary");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await expect(page.getByText(/Calibration is requested but unavailable/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".warning[role=alert]").filter({ hasText: /retained canary material is not usable/ }))
    .toBeVisible();
  await expect(page.locator(".listening-trial")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start trial 1 (paused)" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable calibration explicitly for this plan" }).first())
    .toBeEnabled();

  await testApi(page, "armCorruptNextRead");
  await page.getByRole("button", { name: "Disable calibration explicitly for this plan" }).first().click();
  await expect(page.locator("#listen-view").getByText(/explicitly OFF/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#listen-view").getByText(/not-configured/)).toBeVisible();

  // Recovery stages immediately; a corrupt read must fail atomically and retry the same token.
  await expect(page.getByText(/failed to load atomically/).first()).toBeVisible({ timeout: 60_000 });
  const failedToken = await currentToken(page);
  expect(failedToken).not.toBeNull();
  await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry trial load" }).first().click();
  const retriedToken = await waitForReadyTrial(page);
  expect(retriedToken).toBe(failedToken);
  await expect(page.getByText(/failed to load atomically/)).toHaveCount(0);
  await answerMatching(page);
  await expect(page.locator(".answer-status")).toHaveText(/^(Correct|Incorrect)$/);

  // A delayed (held) next-trial load completes atomically after release.
  const calibrationAnsweredToken = await currentToken(page);
  await testApi(page, "armHoldNextRead");
  await answerMatching(page);
  await expect.poll(async () => Number(await testApi(page, "heldCount"))).toBeGreaterThan(0);
  await testApi(page, "releaseHeld");
  const delayedToken = await waitForReadyTrial(page, calibrationAnsweredToken ?? undefined);
  await expect(page.locator(".answer-status")).toHaveText(/^(Correct|Incorrect)$/);
  await testApi(page, "armHoldNextRead");
  await answerMatching(page);
  await expect(page.locator(".answer-status")).toHaveText(/^(Correct|Incorrect)$/);

  // Hold the following X read; reset must stop immediately and ignore the late reply.
  await expect.poll(async () => Number(await testApi(page, "heldCount"))).toBeGreaterThan(0);
  const beforeReset = await testApi(page, "lastReadToken");
  expect(beforeReset).not.toBe(delayedToken);
  await clickRunAction(page, "Reset listening run");
  await waitForReadyTrial(page);
  const afterReset = await currentToken(page);
  expect(afterReset).not.toBeNull();
  expect(afterReset).not.toBe(beforeReset);
  expect(beforeReset).not.toBeNull();
  // Releasing the late read cannot resurrect a trial or feedback after reset.
  await testApi(page, "releaseHeld");
  await page.waitForTimeout(250);
  expect(await currentToken(page)).toBe(afterReset);
  await expect(page.locator(".answer-status")).toBeEmpty();
  await expect(page.locator(".listening-trial")).toHaveCount(1);

  await clickRunAction(page, "Close listening run");
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.locator("#source-file")).toBeEnabled();
  expect(Number(await testApi(page, "terminatedWorkers"))).toBeGreaterThanOrEqual(1);

  expectNoRemoteOrUpload(guard);
  expect(pageErrors, "uncaught page error").toEqual([]);
});

test("raw diagnostic artifact stays diagnostic-only, then the primary prepare test replaces it and stages a trial", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(installListeningInstrumentation);
  const guard = await guardNetwork(page, origin);
  // Keep one genuinely unavailable codec for the stale-selection guard below.
  // A complete supplemental build otherwise makes every picker option usable.
  await page.route("**/codec-assets/ldac_codec.wasm", (route) => route.fulfill({
    status: 404, contentType: "text/plain", body: "Missing LDAC fixture asset",
  }));
  await page.goto(origin);
  await expect(page.locator("#codec-a option[value=opus]")).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator("#codec-b option[value=ldac]")).toBeDisabled();
  await page.locator(".advanced-preparation > summary").click();
  await page.locator(".listening-test-plan > summary").click();
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "listening-raw-source.wav", makePcm16Wav({
    sampleRate: 44_100,
    channels: 1,
    seconds: 0.5,
  }));
  await configure(page, {
    a: "noop_passthrough",
    b: "opus",
    bitrateB: 64,
    mode: "native",
    policy: "codec-probe-only",
    canary: false,
  });
  await prepare(page);

  // The current raw probe is named as such, not as a historical v1 artifact.
  await showView(page, "Listen");
  await expect(page.getByText(/Prepared for diagnostics\./)).toBeVisible();
  await expect(page.getByText(/ABX listening requires aligned,\s+level-matched audio/)).toBeVisible();
  await expect(page.getByText(/requires delivered-validity-v2 with a measured preparation/))
    .toHaveCount(0);
  await expect(page.locator("#listen-view").getByText(/Prepare test replaces this diagnostic artifact with an aligned pair/))
    .toBeVisible();
  await showView(page, "Setup");
  const primary = page.getByRole("button", { name: "Prepare test", exact: true });
  await expect(primary).toBeEnabled();
  expect(Number(await testApi(page, "experimentWorkersCreated"))).toBe(0);
  expect(Number(await testApi(page, "activeExperimentWorkers"))).toBe(0);

  // Simulate a selection retained after its codec becomes unavailable. The
  // normal picker disables this option; the primary action must guard it too.
  const unavailableCodec = await page.locator("#codec-b option:disabled").first()
    .evaluate((option: HTMLOptionElement) => {
      option.disabled = false;
      return option.value;
    });
  await page.locator("#codec-b").selectOption(unavailableCodec);
  await expect(primary).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: /Selected stages cannot be requested/ })).toBeVisible();
  await page.locator("#codec-b").selectOption("opus");
  await expect(primary).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("raw-primary-reprepare.png"), fullPage: true });

  // The explicit primary action replaces the raw diagnostic artifact, binds the
  // aligned pair and stages trial 1 paused without any extra setup shortcut.
  await page.locator("#canary-enabled").check();
  await primary.click();
  await expect(page.locator(".listening-trial")).toBeVisible({ timeout: 180_000 });
  await showView(page, "Evidence");

  const diagnostic = await downloadJson(page);
  expect(diagnostic.artifact.request.preparationPolicy).toBe("aligned-gain-matched-v1");
  expect(diagnostic.artifact.request.canaryEnabled).toBe(true);
  expect(diagnostic.artifact.validity?.policy).toBe("delivered-validity-v2");
  expect(diagnostic.artifact.canary).toBeTruthy();
  await expect(page.locator(".run-record")).toContainText("Readiness check");

  await clickRunAction(page, "Close listening run");
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeVisible({
    timeout: 60_000,
  });

  expectNoRemoteOrUpload(guard);
  expect(pageErrors, "uncaught page error").toEqual([]);
});

test("a failed first binding exposes recovery and can retry without losing the prepared source", async ({ page, baseURL }) => {
  await page.addInitScript(installListeningInstrumentation);
  const guard = await openLab(page, new URL(baseURL!).origin);
  const errors = collectPageErrors(page);
  await chooseWav(page, "binding-recovery.wav", makePcm16Wav({ seconds: 0.6 }));
  await configure(page, {
    a: "noop_passthrough", b: "opus", bitrateB: 64, mode: "native",
    policy: "aligned-gain-matched-v1", canary: true,
  });
  await prepare(page);
  await testApi(page, "armCorruptNextBind");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry/check listening preparation", exact: true })).toBeVisible();
  await expect(page.locator(".listening-trial")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  await showView(page, "Evidence");
  await page.getByText("Files and diagnostics", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Download results", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry/check listening preparation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await waitForReadyTrial(page);
  await clickRunAction(page, "Close listening run");
  await expect(page.locator("#source-file")).toBeEnabled();
  await expect(page.locator(".file-summary")).toContainText("binding-recovery.wav");
  expectNoRemoteOrUpload(guard);
  expect(errors).toEqual([]);
});
