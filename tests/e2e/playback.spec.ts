import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "vite";

import { collectPageErrors, guardNetwork, type NetworkGuard } from "./fixtures.js";
import type { HarnessResult } from "./playback-harness.js";

/**
 * The playback harness is compiled into a temporary bundle and served only by
 * a Playwright route. Both Vite dev and production projects run this same test;
 * neither the application nor the bundle exposes a test route or global.
 */
let bundleDirectory: string | null = null;
let bundleSource = "";

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-playback-harness-"));
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
        entry: path.join(process.cwd(), "tests", "e2e", "playback-harness.ts"),
        formats: ["es"],
        fileName: () => "playback-harness.js",
      },
      rollupOptions: {
        output: { entryFileNames: "playback-harness.js" },
      },
    },
  });
  bundleSource = await readFile(path.join(bundleDirectory, "playback-harness.js"), "utf8");
  expect(bundleSource.length).toBeGreaterThan(1000);
});

test.afterAll(async () => {
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
    bundleDirectory = null;
  }
});

test("browser playback renders shared timelines and respects lifecycle", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const guard: NetworkGuard = await guardNetwork(page, origin);
  const pageErrors = collectPageErrors(page);
  await page.route("**/playback-harness.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: bundleSource,
    });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  const running = page.evaluate(async () => {
    // @ts-expect-error This module is supplied by the route above, not by the app.
    const harness = await import(/* @vite-ignore */ "/playback-harness.js");
    return harness.runHarness() as Promise<HarnessResult>;
  });
  await page.waitForSelector("#playback-gesture", { state: "attached" });
  await page.click("#playback-gesture");
  const result = await running;

  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.checks["shared-start-identical-a-b"]).toBe(true);
  expect(result.checks["stereo-anti-phase-preserved"]).toBe(true);
  expect(result.checks["identical-a-b-switch-constant-gain"]).toBe(true);
  expect(result.checks["rapid-reversal-complementary-gain"]).toBe(true);
  expect(result.checks["pause-resume-retains-position"]).toBe(true);
  expect(result.checks["seek-moves-shared-timeline"]).toBe(true);
  expect(result.checks["loop-wraps-shared-region"]).toBe(true);
  expect(result.checks["nonloop-end-stops-once"]).toBe(true);
  expect(result.checks["delivered-rate-separate-from-output-rate"]).toBe(true);
  expect(result.checks["atomic-failure-then-retry"]).toBe(true);
  expect(result.checks["reset-invalidates-late-reads"]).toBe(true);
  expect(result.checks["reset-dispose-silence-retiring-graphs"]).toBe(true);
  expect(result.checks["live-playing"]).toBe(true);
  expect(result.checks["live-delivered-rate"]).toBe(44_100);
  expect(result.checks["live-disposed"]).toBe(true);
  expect(typeof result.checks["shared-start-max-difference"]).toBe("number");
  expect(typeof result.checks["anti-phase-max-sum"]).toBe("number");
  expect(typeof result.checks["switch-min"]).toBe("number");
  expect(typeof result.checks["switch-max"]).toBe("number");
  expect(typeof result.checks["reversal-min"]).toBe("number");
  expect(typeof result.checks["reversal-max"]).toBe("number");
  expect(typeof result.checks["paused-position"]).toBe("number");
  expect(typeof result.checks["resumed-position"]).toBe("number");
  expect(typeof result.checks["loop-repeat-difference"]).toBe("number");
  expect(typeof result.checks["live-output-rate"]).toBe("number");
  expect(pageErrors).toEqual([]);
  expect(guard.disallowed, "harness attempted an external/upload request").toEqual([]);
});
