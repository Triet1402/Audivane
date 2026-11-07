import { normalizeLinuxTree } from "./deb.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PRODUCT, platformConfig, releaseDirectory, root, unpackedDirectory } from "./config.mjs";

const exec = promisify(execFile);

async function fileSha256(filename) {
  const bytes = await fs.readFile(filename);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build an AppDir from the exact unpacked Linux package. An AppImage is only
 * produced when an explicit appimagetool path is supplied; packaging does not
 * download a runtime or silently fall back to a wrapper archive.
 */
export async function buildAppImage(options = {}) {
  const source = path.resolve(options.packagedDirectory ?? unpackedDirectory("linux"));
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const version = workspace.version;
  const configuration = platformConfig("linux");
  const appDir = path.resolve(options.appDir ?? path.join(root, "build/appimage/Audivane.AppDir"));
  await fs.rm(appDir, { recursive: true, force: true });
  const installRoot = path.join(appDir, "opt/audivane");
  await fs.mkdir(path.dirname(installRoot), { recursive: true });
  await fs.cp(source, installRoot, { recursive: true, dereference: false });
  await fs.rename(path.join(installRoot, configuration.unpackedExecutable), path.join(installRoot, PRODUCT.linuxExecutable));
  const distributionPath = path.join(installRoot, "resources/distribution.json");
  const distribution = JSON.parse(await fs.readFile(distributionPath, "utf8"));
  distribution.executable = PRODUCT.linuxExecutable;
  distribution.executableRenamedFrom = configuration.unpackedExecutable;
  await fs.writeFile(distributionPath, `${JSON.stringify(distribution, null, 2)}\n`);
  const launcher = path.join(appDir, "AppRun");
  await fs.writeFile(launcher, `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
exec "$HERE/opt/audivane/audivane" "$@"
`, { mode: 0o755 });
  await fs.copyFile(path.join(root, "assets/brand/icons/audivane-256.png"), path.join(appDir, "audivane.png"));
  await fs.copyFile(path.join(root, "assets/brand/icons/audivane-256.png"), path.join(appDir, ".DirIcon"));
  await fs.writeFile(path.join(appDir, "audivane.desktop"), `[Desktop Entry]
Type=Application
Name=${PRODUCT.name}
GenericName=Audio codec comparison
Comment=${PRODUCT.subtitle}
Exec=audivane
Icon=audivane
Terminal=false
Categories=AudioVideo;Audio;Utility;
Keywords=audio;codec;ABX;blind;listening;
StartupNotify=true
StartupWMClass=audivane
X-AppImage-Version=${version}
`);
  await normalizeLinuxTree(appDir);
  const outputDirectory = path.resolve(options.outputDirectory ?? releaseDirectory());
  await fs.mkdir(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, `Audivane-${version}-x86_64.AppImage`);
  const tool = options.appimagetool ?? process.env.APPIMAGETOOL;
  const runtime = options.runtime ?? process.env.APPIMAGETOOL_RUNTIME_FILE;
  const runtimeSha256 = options.runtimeSha256 ?? process.env.APPIMAGETOOL_RUNTIME_SHA256;
  if (!tool) {
    return Object.freeze({ appDir, path: output, produced: false, reason: "APPIMAGETOOL was not supplied; AppDir staged but no AppImage was produced" });
  }
  // Current appimagetool versions can fetch the latest type2 runtime when no
  // runtime is supplied. Never permit a live download: require an explicit
  // runtime file and its expected SHA-256.
  if (!runtime) {
    throw new Error("Refusing to run appimagetool without an explicit --appimage-runtime file; modern appimagetool may download a live runtime");
  }
  if (!runtimeSha256 || !/^[0-9a-f]{64}$/i.test(runtimeSha256)) {
    throw new Error("--appimage-runtime-sha256 (or APPIMAGETOOL_RUNTIME_SHA256) must pin the exact runtime file");
  }
  const actualRuntimeSha256 = await fileSha256(runtime);
  if (actualRuntimeSha256 !== runtimeSha256.toLowerCase()) {
    throw new Error(`AppImage runtime SHA-256 mismatch: expected ${runtimeSha256.toLowerCase()}, got ${actualRuntimeSha256}`);
  }
  await fs.rm(output, { force: true });
  await exec(tool, ["--runtime-file", runtime, appDir, output], {
    env: {
      ...process.env,
      ARCH: "x86_64",
      APPIMAGETOOL_RUNTIME_FILE: runtime,
      SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? String(Math.floor(Date.now() / 1000)),
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const bytes = await fs.readFile(output);
  return Object.freeze({ appDir, path: output, produced: true, runtime, runtimeSha256: actualRuntimeSha256, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
