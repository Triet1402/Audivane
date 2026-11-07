import { fixtureMaterials } from './fixtures/distribution-materials.mjs';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAppImage } from "../distribution/appimage.mjs";
import { checkDistribution } from "../distribution/check.mjs";
import { debianVersion, linuxPackageFilename, normalizePlatform, platformConfig, readRootManifest, verifyVersionConsistency, windowsInstallerFilename, windowsZipFilename } from "../distribution/config.mjs";
import { auditGlibcFloor, buildDeb } from "../distribution/deb.mjs";
import { writeReleaseManifest } from "../distribution/manifest.mjs";
import { verifyRelease } from "../distribution/release.mjs";
import { buildWindowsArtifacts, nsisScript } from "../distribution/windows.mjs";
import { verifyDeb, verifyNsisScript } from "../distribution/verify.mjs";
import { verifyZip, writeZipFromDirectory } from "../distribution/zip.mjs";

test("distribution identity and workspace versions stay coherent", async () => {
  const check = await checkDistribution();
  assert.equal(check.product, "Audivane");
  assert.equal(check.license, "MIT");
  assert.match(check.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const versions = await verifyVersionConsistency();
  assert.equal(versions.version, check.version);
});

test("platform arguments map to the implemented packager targets", () => {
  assert.equal(normalizePlatform("linux"), "linux");
  assert.equal(normalizePlatform("win32"), "win32");
  assert.equal(normalizePlatform("windows"), "win32");
  assert.equal(platformConfig("windows").unpackedExecutable, "Audivane");
  assert.throws(() => normalizePlatform("darwin"), /Unsupported distribution platform/);
});

test("release names derive from one version in consistent formats", () => {
  const version = "0.1.0-beta.1";
  assert.equal(debianVersion(version), "0.1.0~beta.1");
  assert.equal(linuxPackageFilename(version), "audivane_0.1.0~beta.1_amd64.deb");
  assert.equal(windowsInstallerFilename(version), "Audivane-Setup-0.1.0-beta.1-x64.exe");
  assert.equal(windowsZipFilename(version), "Audivane-0.1.0-beta.1-win32-x64.zip");
});

test("portable ZIP writer produces a CRC-checked archive without system zip tools", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-zip-test-"));
  try {
    const source = path.join(directory, "source with spaces");
    await fs.mkdir(path.join(source, "resources"), { recursive: true });
    await fs.writeFile(path.join(source, "Audivane.exe"), Buffer.from("MZ fixture"));
    await fs.writeFile(path.join(source, "resources", "distribution.json"), JSON.stringify({ product: "Audivane" }));
    const output = path.join(directory, "archive.zip");
    const written = await writeZipFromDirectory(source, output);
    const verified = await verifyZip(output);
    assert.deepEqual(verified.entries.map(entry => entry.name), ["Audivane.exe", "resources/distribution.json"]);
    assert.deepEqual(verified.entries.map(entry => entry.sha256), written.entries.map(entry => entry.sha256));
    const bytes = await fs.readFile(output);
    // Corrupt the first entry's compressed payload, not the directory metadata.
    const nameLength = bytes.readUInt16LE(26);
    bytes[30 + nameLength] ^= 0xff;
    await fs.writeFile(output, bytes);
    await assert.rejects(() => verifyZip(output), /central directory|CRC|ZIP|inflate|invalid|code|unexpected/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("NSIS configuration is a fixed per-user install with ownership and lock failures", () => {
  const script = nsisScript({
    version: "0.1.0-beta.1",
    sourceDirectory: "C:\\build\\Audivane-win32-x64",
    output: "C:\\out\\Audivane-Setup.exe",
    icon: "C:\\icons\\audivane.ico",
  });
  assert.match(script, /RequestExecutionLevel user/);
  assert.doesNotMatch(script, /RequestExecutionLevel admin/i);
  assert.match(script, /\$LOCALAPPDATA\\Programs\\Audivane/);
  assert.match(script, /WriteUninstaller/);
  assert.match(script, /SetShellVarContext current/);
  assert.doesNotMatch(script, /--no-sandbox/);
  assert.doesNotMatch(script, /https?:\/\//);
  // Safety contract: no arbitrary directory page, an ownership marker before
  // any deletion, a sibling staging tree, and explicit failure on partial
  // delete/copy rather than continuing.
  assert.doesNotMatch(script, /MUI_PAGE_DIRECTORY/);
  assert.ok(script.includes('IfFileExists "$INSTDIR\\${APP_MARKER}" 0 foreign'));
  assert.ok(script.includes('IfFileExists "$INSTDIR.installing\\${APP_MARKER}"'));
  assert.ok(script.includes('Rename "$INSTDIR.installing" "$INSTDIR"'));
  // Windows cannot rename or delete NSIS's current output directory.
  assert.match(script, /IfFileExists "\$INSTDIR.installing\\resources\\distribution\.json" 0 copyfail\s+(?:;[^\n]*\n\s*)*SetOutPath "\$TEMP"/);
  assert.match(script, /copyfail:\s+SetOutPath "\$TEMP"\s+RMDir/);
  assert.match(script, /Section "Uninstall"\s+SetShellVarContext current\s+SetOutPath "\$TEMP"/);
  assert.ok(script.includes("could not remove the previous installation"));
  assert.ok(script.includes("could not copy a complete installation"));
  assert.ok(script.includes("could not activate the staged installation"));
  assert.ok(script.includes("IfFileExists \"$INSTDIR\" 0 swap"));
  // Silent installers must fail with an error level instead of blocking on a
  // MessageBox in CI or unattended use.
  assert.ok(script.includes("/SD IDOK"));
  assert.ok(script.includes("uninstall-marker-not-written"));
  // RMDir failure sets the NSIS error flag; a successful FileOpen does not
  // clear it. Reset it before recreating either retry ownership marker.
  assert.equal([...script.matchAll(/ClearErrors\s+FileOpen \$0 "\$INSTDIR\\\$\{APP_MARKER\}" w\s+IfErrors (?:uninstall-)?marker-not-written/g)].length, 2);
  // Spaces in LOCALAPPDATA/Program Files must survive shell invocation.
  assert.ok(script.includes('"UninstallString" "$\\"$INSTDIR\\Uninstall.exe$\\""'));
  assert.ok(script.includes('"QuietUninstallString" "$\\"$INSTDIR\\Uninstall.exe$\\" /S"'));
});

async function fixtureElf(directory) {
  // Build a tiny ELF with this host's toolchain. It requires only the old
  // baseline symbols, unlike /bin/true on a newer developer distro.
  const source = path.join(directory, "fixture.c");
  const output = path.join(directory, "fixture-elf");
  await fs.writeFile(source, "int main(void){return 0;}\n");
  execFileSync("cc", ["-O2", "-o", output, source]);
  return output;
}

test("glibc audit covers every shipped ELF and refuses an override", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-glibc-"));
  try {
    const elf = await fixtureElf(directory);
    await fs.copyFile(elf, path.join(directory, "codec-abx"));
    const audit = await auditGlibcFloor(directory);
    assert.equal(audit.baseline, "2.39");
    assert.ok(audit.files.some(file => file.path === "codec-abx"));
    assert.ok(audit.files.every(file => file.glibc === null || Number(file.glibc.split(".")[0]) === 2));
    const previous = process.env.CODEC_ABX_DEB_GLIBC_FLOOR;
    process.env.CODEC_ABX_DEB_GLIBC_FLOOR = "2.1";
    try {
      await assert.rejects(() => auditGlibcFloor(directory), /not honored/);
    } finally {
      if (previous === undefined) delete process.env.CODEC_ABX_DEB_GLIBC_FLOOR;
      else process.env.CODEC_ABX_DEB_GLIBC_FLOOR = previous;
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("deb builder creates an inspectable package without following package symlinks", async t => {
  try {
    execFileSync("dpkg-deb", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("dpkg-deb is not installed on this host");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-deb-contract-"));
  try {
    const packaged = path.join(directory, "packaged");
    await fs.mkdir(path.join(packaged, "resources"), { recursive: true });
    await fs.chmod(packaged, 0o700);
    const elf = await fixtureElf(directory);
    for (const relative of ["codec-abx", "chrome-sandbox", "resources/third_party/ffmpeg/bin/ffmpeg", "resources/third_party/ffmpeg/bin/ffprobe", "resources/third_party/ldac/bin/ldac_helper"]) {
      await fs.mkdir(path.dirname(path.join(packaged, relative)), { recursive: true });
      await fs.copyFile(elf, path.join(packaged, relative));
      await fs.chmod(path.join(packaged, relative), 0o755);
    }
    await fs.writeFile(path.join(packaged, "LICENSE"), "Electron fixture license");
    await fs.writeFile(path.join(packaged, "LICENSES.chromium.html"), "Chromium notices");
    const workspace = await readRootManifest();
    await fs.writeFile(path.join(packaged, "resources", "distribution.json"), JSON.stringify({
      schema: "codec-abx-desktop-distribution-v1",
      product: "Audivane",
      version: workspace.version,
      license: "MIT",
      platform: "linux",
      arch: "x64",
      executable: "codec-abx",
      browserCodecAssets: "excluded-native-only",
      nativeBundle: { mode: "portable-native-bundle-v1", ldacHelperIncluded: true },
    }));
    await fs.writeFile(path.join(packaged, "resources", "native-bundle-manifest.json"), JSON.stringify({
      schema: "codec-abx-native-bundle-manifest-v1",
      mode: "portable-native-bundle-v1",
      platform: "linux",
      arch: "x64",
      ldacHelperIncluded: true,
      files: [],
    }));
    const output = path.join(directory, "release");
    const staging = path.join(directory, "staging");
    const result = await buildDeb({ packagedDirectory: packaged, outputDirectory: output, stagingDirectory: staging });
    assert.equal(result.glibc.baseline, "2.39");
    await assert.rejects(verifyDeb(result.path, { workspaceVersion: workspace.version }), /manifest|materials|ENOENT/i);
    await fixtureMaterials(packaged, 'linux');
    await buildDeb({ packagedDirectory: packaged, outputDirectory: output, stagingDirectory: staging });
    const report = await verifyDeb(result.path, { workspaceVersion: workspace.version });
    assert.equal(report.nativeBundle, "portable-native-bundle-v1");
    assert.equal(report.ldacHelperIncluded, true);
    assert.equal((await fs.stat(path.join(staging, "opt/audivane"))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(staging, "opt"))).mode & 0o777, 0o755);
    const info = execFileSync("dpkg-deb", ["--info", result.path], { encoding: "utf8" });
    assert.match(info, /Depends: libc6 \(>= 2\.39\)/);
    // The absolute /usr/bin -> /opt symlink is intentionally absent from
    // md5sums; hashing it would read the host path and fail.
    const control = path.join(directory, "control");
    execFileSync("dpkg-deb", ["-e", result.path, control]);
    const md5 = await fs.readFile(path.join(control, "md5sums"), "utf8");
    assert.match(md5, /^.*  opt\/audivane\/audivane$/m);
    assert.doesNotMatch(md5, /usr\/bin\/audivane/);
    // Debian order: prerm unloads while the conffile still exists; postrm must
    // never unload after dpkg has removed it. Upgrades preserve/reload.
    const postinst = await fs.readFile(path.join(control, "postinst"), "utf8");
    const prerm = await fs.readFile(path.join(control, "prerm"), "utf8");
    const postrm = await fs.readFile(path.join(control, "postrm"), "utf8");
    assert.match(postinst, /apparmor_parser -r \/etc\/apparmor\.d\/audivane/);
    assert.match(prerm, /remove\|deconfigure/);
    assert.match(prerm, /upgrade\|failed-upgrade/);
    assert.ok(prerm.indexOf("apparmor_parser -R /etc/apparmor.d/audivane") < prerm.indexOf("exit 0"));
    assert.doesNotMatch(postrm, /apparmor_parser -R/);
    assert.match(postrm, /\[ "\$1" = purge \]/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("AppImage build refuses a live runtime download and verifies the pinned runtime", async t => {
  if (process.platform === "win32") {
    t.skip("AppImage tooling is exercised on Linux");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-appimage-"));
  try {
    const packaged = path.join(directory, "packaged");
    await fs.mkdir(path.join(packaged, "resources"), { recursive: true });
    await fs.writeFile(path.join(packaged, "codec-abx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const workspace = await readRootManifest();
    await fs.writeFile(path.join(packaged, "resources", "distribution.json"), JSON.stringify({
      version: workspace.version, platform: "linux", executable: "codec-abx", browserCodecAssets: "excluded-native-only",
    }));
    const appDir = path.join(directory, "AppDir");
    const output = path.join(directory, "release");
    const staged = await buildAppImage({ packagedDirectory: packaged, appDir, outputDirectory: output });
    assert.equal(staged.produced, false);
    const runtime = path.join(directory, "runtime");
    await fs.writeFile(runtime, "pinned runtime bytes");
    await assert.rejects(() => buildAppImage({ packagedDirectory: packaged, appDir, outputDirectory: output, appimagetool: process.execPath }), /explicit --appimage-runtime/);
    await assert.rejects(() => buildAppImage({
      packagedDirectory: packaged, appDir, outputDirectory: output, appimagetool: process.execPath,
      runtime, runtimeSha256: "0".repeat(64),
    }), /runtime SHA-256 mismatch/);
    const tool = path.join(directory, "fake-appimagetool.mjs");
    await fs.writeFile(tool, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[process.argv.length - 1], "fake-appimage");\n`, { mode: 0o755 });
    const built = await buildAppImage({
      packagedDirectory: packaged, appDir, outputDirectory: output, appimagetool: tool,
      runtime, runtimeSha256: createHash("sha256").update(await fs.readFile(runtime)).digest("hex"),
    });
    assert.equal(built.produced, true);
    assert.equal(await fs.readFile(built.path, "utf8"), "fake-appimage");
    assert.equal(JSON.parse(await fs.readFile(path.join(appDir, "opt/audivane/resources/distribution.json"), "utf8")).executable, "audivane");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("release verification checks every artifact hash/size and rejects traversal or stale versions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-release-verify-"));
  try {
    const source = path.join(directory, "zip-source");
    await fs.mkdir(path.join(source, "resources/third_party/ffmpeg/bin"), { recursive: true });
    await fs.mkdir(path.join(source, "resources/third_party/ldac/bin"), { recursive: true });
    for (const [relative, bytes] of [
      ["Audivane.exe", "MZ fixture"],
      ["LICENSE", "MIT"],
      ["LICENSES.chromium.html", "Chromium notices"],
      ["resources/distribution.json", JSON.stringify({
        version: (await readRootManifest()).version, platform: "win32",
        processHost: {
          path: "process-host/audivane-process-host.exe",
          bytes: Buffer.byteLength("PE process host"),
          sha256: createHash("sha256").update("PE process host").digest("hex"),
        },
      })],
      ["resources/native-bundle-manifest.json", JSON.stringify({ mode: "portable-native-bundle-v1" })],
      ["resources/process-host/audivane-process-host.exe", "PE process host"],
      ["resources/third_party/ffmpeg/bin/ffmpeg.exe", "PE fixture"],
      ["resources/third_party/ffmpeg/bin/ffprobe.exe", "PE fixture"],
      ["resources/third_party/ldac/bin/ldac_helper.exe", "PE fixture"],
    ]) {
      await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await fs.writeFile(path.join(source, relative), bytes);
    }
    await fixtureMaterials(source, "win32");
    const zip = path.join(directory, windowsZipFilename((await readRootManifest()).version));
    await writeZipFromDirectory(source, zip);
    const exe = path.join(directory, windowsInstallerFilename((await readRootManifest()).version));
    const exeBytes = Buffer.alloc(128);
    exeBytes.write("MZ", 0, "binary");
    await fs.writeFile(exe, exeBytes);
    const writeManifest = () => writeReleaseManifest({
      directory, platform: "win32", artifacts: [zip, exe], nativeBundle: { mode: "portable-native-bundle-v1", ldacHelperIncluded: true },
    });
    await writeManifest();
    const report = await verifyRelease({ directory, platform: "win32" });
    assert.ok(report.reports.some(item => item.format === "pe"));
    const manifestPath = path.join(directory, "release-manifest-windows.json");
    const valid = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    valid.artifacts[0].bytes += 1;
    await fs.writeFile(manifestPath, JSON.stringify(valid, null, 2));
    await assert.rejects(() => verifyRelease({ directory, platform: "win32" }), /size disagrees/);
    await writeManifest();
    const stale = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    stale.version = "0.0.0-stale";
    await fs.writeFile(manifestPath, JSON.stringify(stale, null, 2));
    await assert.rejects(() => verifyRelease({ directory, platform: "win32" }), /version .* disagrees/);
    await writeManifest();
    const traversal = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    traversal.artifacts = [{ file: "../escape", bytes: 1, sha256: "0".repeat(64) }];
    await fs.writeFile(manifestPath, JSON.stringify(traversal, null, 2));
    await fs.writeFile(path.join(directory, "SHA256SUMS-windows.txt"), `${"0".repeat(64)}  ../escape\n`);
    await assert.rejects(() => verifyRelease({ directory, platform: "win32" }), /unsafe artifact name/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Windows artifact builder emits a real ZIP and .nsi contract with --no-installer", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-win-contract-"));
  const previous = process.env.MAKENSIS;
  process.env.MAKENSIS = "";
  try {
    const packaged = path.join(directory, "Audivane-win32-x64");
    await fs.mkdir(path.join(packaged, "resources", "process-host"), { recursive: true });
    await fs.writeFile(path.join(packaged, "Audivane.exe"), Buffer.from("MZ fixture executable"));
    await fs.writeFile(path.join(packaged, "LICENSE"), "MIT");
    await fs.writeFile(path.join(packaged, "LICENSES.chromium.html"), "Chromium notices");
    const workspace = await readRootManifest();
    const processHostBytes = Buffer.from("MZ fixture process host");
    await fs.writeFile(path.join(packaged, "resources", "process-host", "audivane-process-host.exe"), processHostBytes);
    await fs.writeFile(path.join(packaged, "resources", "distribution.json"), JSON.stringify({
      schema: "codec-abx-desktop-distribution-v1",
      version: workspace.version,
      platform: "win32",
      arch: "x64",
      nativeBundle: { mode: "portable-native-bundle-v1", ldacHelperIncluded: true },
      processHost: {
        path: "process-host/audivane-process-host.exe",
        bytes: processHostBytes.length,
        sha256: createHash("sha256").update(processHostBytes).digest("hex"),
      },
    }));
    const output = path.join(directory, "release");
    const script = path.join(directory, "nsis", "audivane.nsi");
    const result = await buildWindowsArtifacts({
      packagedDirectory: packaged,
      outputDirectory: output,
      scriptPath: script,
      requireInstaller: false,
    });
    assert.equal(result.installer, null);
    assert.equal(result.zip.path, path.join(output, windowsZipFilename(workspace.version)));
    const zip = await verifyZip(result.zip.path);
    assert.deepEqual(zip.entries.map(entry => entry.name).sort(), [
      "Audivane.exe", "LICENSE", "LICENSES.chromium.html", "resources/distribution.json",
      "resources/process-host/audivane-process-host.exe",
    ]);
    await fs.access(script);
    const contract = await verifyNsisScript(script);
    assert.equal(contract.perUser, true);
  } finally {
    if (previous === undefined) delete process.env.MAKENSIS;
    else process.env.MAKENSIS = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});



test('material contract rejects self-consistent wrong pins, platform and broken hash bindings', async t => {
  const { verifyMaterialsDirectory } = await import('../distribution/materials-contract.mjs');
  const { createHash } = await import('node:crypto');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-material-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resources = path.join(directory, 'resources');
  for (const name of ['ffmpeg/bin/ffmpeg', 'ffmpeg/bin/ffprobe', 'ldac/bin/ldac_helper']) {
    await fs.mkdir(path.dirname(path.join(resources, 'third_party', name)), { recursive: true });
    await fs.writeFile(path.join(resources, 'third_party', name), 'TEST binary');
  }
  await fs.writeFile(path.join(resources, 'distribution.json'), JSON.stringify({ platform: 'linux', nativeBundle: {} }));
  await fs.writeFile(path.join(resources, 'native-bundle-manifest.json'), JSON.stringify({ platform: 'linux', ldacHelperIncluded: true }));
  await fixtureMaterials(directory, 'linux');
  await verifyMaterialsDirectory(resources, 'linux');
  const distributionPath = path.join(resources, 'distribution.json');
  const distribution = JSON.parse(await fs.readFile(distributionPath, 'utf8'));
  await fs.writeFile(distributionPath, JSON.stringify({ ...distribution, nativeBundle: { manifestSha256: '0'.repeat(64) } }));
  await assert.rejects(verifyMaterialsDirectory(resources, 'linux'), /Native manifest hash/);
  await fs.writeFile(distributionPath, JSON.stringify(distribution));
  await assert.rejects(verifyMaterialsDirectory(resources, 'win32'), /wrong-platform/);
  const materialPath = path.join(resources, 'notices/MANIFEST.json');
  const materials = JSON.parse(await fs.readFile(materialPath, 'utf8'));
  materials.sourcePins[0].sha256 = '0'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(materials));
  await fs.writeFile(materialPath, bytes);
  const bindingPath = path.join(resources, 'distribution-materials.json');
  const binding = JSON.parse(await fs.readFile(bindingPath, 'utf8'));
  binding.materialsManifestSha256 = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(bindingPath, JSON.stringify(binding));
  await assert.rejects(verifyMaterialsDirectory(resources, 'linux'), /source pin mismatch/);
});
