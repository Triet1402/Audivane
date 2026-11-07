import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { CODEC_IDS } from "@codec-abx/contracts";

import type { NativeBinaryResolution } from "../src/typescript/binaries.js";
import type { NativeCodecCapabilities } from "../src/typescript/capabilities.js";
import {
  assessNativeReadiness,
  formatNativeReadiness,
  type NativeReadinessReport,
} from "../src/typescript/readiness.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(REPOSITORY_ROOT, "packages/engine-native/src/typescript/readiness-cli.ts");

const ALL_ENCODERS = ["libopus", "aac", "libvorbis", "libmp3lame", "libtwolame", "liblc3", "sbc", "aptx", "aptx_hd"];
const ALL_DECODERS = ["opus", "aac", "vorbis", "mp3float", "mp2float", "liblc3", "sbc", "aptx", "aptx_hd"];
const ALL_MUXERS = ["opus", "ipod", "ogg", "mp3", "mp2", "lc3", "sbc", "aptx", "aptx_hd"];
const ALL_DEMUXERS = ["ogg", "mov", "mp3", "lc3", "sbc", "aptx", "aptx_hd"];

function resolution(overrides: Partial<NativeBinaryResolution> = {}): NativeBinaryResolution {
  return {
    repositoryRoot: "/prepared",
    ffmpegPath: "/prepared/third_party/ffmpeg/bin/ffmpeg",
    ffprobePath: "/prepared/third_party/ffmpeg/bin/ffprobe",
    ldacHelperPath: "/prepared/third_party/ldac/bin/ldac_helper",
    ffmpegReason: null,
    ffprobeReason: null,
    ldacHelperReason: null,
    ...overrides,
  };
}

function capabilities({ versions = true, ldac = true, encoders = ALL_ENCODERS, decoders = ALL_DECODERS, muxers = ALL_MUXERS, demuxers = ALL_DEMUXERS }: {
  versions?: boolean;
  ldac?: boolean;
  encoders?: readonly string[];
  decoders?: readonly string[];
  muxers?: readonly string[];
  demuxers?: readonly string[];
} = {}): NativeCodecCapabilities {
  const names = { encoders: new Set(encoders), decoders: new Set(decoders), muxers: new Set(muxers), demuxers: new Set(demuxers) };
  return {
    schema: "native-codec-capabilities-v1",
    ffmpegVersion: versions ? "ffmpeg version 9.0.2-test" : null,
    ffprobeVersion: versions ? "ffprobe version 9.0.2-test" : null,
    ldacHelperVersion: ldac ? "ldac_helper 1.0.0-test" : null,
    tools: { ffmpeg: versions, ffprobe: versions, ldacHelper: ldac },
    codecs: CODEC_IDS.map((codecId) => {
      if (codecId === "ldac") return {
        codecId, availability: ldac ? "available" : "unavailable",
        encoder: "ldac_helper encode", decoder: "ldac_helper decode",
        reason: ldac ? null : "LDAC helper unavailable: not found",
      };
      const availability = versions && names.encoders.size > 0 && names.decoders.size > 0 ? "available" : "unavailable";
      return {
        codecId, availability,
        encoder: "encoder", decoder: "decoder",
        reason: availability === "available" ? null : "FFmpeg encoder probe returned no usable encoders",
      };
    }),
    limitations: ["fixture capabilities"],
  };
}

interface FakeTools {
  readonly directory: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly ldacPath: string;
  readonly includeFfprobe: boolean;
  readonly includeLdac: boolean;
}

function writeExecutable(filename: string, contents: string): Promise<void> {
  return fs.writeFile(filename, contents, { mode: 0o755 });
}

async function fakeTools(
  t: TestContext,
  { includeFfprobe = true, includeEncoders = true, includeLdac = true }: {
    includeFfprobe?: boolean;
    includeEncoders?: boolean;
    includeLdac?: boolean;
  } = {},
): Promise<FakeTools> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-readiness-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const list = (label: string, values: readonly string[]) =>
    `${label}:\n${values.map((name) => ` A.... ${name}              fixture`).join("\n")}\n`;
  const ffmpeg = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("-version")) process.stdout.write("ffmpeg version 9.0.2-test\\n");
else if (args.includes("-encoders")) process.stdout.write(${JSON.stringify(includeEncoders ? list("Encoders", ALL_ENCODERS) : "Encoders:\\n")});
else if (args.includes("-decoders")) process.stdout.write(${JSON.stringify(includeEncoders ? list("Decoders", ALL_DECODERS) : "Decoders:\\n")});
else if (args.includes("-muxers")) process.stdout.write(${JSON.stringify(includeEncoders ? list("Muxers", ALL_MUXERS) : "Muxers:\\n")});
else if (args.includes("-demuxers")) process.stdout.write(${JSON.stringify(includeEncoders ? list("Demuxers", ALL_DEMUXERS) : "Demuxers:\\n")});
`;
  const ffprobe = `#!${process.execPath}
if (process.argv.includes("-version")) process.stdout.write("ffprobe version 9.0.2-test\\n");
`;
  const ldac = `#!${process.execPath}
process.stdout.write("ldac_helper 1.0.0-test\\nlibldac_commit=fixture\\nlibldacdec_commit=fixture\\n");
`;
  const ffmpegPath = path.join(directory, "ffmpeg");
  const ffprobePath = path.join(directory, "ffprobe");
  const ldacPath = path.join(directory, "ldac_helper");
  await writeExecutable(ffmpegPath, ffmpeg);
  if (includeFfprobe) await writeExecutable(ffprobePath, ffprobe);
  if (includeLdac) await writeExecutable(ldacPath, ldac);
  return { directory, ffmpegPath, ffprobePath, ldacPath, includeFfprobe, includeLdac };
}

function cliEnvironment(tools: FakeTools, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["CODEC_ABX_FFMPEG", "CODEC_ABX_FFPROBE", "CODEC_ABX_LDAC_HELPER", "CODEC_ABX_NATIVE_BUNDLE_DIR"]) {
    delete environment[name];
  }
  environment.PATH = tools.directory;
  environment.CODEC_ABX_FFMPEG = tools.ffmpegPath;
  if (tools.includeFfprobe) environment.CODEC_ABX_FFPROBE = tools.ffprobePath;
  if (tools.includeLdac) environment.CODEC_ABX_LDAC_HELPER = tools.ldacPath;
  return { ...environment, ...extra };
}

function runCli(environment: NodeJS.ProcessEnv, extraArguments: readonly string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, "--json", ...extraArguments], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("readiness reports actual codec capability and treats LDAC as optional", () => {
  const withoutLdac = assessNativeReadiness(
    resolution({ ldacHelperPath: null, ldacHelperReason: "not found" }),
    capabilities({ ldac: false }),
    "linux",
    "x64",
  );
  assert.equal(withoutLdac.ok, true);
  assert.equal(withoutLdac.tools.ffmpeg.available, true);
  assert.equal(withoutLdac.tools.ldacHelper.available, false);
  assert.equal(withoutLdac.codecs.find((codec) => codec.codecId === "ldac")!.required, false);
  assert.ok(withoutLdac.warnings.some((warning) => /LDAC is optional/.test(warning)));
  assert.match(formatNativeReadiness(withoutLdac), /Native readiness: READY/);

  const missingTools = assessNativeReadiness(
    resolution({ ffmpegPath: null, ffprobePath: null, ldacHelperPath: null,
      ffmpegReason: "not found", ffprobeReason: "not found", ldacHelperReason: "not found" }),
    capabilities({ versions: false, ldac: false }),
    "linux",
    "x64",
  );
  assert.equal(missingTools.ok, false);
  assert.ok(missingTools.problems.some((problem) => /FFmpeg is required/.test(problem)));
  assert.ok(missingTools.problems.some((problem) => /ffprobe is required/.test(problem)));
  assert.ok(missingTools.remediation.some((step) => /tools\/build_ffmpeg\.sh/.test(step)));
  assert.ok(!missingTools.problems.some((problem) => /LDAC/.test(problem)));
});

test("CLI is machine-readable and uses the real shared probe with optional helper", async t => {
  const tools = await fakeTools(t);
  const result = runCli(cliEnvironment(tools));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as NativeReadinessReport;
  assert.equal(report.schema, "native-readiness-v1");
  assert.equal(report.ok, true);
  assert.equal(report.tools.ffmpeg.available, true);
  assert.equal(report.tools.ffprobe.available, true);
  assert.equal(report.tools.ldacHelper.available, true);
  assert.ok(report.codecs.every((codec) => codec.availability === "available"));
  assert.match(report.tools.ffmpeg.version!, /9\.0\.2-test/);
});

test("missing required ffprobe fails while absent optional LDAC only warns", async t => {
  const tools = await fakeTools(t, { includeFfprobe: false, includeLdac: false });
  // Isolate vendored discovery as well as PATH: a prepared developer checkout
  // legitimately supplies the tools that this negative fixture is withholding.
  const result = runCli(cliEnvironment(tools, { PATH: "" }), ["--repository-root", tools.directory]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as NativeReadinessReport;
  assert.equal(report.ok, false);
  assert.equal(report.tools.ffmpeg.available, true);
  assert.equal(report.tools.ffprobe.available, false);
  assert.equal(report.tools.ldacHelper.available, false);
  assert.ok(report.problems.some((problem) => /ffprobe is required/.test(problem)));
  assert.ok(report.warnings.some((warning) => /LDAC is optional/.test(warning)));
  assert.ok(!report.problems.some((problem) => /LDAC/.test(problem)));
});

test("an executable that answers --version is not enough to claim codec support", async t => {
  const tools = await fakeTools(t, { includeEncoders: false });
  const result = runCli(cliEnvironment(tools));
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as NativeReadinessReport;
  assert.equal(report.ok, false);
  assert.equal(report.tools.ffmpeg.available, true);
  assert.ok(report.codecs.some((codec) => codec.required && codec.availability === "unavailable"));
  assert.ok(report.problems.some((problem) => /Required codec .* unavailable/.test(problem)));
});

test("readiness treats Windows x64 as a supported target with Windows remediation", () => {
  const ready = assessNativeReadiness(resolution(), capabilities(), "win32", "x64");
  assert.equal(ready.ok, true);
  assert.equal(ready.platform.supported, true);
  assert.match(formatNativeReadiness(ready), /Platform: win32 x64 \(supported target\)/);

  const missing = assessNativeReadiness(
    resolution({ ffmpegPath: null, ffprobePath: null, ldacHelperPath: null,
      ffmpegReason: "not found", ffprobeReason: "not found", ldacHelperReason: "not found" }),
    capabilities({ versions: false, ldac: false }),
    "win32",
    "x64",
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.platform.supported, true);
  assert.ok(!missing.problems.some((problem) => /validated for/.test(problem)));
  assert.ok(missing.remediation.some((step) => /tools\/build_ffmpeg_windows\.sh/.test(step)));
  assert.ok(missing.remediation.some((step) => /ldac_helper\.exe/.test(step)));

  const unsupported = assessNativeReadiness(resolution(), capabilities(), "win32", "arm64");
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.platform.supported, false);
  assert.ok(unsupported.problems.some((problem) =>
    /validated for Linux x64 and Windows x64 only; current host is win32 arm64/.test(problem)));
});

test("readiness refuses a Windows bundle on Linux and points to the structural audit", async t => {
  if (process.platform === "win32") {
    t.skip("the inverse host is covered by the Windows readiness report test");
    return;
  }
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "native-readiness-cross-"));
  t.after(() => fs.rm(bundle, { recursive: true, force: true }));
  await fs.mkdir(path.join(bundle, "third_party/ffmpeg/bin"), { recursive: true });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"), "fixture");
  const tools = await fakeTools(t);
  const result = runCli(cliEnvironment(tools), ["--native-bundle", bundle]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Windows \.exe payloads/);
  assert.match(result.stderr, /windows-native-audit\.mjs/);
});

test("a named native bundle does not silently fall back to PATH", async t => {
  const tools = await fakeTools(t);
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "native-readiness-bundle-"));
  t.after(() => fs.rm(bundle, { recursive: true, force: true }));
  // The bundle is intentionally empty; PATH contains usable tools. The closed
  // bundle check must still fail rather than reporting the host as ready.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: tools.directory, CODEC_ABX_NATIVE_BUNDLE_DIR: bundle };
  for (const name of ["CODEC_ABX_FFMPEG", "CODEC_ABX_FFPROBE", "CODEC_ABX_LDAC_HELPER"]) delete env[name];
  const result = runCli(env);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as NativeReadinessReport;
  assert.equal(report.ok, false);
  assert.equal(report.tools.ffmpeg.available, false);
  assert.equal(report.tools.ffmpeg.path, null);
});
