import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Opt-in prepared native resource directory for a desktop package.
 *
 * The directory is the resources root. Linux x64 requires
 * `third_party/ffmpeg/bin/{ffmpeg,ffprobe}` and
 * `third_party/ffmpeg/VERSION.txt`. Windows x64 requires the same files with
 * `.exe` names and PE32+ payloads. `third_party/ldac/` and its VERSION are
 * included only when the optional helper is supplied; Windows helper DLLs must
 * sit beside the executable. Extra regular files (notices/source metadata) are
 * retained and hashed.
 *
 * Nothing is discovered from PATH or downloaded. A release only receives the
 * exact directory the caller names.
 */
export const NATIVE_BUNDLE_MODE = "portable-native-bundle-v1";
export const NATIVE_BUNDLE_MANIFEST = "native-bundle-manifest.json";
export const NATIVE_BUNDLE_MANIFEST_SCHEMA = "codec-abx-native-bundle-manifest-v1";
export const NATIVE_BUNDLE_PLATFORMS = Object.freeze(["linux", "win32"]);

/**
 * DLLs that ship with Windows itself (or with a supported Windows version's
 * universal CRT/API sets). Any other imported DLL must be present in the
 * supplied bundle; that includes MSVC and MinGW runtime redistributables.
 * Names are lower-case; matching is case-insensitive as on Windows.
 */
export const WINDOWS_SYSTEM_DLLS = Object.freeze(new Set([
  "advapi32.dll", "avicap32.dll", "avifil32.dll", "avrt.dll", "bcrypt.dll",
  "cabinet.dll", "cfgmgr32.dll",
  "combase.dll", "comctl32.dll", "comdlg32.dll", "crypt32.dll", "d2d1.dll",
  "d3d11.dll", "dbghelp.dll", "dnsapi.dll", "dsound.dll", "dwmapi.dll",
  // DirectWrite system DLL: Microsoft DWriteCreateFactory API requirements.
  "dxgi.dll", "dwrite.dll", "gdi32.dll", "glu32.dll", "imm32.dll", "iphlpapi.dll",
  "kernel32.dll", "kernelbase.dll", "mf.dll", "mfcore.dll", "mfplat.dll",
  "mpr.dll", "msacm32.dll", "msvcrt.dll", "ncrypt.dll", "netapi32.dll",
  "normaliz.dll", "nsi.dll", "ntdll.dll", "ole32.dll", "oleacc.dll",
  "oleaut32.dll", "opengl32.dll", "pdh.dll", "powrprof.dll", "propsys.dll",
  "psapi.dll", "rpcrt4.dll", "sechost.dll", "secur32.dll", "setupapi.dll",
  "shcore.dll", "shell32.dll", "shlwapi.dll", "sspicli.dll", "twinapi.dll",
  "ucrtbase.dll", "urlmon.dll", "user32.dll", "userenv.dll", "uxtheme.dll",
  "version.dll", "wininet.dll", "winmm.dll", "wintrust.dll", "wldap32.dll",
  "ws2_32.dll", "wtsapi32.dll", "windowscodecs.dll", "xmllite.dll",
]));

const FFMPEG_RELATIVE = "third_party/ffmpeg";
const LDAC_RELATIVE = "third_party/ldac";
const MANIFEST_RELATIVE = NATIVE_BUNDLE_MANIFEST;
const RESERVED_TOP_LEVEL = new Set(["app", "app.asar", "app.asar.unpacked", "default_app.asar", "native-bundle-manifest.json", "process-host"]);

const PLATFORM_LAYOUTS = Object.freeze({
  linux: Object.freeze({
    arch: "x64",
    executableFormat: "elf64",
    ffmpegExecutables: Object.freeze(["ffmpeg", "ffprobe"]),
    ldacHelper: "ldac_helper",
    layout: "resources root; FFmpeg/ffprobe under third_party/ffmpeg/bin",
  }),
  win32: Object.freeze({
    arch: "x64",
    executableFormat: "pe32+",
    ffmpegExecutables: Object.freeze(["ffmpeg.exe", "ffprobe.exe"]),
    ldacHelper: "ldac_helper.exe",
    layout: "resources root; FFmpeg/ffprobe .exe under third_party/ffmpeg/bin; " +
      "required non-system DLLs alongside them",
  }),
});

/**
 * Exact native source pins. VERSION files must describe these sources, not
 * merely contain the right labels. Keep in step with the build scripts.
 */
export const NATIVE_SOURCE_PINS = Object.freeze({
  ffmpegVersion: "9.0.2",
  ffmpegSource: "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
  ffmpegArchiveSha256: "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
  liblc3Version: "1.1.3",
  liblc3ArchiveSha256: "276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af",
  libldacRepo: "https://android.googlesource.com/platform/external/libldac",
  libldacCommit: "eeee1a3f5f8df1282e3a6d297085885fd886737b",
  libldacdecRepo: "https://github.com/hegdi/libldacdec",
  libldacdecCommit: "7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9",
});

const PE_MACHINE_X64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;
const PE_DLL_CHARACTERISTIC = 0x2000;
const MAX_PE_SECTIONS = 96;
const MAX_IMPORT_DESCRIPTORS = 4096;
const MAX_IMPORT_NAME = 260;

export class NativeBundleError extends Error {
  constructor(message, problems) {
    super([message, ...problems.map((problem) => `- ${problem}`)].join("\n"));
    this.name = "NativeBundleError";
    this.problems = Object.freeze([...problems]);
  }
}

function toPosix(relative) {
  return relative.split(path.sep).join("/");
}

function bundlePlatform(platform) {
  const layout = PLATFORM_LAYOUTS[platform];
  if (layout === undefined) {
    throw new NativeBundleError("Unsupported native bundle platform", [
      `platform must be one of: ${NATIVE_BUNDLE_PLATFORMS.join(", ")}`,
    ]);
  }
  return layout;
}

async function canonical(filename) {
  const absolute = path.resolve(filename);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(await canonical(path.dirname(absolute)), path.basename(absolute));
  }
}

/** All trees that the client/desktop/package build may replace. */
export function desktopBuildOutputDirectories(root) {
  return ["apps/client/dist", "apps/desktop/dist", "build/desktop-package",
    "build/desktop-native-bundle", "build/desktop-process-host", "dist/desktop"]
    .map(relative => path.join(root, relative));
}

/** Refuse before any build mutation could remove or alter a supplied tree. */
export async function assertNativeBundleOutsideOutputs(directory, outputs) {
  const source = await canonical(directory);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  for (const output of outputs) {
    const target = await canonical(output);
    if (contains(source, target) || contains(target, source)) {
      throw new NativeBundleError("Native bundle input and build output paths overlap", [source, target]);
    }
  }
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function walk(directory, relative = "") {
  const entries = [];
  for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
    const child = relative === "" ? name : path.join(relative, name);
    const absolute = path.join(directory, child);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new NativeBundleError("Native bundle contains an unsafe symlink", [toPosix(child)]);
    }
    if (stat.isDirectory()) {
      entries.push({ relative: toPosix(child), absolute, kind: "directory", stat });
      entries.push(...await walk(directory, child));
    } else if (stat.isFile()) {
      entries.push({ relative: toPosix(child), absolute, kind: "file", stat });
    } else {
      throw new NativeBundleError("Native bundle contains an unsupported filesystem entry", [toPosix(child)]);
    }
  }
  return entries;
}

async function isElf64X64(absolute) {
  const handle = await fs.open(absolute, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 20) return false;
    return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46 &&
      header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62;
  } finally {
    await handle.close();
  }
}

function peFailure(reason) {
  return Object.freeze({ ok: false, reason });
}

function readAsciiZ(buffer, offset, label) {
  let end = offset;
  while (end < buffer.length && end - offset < MAX_IMPORT_NAME && buffer[end] !== 0) end += 1;
  if (end >= buffer.length || end - offset >= MAX_IMPORT_NAME) {
    throw new Error(`${label} is unterminated`);
  }
  const value = buffer.toString("latin1", offset, end);
  if (value.length === 0) throw new Error(`${label} is empty`);
  return value;
}

function parsePe(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error("missing DOS MZ header");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length ||
      buffer[peOffset] !== 0x50 || buffer[peOffset + 1] !== 0x45 ||
      buffer[peOffset + 2] !== 0 || buffer[peOffset + 3] !== 0) {
    throw new Error("missing PE signature");
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  if (sectionCount === 0 || sectionCount > MAX_PE_SECTIONS) {
    throw new Error(`unexpected PE section count ${String(sectionCount)}`);
  }
  const optionalOffset = peOffset + 24;
  if (optionalOffset + optionalSize > buffer.length || optionalSize < 112) {
    throw new Error("truncated PE optional header");
  }
  const magic = buffer.readUInt16LE(optionalOffset);
  const sectionTable = optionalOffset + optionalSize;
  if (sectionTable + sectionCount * 40 > buffer.length) {
    throw new Error("truncated PE section table");
  }
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTable + index * 40;
    sections.push(Object.freeze({
      virtualSize: buffer.readUInt32LE(entry + 8),
      virtualAddress: buffer.readUInt32LE(entry + 12),
      rawSize: buffer.readUInt32LE(entry + 16),
      rawOffset: buffer.readUInt32LE(entry + 20),
    }));
  }
  const dll = (characteristics & PE_DLL_CHARACTERISTIC) !== 0;
  const isX64 = machine === PE_MACHINE_X64 && magic === PE32_PLUS_MAGIC;
  const imports = [];
  const delayImports = [];
  if (isX64) {
    const directoryCount = buffer.readUInt32LE(optionalOffset + 108);
    const rvaToOffset = (rva, size, label) => {
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva + size <= section.virtualAddress + span) {
          const delta = rva - section.virtualAddress;
          if (delta + size > section.rawSize) {
            throw new Error(`${label} is not backed by raw section data`);
          }
          const offset = section.rawOffset + delta;
          if (offset + size > buffer.length) throw new Error(`${label} is outside the file`);
          return offset;
        }
      }
      throw new Error(`${label} RVA is outside every PE section`);
    };
    if (directoryCount >= 2) {
      // Data directory 0 is the export table; imports are entry 1.
      const importDirectory = optionalOffset + 112 + 8;
      const importRva = buffer.readUInt32LE(importDirectory);
      const importSize = buffer.readUInt32LE(importDirectory + 4);
      if (importRva !== 0) {
        const tableOffset = rvaToOffset(importRva, 20, "import directory");
        const descriptorBudget = importSize >= 20
          ? Math.min(Math.floor(importSize / 20) + 1, MAX_IMPORT_DESCRIPTORS)
          : MAX_IMPORT_DESCRIPTORS;
        for (let index = 0; index < descriptorBudget; index += 1) {
          const descriptor = tableOffset + index * 20;
          if (descriptor + 20 > buffer.length) throw new Error("truncated PE import directory");
          const originalFirstThunk = buffer.readUInt32LE(descriptor);
          const timeDateStamp = buffer.readUInt32LE(descriptor + 4);
          const forwarderChain = buffer.readUInt32LE(descriptor + 8);
          const nameRva = buffer.readUInt32LE(descriptor + 12);
          const firstThunk = buffer.readUInt32LE(descriptor + 16);
          if (originalFirstThunk === 0 && timeDateStamp === 0 && forwarderChain === 0 &&
              nameRva === 0 && firstThunk === 0) {
            break;
          }
          if (nameRva === 0) throw new Error("PE import descriptor has no DLL name");
          const nameOffset = rvaToOffset(nameRva, 1, "import DLL name");
          imports.push(readAsciiZ(buffer, nameOffset, "import DLL name"));
        }
      }
    }
    // Delay-load imports are real runtime dependencies: audit them rather than
    // ignoring a directory that the loader can resolve after process start.
    if (directoryCount >= 14) {
      const delayDirectory = optionalOffset + 112 + 13 * 8;
      const delayRva = buffer.readUInt32LE(delayDirectory);
      const delaySize = buffer.readUInt32LE(delayDirectory + 4);
      if (delayRva !== 0) {
        const tableOffset = rvaToOffset(delayRva, 32, "delay import directory");
        const descriptorBudget = delaySize >= 32
          ? Math.min(Math.floor(delaySize / 32) + 1, MAX_IMPORT_DESCRIPTORS)
          : MAX_IMPORT_DESCRIPTORS;
        for (let index = 0; index < descriptorBudget; index += 1) {
          const descriptor = tableOffset + index * 32;
          if (descriptor + 32 > buffer.length) throw new Error("truncated PE delay import directory");
          const attributes = buffer.readUInt32LE(descriptor);
          const nameRva = buffer.readUInt32LE(descriptor + 4);
          const moduleHandle = buffer.readUInt32LE(descriptor + 8);
          const importAddressTable = buffer.readUInt32LE(descriptor + 12);
          const importNameTable = buffer.readUInt32LE(descriptor + 16);
          const boundImportAddressTable = buffer.readUInt32LE(descriptor + 20);
          const unloadInformationTable = buffer.readUInt32LE(descriptor + 24);
          const timeDateStamp = buffer.readUInt32LE(descriptor + 28);
          if (attributes === 0 && nameRva === 0 && moduleHandle === 0 &&
              importAddressTable === 0 && importNameTable === 0 &&
              boundImportAddressTable === 0 && unloadInformationTable === 0 &&
              timeDateStamp === 0) {
            break;
          }
          // Attribute bit 0 means RVA-based fields; old-style VA descriptors
          // cannot be resolved without the preferred image base, so refuse them
          // rather than silently omitting a dependency.
          if ((attributes & 1) === 0) {
            throw new Error("old-style VA-based PE delay imports are unsupported");
          }
          if (nameRva === 0) throw new Error("PE delay import descriptor has no DLL name");
          const nameOffset = rvaToOffset(nameRva, 1, "delay import DLL name");
          delayImports.push(readAsciiZ(buffer, nameOffset, "delay import DLL name"));
        }
      }
    }
  }
  return Object.freeze({
    machine,
    magic,
    dll,
    isX64,
    imports: Object.freeze(imports),
    delayImports: Object.freeze(delayImports),
  });
}

/**
 * Inspect one Windows PE file without executing it. A malformed or non-PE file
 * is a structured failure; callers must not treat it as usable.
 */
export async function inspectPeExecutable(filename) {
  let buffer;
  try {
    buffer = await fs.readFile(filename);
  } catch (error) {
    return peFailure(error instanceof Error ? error.message : "the file could not be read");
  }
  try {
    const parsed = parsePe(buffer);
    return Object.freeze({ ok: true, ...parsed });
  } catch (error) {
    return peFailure(error instanceof Error ? error.message : "the file is not a usable PE image");
  }
}

function provenanceProblems(label, text, requiredLines) {
  const problems = [];
  for (const [name, expression] of requiredLines) {
    if (!expression.test(text)) problems.push(`${label} VERSION provenance does not record ${name}`);
  }
  return problems;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionField(text, expression) {
  const match = expression.exec(text);
  return match?.[1] === undefined ? null : match[1].toLowerCase();
}

async function executableHashes(executables, byRelative) {
  const hashes = new Map();
  for (const relative of executables) {
    const entry = byRelative.get(relative);
    if (entry?.stat.isFile()) hashes.set(relative, await sha256File(entry.absolute));
  }
  return hashes;
}

function systemDll(name) {
  const lower = name.toLowerCase();
  return WINDOWS_SYSTEM_DLLS.has(lower) || lower.startsWith("api-ms-win-") || lower.startsWith("ext-ms-");
}

/**
 * Audit PE imports against bundled files and the Windows system allowlist.
 * Unknown imports are errors: the release must either ship the exact DLL or
 * document why the name belongs to the supported Windows baseline.
 */
function auditWindowsImports(peFiles, byRelativeLower) {
  const problems = [];
  const imports = [];
  const bundled = [];
  for (const file of peFiles) {
    if (file.relative.toLowerCase().endsWith(".dll")) {
      bundled.push(file.relative);
      if (systemDll(path.posix.basename(file.relative))) {
        problems.push(`Bundled DLL shadows a Windows system DLL: ${file.relative}`);
      }
    }
  }
  for (const file of peFiles) {
    const directory = path.posix.dirname(file.relative);
    const dependencies = [
      ...file.inspection.imports.map((name) => ({ name, kind: "import" })),
      ...file.inspection.delayImports.map((name) => ({ name, kind: "delay-import" })),
    ];
    for (const dependency of dependencies) {
      const { name, kind } = dependency;
      const lowerName = name.toLowerCase();
      const candidate = `${directory}/${lowerName}`;
      const supplied = byRelativeLower.get(candidate);
      if (supplied !== undefined) {
        imports.push(Object.freeze({
          file: file.relative,
          name,
          kind,
          source: "bundle",
          providedBy: supplied.relative,
        }));
        continue;
      }
      if (systemDll(name)) {
        imports.push(Object.freeze({
          file: file.relative,
          name,
          kind,
          source: "system",
          providedBy: null,
        }));
        continue;
      }
      imports.push(Object.freeze({
        file: file.relative,
        name,
        kind,
        source: "missing",
        providedBy: null,
      }));
      const fileKind = file.relative.toLowerCase().endsWith(".dll") ? "library" : "executable";
      const timing = kind === "delay-import" ? "delay-loads" : "imports";
      problems.push(
        `Windows ${fileKind} ${file.relative} ${timing} a DLL that is neither supplied beside it ` +
          `nor a recognized Windows system DLL: ${name}`,
      );
    }
  }
  imports.sort((left, right) => left.file.localeCompare(right.file) || left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
  bundled.sort();
  return Object.freeze({
    problems: Object.freeze(problems),
    audit: Object.freeze({
      systemDlls: Object.freeze([...WINDOWS_SYSTEM_DLLS].sort()),
      bundledDlls: Object.freeze(bundled),
      imports: Object.freeze(imports),
    }),
  });
}

export function resolveNativeBundleRequest(environment = process.env) {
  const value = environment.CODEC_ABX_NATIVE_BUNDLE_DIR;
  if (value === undefined || value === "") return null;
  return path.resolve(value);
}

/**
 * Validate and hash the supplied directory without writing outside it.
 * The returned record is safe to put in a release manifest: no source
 * absolute path or host-specific checkout path is included.
 */
export async function inspectNativeBundle(directory, options = {}) {
  const platform = options.platform ?? "linux";
  const components = options.components ?? "all";
  if (components !== "all" && components !== "ffmpeg" && components !== "ldac") {
    throw new NativeBundleError("Unsupported native bundle component selection", [
      "components must be one of: all, ffmpeg, ldac",
    ]);
  }
  const layout = bundlePlatform(platform);
  const resolved = path.resolve(directory);
  let rootStat;
  try {
    rootStat = await fs.stat(resolved);
  } catch {
    throw new NativeBundleError("Requested native bundle does not exist", [resolved]);
  }
  if (!rootStat.isDirectory()) {
    throw new NativeBundleError("Requested native bundle is not a directory", [resolved]);
  }
  const problems = [];
  const topLevel = (await fs.readdir(resolved)).sort();
  for (const name of topLevel) {
    if (RESERVED_TOP_LEVEL.has(name)) {
      problems.push(`Reserved resources entry cannot be supplied by the bundle: ${name}`);
    }
  }
  if (!topLevel.includes("third_party")) problems.push("Missing third_party/ directory");
  const entries = await walk(resolved);
  const byRelative = new Map(entries.map((entry) => [entry.relative, entry]));
  const byRelativeLower = new Map(entries.map((entry) => [entry.relative.toLowerCase(), entry]));
  const wantsFfmpeg = components === "all" || components === "ffmpeg";
  const wantsLdac = components === "all" || components === "ldac";
  const requiredFiles = wantsFfmpeg
    ? [
        `${FFMPEG_RELATIVE}/bin/${layout.ffmpegExecutables[0]}`,
        `${FFMPEG_RELATIVE}/bin/${layout.ffmpegExecutables[1]}`,
        `${FFMPEG_RELATIVE}/VERSION.txt`,
      ]
    : [];
  for (const relative of requiredFiles) {
    if (!byRelative.has(relative)) problems.push(`Missing required file: ${relative}`);
  }
  const helperRelative = `${LDAC_RELATIVE}/bin/${layout.ldacHelper}`;
  const ldacVersionRelative = `${LDAC_RELATIVE}/VERSION.txt`;
  const helperPresent = byRelative.has(helperRelative);
  const ldacVersionPresent = byRelative.has(ldacVersionRelative);
  if (components === "ldac") {
    if (!helperPresent) problems.push(`Missing required file: ${helperRelative}`);
    if (!ldacVersionPresent) problems.push(`Missing required file: ${ldacVersionRelative}`);
  }
  const ldacHelperIncluded = wantsLdac && (helperPresent || ldacVersionPresent);
  if (components === "all" && ldacHelperIncluded && !helperPresent) {
    problems.push(`Optional LDAC VERSION.txt is present without ${helperRelative}`);
  }
  if (components === "all" && ldacHelperIncluded && !ldacVersionPresent) {
    problems.push(`Optional LDAC helper is present without ${ldacVersionRelative}`);
  }
  const executables = [
    ...(wantsFfmpeg
      ? [
          `${FFMPEG_RELATIVE}/bin/${layout.ffmpegExecutables[0]}`,
          `${FFMPEG_RELATIVE}/bin/${layout.ffmpegExecutables[1]}`,
        ]
      : []),
    ...(wantsLdac && helperPresent ? [helperRelative] : []),
  ];
  const peFiles = [];
  for (const relative of executables) {
    const entry = byRelative.get(relative);
    if (!entry) continue;
    if (!entry.stat.isFile() || (platform === "linux" && (entry.stat.mode & 0o111) === 0)) {
      problems.push(`Not an executable regular file: ${relative}`);
      continue;
    }
    if (entry.stat.size === 0) {
      problems.push(`Empty executable: ${relative}`);
      continue;
    }
    if (platform === "linux") {
      if (!await isElf64X64(entry.absolute)) {
        problems.push(`Executable is not a Linux x64 ELF file: ${relative}`);
      }
      continue;
    }
    const inspection = await inspectPeExecutable(entry.absolute);
    if (!inspection.ok) {
      problems.push(`Executable is not a Windows x64 PE32+ file: ${relative} (${inspection.reason})`);
    } else if (!inspection.isX64) {
      problems.push(
        `Executable is not a Windows x64 PE32+ file: ${relative} ` +
          `(machine 0x${inspection.machine.toString(16)}, optional-header magic 0x${inspection.magic.toString(16)})`,
      );
    } else if (inspection.dll) {
      problems.push(`Windows executable has the DLL characteristic set: ${relative}`);
    } else {
      peFiles.push({ relative, absolute: entry.absolute, inspection });
    }
  }
  if (platform === "win32") {
    for (const entry of entries) {
      if (entry.kind !== "file" || !entry.relative.toLowerCase().endsWith(".dll")) continue;
      const inspection = await inspectPeExecutable(entry.absolute);
      if (!inspection.ok) {
        problems.push(`Bundled DLL is not a Windows PE file: ${entry.relative} (${inspection.reason})`);
      } else if (!inspection.isX64) {
        problems.push(
          `Bundled DLL is not a Windows x64 PE32+ file: ${entry.relative} ` +
            `(machine 0x${inspection.machine.toString(16)}, optional-header magic 0x${inspection.magic.toString(16)})`,
        );
      } else if (!inspection.dll) {
        problems.push(`Bundled DLL does not have the DLL characteristic: ${entry.relative}`);
      } else {
        peFiles.push({ relative: entry.relative, absolute: entry.absolute, inspection });
      }
    }
  }
  const versionTexts = new Map();
  const versionFiles = [
    ...(wantsFfmpeg ? [`${FFMPEG_RELATIVE}/VERSION.txt`] : []),
    ...(wantsLdac ? [ldacVersionRelative] : []),
  ];
  for (const relative of versionFiles) {
    const entry = byRelative.get(relative);
    if (!entry) continue;
    const text = await fs.readFile(entry.absolute, "utf8");
    versionTexts.set(relative, text);
    if (text.trim().length === 0) problems.push(`Empty provenance file: ${relative}`);
  }
  const pins = NATIVE_SOURCE_PINS;
  const ffmpegVersion = versionTexts.get(`${FFMPEG_RELATIVE}/VERSION.txt`);
  if (ffmpegVersion !== undefined) {
    problems.push(...provenanceProblems("FFmpeg", ffmpegVersion, [
      [`FFmpeg ${pins.ffmpegVersion}`, new RegExp(`^FFmpeg:\\s+${escapeRegExp(pins.ffmpegVersion)}\\b`, "m")],
      [`source ${pins.ffmpegSource}`, new RegExp(`^Source:\\s+${escapeRegExp(pins.ffmpegSource)}\\s*$`, "m")],
      [`archive SHA-256 ${pins.ffmpegArchiveSha256}`,
        new RegExp(`^SHA-256:\\s+${pins.ffmpegArchiveSha256}\\s*$`, "m")],
      [`liblc3 ${pins.liblc3Version}`,
        new RegExp(`^\\s*liblc3\\s+${escapeRegExp(pins.liblc3Version)}\\b`, "m")],
      ...(platform === "win32"
        ? [
            ["Windows x64 target", /^Target:.*Windows x64/im],
            [`liblc3 archive SHA-256 ${pins.liblc3ArchiveSha256}`,
              new RegExp(`^\\s*liblc3\\s+${pins.liblc3ArchiveSha256}\\b`, "m")],
          ]
        : []),
    ]));
  }
  const ldacVersion = versionTexts.get(ldacVersionRelative);
  if (ldacVersion !== undefined) {
    problems.push(...provenanceProblems("ldac_helper", ldacVersion, [
      [`libldac repository ${pins.libldacRepo}`,
        new RegExp(`^libldac_repo=${escapeRegExp(pins.libldacRepo)}\\s*$`, "m")],
      [`libldac commit ${pins.libldacCommit}`,
        new RegExp(`^libldac_commit=${pins.libldacCommit}\\s*$`, "m")],
      [`libldacdec repository ${pins.libldacdecRepo}`,
        new RegExp(`^libldacdec_repo=${escapeRegExp(pins.libldacdecRepo)}\\s*$`, "m")],
      [`libldacdec commit ${pins.libldacdecCommit}`,
        new RegExp(`^libldacdec_commit=${pins.libldacdecCommit}\\s*$`, "m")],
      ...(platform === "win32" ? [["Windows x64 target", /^target=windows-x64$/im]] : []),
    ]));
  }
  const binaryHashes = await executableHashes(executables, byRelative);
  const ffmpegExecutable = `${FFMPEG_RELATIVE}/bin/${layout.ffmpegExecutables[0]}`;
  const ffprobeExecutable = `${FFMPEG_RELATIVE}/bin/${layout.ffmpegExecutables[1]}`;
  if (ffmpegVersion !== undefined) {
    const recordedFfmpeg = versionField(ffmpegVersion, /^Binary SHA-256 \(ffmpeg\):\s*([a-f0-9]{64})\s*$/im);
    const recordedFfprobe = versionField(ffmpegVersion, /^Binary SHA-256 \(ffprobe\):\s*([a-f0-9]{64})\s*$/im);
    const required = platform === "win32" || recordedFfmpeg !== null || recordedFfprobe !== null;
    if (required && recordedFfmpeg === null) {
      problems.push("FFmpeg VERSION provenance is missing Binary SHA-256 (ffmpeg)");
    }
    if (required && recordedFfprobe === null) {
      problems.push("FFmpeg VERSION provenance is missing Binary SHA-256 (ffprobe)");
    }
    if (recordedFfmpeg !== null) {
      const actual = binaryHashes.get(ffmpegExecutable);
      if (actual === undefined) problems.push("Cannot verify FFmpeg Binary SHA-256: ffmpeg is missing");
      else if (recordedFfmpeg !== actual) {
        problems.push(`FFmpeg VERSION Binary SHA-256 (ffmpeg) does not match the supplied bytes: ${actual}`);
      }
    }
    if (recordedFfprobe !== null) {
      const actual = binaryHashes.get(ffprobeExecutable);
      if (actual === undefined) problems.push("Cannot verify FFmpeg Binary SHA-256: ffprobe is missing");
      else if (recordedFfprobe !== actual) {
        problems.push(`FFmpeg VERSION Binary SHA-256 (ffprobe) does not match the supplied bytes: ${actual}`);
      }
    }
  }
  if (ldacVersion !== undefined) {
    const recordedLdac = versionField(ldacVersion, /^binary_sha256=([a-f0-9]{64})\s*$/im);
    const required = platform === "win32" || recordedLdac !== null;
    if (required && recordedLdac === null) {
      problems.push("ldac_helper VERSION provenance is missing binary_sha256");
    }
    if (recordedLdac !== null && helperPresent) {
      const actual = binaryHashes.get(helperRelative);
      if (actual === undefined) problems.push("Cannot verify ldac_helper binary_sha256: helper is missing");
      else if (recordedLdac !== actual) {
        problems.push(`ldac_helper VERSION binary_sha256 does not match the supplied bytes: ${actual}`);
      }
    }
  }
  let windowsDlls = null;
  if (platform === "win32") {
    const audit = auditWindowsImports(peFiles, byRelativeLower);
    problems.push(...audit.problems);
    windowsDlls = audit.audit;
  }
  if (problems.length > 0) {
    throw new NativeBundleError(`Requested native bundle is incomplete or unsafe`, problems);
  }
  const files = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.relative === MANIFEST_RELATIVE) continue;
    files.push(Object.freeze({
      path: entry.relative,
      bytes: entry.stat.size,
      executable: platform === "linux"
        ? (entry.stat.mode & 0o111) !== 0
        : entry.relative.toLowerCase().endsWith(".exe"),
      sha256: await sha256File(entry.absolute),
    }));
  }
  return Object.freeze({
    schema: "codec-abx-native-bundle-v1",
    mode: NATIVE_BUNDLE_MODE,
    platform,
    arch: layout.arch,
    executableFormat: layout.executableFormat,
    directory: resolved,
    topLevel: Object.freeze(topLevel.filter((name) => name !== MANIFEST_RELATIVE)),
    ldacHelperIncluded,
    versions: Object.freeze({
      ffmpeg: ffmpegVersion ?? null,
      ldac: ldacVersion ?? null,
    }),
    sourcePins: pins,
    windowsDlls,
    files: Object.freeze(files),
  });
}

function manifestFor(inspection) {
  return {
    schema: NATIVE_BUNDLE_MANIFEST_SCHEMA,
    mode: inspection.mode,
    platform: inspection.platform,
    arch: inspection.arch,
    executableFormat: inspection.executableFormat,
    layout: PLATFORM_LAYOUTS[inspection.platform].layout,
    ldacHelperIncluded: inspection.ldacHelperIncluded,
    versions: inspection.versions,
    sourcePins: inspection.sourcePins,
    ...(inspection.windowsDlls === null ? {} : { windowsDlls: inspection.windowsDlls }),
    files: inspection.files,
    distribution: {
      meaning: "Packaging records the supplied files, hashes and build provenance; it is not a license certification.",
      publicRedistribution: "Public redistribution still requires a separate release review of licenses, notices, source-offer obligations and platform requirements.",
    },
  };
}

/**
 * Copy the explicitly supplied resources directory to an owned staging path and
 * add a deterministic manifest. This never reads PATH and never downloads.
 */
export async function stageNativeBundle(directory, stagingRoot, options = {}) {
  // Resolve existing ancestors too: a destination alias must not let cleanup
  // remove the supplied input, or create staging inside that input tree.
  const source = await canonical(directory);
  const staging = await canonical(stagingRoot);
  await assertNativeBundleOutsideOutputs(source, [staging]);
  const inspection = await inspectNativeBundle(source, options);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  const extraResource = [];
  for (const name of inspection.topLevel) {
    await fs.cp(path.join(inspection.directory, name), path.join(staging, name), {
      recursive: true,
      force: true,
      dereference: false,
    });
    extraResource.push(path.join(staging, name));
  }
  const manifestPath = path.join(staging, NATIVE_BUNDLE_MANIFEST);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifestFor(inspection), null, 2)}\n`);
  extraResource.push(manifestPath);
  return Object.freeze({ inspection, directory: staging, manifestPath, extraResource: Object.freeze(extraResource) });
}

/** Verify that packaging copied the exact inspected bytes and manifest. */
export async function verifyPackagedNativeBundle(resourcesRoot, inspection) {
  for (const file of inspection.files) {
    const stat = await fs.lstat(path.join(resourcesRoot, file.path)).catch(() => null);
    if (!stat?.isFile()) {
      throw new NativeBundleError("Packaged native file is missing or not a regular file", [file.path]);
    }
    if (inspection.platform !== "win32" && ((stat.mode & 0o111) !== 0) !== file.executable) {
      throw new NativeBundleError("Packaged native file type or executable permission disagrees with the supplied resources", [file.path]);
    }
    const actual = await sha256File(path.join(resourcesRoot, file.path)).catch(() => null);
    if (actual !== file.sha256) {
      throw new NativeBundleError("Packaged native bundle does not match the supplied hashes", [file.path]);
    }
  }
  const manifestPath = path.join(resourcesRoot, NATIVE_BUNDLE_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw new NativeBundleError("Packaged native bundle manifest is missing or invalid", [manifestPath]);
  }
  if (!isDeepStrictEqual(manifest, manifestFor(inspection))) {
    throw new NativeBundleError("Packaged native bundle manifest does not describe this bundle", [manifestPath]);
  }
  return manifest;
}
