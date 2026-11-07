import { packageJobs } from './jobs.mjs';
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { PRODUCT, debianVersion, linuxPackageFilename, platformConfig, releaseDirectory, root } from "./config.mjs";

const exec = promisify(execFile);

/** Supported Linux runtime floor for the Linux x64 beta. */
export const BASELINE_GLIBC = "2.39";

const DEBIAN_DEPENDENCIES = [
  // The installed-path userns attachment needs apparmor_parser on restricted
  // Ubuntu hosts; declaring it prevents an apparently installed but unusable app.
  "apparmor",
  // Ubuntu 24.04 renamed several libraries with the t64 suffix. The unsuffixed
  // names remain provided there and are the real package names on older
  // Debian/Ubuntu releases, so alternatives cover both layouts.
  "libgtk-3-0 | libgtk-3-0t64",
  "libnss3",
  "libxss1",
  "libasound2 | libasound2t64",
  "libatk-bridge2.0-0 | libatk-bridge2.0-0t64",
  "libcups2 | libcups2t64",
  "libgbm1",
  "libdrm2",
  "libxkbcommon0",
  "libxcomposite1",
  "libxdamage1",
  "libxrandr2",
  "libx11-xcb1",
  "libxcb-dri3-0",
  "libpango-1.0-0",
  "libcairo2",
  // xdg-open / file dialogs use the desktop's default handler.
  "xdg-utils",
];

async function walkSize(directory) {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await walkSize(absolute);
    else if (entry.isFile()) bytes += (await fs.stat(absolute)).size;
  }
  return bytes;
}

async function walkFiles(directory, relative = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : path.join(relative, entry.name);
    const absolute = path.join(directory, child);
    if (entry.isDirectory()) files.push(...await walkFiles(directory, child));
    // md5sums covers regular package files only. Package symlinks (including
    // /usr/bin/audivane -> /opt/audivane/audivane) must not be dereferenced:
    // doing so reads the host target and records the wrong file.
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
    else if (entry.isSymbolicLink()) continue;
    else throw new Error(`Unsupported package entry: ${child}`);
  }
  return files;
}

async function elfFiles(directory, relative = "") {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : path.join(relative, entry.name);
    const absolute = path.join(directory, child);
    if (entry.isDirectory()) {
      found.push(...await elfFiles(directory, child));
      continue;
    }
    if (!entry.isFile()) continue;
    const handle = await fs.open(absolute, "r");
    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, 4, 0);
      if (bytesRead === 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
        found.push({ relative: child.split(path.sep).join("/"), absolute });
      }
    } finally {
      await handle.close();
    }
  }
  return found;
}

export async function normalizeLinuxTree(directory) {
  await fs.chmod(directory, 0o755);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeLinuxTree(absolute);
      await fs.chmod(absolute, 0o755);
    } else if (entry.isSymbolicLink()) {
      // Symlinks are kept exactly as staged.
    } else if (entry.name === "chrome-sandbox") {
      // Never ship the helper setuid. Secure launch relies on Chromium's user
      // namespace sandbox; installation must not silently create a root helper.
      await fs.chmod(absolute, 0o755);
    } else {
      const mode = (await fs.stat(absolute)).mode & 0o111 ? 0o755 : 0o644;
      await fs.chmod(absolute, mode);
    }
  }
}

async function glibcVersions(executable) {
  const { stdout } = await exec("readelf", ["--version-info", executable], { maxBuffer: 128 * 1024 * 1024 });
  const versions = new Set(stdout.match(/GLIBC_([0-9]+(?:\.[0-9]+)+)/g)?.map(value => value.slice("GLIBC_".length)) ?? []);
  return [...versions];
}

function versionParts(version) {
  return version.split(".").map(part => Number(part));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Audit every shipped ELF object, including Electron's helper libraries, not
 * only the three codec commands. A package cannot support the chosen Ubuntu
 * 24.04 baseline merely by declaring a libc dependency: if any shipped object
 * requires a newer GLIBC symbol, packaging fails with the offending files.
 * CODEC_ABX_DEB_GLIBC_FLOOR is intentionally unsupported so an environment
 * variable cannot lower the claimed floor.
 */
export async function auditGlibcFloor(packagedDirectory) {
  if (process.env.CODEC_ABX_DEB_GLIBC_FLOOR) {
    throw new Error("CODEC_ABX_DEB_GLIBC_FLOOR is not honored; the libc floor is audited from the shipped ELF objects and capped at the supported baseline");
  }
  const files = await elfFiles(packagedDirectory);
  if (files.length === 0) throw new Error("Packaged application contains no ELF objects to audit");
  const audited = [];
  let required = null;
  for (const file of files) {
    const versions = await glibcVersions(file.absolute);
    const highest = versions.reduce((current, version) => current === null || compareVersions(version, current) > 0 ? version : current, null);
    audited.push(Object.freeze({ path: file.relative, glibc: highest }));
    if (highest !== null && (required === null || compareVersions(highest, required) > 0)) required = highest;
  }
  if (required === null) throw new Error("No GLIBC symbol requirements were found in the packaged ELF objects");
  if (compareVersions(required, BASELINE_GLIBC) > 0) {
    const offenders = audited.filter(file => file.glibc !== null && compareVersions(file.glibc, BASELINE_GLIBC) > 0)
      .map(file => `${file.path} (GLIBC_${file.glibc})`);
    throw new Error(`Packaged ELF objects exceed the supported GLIBC_${BASELINE_GLIBC} baseline:\n- ${offenders.join("\n- ")}`);
  }
  return Object.freeze({
    baseline: BASELINE_GLIBC,
    required,
    files: Object.freeze(audited),
  });
}

/** Backwards-compatible scalar helper for callers that only need the audit. */
export async function detectGlibcFloor(packagedDirectory) {
  return (await auditGlibcFloor(packagedDirectory)).required;
}

async function maintscript(kind, body) {
  return `#!/bin/sh\nset -e\n${body}\nexit 0\n`;
}

function noticeName(name) {
  return /^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT|README|VERSION)(\..*)?$/i.test(name) ||
    /\.(txt|md|html|license)$/i.test(name);
}

/**
 * The prepared distribution tree may contain a collector's complete notice,
 * license and source-metadata payload. Keep the exact text files beside the
 * installed application and also under /usr/share/doc, without copying native
 * binaries or following symlinks.
 */
async function copyNoticeMaterials(source, target, relative = "", { thirdPartyOnly = false } = {}) {
  for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Distribution notice input contains a symlink: ${child}`);
    if (entry.isDirectory()) {
      await copyNoticeMaterials(source, target, child, { thirdPartyOnly });
      continue;
    }
    if (!entry.isFile()) throw new Error(`Distribution notice input contains an unsupported entry: ${child}`);
    if (thirdPartyOnly && !noticeName(entry.name)) continue;
    const destination = path.join(target, child);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, child), destination);
  }
}

export async function buildDeb(options = {}) {
  const packagedDirectory = path.resolve(options.packagedDirectory ?? path.join(root, "dist/desktop/Codec ABX-linux-x64"));
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const distribution = JSON.parse(await fs.readFile(path.join(packagedDirectory, "resources/distribution.json"), "utf8"));
  if (distribution.version !== workspace.version) throw new Error("Packaged desktop version disagrees with the workspace manifest");
  if (distribution.nativeBundle?.mode !== "portable-native-bundle-v1") {
    throw new Error("Refusing a distribution .deb without the explicit provenance-controlled native bundle");
  }
  const version = workspace.version;
  const packageVersion = debianVersion(version);
  const glibc = await auditGlibcFloor(packagedDirectory);
  const configuration = platformConfig("linux");
  const staging = path.resolve(options.stagingDirectory ?? path.join(root, "build/debian", `audivane_${packageVersion}_amd64`));
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(path.join(staging, "DEBIAN"), { recursive: true });
  const installRoot = path.join(staging, "opt/audivane");
  await fs.mkdir(path.dirname(installRoot), { recursive: true });
  await fs.cp(packagedDirectory, installRoot, { recursive: true, dereference: false });
  const sourceExecutable = path.join(installRoot, configuration.unpackedExecutable);
  const targetExecutable = path.join(installRoot, PRODUCT.linuxExecutable);
  await fs.rename(sourceExecutable, targetExecutable);
  // The installed command is renamed from the unpacked technical name. Keep
  // the packaged metadata truthful so installed-path acceptance and release
  // verification see the executable that actually exists.
  const distributionPath = path.join(installRoot, "resources/distribution.json");
  const installedDistribution = JSON.parse(await fs.readFile(distributionPath, "utf8"));
  installedDistribution.executable = PRODUCT.linuxExecutable;
  installedDistribution.executableRenamedFrom = configuration.unpackedExecutable;
  await fs.writeFile(distributionPath, `${JSON.stringify(installedDistribution, null, 2)}\n`);
  await normalizeLinuxTree(installRoot);

  const bin = path.join(staging, "usr/bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.symlink("/opt/audivane/audivane", path.join(bin, "audivane"));

  // Narrow, executable-specific userns attachment required by Ubuntu 24.04's
  // unprivileged-namespace restriction. It does not disable AppArmor globally,
  // does not make chrome-sandbox setuid and does not ship --no-sandbox.
  const apparmorDirectory = path.join(staging, "etc/apparmor.d");
  await fs.mkdir(apparmorDirectory, { recursive: true });
  await fs.writeFile(path.join(apparmorDirectory, "audivane"), `abi <abi/4.0>,
include <tunables/global>

profile audivane "/opt/audivane/audivane" flags=(unconfined) {
  userns,
}
`);

  const applications = path.join(staging, "usr/share/applications");
  await fs.mkdir(applications, { recursive: true });
  await fs.writeFile(path.join(applications, "audivane.desktop"), `[Desktop Entry]
Type=Application
Name=${PRODUCT.name}
GenericName=Audio codec comparison
Comment=${PRODUCT.subtitle}
Exec=/opt/audivane/audivane
Icon=audivane
Terminal=false
Categories=AudioVideo;Audio;Utility;
Keywords=audio;codec;ABX;blind;listening;
StartupNotify=true
StartupWMClass=audivane
`);

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const target = path.join(staging, `usr/share/icons/hicolor/${size}x${size}/apps`);
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(path.join(root, `assets/brand/icons/audivane-${size}.png`), path.join(target, "audivane.png"));
  }
  const scalable = path.join(staging, "usr/share/icons/hicolor/scalable/apps");
  await fs.mkdir(scalable, { recursive: true });
  await fs.copyFile(path.join(root, "assets/brand/audivane-mark.svg"), path.join(scalable, "audivane.svg"));

  const documentation = path.join(staging, "usr/share/doc/audivane");
  await fs.mkdir(documentation, { recursive: true });
  await fs.copyFile(path.join(root, "LICENSE"), path.join(documentation, "LICENSE"));
  await fs.copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(documentation, "THIRD_PARTY_NOTICES.md"));
  await fs.copyFile(path.join(root, "packages/measurements/NOTICE.md"), path.join(documentation, "measurements-NOTICE.md"));
  await fs.copyFile(path.join(packagedDirectory, "LICENSE"), path.join(documentation, "Electron-LICENSE"));
  await fs.copyFile(path.join(packagedDirectory, "LICENSES.chromium.html"), path.join(documentation, "Electron-LICENSES.chromium.html"));
  await fs.copyFile(path.join(root, "README.md"), path.join(documentation, "README.md"));
  await fs.writeFile(path.join(documentation, "copyright"), `Audivane
Copyright 2026 Triet (@Triet1402)

The project-owned code is licensed under the MIT license; see LICENSE.
Electron, Chromium, codec libraries, fonts and the measurement implementation
retain their separate licenses and attribution. See THIRD_PARTY_NOTICES.md and
the files in /opt/audivane. This package is not a complete source-offer payload.
`);
  // Preserve the prepared collector payload exactly. The same files remain
  // under /opt/audivane/resources; this copy makes them discoverable through
  // the standard Debian documentation path.
  const packagedResources = path.join(packagedDirectory, "resources");
  const materialTarget = path.join(documentation, "distribution-resources");
  const excluded = new Set(["app", "icons", "third_party", "distribution.json", "native-bundle-manifest.json"]);
  for (const entry of await fs.readdir(packagedResources, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Packaged distribution materials contain a symlink: ${entry.name}`);
    if (entry.isDirectory()) await copyNoticeMaterials(packagedResources, materialTarget, entry.name);
    else if (entry.isFile()) {
      await fs.mkdir(materialTarget, { recursive: true });
      await fs.copyFile(path.join(packagedResources, entry.name), path.join(materialTarget, entry.name));
    } else throw new Error(`Packaged distribution materials contain an unsupported entry: ${entry.name}`);
  }
  const thirdParty = path.join(packagedResources, "third_party");
  if (await fs.access(thirdParty).then(() => true, () => false)) {
    await copyNoticeMaterials(thirdParty, path.join(materialTarget, "third_party"), "", { thirdPartyOnly: true });
  }
  await fs.writeFile(path.join(documentation, "changelog.Debian.gz"), gzipSync(`audivane (${packageVersion}) unstable; urgency=medium

  * Audivane ${version} Linux x64 package.

 -- Triet (@Triet1402)  ${new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000)) * 1000).toUTCString()}
`));

  const installedBytes = await walkSize(installRoot);
  const installedKb = Math.max(1, Math.ceil((installedBytes + (await walkSize(path.join(staging, "usr")))) / 1024));
  await fs.writeFile(path.join(staging, "DEBIAN/control"), `Package: audivane
Version: ${packageVersion}
Architecture: amd64
Maintainer: Triet (@Triet1402)
Installed-Size: ${installedKb}
Section: sound
Priority: optional
Depends: libc6 (>= ${glibc.baseline}), ${DEBIAN_DEPENDENCIES.join(", ")}
Recommends: pulseaudio | pipewire
Description: ${PRODUCT.name} - blind audio comparisons
 ${PRODUCT.subtitle} Local native codec preparation, blinded A/B/X
 listening and exact-byte export. Audio stays on the device.
 .
 This package carries the pinned FFmpeg/ffprobe/LDAC native tools and the
 Electron runtime. It does not ship the developer checkout, Node.js,
 browser codec WebAssembly or developer library paths.
`);
  await fs.writeFile(path.join(staging, "DEBIAN/postinst"), await maintscript("postinst", `if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi\nif command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi\nif [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then\n  apparmor_parser -r /etc/apparmor.d/audivane\nfi`), { mode: 0o755 });
  await fs.writeFile(path.join(staging, "DEBIAN/prerm"), await maintscript("prerm", `# Unload while the conffile still exists. Never unload during an upgrade:\n# the new package's postinst reloads the profile after replacement.\ncase "$1" in\n  remove|deconfigure)\n    if [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1 && [ -f /etc/apparmor.d/audivane ] && grep -q '^audivane (' /sys/kernel/security/apparmor/profiles; then\n      apparmor_parser -R /etc/apparmor.d/audivane\n    fi\n    ;;\n  upgrade|failed-upgrade)\n    ;;\nesac`), { mode: 0o755 });
  await fs.writeFile(path.join(staging, "DEBIAN/postrm"), await maintscript("postrm", `# prerm already unloaded the profile while dpkg still had the conffile.\nif [ "$1" = purge ]; then rm -f /etc/apparmor.d/audivane; fi\nif command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi\nif command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi`), { mode: 0o755 });
  await fs.writeFile(path.join(staging, "DEBIAN/conffiles"), "/etc/apparmor.d/audivane\n");

  const md5 = [];
  for (const file of (await walkFiles(staging)).filter(file => !file.startsWith("DEBIAN/")).sort()) {
    const bytes = await fs.readFile(path.join(staging, file));
    md5.push(`${createHash("md5").update(bytes).digest("hex")}  ${file}`);
  }
  await fs.writeFile(path.join(staging, "DEBIAN/md5sums"), `${md5.join("\n")}\n`);
  await normalizeLinuxTree(staging);

  const outputDirectory = path.resolve(options.outputDirectory ?? releaseDirectory());
  await fs.mkdir(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, linuxPackageFilename(version));
  await fs.rm(output, { force: true });
  const environment = { ...process.env, LC_ALL: "C.UTF-8", DPKG_DEB_THREADS_MAX: process.env.DPKG_DEB_THREADS_MAX ?? String(packageJobs(options.jobs)) };
  await exec("dpkg-deb", ["--build", "--root-owner-group", "--uniform-compression", staging, output], { env: environment, maxBuffer: 64 * 1024 * 1024 });
  const bytes = await fs.readFile(output);
  return Object.freeze({
    path: output,
    version,
    packageVersion,
    glibc,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
