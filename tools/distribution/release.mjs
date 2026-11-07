import { packageJobs } from './jobs.mjs';
import { withReleaseWorkspace } from './release-work.mjs';
import { checkDistribution } from "./check.mjs";
import { verifyMaterialsDirectory } from "./materials-contract.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppImage } from "./appimage.mjs";
import { buildDeb } from "./deb.mjs";
import { archFilename, buildArch, prepareArch, verifyArch } from "./arch.mjs";
import { distributionResourcesDirectory, normalizePlatform, readRootManifest, releaseDirectory, root, unpackedDirectory } from "./config.mjs";
import { buildWindowsArtifacts } from "./windows.mjs";
import { verifyDeb, verifyNsisScript, verifyWindowsZip } from "./verify.mjs";
import { manifestFilenames, sha256File, writeReleaseManifest } from "./manifest.mjs";
import { ensureArtifacts, lockPath } from "../verification/build.mjs";
import { fingerprint, withLock } from "../verification/cache.mjs";
import { cancellation } from "../verification/process.mjs";

function valueAfter(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseReleaseArguments(args) {
  const options = { target: args[0], nativeBundle: process.env.CODEC_ABX_NATIVE_BUNDLE_DIR, appimage: false, requireInstaller: true };
  if (options.target === undefined || options.target.startsWith("--")) {
    throw new Error("Usage: node tools/distribution/release.mjs <linux|arch|windows|win32|verify> [--resources DIR|--native-bundle DIR] [--jobs N] [--platform linux|arch|win32] [--prepare-only|--arch-package FILE] [--appimage --appimagetool PATH --appimage-runtime FILE --appimage-runtime-sha256 HASH]");
  }
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--native-bundle" || argument === "--resources") {
      options.nativeBundle = path.resolve(valueAfter(args, index, argument));
      index += 1;
    } else if (argument === "--jobs") {
      options.jobs = packageJobs(valueAfter(args, index, argument));
      index += 1;
    } else if (argument === "--prepare-only") {
      options.prepareOnly = true;
    } else if (argument === "--arch-package") {
      options.archPackage = path.resolve(valueAfter(args, index, argument));
      index += 1;
    } else if (argument === "--appimage") {
      options.appimage = true;
    } else if (argument === "--appimagetool") {
      options.appimagetool = path.resolve(valueAfter(args, index, argument));
      options.appimage = true;
      index += 1;
    } else if (argument === "--appimage-runtime") {
      options.appimageRuntime = path.resolve(valueAfter(args, index, argument));
      index += 1;
    } else if (argument === "--appimage-runtime-sha256") {
      options.appimageRuntimeSha256 = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--no-appimage") {
      options.appimage = false;
    } else if (argument === "--no-installer") {
      options.requireInstaller = false;
    } else if (argument === "--verify-only") {
      options.verifyOnly = true;
    } else if (argument === "--platform") {
      options.platform = valueAfter(args, index, argument) === "arch" ? "arch" : normalizePlatform(valueAfter(args, index, argument));
      index += 1;
    } else {
      throw new Error(`Unknown release argument: ${argument}`);
    }
  }
  options.jobs = packageJobs(options.jobs);
  return options;
}

// Read-side verification and publication preparation share this same gate.
function withReleaseLock(action) {
  return withLock(lockPath, action, { signal: cancellation.signal });
}

const releaseInputs = ['package.json', 'package-lock.json', 'apps', 'packages', 'tools',
  'assets/brand', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const releaseFingerprint = () => fingerprint(root, releaseInputs);

function replaceResultPaths(value, replacements) {
  if (typeof value === 'string') {
    for (const [from, to] of replacements) if (value === from || value.startsWith(from + path.sep)) return to + value.slice(from.length);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => replaceResultPaths(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceResultPaths(item, replacements)]));
  return value;
}

async function withPackagedRelease(target, options, build) {
  const platform = target === 'arch' ? 'linux' : target;
  return withReleaseWorkspace(target, {
    signal: cancellation.signal,
    capture: async workspace => {
      const inputHash = await releaseFingerprint();
      await checkDistribution();
      const nativeBundle = await resolveReleaseResources(platform, options.nativeBundle);
      if (!options.verifyOnly) await ensureArtifacts('package', { platform, nativeBundle, requireNativeBundle: true });
      const packaged = await requireBundledPackage(platform, nativeBundle, options.verifyOnly);
      const directory = path.join(workspace, 'package');
      await fs.cp(packaged.directory, directory, { recursive: true, dereference: false });
      if (await releaseFingerprint() !== inputHash) throw new Error('Release source changed during capture; retry the build');
      console.log(`[release] ${target}: captured private package; compression jobs=${options.jobs}`);
      return { directory, distribution: packaged.distribution, inputHash };
    },
    build,
    publish: async (result, snapshot, workspace) => {
      if (await releaseFingerprint() !== snapshot.inputHash) throw new Error('Release source changed during compression; refusing to publish mixed inputs');
      const output = path.join(workspace, 'release');
      const replacements = [[output, releaseDirectory()]];
      if (result.prepared) {
        const recipe = path.join(root, 'build/arch/recipe');
        await fs.rm(recipe, { recursive: true, force: true });
        await fs.cp(result.prepared.directory, recipe, { recursive: true });
        replacements.push([result.prepared.directory, recipe]);
      }
      if (result.result?.scriptPath) {
        const script = path.join(root, 'build/nsis/audivane.nsi');
        await fs.mkdir(path.dirname(script), { recursive: true });
        await fs.copyFile(result.result.scriptPath, script);
        replacements.push([result.result.scriptPath, script]);
      }
      if (result.appimage) {
        const appDir = path.join(root, 'build/appimage/Audivane.AppDir');
        await fs.rm(appDir, { recursive: true, force: true });
        await fs.cp(result.appimage.appDir, appDir, { recursive: true });
        replacements.push([result.appimage.appDir, appDir]);
      }
      if (result.manifest) {
        // Build and format verification finished in the private output. Readers
        // cannot observe replacements until this gate is released. Manifest last
        // makes an interrupted multi-file replacement fail checksum validation.
        const names = manifestFilenames(target);
        const files = [...result.manifest.manifest.artifacts.map(record => record.file), names.sums, names.manifest];
        await fs.mkdir(releaseDirectory(), { recursive: true });
        for (const file of files) await fs.rename(path.join(output, file), path.join(releaseDirectory(), file));
      }
      return replaceResultPaths(result, replacements);
    },
  });
}

async function resolveReleaseResources(platform, requested) {
  if (requested) return path.resolve(requested);
  const candidate = distributionResourcesDirectory(platform);
  if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  return null;
}

async function requireBundledPackage(platform, nativeBundle, verifyOnly = false) {
  if (!nativeBundle && !verifyOnly) {
    throw new Error(`Distribution requires --native-bundle/--resources (or CODEC_ABX_NATIVE_BUNDLE_DIR), or the staged ${path.relative(process.cwd(), distributionResourcesDirectory(platform))} tree; native tools are never discovered on PATH`);
  }
  const directory = unpackedDirectory(platform);
  const distribution = JSON.parse(await fs.readFile(path.join(directory, "resources/distribution.json"), "utf8"));
  if (distribution.platform !== platform) throw new Error("Packaged application platform disagrees with the requested distribution target");
  if (distribution.nativeBundle?.mode !== "portable-native-bundle-v1") {
    throw new Error("Packaged app is in external-native-tools mode; refusing distribution artifacts");
  }
  if (distribution.nativeBundle.ldacHelperIncluded !== true) {
    throw new Error("Prepared native bundle lacks the LDAC helper; an eleven-codec release requires it");
  }
  if (platform === "win32" && (distribution.processHost === null || typeof distribution.processHost !== "object" ||
      typeof distribution.processHost.path !== "string")) {
    throw new Error("Windows package lacks the whole-desktop process lifetime host");
  }
  await checkDistribution();
  await verifyMaterialsDirectory(path.join(directory, "resources"), platform);
  return { directory, distribution };
}

async function buildLinux(options) {
  return withPackagedRelease('linux', options, async ({ directory, distribution }, workspace) => {
    const outputDirectory = path.join(workspace, 'release');
    const deb = await buildDeb({ packagedDirectory: directory, outputDirectory, stagingDirectory: path.join(workspace, "debian"), jobs: options.jobs });
    const debReport = await verifyDeb(deb.path, { workspaceVersion: distribution.version });
    const artifacts = [deb.path];
    let appimage = null;
    if (options.appimage) {
      appimage = await buildAppImage({
        packagedDirectory: directory, outputDirectory, appDir: path.join(workspace, "AppDir"),
        appimagetool: options.appimagetool,
        runtime: options.appimageRuntime,
        runtimeSha256: options.appimageRuntimeSha256,
      });
      if (appimage.produced) artifacts.push(appimage.path);
    }
    const manifest = await writeReleaseManifest({
      directory: outputDirectory, artifacts,
      platform: "linux",
      nativeBundle: distribution.nativeBundle,
      notes: [
        "Linux x64 .deb built from the exact unpacked Electron package and the explicitly supplied native bundle.",
        appimage?.produced
          ? "AppImage produced with the explicitly supplied appimagetool."
          : appimage ? "AppImage not produced; the AppDir is staged under build/appimage/Audivane.AppDir." : "AppImage not requested; no AppDir was staged in this run.",
        "Every shipped ELF was audited against the GLIBC_2.39 baseline before the .deb was written.",
        "The installed executable keeps the Chromium sandbox enabled and relies on user namespaces. The .deb ships a narrowly scoped /opt/audivane/audivane AppArmor userns attachment; it contains no setuid helper and changes no global host policy.",
        "This manifest records local artifacts, not publication approval or a clean-machine acceptance claim.",
      ],
    });
    return { deb, debReport, appimage, manifest };
  });
}

async function buildArchRelease(options) {
  return withPackagedRelease('arch', options, async ({ directory, distribution }, workspace) => {
    const outputDirectory = path.join(workspace, 'release');
    if (options.archPackage && options.prepareOnly) throw new Error("--arch-package and --prepare-only are mutually exclusive");
    const prepared = options.archPackage ? null : await prepareArch({ packagedDirectory: directory, directory: path.join(workspace, "arch-recipe"), jobs: options.jobs });
    if (options.prepareOnly) return { prepared, next: "Run makepkg --force --noconfirm as a normal Arch user in the recipe directory, then dist:arch -- --arch-package FILE" };
    let artifact;
    if (options.archPackage) {
      await verifyArch(options.archPackage, { workspaceVersion: distribution.version, expectedApplicationDirectory: directory });
      artifact = path.join(outputDirectory, archFilename(distribution.version));
      await fs.mkdir(outputDirectory, { recursive: true });
      if (path.resolve(options.archPackage) !== artifact) await fs.copyFile(options.archPackage, artifact);
    } else artifact = await buildArch(prepared, { outputDirectory });
    const report = await verifyArch(artifact, { workspaceVersion: distribution.version, expectedApplicationDirectory: directory });
    if (report.nativeBundle.manifestSha256 !== distribution.nativeBundle.manifestSha256) throw new Error("Arch artifact contains a different native bundle");
    const manifest = await writeReleaseManifest({
      directory: outputDirectory, artifacts: [artifact], platform: "arch", nativeBundle: distribution.nativeBundle,
      notes: ["Arch x86_64 pacman package built with makepkg from the explicitly prepared Linux Electron/native/materials payload.",
        "Bundled Electron and codecs install to /opt/audivane; the command, desktop entry, icons and licenses are owned by pacman.",
        "No setuid helper, disabled sandbox, AppArmor policy installation or host policy change. A host that restricts user namespaces may refuse launch.",
        "Unsigned local candidate; no AUR submission or publication. See docs/arch-distribution.md for actual target acceptance and limitations."],
    });
    return { artifact, report, manifest };
  });
}

async function buildWindows(options) {
  return withPackagedRelease('win32', options, async ({ directory, distribution }, workspace) => {
    const outputDirectory = path.join(workspace, 'release');
    const result = await buildWindowsArtifacts({
      packagedDirectory: directory, outputDirectory, jobs: options.jobs, signal: cancellation.signal,
      requireInstaller: options.requireInstaller,
      scriptPath: path.join(workspace, "nsis/audivane.nsi"),
    });
    const zipReport = await verifyWindowsZip(result.zip.path);
    // --no-installer still writes the .nsi contract for inspection and CI.
    const nsisReport = await verifyNsisScript(result.scriptPath);
    const artifacts = [result.zip.path, result.installer?.path];
    const manifest = await writeReleaseManifest({
      directory: outputDirectory, artifacts,
      platform: "win32",
      nativeBundle: distribution.nativeBundle,
      notes: [
        "Windows x64 portable ZIP and per-user NSIS installer are built from the exact packaged Electron tree.",
        result.installer ? "NSIS installer was produced with the explicit makensis executable." : "NSIS installer was not produced because makensis was unavailable; the .nsi script is staged under build/nsis.",
        "The installer is per-user, fixed under LOCALAPPDATA, validates an ownership marker, stages copies before replacement and fails on locked or partially removed files.",
        "Windows execution and installer acceptance must run on an actual Windows machine; Linux cross-packaging is not Windows evidence.",
        "No code-signing credentials are stored in the repository.",
      ],
    });
    return { result, zipReport, nsisReport, manifest };
  });
}

function safeArtifactPath(directory, name) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`Release manifest contains an unsafe artifact name: ${JSON.stringify(name)}`);
  }
  const absolute = path.resolve(directory, name);
  if (path.dirname(absolute) !== path.resolve(directory)) {
    throw new Error(`Release artifact escapes the release directory: ${name}`);
  }
  return absolute;
}

async function verifyChecksums(directory, manifest, platform) {
  const names = manifestFilenames(platform);
  const sumsPath = path.join(directory, names.sums);
  const text = await fs.readFile(sumsPath, "utf8");
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Malformed checksum line in ${names.sums}: ${line}`);
    if (sums.has(match[2])) throw new Error(`Duplicate checksum entry: ${match[2]}`);
    sums.set(match[2], match[1]);
  }
  const expected = new Set(manifest.artifacts.map(record => record.file));
  for (const file of sums.keys()) if (!expected.has(file)) throw new Error(`Checksum lists an artifact absent from the manifest: ${file}`);
  for (const record of manifest.artifacts) {
    if (sums.get(record.file) !== record.sha256) throw new Error(`Checksum disagrees with the manifest: ${record.file}`);
  }
}

async function verifyArtifactFormats(artifact) {
  if (artifact.endsWith(".pkg.tar.zst")) return verifyArch(artifact);
  const extension = path.extname(artifact).toLowerCase();
  if (extension === ".deb") {
    const bytes = await fs.readFile(artifact);
    if (bytes.subarray(0, 8).toString("binary") !== "!<arch>\n") throw new Error(`Not a Debian ar archive: ${path.basename(artifact)}`);
    return verifyDeb(artifact, { workspaceVersion: (await readRootManifest()).version });
  }
  if (extension === ".zip") return verifyWindowsZip(artifact);
  if (extension === ".exe") {
    const bytes = await fs.readFile(artifact);
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`Not a Windows PE executable: ${path.basename(artifact)}`);
    return { path: artifact, size: bytes.length, format: "pe" };
  }
  if (extension === ".appimage") {
    const bytes = await fs.readFile(artifact);
    if (bytes.length < 64 || bytes.subarray(0, 4).toString("binary") !== "\x7fELF") throw new Error(`Not an ELF AppImage: ${path.basename(artifact)}`);
    const stat = await fs.stat(artifact);
    if ((stat.mode & 0o111) === 0) throw new Error(`AppImage is not executable: ${path.basename(artifact)}`);
    return { path: artifact, size: bytes.length, format: "elf" };
  }
  throw new Error(`Release manifest contains an unsupported artifact type: ${path.basename(artifact)}`);
}

export async function verifyRelease(options = {}) {
  return withReleaseLock(async () => {
    const workspace = await readRootManifest();
    const directory = path.resolve(options.directory ?? releaseDirectory());
    const all = await fs.readdir(directory).catch(() => []);
    const names = all.filter(name => /^release-manifest-(linux|arch|windows)\.json$/.test(name));
    const selected = options.platform === undefined ? names : names.filter(name => name === manifestFilenames(options.platform).manifest);
    if (selected.length === 0) throw new Error(`No release manifest found in ${directory}${options.platform ? ` for ${options.platform}` : ""}`);
    const reports = [];
    for (const name of selected.sort()) {
      const manifestPath = path.join(directory, name);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (manifest.platform === undefined) throw new Error(`Release manifest has no platform: ${name}`);
      const expectedName = manifestFilenames(manifest.platform).manifest;
      if (expectedName !== name) throw new Error(`Release manifest naming disagrees with its platform: ${name}`);
      if (manifest.version !== workspace.version) {
        throw new Error(`Release manifest version ${manifest.version} disagrees with workspace ${workspace.version}: ${name}`);
      }
      if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error(`Release manifest lists no artifacts: ${name}`);
      await verifyChecksums(directory, manifest, manifest.platform);
      const seen = new Set();
      for (const record of manifest.artifacts) {
        if (record.file === undefined || record.sha256 === undefined || record.bytes === undefined) {
          throw new Error(`Release manifest artifact record is incomplete: ${JSON.stringify(record)}`);
        }
        if (seen.has(record.file)) throw new Error(`Release manifest repeats artifact: ${record.file}`);
        seen.add(record.file);
        const artifact = safeArtifactPath(directory, record.file);
        const stat = await fs.lstat(artifact);
        if (!stat.isFile()) throw new Error(`Release artifact is not a regular file: ${record.file}`);
        if (stat.size !== record.bytes) throw new Error(`Release artifact size disagrees with the manifest: ${record.file}`);
        const actual = await sha256File(artifact);
        if (actual !== record.sha256) throw new Error(`Release artifact SHA-256 disagrees with the manifest: ${record.file}`);
        reports.push(await verifyArtifactFormats(artifact));
      }
      if (manifest.platform === "win32") {
        const script = path.join(path.dirname(lockPath), "nsis/audivane.nsi");
        if (await fs.access(script).then(() => true, () => false)) reports.push(await verifyNsisScript(script));
      }
    }
    return { reports };
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseReleaseArguments(args);
  const target = options.target === "windows" ? "win32" : options.target;
  if (target === "linux") return buildLinux(options);
  if (target === "arch") return buildArchRelease(options);
  if (target === "win32") return buildWindows(options);
  if (target === "verify") return verifyRelease(options);
  throw new Error(`Unknown release target: ${options.target}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await main();
  console.log(JSON.stringify(result, null, 2));
}
