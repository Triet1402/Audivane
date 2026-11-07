import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
test("real Electron main heartbeat remains responsive through native preparation and binding", async ({}, info) => {
  test.setTimeout(180_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-electron-profile-"));
  let application: ElectronApplication | null = null;
  try {
    // Test-only bundle loaded in trusted Electron main. It exercises the same
    // direct-runtime and production worker-proxy classes, never renderer RPC.
    const probe = path.join(directory, "probe.cjs");
    await build({ entryPoints: [path.join(root, "tools/profile-native.ts")], outfile: probe, bundle: true, platform: "node", format: "cjs", target: "node24", define: { "import.meta.url": "__probeUrl" }, banner: { js: 'const __probeUrl = require("node:url").pathToFileURL(__filename).href;' } });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [path.join(root, "apps/desktop")], cwd: directory, env, chromiumSandbox: true });
    const page = await application.firstWindow();
    await expect(page.locator('section[aria-labelledby="capabilities-heading"]')).toContainText("available");
    const observations: unknown[] = [];
    for (const seconds of [1, 10]) {
      const values = await application.evaluate(async (_electron, options) => {
        const { profile } = process.getBuiltinModule("module").createRequire(options.probe)(options.probe) as typeof import("../../../tools/profile-native.js");
        const workerPath = process.getBuiltinModule("path").join(options.root, "apps/desktop/dist/runtime-worker.cjs");
        const direct = await profile("direct", options.seconds, options.root, workerPath);
        const worker = await profile("worker", options.seconds, options.root, workerPath);
        return { direct, worker, electron: process.versions.electron };
      }, { probe, root, seconds });
      expect(values.worker.scientific).toEqual(values.direct.scientific);
      expect(values.worker.workersAfter).toBe(0); expect(values.worker.nativeChildrenAfter).toBe(0);
      if (seconds === 10) {
        expect(values.worker.heartbeatMaxMs).toBeLessThan(values.direct.heartbeatMaxMs * .75 + 100);
        expect(values.worker.heartbeats).toBeGreaterThan(20);
      }
      observations.push(values);
    }
    const report = info.outputPath("electron-native-performance.json");
    await fs.writeFile(report, JSON.stringify({ memoryScope: "Electron main process RSS including Node worker threads; excludes renderer/GPU/native codec child processes. One production window worker remains alongside each test probe.", observations }, null, 2));
    await info.attach("electron-native-performance", { path: report, contentType: "application/json" });
  } finally { await application?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
