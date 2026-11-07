import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_SYSTEM_DLLS,
  inspectNativeBundle,
  inspectPeExecutable,
  stageNativeBundle,
} from "./native-bundle.mjs";

const USAGE = `Usage: node tools/verification/windows-native-audit.mjs [options]

Validate a prepared Windows x64 native resources tree without executing it:
PE32+ machine/x64 headers, .exe layout, pinned FFmpeg/ldac provenance and the
DLL import audit. This is structural evidence, not a codec capability probe.

Options:
  --bundle <dir>        Prepared resources root containing third_party/
  --component <name>    Audit all (default), ffmpeg or ldac only
  --file <path>         Inspect one PE file's architecture, DLL flag and imports
  --stage <dir>         Copy a valid all-component bundle to <dir> with a
                        deterministic manifest
  --json                Emit a machine-readable report
  --help                Show this help

Exit 0 means the supplied structure passed. It does not prove that the binaries
run on this host, that codecs are present, or that Windows support was accepted.`;

class UsageError extends Error {}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a path value`);
  }
  return value;
}

function parseArguments(args) {
  const options = { bundle: undefined, component: "all", file: undefined, stage: undefined, json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--bundle": options.bundle = valueAfter(args, index, argument); index += 1; break;
      case "--component": options.component = valueAfter(args, index, argument); index += 1; break;
      case "--file": options.file = valueAfter(args, index, argument); index += 1; break;
      case "--stage": options.stage = valueAfter(args, index, argument); index += 1; break;
      case "--json": options.json = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new UsageError(`Unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (["all", "ffmpeg", "ldac"].includes(options.component) === false) {
    throw new UsageError("--component must be all, ffmpeg or ldac");
  }
  if ((options.bundle === undefined) === (options.file === undefined)) {
    throw new UsageError("Use exactly one of --bundle or --file");
  }
  if (options.file !== undefined && (options.stage !== undefined || options.component !== "all")) {
    throw new UsageError("--stage and --component require --bundle");
  }
  if (options.stage !== undefined && options.component !== "all") {
    throw new UsageError("--stage requires --component all");
  }
  return options;
}

function summarise(inspection, component) {
  return {
    schema: "windows-native-audit-v1",
    ok: true,
    platform: inspection.platform,
    arch: inspection.arch,
    executableFormat: inspection.executableFormat,
    component,
    ldacHelperIncluded: inspection.ldacHelperIncluded,
    versions: inspection.versions,
    files: inspection.files,
    windowsDlls: inspection.windowsDlls,
    meaning: "Structural PE/provenance/DLL evidence only; codecs were not executed.",
  };
}

function printBundleSummary(inspection, component) {
  const lines = [
    "Windows native bundle audit: PASS",
    `Component: ${component}`,
    `Platform: ${inspection.platform} ${inspection.arch} (${inspection.executableFormat})`,
    `Files: ${String(inspection.files.length)} (${String(inspection.files.reduce((total, file) => total + file.bytes, 0))} bytes)`,
    `LDAC helper included: ${inspection.ldacHelperIncluded ? "yes" : "no (optional)"}`,
    "Provenance:",
    `  FFmpeg: ${firstLine(inspection.versions.ffmpeg)}`,
    `  LDAC:   ${inspection.versions.ldac === null ? "not supplied" : firstLine(inspection.versions.ldac)}`,
    "DLL audit:",
  ];
  const imports = inspection.windowsDlls?.imports ?? [];
  if (imports.length === 0) {
    lines.push("  no imported DLLs were found");
  }
  for (const entry of imports) {
    const source = entry.source === "bundle"
      ? `bundle:${entry.providedBy ?? "?"}`
      : entry.source;
    lines.push(`  ${entry.file} -> ${entry.name} (${source})`);
  }
  lines.push(
    `Bundled DLLs: ${inspection.windowsDlls?.bundledDlls.length === 0 ? "none" : inspection.windowsDlls.bundledDlls.join(", ")}`,
    `Windows system DLL names accepted by the audit: ${String(WINDOWS_SYSTEM_DLLS.size)}`,
    "This audit does not execute the binaries or prove codec capability/Windows support.",
  );
  return lines.join("\n");
}

function firstLine(text) {
  if (text === null) return "not supplied";
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "not supplied";
}

async function auditBundle(options) {
  const bundle = path.resolve(options.bundle);
  const inspection = await inspectNativeBundle(bundle, {
    platform: "win32",
    components: options.component,
  });
  let staged = null;
  if (options.stage !== undefined) {
    staged = await stageNativeBundle(bundle, path.resolve(options.stage), { platform: "win32" });
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ...summarise(inspection, options.component),
      ...(staged === null ? {} : { manifestPath: staged.manifestPath }),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${printBundleSummary(inspection, options.component)}\n`);
    if (staged !== null) {
      process.stdout.write(`Staged bundle: ${staged.directory}\nManifest: ${staged.manifestPath}\n`);
    }
  }
  return 0;
}

async function auditFile(options) {
  const filename = path.resolve(options.file);
  const inspection = await inspectPeExecutable(filename);
  if (!inspection.ok) {
    process.stderr.write(`Windows PE audit failed: ${path.basename(filename)}: ${inspection.reason}\n`);
    return 1;
  }
  const imports = inspection.imports.map((name) => ({
    name,
    classification: WINDOWS_SYSTEM_DLLS.has(name.toLowerCase()) ||
      name.toLowerCase().startsWith("api-ms-win-") ||
      name.toLowerCase().startsWith("ext-ms-")
      ? "system"
      : "not-system",
  }));
  const ok = inspection.isX64;
  const report = {
    schema: "windows-pe-audit-v1",
    ok,
    file: path.basename(filename),
    machine: `0x${inspection.machine.toString(16)}`,
    optionalHeaderMagic: `0x${inspection.magic.toString(16)}`,
    isWindowsX64: inspection.isX64,
    isDll: inspection.dll,
    imports,
    meaning: "One PE image only; the parent bundle audit also checks provenance and DLL availability.",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Windows PE audit: ${ok ? "PE32+ x64" : "NOT x64"}`,
      `File: ${report.file}`,
      `Machine: ${report.machine}, optional header: ${report.optionalHeaderMagic}, DLL: ${inspection.dll ? "yes" : "no"}`,
      "Imports:",
      ...imports.map((entry) => `  ${entry.name} (${entry.classification})`),
    ].join("\n") + "\n");
  }
  return ok ? 0 : 1;
}

async function main(args) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.bundle !== undefined) return auditBundle(options);
  return auditFile(options);
}

const invoked = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    const message = error instanceof Error ? error.message : "Unknown audit failure";
    process.stderr.write(`Windows native audit failed: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}

export { auditBundle, auditFile, parseArguments };
