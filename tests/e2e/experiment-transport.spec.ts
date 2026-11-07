import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "vite";

import { collectPageErrors, guardNetwork, type NetworkGuard } from "./fixtures.js";
import type { HarnessResult } from "./experiment-transport-harness.js";

/**
 * The transport harness and the real experiment module Worker are compiled by
 * Vite's library build into a temporary directory. Only Playwright routes serve
 * those assets; the application bundle has no test route, global or Worker.
 * Both the Vite dev and production projects exercise the same real Worker.
 */
let bundleDirectory: string | null = null;
const assets = new Map<string, { body: Buffer; contentType: string }>();

function contentType(file: string): string {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "application/javascript";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function collect(directory: string, root: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute, root);
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    assets.set(relative, {
      body: await readFile(absolute),
      contentType: contentType(relative),
    });
  }
}

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-transport-harness-"));
  await build({
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
    worker: { format: "es" },
    build: {
      target: "es2022",
      minify: false,
      emptyOutDir: true,
      outDir: bundleDirectory,
      lib: {
        entry: path.join(process.cwd(), "tests", "e2e", "experiment-transport-harness.ts"),
        formats: ["es"],
        fileName: () => "experiment-transport-harness.js",
      },
      rollupOptions: {
        output: {
          entryFileNames: "experiment-transport-harness.js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
  await collect(bundleDirectory, bundleDirectory);
  expect(assets.get("experiment-transport-harness.js")?.body.byteLength ?? 0)
    .toBeGreaterThan(1000);
  // Vite must emit the real module Worker (and any shared chunks) as separate
  // same-origin assets, not inline it into the harness or use a CDN.
  const workerAsset = [...assets.keys()].find((file) => /experiment-worker/i.test(file));
  expect(workerAsset, "Vite did not emit the experiment Worker asset").toBeTruthy();
  expect(assets.size).toBeGreaterThan(1);
});

test.afterAll(async () => {
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
    bundleDirectory = null;
  }
  assets.clear();
});

test("browser experiment transport owns a real Worker service", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const guard: NetworkGuard = await guardNetwork(page, origin);
  const pageErrors = collectPageErrors(page);
  const byName = new Map(
    [...assets.entries()].map(([relative, file]) => [path.posix.basename(relative), file]),
  );
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const relative = url.pathname.replace(/^\/+/, "");
    const file = assets.get(relative) ??
      byName.get(path.posix.basename(relative));
    if (!file) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: file.contentType,
      body: file.body,
    });
  });
  await page.route("**/missing-experiment-worker.js", async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async () => {
    // @ts-expect-error This module is supplied by the route above, not by the app.
    const harness = await import(/* @vite-ignore */ "/experiment-transport-harness.js");
    return harness.runHarness() as Promise<HarnessResult>;
  });

  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  for (let index = 2; index <= 6; index += 1) {
    expect(result.checks[`scored-index-${index}`], `scored-index-${index}`).toBe(true);
    expect(result.checks[`scored-x-binary-${index}`], `scored-x-binary-${index}`).toBe(true);
    expect(result.checks[`scored-display-sides-${index}`], `scored-display-sides-${index}`).toBe(true);
    expect(result.checks[`scored-correct-${index}`], `scored-correct-${index}`).toBe(true);
    expect(result.checks[`snapshot-last-answer-${index}`], `snapshot-last-answer-${index}`).toBe(true);
  }
  for (const key of [
    "configure-before-bind",
    "bind-prepared-identity",
    "bind-calibration-pending",
    "bind-retains-engine-bytes",
    "concurrent-next-same-token",
    "calibration-binary-sources",
    "calibration-pass",
    "readaudio-exact-copies",
    "completed-at-n",
    "completed-verdict",
    "terminal-reveal",
    "terminal-commitment-verifies",
    "no-early-private-keys",
    "binding-binary-not-json",
    "reset-new-run",
    "reset-retains-pair",
    "reset-export-redacted",
    "seal-terminal",
    "seal-reveals",
    "sealed-answer-refused",
    "dispose-refuses",
    "independent-runs",
    "answer-timeout-uncertain",
    "answer-timeout-uncertain-flag",
    "answer-reconciled-last-answer",
    "answer-retry-same-receipt",
    "answer-retry-no-redraw",
    "answer-dropped-timeout",
    "answer-dropped-retry",
    "corrupt-binding-rejected",
    "failed-replacement-preserves-binding",
    "read-layout-rejected",
    "missing-canary-unavailable",
    "missing-canary-blocks",
    "reset-invalidates-held-read",
    "reset-race-current-run",
    "reset-invalidates-bind",
    "bind-race-never-posted",
    "dispose-invalidates-read",
    "worker-load-failure",
    "worker-construction-failure",
    "worker-cross-origin-construction-failure",
  ]) {
    expect(result.checks[key], key).toBe(true);
  }
  expect(guard.disallowed, "harness attempted an external/upload request").toEqual([]);
  expect(pageErrors, "uncaught page error").toEqual([]);
});
