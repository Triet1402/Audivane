// Trusted test-only spawn audit. It is loaded from an explicit environment path
// in main and in the private worker's execArgv, so it observes the same child
// spawning surface as production without exposing any renderer API.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const logPath = process.env.CODEC_ABX_SPAWN_AUDIT_LOG;
const allowlist = (process.env.CODEC_ABX_SPAWN_ALLOWLIST ?? "")
  .split(path.delimiter)
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const systemTaskkill = process.platform === "win32"
  ? path.resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
  : null;
const processHost = process.env.CODEC_ABX_TEST_PROCESS_HOST
  ? path.resolve(process.env.CODEC_ABX_TEST_PROCESS_HOST)
  : allowlist.find((entry) => /audivane-process-host\.exe$/i.test(entry)) ?? null;

function commandText(command) {
  return typeof command === "string" ? command : String(command);
}

function boundedTaskkill(argv) {
  if (argv.length < 3 || argv.length > 4) return false;
  return argv[0].toLowerCase() === "/pid" &&
    /^[0-9]+$/.test(argv[1]) &&
    argv[2].toLowerCase() === "/t" &&
    (argv.length === 3 || argv[3].toLowerCase() === "/f");
}

// The lifetime host may either guard the Electron main process or run exactly
// one explicitly allowed native tool. It never becomes a general launcher.
function boundedProcessHost(argv) {
  if (argv.length === 2 && argv[0] === "--guard" && /^[0-9]+$/.test(argv[1])) {
    return { kind: "guard", target: null };
  }
  if (argv.length >= 2 && argv[0] === "--run" && typeof argv[1] === "string" && argv[1].length > 0) {
    const target = path.resolve(argv[1]);
    if (target === systemTaskkill || target === processHost) return null;
    if (!allowlist.includes(target)) return null;
    return { kind: "run", target };
  }
  return null;
}

function audit(kind, command, args) {
  const text = commandText(command);
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (!logPath) throw new Error("spawn audit log is not configured");
  const resolved = path.resolve(text);
  let reason = null;
  const exactNative = allowlist.includes(resolved);
  // Windows process cleanup is a bounded system-helper exception: only the
  // exact System32 taskkill path with /pid NUMBER /T [/F] is accepted.
  const cleanup = systemTaskkill !== null && resolved === systemTaskkill && boundedTaskkill(argv);
  // The lifetime host is audited by shape and by its single allowed target.
  const hosted = processHost !== null && resolved === processHost ? boundedProcessHost(argv) : null;
  if (resolved === processHost && hosted === null) {
    reason ??= "process host arguments are not a bounded guard/run form";
  }
  if (!exactNative && !cleanup && hosted === null) {
    reason ??= resolved === systemTaskkill
      ? "taskkill arguments are not the bounded cleanup form"
      : "executable is not an explicitly allowed native tool";
  }
  fs.appendFileSync(logPath, `${JSON.stringify({ kind, command: text, args: argv, denied: reason !== null })}\n`);
  if (reason !== null) throw new Error(`spawn denied by test audit: ${reason}`);
}

for (const name of ["spawn", "exec", "execFile"]) {
  const original = childProcess[name];
  if (typeof original !== "function") continue;
  childProcess[name] = function audited(command, ...rest) {
    audit(name, command, rest[0]);
    return original.apply(this, [command, ...rest]);
  };
}
for (const name of ["spawnSync", "execSync", "execFileSync"]) {
  const original = childProcess[name];
  if (typeof original !== "function") continue;
  childProcess[name] = function audited(command, ...rest) {
    audit(name, command, rest[0]);
    return original.apply(this, [command, ...rest]);
  };
}
const originalFork = childProcess.fork;
childProcess.fork = function auditedFork(modulePath, args, options) {
  const forkOptions = !Array.isArray(args) && args ? args : options;
  audit("fork", forkOptions?.execPath ?? process.execPath,
    [modulePath, ...(Array.isArray(args) ? args : [])]);
  return originalFork.apply(this, arguments);
};
// Cover named ESM imports as well as callers using the CommonJS module object.
syncBuiltinESMExports();
