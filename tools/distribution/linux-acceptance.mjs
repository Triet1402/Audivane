#!/usr/bin/env node
/**
 * Reproducible host orchestrator for the Audivane Linux x64 installed-package
 * acceptance. It boots a disposable Ubuntu 24.04 VM from an existing cloud
 * image with KVM, copies only the versioned .deb and the guest probe, runs the
 * probe, and stores machine-readable evidence.
 *
 * The helper never downloads images/tools, never changes host packages or
 * policy, and never disables the Chromium sandbox. Supply a locally prepared
 * qemu-system-x86_64, Ubuntu cloud image, qemu firmware directory and an
 * SSH key whose public half was authorized by cloud-init.
 *
 * Usage:
 *   node tools/distribution/linux-acceptance.mjs \
 *     --deb dist/release/audivane_0.1.0_amd64.deb \
 *     --expected-sha256 <sha256 from SHA256SUMS.txt> \
 *     --qemu /tmp/audivane-qemu/usr/bin/qemu-system-x86_64 \
 *     --qemu-img /tmp/audivane-qemu/usr/bin/qemu-img \
 *     --qemu-data /tmp/audivane-qemu/usr/share/qemu \
 *     --image /tmp/audivane-images/noble-server-cloudimg-amd64.img \
 *     --ssh-key /tmp/audivane-vm/id_ed25519 \
 *     --vm-dir build/linux-acceptance/vm
 *
 * The guest probe is tools/distribution/linux-acceptance-guest.sh. Results are
 * written to <vm-dir>/evidence.json and <vm-dir>/guest/. A sandbox refusal is
 * recorded as `blocked`, not hidden; use --require-sandbox to make that fatal.
 */
import { createHash } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");

const SANDBOX_MESSAGE = /Failed to move to new namespace|SUID sandbox helper|No usable sandbox|namespace sandbox|sandbox_linux|Operation not permitted/;

export function parseArguments(args) {
  const options = {
    cpus: 4,
    memory: 6144,
    port: 2222,
    user: "audivane",
    bootTimeout: 300,
    probePackages: "xvfb xauth x11-utils xdotool dbus-x11",
    keep: false,
    requireSandbox: false,
    allowBlocked: false,
  };
  const value = index => {
    const candidate = args[index + 1];
    if (candidate === undefined || candidate === "" || candidate.startsWith("--")) {
      throw new Error(`${args[index]} requires a value`);
    }
    return candidate;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--deb") options.deb = path.resolve(value(index)), index += 1;
    else if (argument === "--upgrade-deb") options.upgradeDeb = path.resolve(value(index)), index += 1;
    else if (argument === "--expected-sha256") options.expectedSha256 = value(index).toLowerCase(), index += 1;
    else if (argument === "--qemu") options.qemu = path.resolve(value(index)), index += 1;
    else if (argument === "--qemu-img") options.qemuImg = path.resolve(value(index)), index += 1;
    else if (argument === "--qemu-data") options.qemuData = path.resolve(value(index)), index += 1;
    else if (argument === "--image") options.image = path.resolve(value(index)), index += 1;
    else if (argument === "--ssh-key") options.sshKey = path.resolve(value(index)), index += 1;
    else if (argument === "--vm-dir") options.vmDirectory = path.resolve(value(index)), index += 1;
    else if (argument === "--user") options.user = value(index), index += 1;
    else if (argument === "--cpus") options.cpus = Number(value(index)), index += 1;
    else if (argument === "--memory") options.memory = Number(value(index)), index += 1;
    else if (argument === "--port") options.port = Number(value(index)), index += 1;
    else if (argument === "--boot-timeout") options.bootTimeout = Number(value(index)), index += 1;
    else if (argument === "--probe-packages") options.probePackages = value(index), index += 1;
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--require-sandbox") options.requireSandbox = true;
    else if (argument === "--allow-blocked") options.allowBlocked = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  const required = ["deb", "qemu", "qemuData", "image", "sshKey", "vmDirectory"];
  for (const key of required) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be a TCP port");
  if (!Number.isInteger(options.cpus) || options.cpus < 1) throw new Error("--cpus must be a positive integer");
  if (!Number.isInteger(options.memory) || options.memory < 1024) throw new Error("--memory must be at least 1024 MiB");
  return options;
}

/** Stable subset of the guest probe output. Unknown/duplicate keys are retained. */
export function parseGuestResults(text) {
  const results = {};
  const duplicates = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^RESULT ([A-Za-z0-9_.-]+)=(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (Object.prototype.hasOwnProperty.call(results, key)) duplicates.push(key);
    results[key] = raw;
  }
  return { results, duplicates };
}

export function classifySandbox(results, launchLog = "") {
  const outcome = results["launch.outcome"] ?? "missing";
  const firstError = results["launch.first_error"] ?? "";
  const blocked = outcome === "sandbox-blocked" || (!outcome.startsWith("running") && SANDBOX_MESSAGE.test(launchLog));
  return {
    outcome,
    blocked,
    firstError,
    message: blocked
      ? "The installed executable refused to start because the normal Ubuntu user-namespace policy blocks Chromium's sandbox. No --no-sandbox, setuid helper or global policy change was used."
      : outcome === "running-sandboxed"
        ? "The installed executable stayed running with the Chromium sandbox unchanged and a sandboxed renderer was observed."
        : outcome === "running-until-timeout"
          ? "The installed executable stayed running with the Chromium sandbox unchanged until the probe timeout."
          : "The launch did not produce a recognized sandbox message; inspect the retained launch log.",
  };
}

export function mandatoryFailures(results, { allowBlocked = false } = {}) {
  const failures = [];
  for (const [key, value] of Object.entries(results)) {
    if (value === "fail") failures.push(key);
  }
  for (const key of ["install.completed", "files.executable", "files.native_manifest", "native.ffmpeg_runs", "native.all_encoders", "native.all_decoders", "native.linkage", "launch.display", "remove.install_tree_gone", "purge.no_dpkg_record"]) {
    if (results[key] === undefined) failures.push(`${key}:missing`);
    else if (results[key] !== "pass") failures.push(`${key}:${results[key]}`);
  }
  const acceptedOutcomes = allowBlocked
    ? ["sandbox-blocked", "running-sandboxed", "running-until-timeout"]
    : ["running-sandboxed"];
  if (!acceptedOutcomes.includes(results["launch.outcome"])) {
    failures.push("launch.outcome");
  }
  return [...new Set(failures)];
}

export function buildQemuArguments(options) {
  return [
    "-accel", "kvm",
    "-machine", "q35",
    "-cpu", "host",
    "-smp", String(options.cpus),
    "-m", String(options.memory),
    "-drive", `file=${options.disk},if=virtio,format=qcow2`,
    "-drive", `file=${options.seed},if=virtio,format=raw,readonly=on`,
    "-nic", `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${options.port}-:22`,
    "-device", "virtio-rng-pci",
    "-L", options.qemuData,
    "-display", "none",
    "-serial", `file:${options.serial}`,
    "-pidfile", options.pidfile,
    "-daemonize",
  ];
}

export function sshArguments(options, extra = []) {
  return [
    "-i", options.sshKey,
    "-p", String(options.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=5",
    `${options.user}@127.0.0.1`,
    ...extra,
  ];
}

async function fileSha256(filename) {
  return createHash("sha256").update(await fs.readFile(filename)).digest("hex");
}

async function run(command, args, options = {}) {
  try {
    return await exec(command, args, { maxBuffer: 128 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail || error.message}`);
  }
}

async function waitForSsh(options, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      await exec("ssh", sshArguments(options, ["true"]), { timeout: 10000, maxBuffer: 1024 * 1024 });
      return;
    } catch (error) {
      last = (error.stderr || error.message || "").trim().split("\n").slice(-1)[0] ?? "ssh failed";
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`VM did not accept SSH within ${timeoutSeconds}s: ${last}`);
}

async function writeSeed(options) {
  const seedDirectory = path.join(options.vmDirectory, "seed");
  await fs.rm(seedDirectory, { recursive: true, force: true });
  await fs.mkdir(seedDirectory, { recursive: true });
  const publicKey = (await fs.readFile(`${options.sshKey}.pub`, "utf8")).trim();
  await fs.writeFile(path.join(seedDirectory, "meta-data"), "instance-id: audivane-acceptance\nlocal-hostname: audivane-accept\n");
  await fs.writeFile(path.join(seedDirectory, "user-data"), `#cloud-config
hostname: audivane-accept
manage_etc_hosts: true
users:
  - default
  - name: ${options.user}
    gecos: Audivane acceptance
    groups: [sudo, adm, audio, video]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${publicKey}
ssh_pwauth: false
package_update: false
package_upgrade: false
`);
  const seed = path.join(options.vmDirectory, "seed.img");
  await fs.rm(seed, { force: true });
  await run("truncate", ["-s", "8M", seed]);
  await run("mkfs.vfat", ["-n", "CIDATA", seed]);
  await run(process.env.MCOPY || "mcopy", ["-i", seed, path.join(seedDirectory, "meta-data"), path.join(seedDirectory, "user-data"), "::"]);
  return seed;
}

async function prepareDisk(options) {
  await fs.mkdir(options.vmDirectory, { recursive: true });
  for (const name of ["disk.qcow2", "qemu.pid", "serial.log", "guest", "evidence.json"]) {
    await fs.rm(path.join(options.vmDirectory, name), { recursive: true, force: true });
  }
  const disk = path.join(options.vmDirectory, "disk.qcow2");
  const qemuImg = options.qemuImg || path.join(path.dirname(options.qemu), "qemu-img");
  await run(qemuImg, ["create", "-f", "qcow2", "-F", "qcow2", "-b", options.image, disk, "30G"]);
  return disk;
}

async function stopVm(options, pid) {
  if (!pid) return;
  try {
    await exec("ssh", sshArguments(options, ["sudo", "poweroff"]), { timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch {
    // The VM may already be gone or SSH may close during poweroff.
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log("See the header of tools/distribution/linux-acceptance.mjs for usage.");
    return { help: true };
  }
  const startedAt = new Date().toISOString();
  await fs.mkdir(options.vmDirectory, { recursive: true });
  const evidencePath = path.join(options.vmDirectory, "evidence.json");
  const guestDirectory = path.join(options.vmDirectory, "guest");
  const serial = path.join(options.vmDirectory, "serial.log");
  const pidfile = path.join(options.vmDirectory, "qemu.pid");

  const debSha256 = await fileSha256(options.deb);
  if (options.expectedSha256 && options.expectedSha256 !== debSha256) {
    throw new Error(`.deb SHA-256 ${debSha256} does not match the expected ${options.expectedSha256}`);
  }
  const imageSha256 = await fileSha256(options.image);

  const seed = await writeSeed(options);
  const disk = await prepareDisk(options);
  const qemuArguments = buildQemuArguments({ ...options, seed, disk, serial, pidfile });

  const qemuVersion = (await run(options.qemu, ["--version"])).stdout.trim().split("\n")[0];
  const launch = spawn(options.qemu, qemuArguments, { stdio: "inherit", env: process.env });
  const launchFailure = await new Promise(resolve => {
    launch.once("error", resolve);
    launch.once("exit", code => resolve(code === 0 ? null : new Error(`qemu exited with code ${code}`)));
    setTimeout(() => resolve(null), 1500);
  });
  if (launchFailure) throw launchFailure;
  const pid = Number((await fs.readFile(pidfile, "utf8")).trim());
  if (!Number.isInteger(pid)) throw new Error("QEMU did not write a pidfile");

  let guestStatus = "not-run";
  try {
    await waitForSsh(options, options.bootTimeout);
    const guestScript = path.join(scriptDirectory, "linux-acceptance-guest.sh");
    await run("scp", ["-i", options.sshKey, "-P", String(options.port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", options.deb, `${options.user}@127.0.0.1:~/audivane-acceptance.deb`]);
    if (options.upgradeDeb) {
      await run("scp", ["-i", options.sshKey, "-P", String(options.port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", options.upgradeDeb, `${options.user}@127.0.0.1:~/audivane-upgrade.deb`]);
    }
    await run("scp", ["-i", options.sshKey, "-P", String(options.port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", guestScript, `${options.user}@127.0.0.1:~/linux-acceptance-guest.sh`]);
    if (options.probePackages.trim()) {
      await run("ssh", sshArguments(options, [`sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${options.probePackages}`]), { timeout: 600000 });
    }
    const guestArguments = ["bash", "linux-acceptance-guest.sh", "--deb", "audivane-acceptance.deb", "--out", "linux-acceptance"];
    if (options.expectedSha256) guestArguments.push("--expected-sha256", options.expectedSha256);
    if (options.upgradeDeb) guestArguments.push("--upgrade-deb", "audivane-upgrade.deb");
    try {
      const probe = await exec("ssh", sshArguments(options, guestArguments), { timeout: 1800000, maxBuffer: 256 * 1024 * 1024 });
      guestStatus = probe.stdout;
    } catch (error) {
      guestStatus = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
    }
    await fs.mkdir(guestDirectory, { recursive: true });
    await run("scp", ["-i", options.sshKey, "-P", String(options.port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-r", `${options.user}@127.0.0.1:~/linux-acceptance/.`, guestDirectory]);
  } finally {
    if (!options.keep) await stopVm(options, pid);
  }

  const parsed = parseGuestResults(guestStatus);
  const launchLog = await fs.readFile(path.join(guestDirectory, "launch.log"), "utf8").catch(() => "");
  const sandbox = classifySandbox(parsed.results, launchLog);
  const failures = mandatoryFailures(parsed.results, { allowBlocked: options.allowBlocked });
  const evidence = {
    schema: "audivane-linux-installed-acceptance-v1",
    startedAt,
    completedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, qemu: qemuVersion },
    image: { path: options.image, sha256: imageSha256 },
    artifact: { file: path.basename(options.deb), sha256: debSha256, expectedSha256: options.expectedSha256 ?? null },
    guest: parsed.results,
    hostSide: { build: "see tools/distribution/release.mjs", vm: "disposable qemu overlay", cpus: options.cpus, memoryMiB: options.memory },
    sandbox,
    failures,
    duplicates: parsed.duplicates,
    limitations: [
      "A VM with normal Ubuntu 24.04 policy is not a physical clean machine; firmware, audio devices and vendor drivers are still unexercised.",
      "No human listening, physical headphones, Bluetooth, Windows or AppImage acceptance is implied.",
      "A sandbox refusal with the stock Ubuntu user-namespace restriction must be resolved by an explicit installed-path policy decision; this probe does not add --no-sandbox, a setuid helper or a global AppArmor change.",
    ],
    result: failures.length === 0 && !(options.requireSandbox && sandbox.blocked) ? "completed" : "completed-with-failures",
    policy: {
      requireSandboxedLaunch: !options.allowBlocked,
      allowBlocked: options.allowBlocked,
      implementation: "running-sandboxed is required by default; sandbox-blocked/running-until-timeout are diagnostic only with --allow-blocked",
    },
  };
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    evidence: evidencePath,
    result: evidence.result,
    failures,
    sandbox: { outcome: sandbox.outcome, blocked: sandbox.blocked, firstError: sandbox.firstError },
    guestLog: path.join(guestDirectory, "guest.log"),
  }, null, 2));
  if (failures.length > 0 || (options.requireSandbox && sandbox.blocked)) process.exitCode = 1;
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
