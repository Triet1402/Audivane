import { defineConfig } from "@playwright/test";
import path from "node:path";
import { randomUUID } from "node:crypto";
const performance = process.env.CODEC_ABX_DESKTOP_PERFORMANCE === "1";
export default defineConfig({
  testDir: "./test",
  testMatch: performance ? "**/performance.electron.ts" : "**/*.electron.ts",
  ...(performance ? {} : { testIgnore: "**/performance.electron.ts" }),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: path.join(process.env.CODEC_ABX_REPORT_DIR ?? path.resolve("test-results", `desktop-direct-${randomUUID()}`), "artifacts"),
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
