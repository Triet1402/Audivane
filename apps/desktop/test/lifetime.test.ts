import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WINDOWS_PROCESS_HOST_FILENAME,
  resolveWindowsProcessHost,
  startWindowsLifetime,
} from "../src/lifetime.js";

test("Windows lifetime host resolution is explicit and fail-closed", () => {
  assert.equal(resolveWindowsProcessHost({
    platform: "linux", packaged: true, resourcesPath: "/opt/app/resources",
    repositoryRoot: "/repo", environment: {},
  }), null);
  assert.equal(resolveWindowsProcessHost({
    platform: "win32", packaged: true, resourcesPath: "C:\\App\\resources",
    repositoryRoot: "C:\\repo", environment: {},
  }), path.win32.join("C:\\App\\resources", "process-host", WINDOWS_PROCESS_HOST_FILENAME));
  assert.equal(resolveWindowsProcessHost({
    platform: "win32", packaged: false, resourcesPath: "C:\\App\\resources",
    repositoryRoot: "C:\\repo", environment: {},
  }), path.win32.join("C:\\repo", "build", "windows-process-host", "bin", WINDOWS_PROCESS_HOST_FILENAME));
  assert.equal(resolveWindowsProcessHost({
    platform: "win32", packaged: true, resourcesPath: "C:\\App\\resources",
    repositoryRoot: "C:\\repo", environment: { CODEC_ABX_PROCESS_HOST: "C:\\tools\\lifetime.exe" },
  }), "C:\\tools\\lifetime.exe");
  assert.throws(() => resolveWindowsProcessHost({
    platform: "win32", packaged: true, resourcesPath: "C:\\App\\resources",
    repositoryRoot: "C:\\repo", environment: { CODEC_ABX_PROCESS_HOST: "lifetime.exe" },
  }), /absolute trusted executable path/);
});

async function fixture(script: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-lifetime-test-"));
  const file = path.join(directory, "lifetime-host.cjs");
  await fs.writeFile(file, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return file;
}

test("lifetime startup waits for the guard containment handshake", async () => {
  const host = await fixture(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
  const lifetime = await startWindowsLifetime({ hostPath: host, platform: "win32", mainPid: 4242, startupTimeoutMs: 2_000 });
  try {
    assert.equal(lifetime?.hostPath, host);
    assert.ok(Number.isSafeInteger(lifetime?.pid));
  } finally {
    if (lifetime?.pid !== undefined) {
      try { process.kill(lifetime.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("lifetime startup rejects an early exit, malformed readiness and no handshake", async () => {
  const exited = await fixture(`process.stderr.write("job assignment refused\\n"); process.exit(3);`);
  await assert.rejects(
    startWindowsLifetime({ hostPath: exited, platform: "win32", mainPid: 4242, startupTimeoutMs: 2_000 }),
    /exited before readiness.*job assignment refused/s,
  );

  const malformed = await fixture(`process.stdout.write("contained\\n"); setInterval(() => {}, 1000);`);
  await assert.rejects(
    startWindowsLifetime({ hostPath: malformed, platform: "win32", mainPid: 4242, startupTimeoutMs: 2_000 }),
    /refused containment/,
  );

  const silent = await fixture(`setInterval(() => {}, 1000);`);
  await assert.rejects(
    startWindowsLifetime({ hostPath: silent, platform: "win32", mainPid: 4242, startupTimeoutMs: 150 }),
    /did not become ready/,
  );
});

test("non-Windows startup performs no process work and rejects an invalid Windows PID", async () => {
  assert.equal(await startWindowsLifetime({ hostPath: "/missing/host", platform: "linux", mainPid: 4242 }), null);
  await assert.rejects(
    startWindowsLifetime({ hostPath: process.execPath, platform: "win32", mainPid: 0 }),
    /valid main-process PID/,
  );
});
