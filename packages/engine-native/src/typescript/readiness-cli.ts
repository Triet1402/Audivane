import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveNativeBinaries, type NativeBinaryOptions } from "./binaries.js";
import { probeNativeCodecCapabilities } from "./capabilities.js";
import { NativeProcessManager } from "./process.js";
import {
  assessNativeReadiness,
  formatNativeReadiness,
} from "./readiness.js";

const USAGE = `Usage: npm run check:native -- [options]

Probe the actual native FFmpeg/ffprobe (and optional LDAC helper) toolchain on
Linux x64 or Windows x64. A resolved file is not treated as codec support:
encoders, decoders, muxers and demuxers are probed. Exit 0 means required tools
and codecs are ready; optional LDAC unavailability is reported as a warning.

Options:
  --json                     Emit the native-readiness-v1 report as JSON
  --native-bundle <dir>      Prepared resources root containing third_party/
                             (does not fall back to PATH); uses .exe names on
                             Windows
  --repository-root <dir>    Repository root containing third_party/
  --ffmpeg <absolute-path>   Authoritative FFmpeg executable
  --ffprobe <absolute-path>  Authoritative ffprobe executable
  --ldac-helper <absolute>   Authoritative optional LDAC helper
  --windows-process-host <absolute>
                             Required Windows codec lifetime host
  --help                     Show this help

Environment (same trusted names as the desktop launcher):
  CODEC_ABX_FFMPEG, CODEC_ABX_FFPROBE, CODEC_ABX_LDAC_HELPER
  CODEC_ABX_NATIVE_BUNDLE_DIR, CODEC_ABX_PROCESS_HOST

Run tools/verification/windows-native-audit.mjs to validate a prepared Windows
PE/DLL bundle without executing it. That structural audit is not a codec probe.`;

interface CliOptions {
  readonly json: boolean;
  readonly help: boolean;
  readonly nativeBundle: string | undefined;
  readonly repositoryRoot: string | undefined;
  readonly ffmpegPath: string | undefined;
  readonly ffprobePath: string | undefined;
  readonly ldacHelperPath: string | undefined;
  readonly windowsProcessHost: string | undefined;
}

class UsageError extends Error {}

function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a path value`);
  }
  return value;
}

function parseArguments(args: readonly string[]): CliOptions {
  let json = false;
  let help = false;
  let nativeBundle: string | undefined;
  let repositoryRoot: string | undefined;
  let ffmpegPath: string | undefined;
  let ffprobePath: string | undefined;
  let ldacHelperPath: string | undefined;
  let windowsProcessHost: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    switch (argument) {
      case "--json": json = true; break;
      case "--help": case "-h": help = true; break;
      case "--native-bundle": nativeBundle = valueAfter(args, index, argument); index += 1; break;
      case "--repository-root": repositoryRoot = valueAfter(args, index, argument); index += 1; break;
      case "--ffmpeg": ffmpegPath = valueAfter(args, index, argument); index += 1; break;
      case "--ffprobe": ffprobePath = valueAfter(args, index, argument); index += 1; break;
      case "--ldac-helper": ldacHelperPath = valueAfter(args, index, argument); index += 1; break;
      case "--windows-process-host": windowsProcessHost = valueAfter(args, index, argument); index += 1; break;
      default: throw new UsageError(`Unknown argument: ${argument}`);
    }
  }
  return { json, help, nativeBundle, repositoryRoot, ffmpegPath, ffprobePath, ldacHelperPath, windowsProcessHost };
}

function absoluteExecutable(
  flagValue: string | undefined,
  environmentName: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = flagValue ?? environment[environmentName];
  if (value === undefined || value === "") return undefined;
  if (!path.isAbsolute(value)) {
    throw new UsageError(`${environmentName} must be an absolute trusted executable path`);
  }
  return value;
}

function existingDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new UsageError(`${label} does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new UsageError(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function bundleTargetProblems(bundle: string): string | null {
  const windowsExecutable = existsSync(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"));
  const linuxExecutable = existsSync(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg"));
  if (windowsExecutable && process.platform !== "win32") {
    return "This native bundle contains Windows .exe payloads. Probe it on Windows x64; " +
      "use tools/verification/windows-native-audit.mjs for a structural PE/DLL audit on this host.";
  }
  if (linuxExecutable && process.platform === "win32") {
    return "This native bundle contains Linux ELF payloads. Probe it on Linux x64 or prepare a Windows bundle.";
  }
  return null;
}

function resolutionOptions(options: CliOptions): NativeBinaryOptions {
  const environmentBundle = process.env.CODEC_ABX_NATIVE_BUNDLE_DIR;
  if (options.nativeBundle !== undefined && options.repositoryRoot !== undefined) {
    throw new UsageError("Use either --native-bundle or --repository-root, not both");
  }
  const bundle = options.nativeBundle !== undefined
    ? existingDirectory(options.nativeBundle, "Native bundle directory")
    : environmentBundle !== undefined && environmentBundle !== ""
      ? existingDirectory(environmentBundle, "CODEC_ABX_NATIVE_BUNDLE_DIR")
      : undefined;
  if (bundle !== undefined) {
    const problem = bundleTargetProblems(bundle);
    if (problem !== null) throw new UsageError(problem);
  }
  const repositoryRoot = bundle ?? (options.repositoryRoot === undefined
    ? undefined
    : existingDirectory(options.repositoryRoot, "Repository root"));
  const ffmpegPath = absoluteExecutable(options.ffmpegPath, "CODEC_ABX_FFMPEG", process.env);
  const ffprobePath = absoluteExecutable(options.ffprobePath, "CODEC_ABX_FFPROBE", process.env);
  const ldacHelperPath = absoluteExecutable(
    options.ldacHelperPath,
    "CODEC_ABX_LDAC_HELPER",
    process.env,
  );
  const windowsProcessHost = absoluteExecutable(
    options.windowsProcessHost,
    "CODEC_ABX_PROCESS_HOST",
    process.env,
  );
  // A named bundle is a closed check: falling back to PATH could hide missing
  // files in the very bundle a release is about to ship.
  const bundleOnly = { ...(bundle === undefined ? {} : { pathEnv: "" }) };
  return {
    ...bundleOnly,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
    ...(ldacHelperPath === undefined ? {} : { ldacHelperPath }),
    ...(windowsProcessHost === undefined ? {} : { windowsProcessHost }),
  };
}

async function main(args: readonly string[]): Promise<number> {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const nativeOptions = resolutionOptions(options);
  const resolution = resolveNativeBinaries(nativeOptions);
  const manager = new NativeProcessManager(undefined, nativeOptions.windowsProcessHost);
  try {
    const capabilities = await probeNativeCodecCapabilities(manager, resolution);
    const report = assessNativeReadiness(resolution, capabilities);
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatNativeReadiness(report)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await manager.dispose();
  }
}

if (process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown readiness failure";
    process.stderr.write(`Native readiness check failed: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
