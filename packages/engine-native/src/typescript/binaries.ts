import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeBinaryOptions {
  /** Explicit executable. When supplied but unusable, no fallback is attempted. */
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly ldacHelperPath?: string;
  /** Repository whose vendored builds are the local default. */
  readonly repositoryRoot?: string;
  /** Test seam; defaults to the process PATH. */
  readonly pathEnv?: string;
  /**
   * Trusted Windows process-lifetime host. Required for every Windows spawn;
   * an absent host is a refusal, never an uncontained fallback. Ignored on
   * POSIX where detached process groups provide descendant custody.
   */
  readonly windowsProcessHost?: string;
}

export interface NativeBinaryResolution {
  readonly ffmpegPath: string | null;
  readonly ffprobePath: string | null;
  readonly ldacHelperPath: string | null;
  readonly ffmpegReason: string | null;
  readonly ffprobeReason: string | null;
  readonly ldacHelperReason: string | null;
  readonly repositoryRoot: string;
}

const EXECUTABLE_NAMES = Object.freeze({
  ffmpeg: process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"],
  ffprobe: process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"],
  ldacHelper: process.platform === "win32"
    ? ["ldac_helper.exe", "ldac_helper"]
    : ["ldac_helper"],
});

function defaultRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathRoots(pathEnv: string | undefined): string[] {
  if (!pathEnv) return [];
  return pathEnv
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

interface ResolveOneOptions {
  readonly explicit: string | undefined;
  readonly names: readonly string[];
  readonly roots: readonly string[];
  readonly pathRoots: readonly string[];
}

function resolveOne(options: ResolveOneOptions): { path: string | null; reason: string | null } {
  if (options.explicit !== undefined) {
    const resolved = path.resolve(options.explicit);
    return isExecutableFile(resolved)
      ? { path: resolved, reason: null }
      : { path: null, reason: "the explicit executable path is not an executable file" };
  }
  for (const root of options.roots) {
    for (const name of options.names) {
      const candidate = path.join(root, name);
      if (isExecutableFile(candidate)) return { path: candidate, reason: null };
    }
  }
  for (const root of options.pathRoots) {
    for (const name of options.names) {
      const candidate = path.join(root, name);
      if (isExecutableFile(candidate)) return { path: candidate, reason: null };
    }
  }
  return {
    path: null,
    reason: "not found as an executable in the vendored build directories or PATH",
  };
}

/**
 * Safe local resolution with no interpreter involvement:
 * explicit executable -> vendored repository build -> PATH.
 *
 * An explicit path is authoritative: if it is unusable this returns a reason
 * rather than silently borrowing another binary.
 */
export function resolveNativeBinaries(options: NativeBinaryOptions = {}): NativeBinaryResolution {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot());
  const pathDirectories = pathRoots(options.pathEnv ?? process.env.PATH);
  const ffmpegRoots = [path.join(repositoryRoot, "third_party", "ffmpeg", "bin")];
  const ldacRoots = [path.join(repositoryRoot, "third_party", "ldac", "bin")];

  const ffmpeg = resolveOne({
    explicit: options.ffmpegPath,
    names: EXECUTABLE_NAMES.ffmpeg,
    roots: ffmpegRoots,
    pathRoots: pathDirectories,
  });
  const ffprobe = resolveOne({
    explicit: options.ffprobePath,
    names: EXECUTABLE_NAMES.ffprobe,
    roots: ffmpegRoots,
    pathRoots: pathDirectories,
  });
  const ldacHelper = resolveOne({
    explicit: options.ldacHelperPath,
    names: EXECUTABLE_NAMES.ldacHelper,
    roots: ldacRoots,
    pathRoots: pathDirectories,
  });

  return Object.freeze({
    ffmpegPath: ffmpeg.path,
    ffprobePath: ffprobe.path,
    ldacHelperPath: ldacHelper.path,
    ffmpegReason: ffmpeg.reason,
    ffprobeReason: ffprobe.reason,
    ldacHelperReason: ldacHelper.reason,
    repositoryRoot,
  });
}
