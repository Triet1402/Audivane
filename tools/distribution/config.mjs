import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Distribution identity. Publisher/repository URLs and a reverse-DNS app ID are
 * deliberately absent until the owner chooses them; packaging must not invent
 * public endpoints, credentials or a publisher namespace.
 */
export const PRODUCT = Object.freeze({
  name: "Audivane",
  subtitle: "Blind audio comparisons.",
  // Linux desktop entry / package / command name. Also used for Windows
  // shortcuts and the per-user install folder.
  id: "audivane",
  // Retained technical executable name for the unpacked Linux test package.
  // The AppArmor profile used by the developer/test host is attached to this
  // exact path; distribution artifacts use the Audivane name below.
  legacyExecutable: "codec-abx",
  linuxExecutable: "audivane",
  windowsExecutable: "Audivane",
});

export const DISTRIBUTION = Object.freeze({
  linux: Object.freeze({
    platform: "linux",
    arch: "x64",
    electronPlatform: "linux",
    unpackedName: "Codec ABX",
    unpackedExecutable: PRODUCT.legacyExecutable,
    installDir: "/opt/audivane",
    dataDirs: Object.freeze({
      bin: "/usr/bin",
      applications: "/usr/share/applications",
      icons: "/usr/share/icons/hicolor",
      doc: "/usr/share/doc/audivane",
    }),
  }),
  win32: Object.freeze({
    platform: "win32",
    arch: "x64",
    electronPlatform: "win32",
    unpackedName: PRODUCT.name,
    unpackedExecutable: PRODUCT.windowsExecutable,
  }),
});

export const ICONS = Object.freeze({
  png16: "assets/brand/icons/audivane-16.png",
  png24: "assets/brand/icons/audivane-24.png",
  png32: "assets/brand/icons/audivane-32.png",
  png48: "assets/brand/icons/audivane-48.png",
  png64: "assets/brand/icons/audivane-64.png",
  png128: "assets/brand/icons/audivane-128.png",
  png256: "assets/brand/icons/audivane-256.png",
  png512: "assets/brand/icons/audivane-512.png",
  ico: "assets/brand/icons/audivane.ico",
});

export function normalizePlatform(value = "linux") {
  const key = String(value).toLowerCase();
  if (["linux", "linux-x64"].includes(key)) return "linux";
  if (["win32", "windows", "windows-x64", "win"].includes(key)) return "win32";
  throw new Error(`Unsupported distribution platform: ${value} (expected linux or win32)`);
}

export function platformConfig(platform = "linux") {
  const key = normalizePlatform(platform);
  return DISTRIBUTION[key];
}

export async function readRootManifest() {
  return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
}

/** Debian's tilde form sorts before the matching final release. */
export function debianVersion(version) {
  return version.replace(/-([0-9A-Za-z.]+)$/, "~$1");
}

export function linuxPackageFilename(version) {
  return `audivane_${debianVersion(version)}_amd64.deb`;
}

export function windowsInstallerFilename(version) {
  return `Audivane-Setup-${version}-x64.exe`;
}

export function windowsZipFilename(version) {
  return `Audivane-${version}-win32-x64.zip`;
}

export function releaseDirectory() {
  return path.join(root, "dist/release");
}

/**
 * Final distribution input staged by tools/distribution/prepare-materials.mjs:
 * pinned native tools plus the complete notice/license collection. Explicit
 * --native-bundle/--resources still wins, but release builds default here so a
 * bare developer resources tree is not silently treated as a release payload.
 */
export function distributionResourcesDirectory(platform = "linux") {
  return path.join(root, "build/distribution-resources", platform === "win32" ? "win32" : "linux");
}

export function unpackedDirectory(platform = "linux") {
  const config = platformConfig(platform);
  return path.join(root, "dist/desktop", `${config.unpackedName}-${config.platform}-${config.arch}`);
}

export function unpackedExecutable(platform = "linux") {
  const config = platformConfig(platform);
  const extension = config.platform === "win32" ? ".exe" : "";
  return path.join(unpackedDirectory(platform), `${config.unpackedExecutable}${extension}`);
}

const workspacePrefix = "@codec-abx/";

/**
 * Fail before building when the app version, workspace versions, internal
 * dependency references or lockfile disagree. Release filenames and the
 * packaged manifest all derive from this one value.
 */
export async function verifyVersionConsistency() {
  const manifest = await readRootManifest();
  const version = manifest.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Root package version is not a coherent release version: ${String(version)}`);
  }
  if (manifest.license !== "MIT") throw new Error("Root package license must remain MIT for this distribution");
  const files = [path.join(root, "package.json")];
  for (const group of ["apps", "packages"]) {
    const entries = await fs.readdir(path.join(root, group), { withFileTypes: true });
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const manifest = path.join(root, group, entry.name, "package.json");
      // A source package directory without a manifest (e.g. packages/tooling)
      // is not a workspace package and must not acquire a version.
      if (await fs.access(manifest).then(() => true, () => false)) files.push(manifest);
    }
  }
  const workspaces = new Map();
  const workspaceFiles = new Map();
  for (const file of files) {
    const workspace = JSON.parse(await fs.readFile(file, "utf8"));
    workspaces.set(workspace.name, workspace);
    workspaceFiles.set(workspace.name, file);
    if (workspace.version !== version) {
      throw new Error(`${path.relative(root, file)} version ${workspace.version} disagrees with ${version}`);
    }
    for (const [name, range] of Object.entries(workspace.dependencies ?? {})) {
      if (name.startsWith(workspacePrefix) && range !== version) {
        throw new Error(`${path.relative(root, file)} depends on ${name}@${range}, expected ${version}`);
      }
    }
  }
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error(`package-lock.json root version does not match ${version}`);
  }
  for (const [name, workspace] of workspaces) {
    const relative = path.relative(root, workspaceFiles.get(name)).split(path.sep).join("/");
    const lockKey = relative === "package.json" ? "" : path.posix.dirname(relative);
    const locked = lock.packages?.[lockKey];
    if (!locked) throw new Error(`package-lock.json is missing workspace entry ${lockKey || "."}`);
    if (locked.version !== version) {
      throw new Error(`package-lock.json ${lockKey || "."} version ${locked.version} disagrees with ${version}`);
    }
    for (const [dependency, range] of Object.entries(workspace.dependencies ?? {})) {
      if (dependency.startsWith(workspacePrefix) && locked.dependencies?.[dependency] !== range) {
        throw new Error(`package-lock.json ${lockKey || "."} dependency ${dependency} disagrees with package.json`);
      }
    }
  }
  return Object.freeze({ version, license: manifest.license, manifest });
}
