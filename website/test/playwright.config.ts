import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseURL = process.env.CODEC_ABX_WEBSITE_URL;
if (!baseURL) {
  throw new Error(
    "Website browser tests must run through website/scripts/test-browser.mjs " +
    "so they use the owned static server and its production CSP.",
  );
}
const report = process.env.CODEC_ABX_REPORT_DIR
  ?? path.join(root, "test-results", `website-direct-${randomUUID()}`);

export default defineConfig({
  testDir: path.dirname(fileURLToPath(import.meta.url)),
  testMatch: "**/*.spec.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  // One worker keeps the real WASM codec load and audio preparation bounded.
  workers: 1,
  outputDir: path.join(report, "artifacts"),
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(report, "website-report.json") }],
  ],
  use: {
    headless: true,
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-website",
      use: { browserName: "chromium" },
    },
  ],
});
