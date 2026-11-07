#!/usr/bin/env node
/**
 * Audit a prepared native codec bundle for release provenance.
 *
 * This is an independent check of the exact bytes and the claims recorded in
 * the FFmpeg/LDAC VERSION files. It does not trust PATH, does not download
 * anything, and never modifies the bundle. It verifies:
 *
 *   - x86-64 ELF executables with the executable bit set;
 *   - SHA-256 values recorded by tools/build_ffmpeg.sh / build_ldac_helper.sh;
 *   - dynamic dependencies are limited to the system C runtime;
 *   - no required glibc symbol is newer than the selected release baseline;
 *   - FFmpeg reports the intended LGPL configuration and all claimed codecs;
 *   - the optional LDAC helper reports its pinned versions and round-trips
 *     synthetic PCM without loss of the declared sample count.
 *
 * Usage:
 *   node tools/audit-native-provenance.mjs --bundle build/linux-baseline/artifacts
 *   node tools/audit-native-provenance.mjs --bundle DIR --baseline-glibc 2.39 \
 *     --json DIR/provenance.json
 *
 * Exit status 0 means every check passed. A missing bundle or a newer glibc
 * requirement is a failure, not a warning: a release must not infer
 * compatibility from statically linked codec libraries.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SCHEMA = "audivane-native-provenance-v1";
const DEFAULT_BASELINE_GLIBC = "2.39";
const ALLOWED_NEEDED = new Set([
  "libc.so.6",
  "libm.so.6",
  "libpthread.so.0",
  "libdl.so.2",
  "librt.so.1",
  "libmvec.so.1",
  "libgcc_s.so.1",
]);
const FFMPEG_ENCODERS = ["libopus", "aac", "libvorbis", "libmp3lame", "libtwolame", "liblc3", "sbc", "aptx", "aptx_hd"];
const FFMPEG_DECODERS = ["opus", "aac", "vorbis", "mp3float", "mp2float", "liblc3", "sbc", "aptx", "aptx_hd"];
const FFMPEG_MUXERS = ["opus", "ipod", "ogg", "mp3", "mp2", "lc3", "sbc", "aptx", "aptx_hd", "adts", "flac", "wav"];
const FFMPEG_DEMUXERS = ["aac", "aptx", "aptx_hd", "flac", "lc3", "mov", "mp3", "ogg", "sbc", "wav"];

function usage() {
  process.stdout.write(`Usage: node tools/audit-native-provenance.mjs [options]

Options:
  --bundle <dir>            Prepared resources root containing third_party/
                            (default: <repository>/third_party)
  --baseline-glibc <x.y>    Oldest supported glibc (default: ${DEFAULT_BASELINE_GLIBC})
  --json <file>             Write the audivane-native-provenance-v1 report
  --skip-functional         Skip FFmpeg/LDAC execution (provenance bytes only)
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const options = {
    bundle: undefined,
    baselineGlibc: DEFAULT_BASELINE_GLIBC,
    json: undefined,
    functional: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--bundle": options.bundle = argv[++index]; break;
      case "--baseline-glibc": options.baselineGlibc = argv[++index]; break;
      case "--json": options.json = argv[++index]; break;
      case "--skip-functional": options.functional = false; break;
      case "--help": case "-h": usage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.bundle) {
    const script = path.dirname(new URL(import.meta.url).pathname);
    options.bundle = path.resolve(script, "..");
  }
  if (!/^\d+\.\d+$/.test(options.baselineGlibc)) {
    throw new Error(`--baseline-glibc must look like 2.39, got: ${options.baselineGlibc}`);
  }
  return options;
}

function versionParts(value) {
  return value.split(".").map(Number);
}

function glibcNewer(actual, baseline) {
  const a = versionParts(actual);
  const b = versionParts(baseline);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function sha256(filename) {
  const hash = createHash("sha256");
  const handle = await fs.open(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function parseVersionFile(filename) {
  let text;
  try {
    text = await fs.readFile(filename, "utf8");
  } catch {
    return null;
  }
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9 _().-]*?):\s+(.*)$/.exec(line);
    if (match) {
      values.set(match[1].trim(), match[2].trim());
      continue;
    }
    const equals = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (equals) values.set(equals[1], equals[2].trim());
  }
  return { text, values };
}

async function elfFacts(filename, readelf) {
  const header = Buffer.alloc(64);
  const handle = await fs.open(filename, "r");
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const isElf = header[0] === 0x7f && header.subarray(1, 4).toString("ascii") === "ELF";
  const facts = {
    elf: isElf,
    class64: isElf && header[4] === 2,
    littleEndian: isElf && header[5] === 1,
    machine: isElf ? header.readUInt16LE(18) : null,
    type: isElf ? header.readUInt16LE(16) : null,
    needed: [],
    glibcVersions: [],
    maxGlibc: null,
  };
  if (!isElf) return facts;

  const dynamic = await run(readelf, ["-d", filename]);
  if (dynamic.code !== 0) throw new Error(`readelf -d failed for ${filename}: ${dynamic.stderr.trim()}`);
  for (const line of dynamic.stdout.split(/\r?\n/)) {
    const match = /\(NEEDED\).*\[(.*)\]/.exec(line);
    if (match) facts.needed.push(match[1]);
  }

  const versions = await run(readelf, ["--version-info", filename]);
  if (versions.code !== 0) throw new Error(`readelf --version-info failed for ${filename}: ${versions.stderr.trim()}`);
  const found = new Set();
  for (const line of versions.stdout.split(/\r?\n/)) {
    const match = /Name: (GLIBC_[0-9.]+)/.exec(line);
    if (match) found.add(match[1].slice("GLIBC_".length));
  }
  facts.glibcVersions = [...found].sort((left, right) => {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  facts.maxGlibc = facts.glibcVersions.at(-1) ?? null;
  return facts;
}

function containsName(table, name) {
  // FFmpeg prints comma-joined aliases (for example
  // "mov,mp4,m4a,3gp,3g2,mj2") in the name column.
  return table.split(/\r?\n/).some((line) => line.split(/[\s,]+/).includes(name));
}

async function capabilityTable(executable, flag) {
  const result = await run(executable, ["-hide_banner", flag]);
  if (result.code !== 0) throw new Error(`${executable} ${flag} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function pcmFixture(rate, channels, frames) {
  const samples = frames * channels;
  const buffer = Buffer.alloc(samples * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.round(8000 * Math.sin((2 * Math.PI * (440 + 220 * channel) * frame) / rate));
      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, value)), (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

async function auditLdacRoundTrip(helper, tempDirectory) {
  const pcm = pcmFixture(48000, 2, 4800);
  const pcmPath = path.join(tempDirectory, "ldac-input.pcm");
  const encodedPath = path.join(tempDirectory, "ldac-roundtrip.ldac");
  const decodedPath = path.join(tempDirectory, "ldac-output.pcm");
  await fs.writeFile(pcmPath, pcm);
  const encode = await run(helper, ["encode", "--rate", "48000", "--channels", "2", "--bitrate", "660", "--in", pcmPath, "--out", encodedPath]);
  if (encode.code !== 0) throw new Error(`LDAC encode failed: ${encode.stderr.trim()}`);
  const decode = await run(helper, ["decode", "--rate", "48000", "--channels", "2", "--bitrate", "660", "--in", encodedPath, "--out", decodedPath]);
  if (decode.code !== 0) throw new Error(`LDAC decode failed: ${decode.stderr.trim()}`);
  const decoded = await fs.stat(decodedPath);
  if (decoded.size !== pcm.length) {
    throw new Error(`LDAC round trip returned ${decoded.size} bytes, expected ${pcm.length}`);
  }
  return { encodedBytes: (await fs.stat(encodedPath)).size, decodedBytes: decoded.size };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundle = path.resolve(options.bundle);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const checks = [];
  const failures = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) failures.push(`${name}: ${typeof detail === "string" ? detail : "failed"}`);
  };

  const readelf = process.env.READELF || "readelf";
  try {
    await run(readelf, ["--version"]);
  } catch {
    throw new Error(`readelf is required (binutils); set READELF to its absolute path`);
  }

  const ffmpegRoot = path.join(bundle, "third_party", "ffmpeg");
  const ldacRoot = path.join(bundle, "third_party", "ldac");
  const ffmpeg = path.join(ffmpegRoot, "bin", "ffmpeg");
  const ffprobe = path.join(ffmpegRoot, "bin", "ffprobe");
  const helper = path.join(ldacRoot, "bin", "ldac_helper");

  const files = {};
  for (const [label, filename] of Object.entries({ ffmpeg, ffprobe, helper })) {
    try {
      const stat = await fs.stat(filename);
      files[label] = {
        path: path.relative(bundle, filename).split(path.sep).join("/"),
        bytes: stat.size,
        executable: (stat.mode & 0o111) !== 0,
        sha256: await sha256(filename),
      };
    } catch {
      files[label] = null;
    }
  }
  record("ffmpeg is a regular executable", Boolean(files.ffmpeg?.executable), files.ffmpeg?.path);
  record("ffprobe is a regular executable", Boolean(files.ffprobe?.executable), files.ffprobe?.path);

  const ffmpegVersion = await parseVersionFile(path.join(ffmpegRoot, "VERSION.txt"));
  record("FFmpeg VERSION.txt exists and is non-empty", Boolean(ffmpegVersion?.text.trim()));
  if (ffmpegVersion) {
    const v = ffmpegVersion.values;
    for (const [label, key, expression] of [
      ["FFmpeg version", "FFmpeg", /^\d+\.\d+/],
      ["source URL", "Source", /^https:\/\//],
      ["archive SHA-256", "SHA-256", /^[0-9a-f]{64}$/],
    ]) {
      record(`FFmpeg records ${label}`, expression.test(v.get(key) ?? ""), v.get(key));
    }
    const recorded = v.get("Binary SHA-256 (ffmpeg)");
    record("FFmpeg binary hash matches VERSION.txt", /^[0-9a-f]{64}$/.test(recorded ?? "") && recorded === files.ffmpeg?.sha256, recorded);
    const recordedProbe = v.get("Binary SHA-256 (ffprobe)");
    record("ffprobe binary hash matches VERSION.txt", /^[0-9a-f]{64}$/.test(recordedProbe ?? "") && recordedProbe === files.ffprobe?.sha256, recordedProbe);
    const baseline = v.get("Build baseline") ?? "";
    record("FFmpeg VERSION.txt records a build baseline", baseline.length > 0, baseline);
  }

  const ldacVersion = await parseVersionFile(path.join(ldacRoot, "VERSION.txt"));
  let ldacPresent = false;
  try {
    await fs.access(helper);
    ldacPresent = true;
  } catch {
    ldacPresent = false;
  }
  if (ldacPresent) {
    record("ldac_helper is a regular executable", Boolean(files.helper?.executable), files.helper?.path);
    record("LDAC VERSION.txt exists and is non-empty", Boolean(ldacVersion?.text.trim()));
    if (ldacVersion) {
      const v = ldacVersion.values;
      for (const name of ["libldac_repo", "libldac_commit", "libldacdec_repo", "libldacdec_commit"]) {
        record(`LDAC records ${name}`, /^(https|git):?\/\//.test(v.get(name) ?? "") || /^[0-9a-f]{40}$/.test(v.get(name) ?? ""), v.get(name));
      }
      record("LDAC records libldac commit", /^[0-9a-f]{40}$/.test(v.get("libldac_commit") ?? ""), v.get("libldac_commit"));
      record("LDAC records libldacdec commit", /^[0-9a-f]{40}$/.test(v.get("libldacdec_commit") ?? ""), v.get("libldacdec_commit"));
      record("LDAC binary hash matches VERSION.txt", v.get("binary_sha256") === files.helper?.sha256, v.get("binary_sha256"));
    }
  }

  for (const [label, file] of Object.entries(files)) {
    if (!file) {
      if (label !== "helper" || ldacPresent) record(`${label} exists`, false, "missing");
      continue;
    }
    const facts = await elfFacts(path.join(bundle, file.path), readelf);
    record(`${label} is a 64-bit little-endian x86-64 ELF`, facts.class64 && facts.littleEndian && facts.machine === 62, JSON.stringify({ machine: facts.machine }));
    record(`${label} is an executable or PIE`, facts.type === 2 || facts.type === 3, String(facts.type));
    const unexpected = facts.needed.filter((name) => !ALLOWED_NEEDED.has(name));
    record(`${label} needs only the system C runtime`, unexpected.length === 0, facts.needed.join(", "));
    record(`${label} requires glibc <= ${options.baselineGlibc}`, facts.maxGlibc !== null && !glibcNewer(facts.maxGlibc, options.baselineGlibc), facts.maxGlibc);
    file.elf = facts;
  }

  let functional = {};
  if (options.functional && files.ffmpeg) {
    const license = await run(ffmpeg, ["-hide_banner", "-L"]);
    const licenseText = `${license.stdout}\n${license.stderr}`;
    const licenseFlat = licenseText.replace(/\s+/g, " ");
    const licenseProbe = licenseFlat.replace(/Lesser General Public License/gi, "LGPL");
    const reportsLgpl = /LGPL|Lesser General Public License/i.test(licenseFlat);
    const reportsGpl = /GNU General Public License/i.test(licenseProbe) || /(^|[^A-Za-z])GPL([^A-Za-z]|$)/i.test(licenseProbe);
    record("FFmpeg reports LGPL, not GPL", reportsLgpl && !reportsGpl, reportsLgpl ? "LGPL" : "not LGPL");
    const buildconf = await run(ffmpeg, ["-hide_banner", "-buildconf"]);
    const buildconfText = `${buildconf.stdout}\n${buildconf.stderr}`;
    record("FFmpeg buildconf has no GPL/nonfree flag", !/--enable-(gpl|nonfree)/.test(buildconfText));
    record("FFmpeg buildconf enables liblc3", /--enable-liblc3/.test(buildconfText));
    for (const [label, flag, required] of [
      ["encoder", "-encoders", FFMPEG_ENCODERS],
      ["decoder", "-decoders", FFMPEG_DECODERS],
      ["muxer", "-muxers", FFMPEG_MUXERS],
      ["demuxer", "-demuxers", FFMPEG_DEMUXERS],
    ]) {
      const table = await capabilityTable(ffmpeg, flag);
      const missing = required.filter((name) => !containsName(table, name));
      record(`FFmpeg provides all required ${label}s`, missing.length === 0, missing.join(", ") || `${required.length} present`);
    }
    const probe = await run(ffprobe, ["-hide_banner", "-version"]);
    record("ffprobe runs", probe.code === 0, probe.stdout.split(/\r?\n/)[0]);
    functional.ffmpeg = { license: reportsLgpl ? "LGPL-2.1-or-later (as reported by ffmpeg -L)" : "not LGPL" };
  }
  if (options.functional && ldacPresent) {
    const version = await run(helper, ["--version"]);
    record("ldac_helper runs and reports versions", version.code === 0 && /libldac/.test(version.stdout + version.stderr), (version.stdout + version.stderr).trim().split(/\r?\n/)[0]);
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-provenance-"));
    try {
      functional.ldac = await auditLdacRoundTrip(helper, tempDirectory);
      record("ldac_helper 48 kHz stereo round trip keeps the declared sample count", true, `${functional.ldac.decodedBytes} bytes`);
    } catch (error) {
      record("ldac_helper 48 kHz stereo round trip keeps the declared sample count", false, error.message);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  const report = {
    schema: SCHEMA,
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    bundle: path.relative(root, bundle).split(path.sep).join("/") || ".",
    baseline: { glibc: options.baselineGlibc },
    platform: { platform: process.platform, arch: process.arch },
    files,
    checks,
    failures,
    functional,
    limitations: [
      "This audit verifies bytes, runtime linkage and capability tables, not audible quality.",
      "It does not certify codec conformance, patent licensing or clean-machine installation.",
    ],
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json) {
    await fs.mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await fs.writeFile(options.json, output);
  }
  process.stdout.write(output);
  if (!report.ok) {
    process.stderr.write(`\nNative provenance audit FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"}).\n`);
    process.exit(1);
  }
  process.stderr.write(`\nNative provenance audit passed: ${checks.length} checks, glibc <= ${options.baselineGlibc}.\n`);
}

await main();
