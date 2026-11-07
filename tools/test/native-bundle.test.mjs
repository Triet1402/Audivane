import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_BUNDLE_MANIFEST,
  NATIVE_BUNDLE_MANIFEST_SCHEMA,
  NativeBundleError,
  assertNativeBundleOutsideOutputs,
  desktopBuildOutputDirectories,
  inspectNativeBundle,
  inspectPeExecutable,
  resolveNativeBundleRequest,
  stageNativeBundle,
  verifyPackagedNativeBundle,
} from "../verification/native-bundle.mjs";

const FFMPEG_VERSION = `FFmpeg:       9.0.2 (stable release)
Source:       https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
SHA-256:      8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
built by tools/build_ffmpeg.sh
Static dependencies:
  liblc3      1.1.3   https://github.com/google/liblc3
`;
const LDAC_VERSION = `ldac_helper 1.0.0
container_version 1
libldac_repo=https://android.googlesource.com/platform/external/libldac
libldac_commit=eeee1a3f5f8df1282e3a6d297085885fd886737b
libldacdec_repo=https://github.com/hegdi/libldacdec
libldacdec_commit=7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9
`;

function elf64x64() {
  const bytes = Buffer.alloc(64);
  bytes.write("\x7fELF", 0, "latin1");
  bytes[4] = 2; // ELFCLASS64
  bytes[5] = 1; // little endian
  bytes[6] = 1; // current version
  bytes.writeUInt16LE(62, 18); // EM_X86_64
  return bytes;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-bundle-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "prepared");
  await fs.mkdir(path.join(bundle, "third_party/ffmpeg/bin"), { recursive: true });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg"), elf64x64(), { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffprobe"), elf64x64(), { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/VERSION.txt"), FFMPEG_VERSION);
  await fs.writeFile(path.join(bundle, "NOTICE"), "supplied third-party notices\n");
  return { root, bundle };
}

async function addLdac(bundle) {
  await fs.mkdir(path.join(bundle, "third_party/ldac/bin"), { recursive: true });
  await fs.writeFile(path.join(bundle, "third_party/ldac/bin/ldac_helper"), elf64x64(), { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "third_party/ldac/VERSION.txt"), LDAC_VERSION);
}

test("prepared native bundle records exact hashes, optional LDAC and supplied provenance", async t => {
  const { bundle } = await fixture(t);
  await addLdac(bundle);
  const inspection = await inspectNativeBundle(bundle);
  assert.equal(inspection.mode, "portable-native-bundle-v1");
  assert.equal(inspection.ldacHelperIncluded, true);
  assert.match(inspection.versions.ffmpeg, /^FFmpeg:/m);
  assert.match(inspection.versions.ldac, /^libldac_commit=/m);
  assert.deepEqual(inspection.files.map((file) => file.path).sort(), [
    "NOTICE",
    "third_party/ffmpeg/VERSION.txt",
    "third_party/ffmpeg/bin/ffmpeg",
    "third_party/ffmpeg/bin/ffprobe",
    "third_party/ldac/VERSION.txt",
    "third_party/ldac/bin/ldac_helper",
  ]);
  for (const file of inspection.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);

  const stagingRoot = path.join(path.dirname(bundle), "stage");
  const staged = await stageNativeBundle(bundle, stagingRoot);
  const manifest = JSON.parse(await fs.readFile(staged.manifestPath, "utf8"));
  assert.equal(manifest.schema, NATIVE_BUNDLE_MANIFEST_SCHEMA);
  assert.equal(manifest.mode, inspection.mode);
  assert.equal(manifest.ldacHelperIncluded, true);
  assert.match(manifest.distribution.publicRedistribution, /separate release review/);
  assert.deepEqual(manifest.files, inspection.files);
  await fs.access(path.join(staged.directory, NATIVE_BUNDLE_MANIFEST));
  await fs.access(path.join(staged.directory, "NOTICE"));
  assert.equal(await verifyPackagedNativeBundle(staged.directory, inspection).then((value) => value.schema), NATIVE_BUNDLE_MANIFEST_SCHEMA);
});

test("optional LDAC is absent without inventing helper support", async t => {
  const { bundle } = await fixture(t);
  const inspection = await inspectNativeBundle(bundle);
  assert.equal(inspection.ldacHelperIncluded, false);
  assert.equal(inspection.versions.ldac, null);
  const staged = await stageNativeBundle(bundle, path.join(path.dirname(bundle), "stage"));
  const manifest = JSON.parse(await fs.readFile(staged.manifestPath, "utf8"));
  assert.equal(manifest.ldacHelperIncluded, false);
  await assert.rejects(fs.access(path.join(staged.directory, "third_party/ldac")));
});

test("incomplete, unsafe or unproven native bundles fail clearly", async t => {
  const { bundle } = await fixture(t);
  await fs.rm(path.join(bundle, "third_party/ffmpeg/bin/ffprobe"));
  await assert.rejects(inspectNativeBundle(bundle), (error) => {
    assert.ok(error instanceof NativeBundleError);
    assert.match(error.message, /Missing required file: third_party\/ffmpeg\/bin\/ffprobe/);
    return true;
  });

  const { bundle: unsafe } = await fixture(t);
  await fs.rm(path.join(unsafe, "third_party/ffmpeg/bin/ffmpeg"));
  await fs.symlink("/bin/true", path.join(unsafe, "third_party/ffmpeg/bin/ffmpeg"));
  await assert.rejects(inspectNativeBundle(unsafe), /unsafe symlink/);

  const { bundle: notExecutable } = await fixture(t);
  await fs.chmod(path.join(notExecutable, "third_party/ffmpeg/bin/ffmpeg"), 0o644);
  await assert.rejects(inspectNativeBundle(notExecutable), /Not an executable regular file/);

  const { bundle: wrongArch } = await fixture(t);
  const wrong = elf64x64();
  wrong.writeUInt16LE(183, 18); // AArch64 is not a Linux x64 release payload.
  await fs.writeFile(path.join(wrongArch, "third_party/ffmpeg/bin/ffmpeg"), wrong, { mode: 0o755 });
  await assert.rejects(inspectNativeBundle(wrongArch), /not a Linux x64 ELF file/);

  const { bundle: noProvenance } = await fixture(t);
  await fs.writeFile(path.join(noProvenance, "third_party/ffmpeg/VERSION.txt"), "local build\n");
  await assert.rejects(inspectNativeBundle(noProvenance), /FFmpeg VERSION provenance does not record FFmpeg 9\.0\.2/);

  const { bundle: halfLdac } = await fixture(t);
  await fs.mkdir(path.join(halfLdac, "third_party/ldac"), { recursive: true });
  await fs.writeFile(path.join(halfLdac, "third_party/ldac/VERSION.txt"), LDAC_VERSION);
  await assert.rejects(inspectNativeBundle(halfLdac), /VERSION.txt is present without/);
});

test("bundle request is explicit only and accepts no PATH fallback", () => {
  assert.equal(resolveNativeBundleRequest({}), null);
  assert.equal(resolveNativeBundleRequest({ CODEC_ABX_NATIVE_BUNDLE_DIR: "" }), null);
  assert.equal(resolveNativeBundleRequest({ CODEC_ABX_NATIVE_BUNDLE_DIR: "prepared" }),
    path.resolve("prepared"));
});

test("staging refuses overlapping input/output and preserves the supplied resources", async t => {
  for (const direction of ["same", "parent", "child"]) {
    const { bundle, root } = await fixture(t);
    const staging = direction === "same" ? bundle : direction === "parent" ? root : path.join(bundle, "stage");
    await assert.rejects(stageNativeBundle(bundle, staging), /overlap/);
    assert.equal(await fs.readFile(path.join(bundle, "NOTICE"), "utf8"), "supplied third-party notices\n");
    await fs.access(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg"));
  }
});

test("native resources cannot replace the Electron app archive or lifetime host", async t => {
  const { bundle } = await fixture(t);
  await fs.writeFile(path.join(bundle, "app.asar"), "unrelated archive");
  await fs.mkdir(path.join(bundle, "process-host"));
  await assert.rejects(inspectNativeBundle(bundle), /Reserved resources entry/);
  await assert.rejects(inspectNativeBundle(bundle), /process-host/);
});

test("all build cleanup trees refuse nested native input before mutation, including symlink aliases", async t => {
  const { root } = await fixture(t);
  for (const output of desktopBuildOutputDirectories(root)) {
    const supplied = path.join(output, "prepared-resources");
    await fs.mkdir(supplied, { recursive: true });
    const marker = path.join(supplied, "NOTICE");
    await fs.writeFile(marker, "preserve input");
    await assert.rejects(assertNativeBundleOutsideOutputs(supplied, desktopBuildOutputDirectories(root)), /overlap/);
    assert.equal(await fs.readFile(marker, "utf8"), "preserve input");
  }
  const alias = path.join(root, "aliased-output");
  await fs.symlink(path.join(root, "dist/desktop"), alias);
  await assert.rejects(assertNativeBundleOutsideOutputs(path.join(alias, "prepared-resources"), desktopBuildOutputDirectories(root)), /overlap/);
});

test("package verification refuses lost executable permissions and altered manifest evidence", async t => {
  const { bundle, root } = await fixture(t);
  const staged = await stageNativeBundle(bundle, path.join(root, "stage"));
  const executable = path.join(staged.directory, "third_party/ffmpeg/bin/ffmpeg");
  await fs.chmod(executable, 0o644);
  await assert.rejects(verifyPackagedNativeBundle(staged.directory, staged.inspection), /executable/);
  await fs.chmod(executable, 0o755);
  const manifest = JSON.parse(await fs.readFile(staged.manifestPath, "utf8"));
  manifest.files[0].sha256 = "0".repeat(64);
  await fs.writeFile(staged.manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyPackagedNativeBundle(staged.directory, staged.inspection), /manifest/);
});

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function windowsFfmpegVersion(ffmpegBytes, ffprobeBytes) {
  return `FFmpeg:       9.0.2 (stable release)
Source:       https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
SHA-256:      8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
Target:       Windows x64 (PE32+), MSYS2 MINGW64
Binary type:  PE32+ executable, statically linked codec libs and MinGW runtime
Binary SHA-256 (ffmpeg):  ${sha256Of(ffmpegBytes)}
Binary SHA-256 (ffprobe): ${sha256Of(ffprobeBytes)}
built by tools/build_ffmpeg_windows.sh
Static dependencies:
  liblc3      1.1.3   https://github.com/google/liblc3

Static dependency archive SHA-256:
  liblc3      276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af   https://github.com/google/liblc3/archive/refs/tags/v1.1.3.tar.gz
`;
}

function windowsLdacVersion(helperBytes) {
  return `ldac_helper 1.0.0
container_version 1
target=windows-x64
libldac_repo=https://android.googlesource.com/platform/external/libldac
libldac_commit=eeee1a3f5f8df1282e3a6d297085885fd886737b
libldacdec_repo=https://github.com/hegdi/libldacdec
libldacdec_commit=7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9
binary_sha256=${sha256Of(helperBytes)}
`;
}

/**
 * Minimal PE32+ image with an import directory. Only the documented headers
 * and one raw-backed section are populated; this exercises the validator, not
 * a Windows loader.
 */
function peImage({ machine = 0x8664, magic = 0x20b, dll = false, imports = [], delayImports = [] } = {}) {
  const PE_OFFSET = 0x40;
  const COFF = PE_OFFSET + 4;
  const OPTIONAL = COFF + 20;
  const OPTIONAL_SIZE = magic === 0x20b ? 0xf0 : 0xe0;
  const SECTION = OPTIONAL + OPTIONAL_SIZE;
  const RAW = 0x200;
  const RAW_SIZE = 0x400;
  const buffer = Buffer.alloc(RAW + RAW_SIZE);
  buffer.write("MZ", 0, "latin1");
  buffer.writeUInt32LE(PE_OFFSET, 0x3c);
  buffer.write("PE\0\0", PE_OFFSET, "latin1");
  buffer.writeUInt16LE(machine, COFF);
  buffer.writeUInt16LE(1, COFF + 2);
  buffer.writeUInt16LE(OPTIONAL_SIZE, COFF + 16);
  buffer.writeUInt16LE(dll ? 0x2022 : 0x0022, COFF + 18);
  buffer.writeUInt16LE(magic, OPTIONAL);
  buffer.writeUInt32LE(16, OPTIONAL + 108);
  const importDescriptors = imports.length + 1;
  const delayDescriptors = delayImports.length + 1;
  const delayTableOffset = importDescriptors * 20;
  let stringOffset = delayTableOffset + delayDescriptors * 32;
  const importOffsets = imports.map((name) => {
    const offset = stringOffset;
    stringOffset += Buffer.byteLength(name, "latin1") + 1;
    return offset;
  });
  const delayOffsets = delayImports.map((name) => {
    const offset = stringOffset;
    stringOffset += Buffer.byteLength(name, "latin1") + 1;
    return offset;
  });
  // Optional-header data directory 0 is exports; imports are directory 1 and
  // delay-load imports are directory 13.
  buffer.writeUInt32LE(imports.length === 0 ? 0 : 0x1000, OPTIONAL + 112 + 8);
  buffer.writeUInt32LE(imports.length === 0 ? 0 : importDescriptors * 20, OPTIONAL + 112 + 12);
  buffer.writeUInt32LE(delayImports.length === 0 ? 0 : 0x1000 + delayTableOffset, OPTIONAL + 112 + 13 * 8);
  buffer.writeUInt32LE(delayImports.length === 0 ? 0 : delayDescriptors * 32, OPTIONAL + 112 + 13 * 8 + 4);
  imports.forEach((name, index) => {
    const nameOffset = importOffsets[index];
    buffer.writeUInt32LE(0x1000 + nameOffset, RAW + index * 20 + 12);
    buffer.write(name, RAW + nameOffset, "latin1");
    buffer[RAW + nameOffset + Buffer.byteLength(name, "latin1")] = 0;
  });
  delayImports.forEach((name, index) => {
    const descriptor = RAW + delayTableOffset + index * 32;
    buffer.writeUInt32LE(1, descriptor); // RVA-based delay descriptor
    buffer.writeUInt32LE(0x1000 + delayOffsets[index], descriptor + 4);
    buffer.write(name, RAW + delayOffsets[index], "latin1");
    buffer[RAW + delayOffsets[index] + Buffer.byteLength(name, "latin1")] = 0;
  });
  buffer.write(".idata", SECTION, "latin1");
  buffer.writeUInt32LE(Math.max(stringOffset, 1), SECTION + 8);
  buffer.writeUInt32LE(0x1000, SECTION + 12);
  buffer.writeUInt32LE(RAW_SIZE, SECTION + 16);
  buffer.writeUInt32LE(RAW, SECTION + 20);
  return buffer;
}

async function windowsFixture(t, {
  ffmpegImports = ["KERNEL32.dll"],
  ffprobeImports = ["KERNEL32.dll"],
  ffmpegDelayImports = [],
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-bundle-win-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "prepared");
  await fs.mkdir(path.join(bundle, "third_party/ffmpeg/bin"), { recursive: true });
  const ffmpegBytes = peImage({ imports: ffmpegImports, delayImports: ffmpegDelayImports });
  const ffprobeBytes = peImage({ imports: ffprobeImports });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"), ffmpegBytes, { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffprobe.exe"), ffprobeBytes, { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/VERSION.txt"),
    windowsFfmpegVersion(ffmpegBytes, ffprobeBytes));
  await fs.writeFile(path.join(bundle, "NOTICE"), "supplied third-party notices\n");
  return { root, bundle };
}

async function addWindowsLdac(bundle) {
  await fs.mkdir(path.join(bundle, "third_party/ldac/bin"), { recursive: true });
  const helperBytes = peImage({ imports: ["KERNEL32.dll", "msvcrt.dll"] });
  await fs.writeFile(path.join(bundle, "third_party/ldac/bin/ldac_helper.exe"), helperBytes, { mode: 0o755 });
  await fs.writeFile(path.join(bundle, "third_party/ldac/VERSION.txt"), windowsLdacVersion(helperBytes));
}

async function addWindowsDll(bundle, name, { imports = [], machine = 0x8664, magic = 0x20b, dll = true } = {}) {
  const directory = path.join(bundle, "third_party/ffmpeg/bin");
  await fs.writeFile(path.join(directory, name), peImage({ imports, machine, magic, dll }), { mode: 0o755 });
  return path.join(directory, name);
}

test("Windows x64 bundle validates PE32+ payloads, provenance and DLL imports", async t => {
  const { bundle, root } = await windowsFixture(t, {
    ffmpegImports: ["KERNEL32.dll", "AVCODEC-62.dll", "msvcrt.dll"],
    ffprobeImports: ["KERNEL32.dll", "WS2_32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"],
  });
  await addWindowsDll(bundle, "avcodec-62.dll", { imports: ["KERNEL32.dll"] });
  await addWindowsLdac(bundle);
  const inspection = await inspectNativeBundle(bundle, { platform: "win32" });
  assert.equal(inspection.platform, "win32");
  assert.equal(inspection.arch, "x64");
  assert.equal(inspection.executableFormat, "pe32+");
  assert.equal(inspection.ldacHelperIncluded, true);
  assert.match(inspection.versions.ffmpeg, /^Target:.*Windows x64/m);
  assert.deepEqual(inspection.windowsDlls.bundledDlls, ["third_party/ffmpeg/bin/avcodec-62.dll"]);
  const imports = inspection.windowsDlls.imports;
  const ffmpegImports = imports.filter((entry) => entry.file.endsWith("ffmpeg.exe"));
  assert.equal(ffmpegImports.find((entry) => entry.name === "KERNEL32.dll").source, "system");
  assert.equal(ffmpegImports.find((entry) => entry.name.toLowerCase() === "avcodec-62.dll").source, "bundle");
  assert.equal(ffmpegImports.find((entry) => entry.name.toLowerCase() === "avcodec-62.dll").providedBy,
    "third_party/ffmpeg/bin/avcodec-62.dll");
  assert.ok(!imports.some((entry) => entry.source === "missing"));
  assert.deepEqual(inspection.files.map((file) => file.path).sort(), [
    "NOTICE",
    "third_party/ffmpeg/VERSION.txt",
    "third_party/ffmpeg/bin/avcodec-62.dll",
    "third_party/ffmpeg/bin/ffmpeg.exe",
    "third_party/ffmpeg/bin/ffprobe.exe",
    "third_party/ldac/VERSION.txt",
    "third_party/ldac/bin/ldac_helper.exe",
  ]);

  const stagingRoot = path.join(root, "stage-win");
  const staged = await stageNativeBundle(bundle, stagingRoot, { platform: "win32" });
  const manifest = JSON.parse(await fs.readFile(staged.manifestPath, "utf8"));
  assert.equal(manifest.schema, NATIVE_BUNDLE_MANIFEST_SCHEMA);
  assert.equal(manifest.platform, "win32");
  assert.equal(manifest.executableFormat, "pe32+");
  assert.equal(manifest.windowsDlls.bundledDlls[0], "third_party/ffmpeg/bin/avcodec-62.dll");
  assert.equal(await verifyPackagedNativeBundle(staged.directory, staged.inspection)
    .then((value) => value.platform), "win32");
  // Windows payloads do not carry Unix executable bits; the manifest still
  // binds exact bytes and the packaged verification must not require mode bits.
  await fs.chmod(path.join(staged.directory, "third_party/ffmpeg/bin/ffmpeg.exe"), 0o644);
  assert.equal(await verifyPackagedNativeBundle(staged.directory, staged.inspection)
    .then((value) => value.platform), "win32");
});

test("Windows bundle validation fails closed for DLL, architecture and provenance gaps", async t => {
  {
    const { bundle } = await windowsFixture(t, { ffmpegImports: ["KERNEL32.dll", "avcodec-62.dll"] });
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), (error) => {
      assert.ok(error instanceof NativeBundleError);
      assert.match(error.message, /imports a DLL that is neither supplied beside it/);
      assert.match(error.message, /avcodec-62\.dll/);
      return true;
    });
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsDll(bundle, "vcruntime140.dll", { imports: ["KERNEL32.dll"] });
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffprobe.exe"),
      peImage({ imports: ["VCRUNTIME140.dll"] }), { mode: 0o755 });
    await fs.rm(path.join(bundle, "third_party/ffmpeg/bin/vcruntime140.dll"));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /VCRUNTIME140\.dll/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsDll(bundle, "helper.dll", { imports: ["KERNEL32.dll", "zlib1.dll"] });
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"),
      peImage({ imports: ["KERNEL32.dll", "helper.dll"] }), { mode: 0o755 });
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /zlib1\.dll/);
  }
  for (const options of [
    { machine: 0xaa64 }, // ARM64
    { machine: 0x14c }, // i386
    { magic: 0x10b }, // PE32, not PE32+
  ]) {
    const { bundle } = await windowsFixture(t);
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"),
      peImage(options), { mode: 0o755 });
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /not a Windows x64 PE32\+ file/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"), "not a PE image");
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /not a Windows x64 PE32\+ file/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"),
      peImage({ dll: true }), { mode: 0o755 });
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /DLL characteristic/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsDll(bundle, "wrong.dll", { machine: 0xaa64 });
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"),
      peImage({ imports: ["KERNEL32.dll", "wrong.dll"] }), { mode: 0o755 });
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /Bundled DLL is not a Windows x64 PE32\+ file/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsDll(bundle, "not-a-dll.dll", { dll: false });
    await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"),
      peImage({ imports: ["KERNEL32.dll", "not-a-dll.dll"] }), { mode: 0o755 });
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /does not have the DLL characteristic/);
  }
  {
    const { bundle } = await windowsFixture(t);
    const versionPath = path.join(bundle, "third_party/ffmpeg/VERSION.txt");
    await fs.writeFile(versionPath, (await fs.readFile(versionPath, "utf8")).replace(/^Target:.*\n/m, ""));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /Windows x64 target/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsLdac(bundle);
    const versionPath = path.join(bundle, "third_party/ldac/VERSION.txt");
    await fs.writeFile(versionPath, (await fs.readFile(versionPath, "utf8")).replace("target=windows-x64\n", ""));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /Windows x64 target/);
  }
});

test("Windows delay-load imports are audited as runtime dependencies", async t => {
  const { bundle } = await windowsFixture(t, { ffmpegDelayImports: ["delay_codec.dll"] });
  await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), (error) => {
    assert.match(error.message, /delay-loads a DLL that is neither supplied beside it/);
    assert.match(error.message, /delay_codec\.dll/);
    return true;
  });
  await addWindowsDll(bundle, "delay_codec.dll", { imports: ["KERNEL32.dll"] });
  const inspection = await inspectNativeBundle(bundle, { platform: "win32" });
  const dependency = inspection.windowsDlls.imports.find((entry) => entry.name === "delay_codec.dll");
  assert.equal(dependency.kind, "delay-import");
  assert.equal(dependency.source, "bundle");
});

test("Windows provenance enforces exact source pins and binary hashes", async t => {
  const cases = [
    ["FFmpeg version", /^FFmpeg:\s+9\.0\.2/m, /FFmpeg 9\.0\.2/, (text) => text.replace(/^FFmpeg:\s+9\.0\.2/m, "FFmpeg:       9.0.3")],
    ["FFmpeg archive", /^SHA-256:\s+[a-f0-9]{64}/m, /archive SHA-256/,
      (text) => text.replace(/^SHA-256:\s+[a-f0-9]{64}/m, `SHA-256:      ${"0".repeat(64)}`)],
    ["FFmpeg source", /^Source:\s+\S+/m, /source https:\/\/ffmpeg\.org/,
      (text) => text.replace(/^Source:\s+\S+/m, "Source:       https://example.invalid/ffmpeg.tar.xz")],
    ["ffmpeg binary hash", /^Binary SHA-256 \(ffmpeg\):\s+[a-f0-9]{64}/m, /does not match the supplied bytes/,
      (text) => text.replace(/^(Binary SHA-256 \(ffmpeg\):\s+)[a-f0-9]{64}/m, `$1${"0".repeat(64)}`)],
    ["missing ffprobe binary hash", /^Binary SHA-256 \(ffprobe\):/m, /missing Binary SHA-256 \(ffprobe\)/,
      (text) => text.replace(/^Binary SHA-256 \(ffprobe\):.*\n/m, "")],
    ["liblc3 version", /^\s*liblc3\s+1\.1\.3/m, /liblc3 1\.1\.3/,
      (text) => text.replace(/^(\s*liblc3\s+)1\.1\.3/m, "$11.1.2")],
    ["liblc3 archive", /276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af/,
      /liblc3 archive SHA-256/, (text) => text.replace("276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af", "0".repeat(64))],
  ];
  for (const [label, locate, message, mutate] of cases) {
    const { bundle } = await windowsFixture(t);
    const versionPath = path.join(bundle, "third_party/ffmpeg/VERSION.txt");
    const original = await fs.readFile(versionPath, "utf8");
    assert.match(original, locate, label);
    await fs.writeFile(versionPath, mutate(original));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), message);
  }

  {
    const { bundle } = await windowsFixture(t);
    await addWindowsLdac(bundle);
    const versionPath = path.join(bundle, "third_party/ldac/VERSION.txt");
    const original = await fs.readFile(versionPath, "utf8");
    await fs.writeFile(versionPath,
      original.replace(/^libldac_commit=.*$/m, `libldac_commit=${"1".repeat(40)}`));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /libldac commit/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsLdac(bundle);
    const versionPath = path.join(bundle, "third_party/ldac/VERSION.txt");
    const original = await fs.readFile(versionPath, "utf8");
    await fs.writeFile(versionPath, original.replace(/^binary_sha256=\S+$/m, `binary_sha256=${"0".repeat(64)}`));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /binary_sha256 does not match/);
  }
  {
    const { bundle } = await windowsFixture(t);
    await addWindowsLdac(bundle);
    const versionPath = path.join(bundle, "third_party/ldac/VERSION.txt");
    const original = await fs.readFile(versionPath, "utf8");
    await fs.writeFile(versionPath, original.replace(/^binary_sha256=.*\n/m, ""));
    await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /missing binary_sha256/);
  }
});

test("Windows bundle rejects a bundled DLL that shadows a system DLL", async t => {
  const { bundle } = await windowsFixture(t);
  await addWindowsDll(bundle, "KERNEL32.dll");
  await fs.writeFile(path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"),
    peImage({ imports: ["KERNEL32.dll"] }), { mode: 0o755 });
  await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /shadows a Windows system DLL/);
});

test("a Windows request against a Linux-layout bundle fails rather than guessing", async t => {
  const { bundle } = await fixture(t);
  await assert.rejects(inspectNativeBundle(bundle, { platform: "win32" }), /Missing required file: third_party\/ffmpeg\/bin\/ffmpeg\.exe/);
  const { bundle: windows } = await windowsFixture(t);
  await assert.rejects(inspectNativeBundle(windows), /Missing required file: third_party\/ffmpeg\/bin\/ffmpeg/);
});

test("PE parser agrees with a real vendor x64 executable when present", async t => {
  // Independent sample: an installed Electron tooling dependency, not our
  // synthetic builder. Skip cleanly if a pruned install omits it.
  const sample = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "../../node_modules/@electron/windows-sign/vendor/signtool.exe");
  try {
    await fs.access(sample);
  } catch {
    t.skip("vendor PE sample is not installed");
    return;
  }
  const inspection = await inspectPeExecutable(sample);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.isX64, true);
  assert.equal(inspection.dll, false);
  assert.ok(inspection.imports.includes("KERNEL32.dll"));
  assert.ok(inspection.imports.includes("ADVAPI32.dll"));
});

const AUDIT_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../verification/windows-native-audit.mjs");

function runAudit(argumentsList) {
  const result = spawnSync(process.execPath, [AUDIT_CLI, ...argumentsList], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("Windows audit CLI reports structural evidence and supports component-only builds", async t => {
  const { bundle } = await windowsFixture(t, { ffmpegImports: ["KERNEL32.dll", "avcodec-62.dll"] });
  await addWindowsDll(bundle, "avcodec-62.dll");
  await addWindowsLdac(bundle);
  const all = runAudit(["--bundle", bundle, "--json"]);
  assert.equal(all.status, 0, all.stderr);
  const report = JSON.parse(all.stdout);
  assert.equal(report.schema, "windows-native-audit-v1");
  assert.equal(report.ok, true);
  assert.equal(report.platform, "win32");
  assert.equal(report.component, "all");
  assert.ok(report.windowsDlls.imports.some((entry) => entry.source === "bundle"));
  assert.ok(!report.windowsDlls.imports.some((entry) => entry.source === "missing"));

  const ffmpeg = runAudit(["--bundle", bundle, "--component", "ffmpeg", "--json"]);
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  assert.equal(JSON.parse(ffmpeg.stdout).component, "ffmpeg");

  const ldacOnly = await fs.mkdtemp(path.join(os.tmpdir(), "native-bundle-win-ldac-"));
  t.after(() => fs.rm(ldacOnly, { recursive: true, force: true }));
  await fs.mkdir(path.join(ldacOnly, "third_party/ldac/bin"), { recursive: true });
  const helperBytes = peImage({ imports: ["KERNEL32.dll"] });
  await fs.writeFile(path.join(ldacOnly, "third_party/ldac/bin/ldac_helper.exe"), helperBytes, { mode: 0o755 });
  await fs.writeFile(path.join(ldacOnly, "third_party/ldac/VERSION.txt"), windowsLdacVersion(helperBytes));
  const ldac = runAudit(["--bundle", ldacOnly, "--component", "ldac"]);
  assert.equal(ldac.status, 0, ldac.stderr);
  assert.match(ldac.stdout, /Component: ldac/);
  assert.equal(runAudit(["--bundle", ldacOnly, "--json"]).status, 1);

  const file = runAudit(["--file", path.join(bundle, "third_party/ffmpeg/bin/ffmpeg.exe"), "--json"]);
  assert.equal(file.status, 0, file.stderr);
  assert.equal(JSON.parse(file.stdout).isWindowsX64, true);
  assert.equal(runAudit(["--bundle", bundle, "--component", "ldac", "--stage", path.join(bundle, "stage")]).status, 2);
});


test('whole Windows package audit catches Electron/runtime DLL gaps and wrong architectures', async t => {
  const { auditWindowsPackage } = await import('../verification/windows-package-audit.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-pe-package-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'resources/process-host'), { recursive: true });
  await fs.writeFile(path.join(directory, 'resources/process-host/audivane-process-host.exe'),
    peImage({ imports: ['KERNEL32.dll'] }));
  await fs.writeFile(path.join(directory, 'Audivane.exe'), peImage({ imports: ['KERNEL32.dll', 'DWrite.dll', 'private-runtime.dll'] }));
  await assert.rejects(auditWindowsPackage(directory), /missing runtime DLL private-runtime/);
  await fs.writeFile(path.join(directory, 'private-runtime.dll'), peImage({ dll: true, imports: ['missing-transitive.dll'] }));
  await assert.rejects(auditWindowsPackage(directory), /missing-transitive/);
  await fs.writeFile(path.join(directory, 'private-runtime.dll'), peImage({ dll: true, imports: ['KERNEL32.dll'] }));
  const audit = await auditWindowsPackage(directory);
  assert.equal(audit.files.length, 3);
  assert.ok(audit.files.flatMap(file => file.imports).some(item => item.name === 'DWrite.dll' && item.source === 'system'));
  await fs.writeFile(path.join(directory, 'private-runtime.dll'), peImage({ dll: true, machine: 0x14c }));
  await assert.rejects(auditWindowsPackage(directory), /not a valid Windows x64/);
});
