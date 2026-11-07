import { defineConfig } from "@playwright/test";
import { browserWorkers } from "./tools/verification/workers.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEV_URL = process.env.CODEC_ABX_DEV_URL ?? "http://127.0.0.1:5173";
const PREVIEW_URL = process.env.CODEC_ABX_PREVIEW_URL ?? "http://127.0.0.1:4173";
const report = process.env.CODEC_ABX_REPORT_DIR ?? path.resolve("test-results", `browser-direct-${randomUUID()}`);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: browserWorkers(),
  outputDir: path.join(report, "artifacts"),
  retries: 0,
  reporter: [["list"]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-dev",
      use: { baseURL: DEV_URL, browserName: "chromium" },
    },
    {
      name: "chromium-production",
      testIgnore: "**/engine-contract.spec.ts",
      use: { baseURL: PREVIEW_URL, browserName: "chromium" },
    },
  ],
  // Owned ephemeral servers are started by npm run test:browser. Direct
  // Playwright remains useful with --list; execution uses the launcher.
  globalSetup: "./tools/verification/require-browser-launcher.mjs",
});
