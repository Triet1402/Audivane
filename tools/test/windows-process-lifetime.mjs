import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const host = process.env.CODEC_ABX_PROCESS_HOST ??
  path.join(root, "build", "windows-process-host", "bin", "audivane-process-host.exe");
const taskkill = process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
  : null;
if (process.platform === "win32" && !existsSync(host)) {
  throw new Error("Build the Windows process lifetime host before running its acceptance harness");
}
const available = process.platform === "win32" && existsSync(host);
const skip = available ? false : "Windows process lifetime host was not built on this host";

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await delay(50);
  }
  return false;
}

function killMain(pid) {
  execFileSync(taskkill, ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

test("guard terminates descendants when the Electron main process dies without /T", {
  skip, timeout: 45_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-guard-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "pids.json");
  const script = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const guard = spawn(process.env.LIFETIME_HOST, ["--guard", String(process.pid)],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "";
    guard.stdout.setEncoding("utf8");
    guard.stdout.on("data", chunk => {
      text += chunk;
      if (!text.includes("ready")) return;
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true });
      fs.writeFileSync(process.env.PID_FILE, JSON.stringify({
        leader: process.pid, descendant: descendant.pid, guard: guard.pid,
      }));
    });
    guard.once("exit", code => { if (!text.includes("ready")) process.exit(9); });
    setInterval(() => {}, 1000);
  `;
  const leader = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, LIFETIME_HOST: host, PID_FILE: pidFile },
  });
  try {
    const pids = await waitForFile(pidFile);
    assert.ok(Number.isSafeInteger(pids.descendant) && pids.descendant > 1);
    killMain(pids.leader);
    assert.equal(await waitGone(pids.descendant), true, "descendant survived main-process death");
    assert.equal(await waitGone(pids.guard), true, "lifetime guard did not retire after main exit");
  } finally {
    try { leader.kill(); } catch { /* already exited */ }
  }
});

test("per-codec host kills descendants after an early codec leader exit", {
  skip, timeout: 30_000,
}, async () => {
  const leaderCode = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "inherit", windowsHide: true });
    console.log(descendant.pid);
    setTimeout(() => process.exit(0), 100);
  `;
  const result = spawnSync(host, ["--run", process.execPath, "-e", leaderCode], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim().split(/\s+/)[0]);
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `unexpected leader output: ${result.stdout}`);
  assert.equal(await waitGone(pid), true, "descendant survived the early codec leader exit");
});

test("terminating the per-codec host kills the codec tree", {
  skip, timeout: 30_000,
}, async (t) => {
  const leaderCode = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true });
    console.log(JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
    setInterval(() => {}, 1000);
  `;
  const hosted = spawn(host, ["--run", process.execPath, "-e", leaderCode], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  t.after(() => { try { hosted.kill(); } catch { /* already exited */ } });
  const pids = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("per-codec host produced no leader metadata")), 15_000);
    hosted.stdout.setEncoding("utf8");
    hosted.stdout.on("data", chunk => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(text.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    hosted.once("error", reject);
    hosted.once("exit", code => {
      if (text.includes("\n")) return;
      clearTimeout(timer);
      reject(new Error(`per-codec host exited ${String(code)} before reporting a leader`));
    });
  });
  assert.ok(Number.isSafeInteger(pids.leader) && pids.leader > 1);
  assert.ok(Number.isSafeInteger(pids.descendant) && pids.descendant > 1);
  process.kill(hosted.pid, "SIGKILL");
  assert.equal(await waitGone(pids.leader), true, "codec leader survived host termination");
  assert.equal(await waitGone(pids.descendant), true, "codec descendant survived host termination");
});
