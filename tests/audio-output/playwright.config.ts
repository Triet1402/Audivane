import { defineConfig } from "@playwright/test";
import path from "node:path";
import { randomUUID } from "node:crypto";

const report = process.env.CODEC_ABX_AUDIO_REPORT ??
  path.resolve("test-results", `audio-output-direct-${randomUUID()}`);

/**
 * Dedicated serial lane for real OS-level output capture. It is intentionally
 * separate from the normal browser/desktop configurations; a direct run without
 * the private launcher fails in the capture helper instead of skipping.
 *
 * `--mute-audio` is a Playwright default that silences Chromium's OS output even
 * though Web Audio advances. Removing that default is required to capture real
 * output; no sandbox, permission or autoplay flag is changed.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*(?:capture\.spec|capture\.electron)\.ts$/,
  timeout: 300_000,
  globalTimeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: path.join(report, "artifacts"),
  reporter: [["list"]],
  use: {
    headless: true,
    baseURL: process.env.CODEC_ABX_PREVIEW_URL ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: { ignoreDefaultArgs: ["--mute-audio"] },
  },
});
