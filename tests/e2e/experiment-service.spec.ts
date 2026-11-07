import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "vite";

import { guardNetwork, type NetworkGuard } from "./fixtures.js";

/**
 * The harness is compiled by Vite's library build into a temporary bundle and
 * served only by a Playwright route. No test route/global/component exists in
 * the application bundle, and the harness itself performs no network I/O.
 */
let bundleDirectory: string | null = null;
let bundleSource = "";

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-experiment-harness-"));
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
        entry: path.join(process.cwd(), "tests", "e2e", "experiment-harness.ts"),
        formats: ["es"],
        fileName: () => "experiment-harness.js",
      },
      rollupOptions: {
        output: { entryFileNames: "experiment-harness.js" },
      },
    },
  });
  bundleSource = await readFile(path.join(bundleDirectory, "experiment-harness.js"), "utf8");
  expect(bundleSource.length).toBeGreaterThan(1000);
});

test.afterAll(async () => {
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
    bundleDirectory = null;
  }
});

test("experiment service runs in Chromium with WebCrypto and real binary fixtures", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const guard: NetworkGuard = await guardNetwork(page, origin);
  await page.route("**/experiment-harness.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: bundleSource,
    });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async () => {
    // @ts-expect-error This module is supplied by the route above, not by the app.
    const harness = await import(/* @vite-ignore */ "/experiment-harness.js");
    return harness.runHarness();
  });

  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.checks["binding-null-not-applicable"]).toBe(true);
  expect(result.checks["binding-calibration-pending"]).toBe(true);
  expect(result.checks["calibration-binary-sources"]).toBe(true);
  expect(result.checks["calibration-listener-pass"]).toBe(true);
  expect(result.checks["completed-verdict"]).toBe(true);
  expect(result.checks["reveal-commitment-verifies"]).toBe(true);
  expect(result.checks["reset-retains-pair"]).toBe(true);
  expect(result.checks["null-passed-gate"]).toBe(true);
  expect(result.checks["null-failed-blocks"]).toBe(true);
  expect(result.checks["corrupt-served-bytes"]).toBe(true);
  expect(result.checks["public-dto-no-private-keys"]).toBe(true);
  expect(guard.disallowed, "harness attempted an external/upload request").toEqual([]);
});
