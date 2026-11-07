import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WINDOWS_SYSTEM_DLLS, inspectPeExecutable } from "./native-bundle.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const WINDOWS_PROCESS_HOST_DIRECTORY = "process-host";
export const WINDOWS_PROCESS_HOST_BUILD_DIRECTORY = "windows-process-host";
export const WINDOWS_PROCESS_HOST_FILENAME = "audivane-process-host.exe";
export const WINDOWS_PROCESS_HOST_RELATIVE =
  `${WINDOWS_PROCESS_HOST_DIRECTORY}/${WINDOWS_PROCESS_HOST_FILENAME}`;

function isSystemImport(name) {
  return WINDOWS_SYSTEM_DLLS.has(name.toLowerCase()) ||
    /^(api-ms-win-|ext-ms-)/i.test(name);
}

/**
 * Resolve the production Windows lifetime host. An explicit path is
 * authoritative; no PATH, checkout or package discovery is attempted. A
 * relative explicit path is refused so the packaged app and the audited bytes
 * cannot disagree about which helper is owned.
 */
export function resolveWindowsProcessHost(root = repositoryRoot, environment = process.env) {
  const configured = environment.CODEC_ABX_PROCESS_HOST;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured)) {
      throw new Error("CODEC_ABX_PROCESS_HOST must be an absolute trusted executable path");
    }
    return path.resolve(configured);
  }
  return path.join(root, "build", WINDOWS_PROCESS_HOST_BUILD_DIRECTORY, "bin", WINDOWS_PROCESS_HOST_FILENAME);
}

/**
 * Validate and copy the app-owned lifetime host into a Windows resources tree.
 * The helper is a 64-bit console PE with only Windows system imports; a missing
 * file, wrong architecture, DLL image or unexpected local dependency fails
 * packaging instead of producing an app that cannot establish containment.
 */
export async function stageWindowsProcessHost(source, resourcesRoot, { outputDirectory = WINDOWS_PROCESS_HOST_DIRECTORY } = {}) {
  const absolute = path.resolve(source);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    throw new Error(`Windows process lifetime host is missing: ${absolute} (build it with tools/build_windows_process_host.sh)`, { cause: error });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Windows process lifetime host is not a non-empty file: ${absolute}`);
  }
  const inspection = await inspectPeExecutable(absolute);
  if (!inspection.ok || !inspection.isX64 || inspection.dll) {
    throw new Error(`Windows process lifetime host is not a Windows x64 PE32+ executable: ${absolute}`);
  }
  const missing = inspection.imports.filter(name => !isSystemImport(name));
  if (missing.length > 0) {
    throw new Error(
      `Windows process lifetime host imports dependencies that would not be shipped: ${missing.join(", ")}`,
    );
  }
  const bytes = await fs.readFile(absolute);
  const destination = path.join(path.resolve(resourcesRoot), outputDirectory, WINDOWS_PROCESS_HOST_FILENAME);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(absolute, destination);
  return Object.freeze({
    source: absolute,
    path: `${outputDirectory.split(path.sep).join("/")}/${WINDOWS_PROCESS_HOST_FILENAME}`,
    absolutePath: destination,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    imports: Object.freeze([...inspection.imports]),
  });
}
