import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NativeProcessManager, resolveNativeSpawnCommand } from "../src/typescript/process.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const windowsProcessHost = process.platform === "win32"
  ? process.env.CODEC_ABX_PROCESS_HOST
    ?? path.join(repositoryRoot, "build", "windows-process-host", "bin", "audivane-process-host.exe")
  : undefined;
const windowsHostAvailable = process.platform !== "win32" ||
  (windowsProcessHost !== undefined && existsSync(windowsProcessHost));

test("Windows codec spawns require the lifetime host and never fall back uncontained", () => {
  assert.throws(
    () => resolveNativeSpawnCommand("C:\\tools\\ffmpeg.exe", ["-version"], undefined, "win32"),
    /lifetime host is required/,
  );
  assert.throws(
    () => resolveNativeSpawnCommand("C:\\tools\\ffmpeg.exe", ["-version"], "relative-host.exe", "win32"),
    /must be absolute/,
  );
  assert.deepEqual(
    resolveNativeSpawnCommand("C:\\tools\\ffmpeg.exe", ["-version"], "C:\\Audivane\\process-host.exe", "win32"),
    {
      file: "C:\\Audivane\\process-host.exe",
      args: ["--run", "C:\\tools\\ffmpeg.exe", "-version"],
      viaHost: true,
    },
  );
  assert.deepEqual(
    resolveNativeSpawnCommand("/usr/bin/ffmpeg", ["-version"], undefined, "linux"),
    { file: "/usr/bin/ffmpeg", args: ["-version"], viaHost: false },
  );
});

test("leader exit retires a descendant holding inherited stdio before resolving", {
  timeout: 10_000,
  // On Windows the production host assigns the suspended codec leader to a
  // kill-on-close Job Object. The host closes it after the leader exits, so a
  // descendant that inherited stdio cannot survive. Without a built host this
  // acceptance is honestly skipped rather than falling back to taskkill /T.
  skip: windowsHostAvailable ? false : "Windows process lifetime host is not built",
}, async () => {
  const manager = new NativeProcessManager(undefined, windowsProcessHost);
  try {
    const result = await manager.run({
      file: process.execPath,
      args: ["-e", `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'inherit'});
        console.log(child.pid);
        setTimeout(() => process.exit(0), 100);
      `],
      label: "inherited-stdio fixture", timeoutMs: 3_000,
    });
    assert.equal(result.code, 0);
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    if (process.platform === "linux") {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        assert.ok(["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else if (process.platform === "win32") {
      // The Job Object is closed before the host returns, so this process must
      // already be gone. Retry briefly for Windows' asynchronous exit.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail("contained descendant survived the codec leader exit");
    }
  } finally { await manager.dispose(); }
});

test("abort during synchronous process registration is observed and cleaned up", { timeout: 10_000, skip: windowsHostAvailable ? false : "Windows process lifetime host is not built" }, async () => {
  const abort = new AbortController();
  const events: string[] = [];
  const manager = new NativeProcessManager(event => {
    events.push(event.type);
    if (event.type === "spawn") abort.abort();
  }, windowsProcessHost);
  try {
    await assert.rejects(manager.run({
      file: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"],
      label: "registration abort", signal: abort.signal, timeoutMs: 1_000,
    }), { name: "AbortError" });
    assert.deepEqual(events, ["spawn", "exit"]);
  } finally { await manager.dispose(); }
});
