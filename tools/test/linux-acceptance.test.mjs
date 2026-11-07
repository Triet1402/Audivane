import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildQemuArguments,
  classifySandbox,
  mandatoryFailures,
  parseArguments,
  parseGuestResults,
  sshArguments,
} from "../distribution/linux-acceptance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("guest RESULT lines are parsed without treating logs as evidence", () => {
  const { results, duplicates } = parseGuestResults([
    "noise",
    "RESULT install.completed=pass",
    "RESULT native.glibc_floor=2.39",
    "RESULT install.completed=pass",
    "RESULT launch.first_error=Failed to move to new namespace|No usable sandbox",
  ].join("\n"));
  assert.equal(results["install.completed"], "pass");
  assert.equal(results["native.glibc_floor"], "2.39");
  assert.match(results["launch.first_error"], /Failed to move/);
  assert.deepEqual(duplicates, ["install.completed"]);
});

test("sandbox classification preserves refusal instead of converting it to a pass", () => {
  const blocked = classifySandbox({ "launch.outcome": "sandbox-blocked", "launch.first_error": "No usable sandbox" });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.message, /No --no-sandbox/);

  const running = classifySandbox({ "launch.outcome": "running-sandboxed" });
  assert.equal(running.blocked, false);
  assert.match(running.message, /sandboxed renderer/);

  const timeout = classifySandbox({ "launch.outcome": "running-until-timeout" });
  assert.equal(timeout.blocked, false);
  assert.match(timeout.message, /stayed running/);

  const inferred = classifySandbox({ "launch.outcome": "exited-without-sandbox-message" }, "SUID sandbox helper binary was found");
  assert.equal(inferred.blocked, true);
});

test("mandatory failures include explicit failures and missing critical evidence", () => {
  assert.deepEqual(mandatoryFailures({}), [
    "install.completed:missing",
    "files.executable:missing",
    "files.native_manifest:missing",
    "native.ffmpeg_runs:missing",
    "native.all_encoders:missing",
    "native.all_decoders:missing",
    "native.linkage:missing",
    "launch.display:missing",
    "remove.install_tree_gone:missing",
    "purge.no_dpkg_record:missing",
    "launch.outcome",
  ]);
  const failures = mandatoryFailures({
    "install.completed": "pass",
    "files.executable": "pass",
    "files.native_manifest": "pass",
    "native.ffmpeg_runs": "pass",
    "native.all_encoders": "pass",
    "native.all_decoders": "pass",
    "native.linkage": "pass",
    "launch.display": "pass",
    "launch.outcome": "running-sandboxed",
    "remove.install_tree_gone": "pass",
    "purge.no_dpkg_record": "pass",
    "files.chrome_sandbox_not_setuid": "fail",
  });
  assert.deepEqual(failures, ["files.chrome_sandbox_not_setuid"]);
  const diagnostic = mandatoryFailures({
    "install.completed": "pass",
    "files.executable": "pass",
    "files.native_manifest": "pass",
    "native.ffmpeg_runs": "pass",
    "native.all_encoders": "pass",
    "native.all_decoders": "pass",
    "native.linkage": "pass",
    "launch.display": "pass",
    "launch.outcome": "sandbox-blocked",
    "remove.install_tree_gone": "pass",
    "purge.no_dpkg_record": "pass",
  }, { allowBlocked: true });
  assert.deepEqual(diagnostic, []);
  const strict = mandatoryFailures({
    "install.completed": "pass",
    "files.executable": "pass",
    "files.native_manifest": "pass",
    "native.ffmpeg_runs": "pass",
    "native.all_encoders": "pass",
    "native.all_decoders": "pass",
    "native.linkage": "pass",
    "launch.display": "pass",
    "launch.outcome": "sandbox-blocked",
    "remove.install_tree_gone": "pass",
    "purge.no_dpkg_record": "pass",
  });
  assert.deepEqual(strict, ["launch.outcome"]);
  // An unconfirmed probe is a failure even when the field exists.
  assert.ok(mandatoryFailures({ "native.linkage": "unconfirmed" }).includes("native.linkage:unconfirmed"));
});

test("QEMU arguments use KVM, an immutable seed and a disposable overlay", () => {
  const args = buildQemuArguments({
    cpus: 2,
    memory: 4096,
    disk: "/tmp/disk.qcow2",
    seed: "/tmp/seed.img",
    port: 2222,
    qemuData: "/tmp/qemu/share",
    serial: "/tmp/serial.log",
    pidfile: "/tmp/qemu.pid",
  });
  const line = args.join(" ");
  assert.match(line, /-accel kvm/);
  assert.match(line, /file=\/tmp\/disk\.qcow2,if=virtio,format=qcow2/);
  assert.match(line, /file=\/tmp\/seed\.img,if=virtio,format=raw,readonly=on/);
  assert.match(line, /hostfwd=tcp:127\.0\.0\.1:2222-:22/);
  assert.doesNotMatch(line, /--no-sandbox|--disable-setuid-sandbox/);
});

test("SSH options target the forwarded loopback port and a supplied key", () => {
  const args = sshArguments({ sshKey: "/tmp/key", port: 2200, user: "audivane" }, ["true"]);
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("/tmp/key"));
  assert.ok(args.includes("2200"));
  assert.ok(args.includes("audivane@127.0.0.1"));
  assert.equal(args.at(-2), "audivane@127.0.0.1");
  assert.equal(args.at(-1), "true");
});

test("CLI rejects incomplete invocations and documents all required paths", () => {
  assert.throws(() => parseArguments(["--deb", "x.deb"]), /--qemu is required/);
  assert.throws(() => parseArguments(["--deb"]), /--deb requires a value/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
  const parsed = parseArguments([
    "--deb", "a.deb",
    "--qemu", "qemu-system-x86_64",
    "--qemu-data", "share/qemu",
    "--image", "noble.img",
    "--ssh-key", "id_ed25519",
    "--vm-dir", "vm",
  ]);
  assert.equal(parsed.cpus, 4);
  assert.equal(parsed.memory, 6144);
  assert.equal(parsed.requireSandbox, false);
});

test("guest probe never requests a disabled Chromium sandbox or a setuid helper", async () => {
  const guest = await readFile(path.join(root, "tools/distribution/linux-acceptance-guest.sh"), "utf8");
  assert.doesNotMatch(guest, /chmod\s+(?:u\+s|4755|4[0-7][0-7][0-7])/);
  assert.match(guest, /sandbox unchanged/);
  assert.match(guest, /launch\.outcome sandbox-blocked/);
  // The guest probe must compare the actual installed GLIBC symbol floor.
  assert.match(guest, /GLIBC_2/);
  assert.match(guest, /apt-get install -y --allow-downgrades/);
  assert.match(guest, /apt-get purge -y audivane/);
  // Installed-path linkage must sweep every ELF object, not only the three
  // codec commands, and desktop/AppArmor integration must be recorded.
  assert.match(guest, /native\.elf_objects_checked/);
  assert.match(guest, /find "\$APP" -type f/);
  assert.match(guest, /launch\.wm_class/);
  assert.match(guest, /remove\.apparmor_profile_unloaded/);
});
