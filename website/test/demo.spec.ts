import { expect, test } from "@playwright/test";

import {
  chooseWav,
  collectPageErrors,
  configure,
  downloadListeningExport,
  expectDemoCsp,
  expectNoRemoteOrUpload,
  installWebsiteProbe,
  makePcm16Wav,
  openDemo,
  readWebsiteProbe,
  sha256,
} from "./helpers.js";

test("the served demo uses the production CSP and loads same-origin workers and WASM, not a Vite preview", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installWebsiteProbe);
  const errors = collectPageErrors(page);
  const origin = new URL(baseURL!).origin;
  const response = await page.goto(`${origin}/demo/`, { waitUntil: "load" });
  expect(response, "demo response").not.toBeNull();
  expect(response!.status()).toBe(200);
  expectDemoCsp(response!.headers()["content-security-policy"]);
  expect(response!.headers()["x-robots-tag"]).toBe("noindex");

  // The real app must start and load its codec core from this same origin.
  await expect(page.locator("#capabilities-heading")).toBeVisible();
  await expect(page.locator("#codec-a option[value=opus]")).toBeEnabled({ timeout: 90_000 });

  const scripts = await page.locator("script[src]").evaluateAll((elements) =>
    elements.map((element) => (element as HTMLScriptElement).src));
  expect(scripts.length, "the demo should load built module scripts").toBeGreaterThan(0);
  for (const source of scripts) {
    const url = new URL(source);
    expect(url.origin, `script ${source} is cross-origin`).toBe(origin);
    expect(url.pathname.startsWith("/demo/assets/"), `script ${source} is outside /demo/assets/`).toBe(true);
  }

  const previewResources = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes("/@vite/") || name.includes("/src/") || name.includes("vite")));
  expect(previewResources, "Vite preview/dev resources leaked into the built demo").toEqual([]);

  const probe = await readWebsiteProbe(page);
  expect(probe.violations, "CSP blocked a required demo resource").toEqual([]);
  expect(probe.workers.length, "the demo should create a module Worker for codec work").toBeGreaterThan(0);
  for (const worker of probe.workers) {
    const url = new URL(worker.href);
    expect(url.origin, `worker ${worker.href} is cross-origin`).toBe(origin);
    expect(url.pathname.startsWith("/demo/assets/"), `worker ${worker.href} is outside the built demo`).toBe(true);
    expect(worker.type, `worker ${worker.href} should be a module worker`).toBe("module");
  }

  expect(errors, "uncaught page error").toEqual([]);
});

test("the demo imports a generated analytical WAV, prepares, stages paused, answers A/B/X, and exports evidence", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(installWebsiteProbe);
  const errors = collectPageErrors(page);
  const guard = await openDemo(page, baseURL!);
  const origin = new URL(baseURL!).origin;

  // Small, deterministic analytical source: 0.6 s of 440 Hz at 48 kHz mono.
  // No user audio and no repository sample files are involved.
  const fixture = makePcm16Wav({
    sampleRate: 48_000,
    channels: 1,
    seconds: 0.6,
    amplitude: 0.2,
  });
  const fixtureHash = sha256(fixture);
  await chooseWav(page, "website-analytical-48000-mono.wav", fixture);
  await configure(page, {
    a: "noop_passthrough",
    b: "opus",
    bitrateB: 64,
    mode: "native",
    policy: "aligned-gain-matched-v1",
    canary: false,
  });
  await page.getByLabel("Planned scored trials N (1–1000)").fill("1");
  await page.getByLabel("Label mode", { exact: true }).selectOption("fixed");
  await expect(page.getByRole("button", { name: "Prepare test", exact: true })).toBeEnabled();

  // The primary action runs the real alignment/gain/validity preparation and
  // must stage trial 1 paused rather than autoplaying.
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  const trial = page.locator(".listening-trial");
  await expect(trial).toBeVisible({ timeout: 180_000 });
  await expect(trial).toHaveAttribute("data-kind", "scored");
  await expect(page.locator(".stage-status")).toContainText("Paused");
  expect(await trial.getAttribute("data-token"), "staged trial token").toBeTruthy();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeEnabled();

  // Exercise all three display labels and real paused playback before answering.
  for (const label of ["A", "B", "X"] as const) {
    const button = page.getByRole("button", { name: `Monitor playback label ${label}` });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Answer A", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run · completed", exact: true }))
    .toBeVisible({ timeout: 60_000 });

  // Evidence view and the listening export are the durable run artifacts.
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.locator("#evidence-view")).toBeVisible();
  await expect(page.locator(".listening-stats")).toContainText("1 / 1 scored");
  await expect(page.locator(".validity")).toContainText("delivered-validity-v2");

  const exported = await downloadListeningExport(page) as {
    schema: string;
    listening: {
      lifecycle: string;
      calibrationExcludedFromScoredN: boolean;
      stopAtPlannedN: boolean;
      humanValidation: string;
    };
    experiment: {
      snapshot: {
        lifecycle: string;
        plan: { plannedTrials: number | null; calibrationEnabled: boolean; labelMode: string };
        statistics: { scoredTrials: number; isFinal: boolean };
      };
      trials: Array<{ kind: string; answer: string; correct: boolean }>;
      reveal: { redacted: boolean; secretHex: string | null; verifiable: boolean };
    };
    prepared: {
      sourceSha256: string;
      request: {
        preparationPolicy: string;
        canaryEnabled?: boolean;
        sampleRateMode: string;
        a: { codecId: string };
        b: { codecId: string };
      };
      validity: { policy: string } | null;
      tracks: {
        a: { delivered: { sampleRate: number; channels: number; frames: number; wavSha256: string } };
        b: { delivered: { sampleRate: number; channels: number; frames: number; wavSha256: string } };
      };
    };
  };

  expect(exported.schema).toBe("codec-abx-browser-listening-v1");
  expect(exported.prepared.sourceSha256).toBe(fixtureHash);
  expect(exported.prepared.request.canaryEnabled ?? false).toBe(false);
  expect(exported.prepared.request).toMatchObject({
    preparationPolicy: "aligned-gain-matched-v1",
    sampleRateMode: "native",
    a: { codecId: "noop_passthrough" },
    b: { codecId: "opus" },
  });
  expect(exported.prepared.validity?.policy).toBe("delivered-validity-v2");
  const deliveredA = exported.prepared.tracks.a.delivered;
  const deliveredB = exported.prepared.tracks.b.delivered;
  expect(deliveredA.sampleRate).toBe(48_000);
  expect(deliveredA.channels).toBe(1);
  expect(deliveredB.sampleRate).toBe(48_000);
  expect(deliveredB.channels).toBe(1);
  expect(deliveredA.wavSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(deliveredB.wavSha256).toMatch(/^[0-9a-f]{64}$/);
  const duration = deliveredA.frames / deliveredA.sampleRate;
  expect(duration).toBeGreaterThan(0.5);
  expect(duration).toBeLessThanOrEqual(0.601);

  expect(exported.listening.lifecycle).toBe("completed");
  expect(exported.listening.calibrationExcludedFromScoredN).toBe(true);
  expect(exported.listening.stopAtPlannedN).toBe(true);
  expect(exported.listening.humanValidation).toBe("not performed");
  expect(exported.experiment.snapshot.lifecycle).toBe("completed");
  expect(exported.experiment.snapshot.plan).toMatchObject({
    plannedTrials: 1,
    calibrationEnabled: false,
    labelMode: "fixed",
  });
  expect(exported.experiment.snapshot.statistics.scoredTrials).toBe(1);
  expect(exported.experiment.trials).toHaveLength(1);
  expect(exported.experiment.trials[0]).toMatchObject({ kind: "scored", answer: "A" });
  expect(exported.experiment.reveal.redacted).toBe(false);
  expect(exported.experiment.reveal.secretHex).toMatch(/^[0-9a-f]{64}$/);
  expect(exported.experiment.reveal.verifiable).toBe(true);

  // Both the numerical measurement worker and the experiment worker must be
  // real same-origin module workers from the built demo.
  const probe = await readWebsiteProbe(page);
  const workerNames = probe.workers.map((worker) => worker.name);
  expect(workerNames, "measurement worker missing").toContain("codec-abx-measurements");
  expect(workerNames, "experiment worker missing").toContain("codec-abx-experiment");
  for (const worker of probe.workers) {
    const url = new URL(worker.href);
    expect(url.origin, `worker ${worker.href} is cross-origin`).toBe(origin);
    expect(url.pathname.startsWith("/demo/"), `worker ${worker.href} is outside /demo/`).toBe(true);
  }
  expect(probe.violations, "CSP blocked a required demo resource").toEqual([]);

  expect(guard.wasmAssets.length, "the real codec WASM assets must be requested").toBeGreaterThan(0);
  for (const path of guard.wasmAssets) {
    expect(path.startsWith("/demo/codec-assets/"), `WASM ${path} is outside the demo`).toBe(true);
  }
  expectNoRemoteOrUpload(guard);
  expect(errors, "uncaught page error").toEqual([]);
});
