import { clickRunAction } from "../ui/run-actions.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "vite";

import {
  chooseWav,
  collectPageErrors,
  configure,
  expectNoRemoteOrUpload,
  guardNetwork,
  makePcm16Wav,
  openLab,
  prepare,
  type NetworkGuard,
} from "./fixtures.js";
import type { OutputHarnessResult } from "./output-device-harness.js";

/**
 * The harness bundle is served only by a Playwright route. Both dev and
 * production projects execute the same real Chromium checks; the application
 * contains no output-device test route or global.
 */
let bundleDirectory: string | null = null;
let bundleSource = "";

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-output-harness-"));
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
        entry: path.join(process.cwd(), "tests", "e2e", "output-device-harness.ts"),
        formats: ["es"],
        fileName: () => "output-device-harness.js",
      },
      rollupOptions: {
        output: { entryFileNames: "output-device-harness.js" },
      },
    },
  });
  bundleSource = await readFile(path.join(bundleDirectory, "output-device-harness.js"), "utf8");
  expect(bundleSource.length).toBeGreaterThan(1000);
});

test.afterAll(async () => {
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
    bundleDirectory = null;
  }
});

test("real Chromium output APIs report support, apply the default sink, and redact failures", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const guard: NetworkGuard = await guardNetwork(page, origin);
  const pageErrors = collectPageErrors(page);
  await page.route("**/output-device-harness.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: bundleSource,
    });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  const running = page.evaluate(async () => {
    // @ts-expect-error This module is supplied by the route above, not by the app.
    const harness = await import(/* @vite-ignore */ "/output-device-harness.js");
    return harness.runHarness() as Promise<OutputHarnessResult>;
  });
  await page.waitForSelector("#output-gesture", { state: "attached" });
  await page.click("#output-gesture");
  const result = await running;

  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.checks.support).toBe("supported");
  expect(Number(result.checks["device-count"])).toBeGreaterThanOrEqual(1);
  expect(result.checks["refresh-without-context"]).toBe(true);
  expect(result.checks["selection-applied"]).toBe(true);
  expect(result.checks["observed-default"]).toBe(true);
  expect(result.checks["failure-redacted"]).toBe(true);
  expect(result.checks["live-disposed"]).toBe(true);
  expect(result.checks["unsupported-support"]).toBe("unsupported");
  expect(result.checks["unsupported-default-usable"]).toBe(true);
  // Continuation is checked against real Web Audio: the sounding graph keeps
  // playing while a verified next set is staged, and only an explicit pick
  // switches it. A failed continuation keeps retired sound but no selection.
  expect(result.checks["continuation-carries"]).toBe(true);
  expect(result.checks["continuation-switch"]).toBe(true);
  expect(result.checks["continuation-failure"]).toBe(true);
  expect(typeof result.checks["live-output-rate"]).toBe("number");
  expect(typeof result.checks["chooser-available"]).toBe("boolean");
  // Headless Linux Chromium exposes no chooser; if a build does expose it, the
  // harness deliberately does not open a system dialog.
  if (result.checks["chooser-available"] === false) {
    expect(result.checks["chooser-unavailable"]).toBe(true);
  }
  expect(pageErrors).toEqual([]);
  expect(guard.disallowed, "harness attempted an external/upload request").toEqual([]);
});

test("listening UI refreshes real output support, locks changes after staging, and unlocks on reset", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const guard = await openLab(page, origin);
  const pageErrors = collectPageErrors(page);

  await chooseWav(page, "output-device-source.wav", makePcm16Wav({
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
    canary: false,
  });
  await prepare(page);

  // The output select is always visible. Automatic permission-free discovery
  // has already populated the default route without
  // starting playback or a preparation.
  await page.locator(".listening-output-details > summary").click();
  await expect(page.getByRole("heading", { name: "Output device" })).toBeVisible();
  await expect(page.getByLabel("Select a listed output")).toContainText("System default output");
  await page.getByRole("button", { name: "Refresh output devices" }).click();
  await expect(page.getByText(/supported: this browser exposes Web Audio output routing/))
    .toBeVisible();

  const chooserExposed = await page.evaluate(() =>
    typeof (navigator.mediaDevices as MediaDevices & {
      selectAudioOutput?: unknown;
    })?.selectAudioOutput === "function");
  await expect(page.getByRole("button", { name: "Choose output device…" }))
    .toHaveCount(chooserExposed ? 1 : 0);

  await page.locator("#canary-enabled").uncheck();
  await page.getByLabel("Planned scored trials N (1–1000)").fill("1");
  await page.getByRole("button", { name: "Prepare test", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true }))
    .toBeEnabled({ timeout: 180_000 });
  await expect(page.getByText("Locked for this test.")).toBeVisible();
  await expect(page.getByLabel("Select a listed output")).toBeDisabled();

  await clickRunAction(page, "Close listening run");
  await expect(page.getByLabel("Select a listed output")).toBeVisible();
  await expect(page.getByText("Locked for this test.")).toHaveCount(0);
  await expect(page.getByLabel("Select a listed output")).toBeEnabled();

  expect(pageErrors).toEqual([]);
  expectNoRemoteOrUpload(guard);
});
