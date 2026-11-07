#!/usr/bin/env node
/**
 * Collect the third-party license, notice, source and build payload for the
 * exact native codec artifacts described by third_party/release-materials.json.
 *
 * The output is a release-material tree, not a package:
 *
 *   licenses/<component>/...        complete upstream license/notice texts
 *   sources/<archive>               exact pinned source archives (hashed)
 *   application/<component>/...     Electron, font, measurement and JS notices
 *   build/...                       build scripts, helper C source, VERSION files
 *   provenance/...                  baseline audit output when available
 *   NOTICES.md                      human-readable release notice inventory
 *   SOURCE-OFFER.md                 exact source and rebuild instructions
 *   MANIFEST.json                   every material file with its SHA-256
 *
 * Usage:
 *   node tools/collect-third-party-materials.mjs
 *   node tools/collect-third-party-materials.mjs --output build/release-materials
 *   node tools/collect-third-party-materials.mjs --source-cache /tmp/opencode/ffmpeg-build/src
 *   node tools/collect-third-party-materials.mjs --offline   # use cached archives only
 *   node tools/collect-third-party-materials.mjs --verify    # verify an existing output
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCHEMA = "audivane-third-party-materials-v1";
const DEFAULT_MANIFEST = path.join(ROOT, "third_party", "release-materials.json");
const DEFAULT_OUTPUT = path.join(ROOT, "build", "release-materials");
const DEFAULT_CACHE = "/tmp/opencode/audivane-source-cache";

function usage() {
  process.stdout.write(`Usage: node tools/collect-third-party-materials.mjs [options]

Options:
  --manifest <file>     Inventory manifest (default third_party/release-materials.json)
  --output <dir>        Material output (default build/release-materials)
  --source-cache <dir>  Reuse downloaded archives from this directory
  --platform <target>   linux (default) or win32 provenance/build scope
  --artifacts <dir>     Native artifact bundle to copy provenance from
                        (default build/linux-baseline/artifacts)
  --offline             Never download; fail if a verified archive is missing
  --verify              Verify MANIFEST.json in an existing --output tree
  --help                Show this help
`);
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    output: DEFAULT_OUTPUT,
    cache: DEFAULT_CACHE,
    artifacts: path.join(ROOT, "build", "linux-baseline", "artifacts"),
    platform: "linux",
    offline: false,
    verify: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--manifest": options.manifest = path.resolve(argv[++index]); break;
      case "--output": options.output = path.resolve(argv[++index]); break;
      case "--source-cache": options.cache = path.resolve(argv[++index]); break;
      case "--platform": options.platform = argv[++index]; break;
      case "--artifacts": options.artifacts = path.resolve(argv[++index]); break;
      case "--offline": options.offline = true; break;
      case "--verify": options.verify = true; break;
      case "--help": case "-h": usage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!["linux", "win32"].includes(options.platform)) throw new Error("--platform must be linux or win32");
  return options;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function sha256(filename) {
  const hash = createHash("sha256");
  const handle = await fs.open(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

/**
 * Some upstream archives are regenerated per request (Android Gitiles writes
 * fresh tar/gzip metadata), so their byte hash is not stable. For those
 * components the inventory pins the extracted *content*: a SHA-256 over sorted
 * relative paths, entry types/sizes and bytes. The archive URL and commit remain
 * the authoritative source.
 */
async function canonicalContentSha256(archive) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-content-"));
  try {
    const flag = archiveFlag(archive);
    const names = await listArchive(archive);
    for (const name of names) {
      const relative = name.replace(/\/$/, "").replace(/^\.\//, "");
      if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) {
        throw new Error("Unsafe source archive path");
      }
    }
    const listing = (await run("tar", [`${flag}tvf`, archive])).toString("utf8");
    if (listing.split(/\r?\n/).filter(Boolean).some(line => !["-", "d"].includes(line[0]))) {
      throw new Error("Source archive links and special entries are not accepted for content hashing");
    }
    await run("tar", [`${flag}xf`, archive, "-C", directory]);
    const files = (await walk(directory)).map((relative) => relative.split(path.sep).join("/")).sort();
    const hash = createHash("sha256");
    for (const relative of files) {
      const absolute = path.join(directory, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (stat.isFile()) {
        hash.update(`f\0${relative}\0${stat.size}\0`);
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      } else {
        throw new Error(`Unsupported archive entry in ${archive}: ${relative}`);
      }
    }
    return hash.digest("hex");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function archiveFlag(filename) {
  if (filename.endsWith(".tar.xz")) return "-J";
  if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) return "-z";
  if (filename.endsWith(".tar.bz2")) return "-j";
  return "";
}

async function listArchive(filename) {
  const flag = archiveFlag(filename);
  if (!flag) throw new Error(`Unsupported archive type: ${filename}`);
  const output = await run("tar", [`${flag}tf`, filename]);
  return output.toString("utf8").split(/\r?\n/).filter((entry) => entry.length > 0);
}

async function extractArchiveFile(archive, entry) {
  const flag = archiveFlag(archive);
  return run("tar", [`${flag}xOf`, archive, "--", entry]);
}

async function fetchArchive(component, destination) {
  const url = component.archive.url;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(`${destination}.part`, buffer);
  await fs.rename(`${destination}.part`, destination);
}

async function verifyArchive(component, filename) {
  const raw = await sha256(filename);
  if (component.archive.sha256 !== undefined) {
    return { ok: raw === component.archive.sha256, raw, content: null, expected: component.archive.sha256, kind: "archive SHA-256" };
  }
  if (component.archive.contentSha256 !== undefined) {
    const content = await canonicalContentSha256(filename);
    return { ok: content === component.archive.contentSha256, raw, content, expected: component.archive.contentSha256, kind: "content SHA-256" };
  }
  throw new Error(`${component.id} has no archive SHA-256 or content SHA-256 pin`);
}

async function obtainArchive(component, options) {
  const filename = component.archive.filename;
  const destination = path.join(options.output, "sources", filename);
  if (await exists(destination)) {
    const verified = await verifyArchive(component, destination);
    if (verified.ok) return { filename, path: destination, sha256: verified.raw, contentSha256: verified.content, source: "output" };
    throw new Error(`Existing source archive does not match the pinned ${verified.kind}: ${destination}`);
  }
  const cached = path.join(options.cache, filename);
  if (await exists(cached)) {
    const verified = await verifyArchive(component, cached);
    if (verified.ok) {
      await copyFile(cached, destination);
      return { filename, path: destination, sha256: verified.raw, contentSha256: verified.content, source: "cache" };
    }
    process.stderr.write(`warning: cached ${filename} does not match the pinned ${verified.kind}; ignoring\n`);
  }
  if (options.offline) throw new Error(`Offline and no verified archive for ${component.id}: ${filename}`);
  process.stderr.write(`fetching ${component.name} source archive\n`);
  await fetchArchive(component, destination);
  const verified = await verifyArchive(component, destination);
  if (!verified.ok) {
    await fs.rm(destination, { force: true });
    throw new Error(`Downloaded ${filename} ${verified.kind} mismatch: got ${verified.content ?? verified.raw}`);
  }
  return { filename, path: destination, sha256: verified.raw, contentSha256: verified.content, source: "download" };
}

function findLicenseEntry(entries, basename) {
  const matches = entries.filter((entry) => !entry.endsWith("/") && (basename.includes("/") ? entry.endsWith("/" + basename) || entry === basename : entry.split("/").at(-1) === basename));
  if (matches.length === 0) return null;
  return matches.sort((left, right) => left.split("/").length - right.split("/").length)[0];
}

async function collectLicenses(component, archivePath, output) {
  const entries = await listArchive(archivePath);
  const collected = [];
  for (const basename of component.licenseFiles) {
    const entry = findLicenseEntry(entries, basename);
    if (!entry) throw new Error(`${component.id} archive does not contain ${basename}`);
    const contents = await extractArchiveFile(archivePath, entry);
    if (contents.length === 0) throw new Error(`${component.id} ${basename} is empty`);
    const destination = path.join(output, "licenses", component.id, basename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    collected.push({ archiveEntry: entry, path: path.relative(output, destination).split(path.sep).join("/"), bytes: contents.length });
  }
  return collected;
}

async function collectLocalAssets(asset, output) {
  const collected = [];
  for (const relative of asset.paths) {
    const source = path.join(ROOT, relative);
    if (!await exists(source)) throw new Error(`Missing local asset for ${asset.id}: ${relative}`);
    const safeRelative = relative.replaceAll("\\", "/").replace(/^\.\//, "");
    const destination = path.join(output, "application", asset.id, safeRelative);
    await copyFile(source, destination);
    collected.push({ source: relative, path: path.relative(output, destination).split(path.sep).join("/"), bytes: (await fs.stat(destination)).size });
  }
  return collected;
}

async function collectBuildPayload(output, artifacts) {
  const files = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "tools/build_ffmpeg.sh",
    "tools/build_ldac_helper.sh",
    "tools/build_linux_baseline.sh",
    "tools/build_ffmpeg_windows.sh",
    "tools/build_ldac_helper_windows.sh",
    "tools/build_native_windows.sh",
    "tools/verification/windows-native-audit.mjs",
    "tools/verification/native-bundle.mjs",
    "tools/build_codec_wasm.sh",
    "tools/lc3_wasm.c",
    "tools/ldac_wasm.c",
    "tools/audit-native-provenance.mjs",
    "tools/collect-third-party-materials.mjs",
    "tools/ldac_helper.c",
    "third_party/release-materials.json",
  ];
  const collected = [];
  for (const relative of files) {
    const source = path.join(ROOT, relative);
    if (!await exists(source)) continue;
    const destination = path.join(output, "build", relative);
    await copyFile(source, destination);
    collected.push({ source: relative, path: path.relative(output, destination).split(path.sep).join("/") });
  }
  const provenance = [
    ["third_party/ffmpeg/VERSION.txt", path.join(artifacts, "third_party/ffmpeg/VERSION.txt"), "ffmpeg-VERSION.txt"],
    ["third_party/ldac/VERSION.txt", path.join(artifacts, "third_party/ldac/VERSION.txt"), "ldac-VERSION.txt"],
    ["BASELINE.txt", path.join(artifacts, "..", "BASELINE.txt"), "BASELINE.txt"],
    ["package-versions.txt", path.join(artifacts, "..", "package-versions.txt"), "package-versions.txt"],
    ["provenance.json", path.join(artifacts, "..", "provenance.json"), "provenance.json"],
    ["windows-native-audit.json", path.join(artifacts, "..", "windows-native-audit.json"), "windows-native-audit.json"],
  ];
  for (const [label, source, destinationName] of provenance) {
    if (!await exists(source)) continue;
    const destination = path.join(output, "provenance", destinationName);
    await copyFile(source, destination);
    collected.push({ source: label, path: path.relative(output, destination).split(path.sep).join("/") });
  }
  return collected;
}

async function walk(directory, relative = "") {
  const files = [];
  for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
    const child = relative === "" ? name : path.join(relative, name);
    const stat = await fs.lstat(path.join(directory, child));
    if (stat.isDirectory()) files.push(...await walk(directory, child));
    else if (stat.isFile()) files.push(child);
    else throw new Error(`Unsafe non-regular material entry: ${child}`);
  }
  return files;
}

async function buildManifest(output) {
  const files = [];
  for (const relative of await walk(output)) {
    if (relative.split(path.sep).join("/") === "MANIFEST.json") continue;
    files.push({
      path: relative.split(path.sep).join("/"),
      bytes: (await fs.stat(path.join(output, relative))).size,
      sha256: await sha256(path.join(output, relative)),
    });
  }
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), files };
}

export async function verifyMaterialPins(output, platform) {
  await verifyMaterials(output);
  const manifest = JSON.parse(await fs.readFile(path.join(output, "MANIFEST.json"), "utf8"));
  if (manifest.platform !== platform) throw new Error("Materials platform does not match the requested target");
  const inventory = JSON.parse(await fs.readFile(DEFAULT_MANIFEST, "utf8"));
  const components = inventory.components.filter(item => !item.platforms || item.platforms.includes(platform));
  for (const component of components) {
    const archive = path.join(output, "sources", component.archive.filename);
    if (!(await verifyArchive(component, archive)).ok) throw new Error(`Source pin mismatch: ${component.id}`);
    const entries = await listArchive(archive);
    for (const license of component.licenseFiles) {
      const entry = findLicenseEntry(entries, license);
      if (!entry) throw new Error(`Missing pinned source license: ${component.id}/${license}`);
      const upstream = await extractArchiveFile(archive, entry);
      const included = await fs.readFile(path.join(output, "licenses", component.id, license));
      if (!upstream.equals(included)) throw new Error(`License does not match pinned source: ${component.id}/${license}`);
    }
  }
  return manifest;
}

export async function verifyMaterials(output) {
  const manifestPath = path.join(output, "MANIFEST.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schema !== SCHEMA) throw new Error(`Unexpected manifest schema: ${manifest.schema}`);
  const problems = [];
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || path.isAbsolute(file.path) || file.path.includes("\\") ||
        file.path.split("/").some(part => ["", ".", ".."].includes(part)) || seen.has(file.path)) {
      throw new Error("Unsafe or duplicate material manifest path");
    }
    seen.add(file.path);
    const absolute = path.join(output, file.path);
    if (!await exists(absolute)) {
      problems.push(`missing ${file.path}`);
      continue;
    }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size !== file.bytes) problems.push(`type/size mismatch ${file.path}`);
    if (await sha256(absolute) !== file.sha256) problems.push(`hash mismatch ${file.path}`);
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const relative of await walk(output)) {
    const posix = relative.split(path.sep).join("/");
    if (posix !== "MANIFEST.json" && !listed.has(posix)) problems.push(`unlisted ${posix}`);
  }
  if (problems.length > 0) {
    throw new Error(`Materials verification failed:\n- ${problems.join("\n- ")}`);
  }
  process.stdout.write(`Materials verified: ${manifest.files.length} files match MANIFEST.json.\n`);
}

function noticesMarkdown(manifest) {
  const rows = manifest.components.map((component) => {
    const licenses = component.collectedLicenses.map((entry) => `\`${entry.path}\``).join("<br>");
    const pin = component.archive.sha256
      ? `SHA-256 \`${component.archive.sha256}\``
      : `content SHA-256 \`${component.archive.contentSha256}\` (upstream regenerates archive bytes)`;
    return `| ${component.name} ${component.version} | ${component.license} | \`sources/${component.archive.filename}\`<br>${pin} | ${licenses} |`;
  }).join("\n");
  const assets = manifest.localAssets.map((asset) => {
    const files = asset.collected.map((entry) => `\`${entry.path}\``).join("<br>");
    return `| ${asset.name} | ${asset.license} | ${files} | ${asset.notes} |`;
  }).join("\n");
  return `# Audivane third-party notices and source materials

Generated by \`tools/collect-third-party-materials.mjs\` from
\`third_party/release-materials.json\`. Copyright in each component remains with
its authors. Audivane's own code is MIT; the components below retain their own
licenses.

## Native codec executables and dependencies

| Component | License | Exact source archive (SHA-256) | Complete license text |
| --- | --- | --- | --- |
${rows}

FFmpeg was configured without \`--enable-gpl\` or \`--enable-nonfree\`. The exact
configure line, archive hashes and binary hashes are in
\`provenance/ffmpeg-VERSION.txt\` and \`provenance/ldac-VERSION.txt\`. glibc and
libm are dynamically linked system libraries and are not redistributed here.

## Application assets

| Component | License | Complete text | Notes |
| --- | --- | --- | --- |
${assets}

## Build and relink materials

The pinned archives under \`sources/\` plus the scripts under \`build/\` are the
corresponding build materials. \`provenance/\` records the exact baseline,
toolchain package versions and ELF/linkage audit for the produced binaries.

${manifest.knownGapsBeforePublicRelease.map((gap) => `- ${gap}`).join("\n")}

Keep this directory with the release assets. Do not substitute the project MIT
license for any dependency license.
`;
}

function sourceOfferMarkdown(manifest) {
  const windowsNote = manifest.platform === "win32" ? `## Windows build scope\n\nThese VERSION files describe Windows x64 binaries. Use the included\n\`tools/build_native_windows.sh\`, Windows component recipes and PE audit,\nnot the Linux recipe below, to rebuild this payload. Linux build instructions\nare retained for the shared source pins. This candidate includes the recorded MinGW-w64/GCC runtime source and\nlicenses plus NSIS source/patches. The cross compiler package versions and\nhashes are recorded in the windows-build-tools inventory. A native MSYS2\nrebuild must replace these with its own exact toolchain/runtime materials.\n\n` : "";
  const rows = manifest.components.map((component) => {
    const pin = component.archive.sha256
      ? `  - Archive SHA-256: \`${component.archive.sha256}\``
      : `  - Content SHA-256: \`${component.archive.contentSha256}\` (upstream Gitiles regenerates archive bytes; extracted content is pinned)`;
    return `- **${component.name} ${component.version}** — ${component.license}
  - Source: ${component.archive.url}
${pin}
  - Included as: \`sources/${component.archive.filename}\`
  - Build: ${component.buildScripts.map((script) => `\`${script}\``).join(", ")}`;
  }).join("\n");
  return `# Source offer and rebuild instructions

This file accompanies the Audivane native codec binaries. The exact source
archives are included in \`sources/\` and can also be obtained from the upstream
URLs below. Every archive is pinned by an archive or content SHA-256. The build
scripts are included in \`build/\`.

${rows}

${windowsNote}## Rebuilding the Linux baseline

The supported Linux baseline is Ubuntu 24.04 LTS x64 (glibc 2.39). From a
checkout at the recorded revision:

\`\`\`bash
tools/build_linux_baseline.sh
node tools/audit-native-provenance.mjs \\
  --bundle build/linux-baseline/artifacts --baseline-glibc 2.39 \\
  --json build/linux-baseline/provenance.json
\`\`\`

The builder runs the pinned sources inside an Ubuntu 24.04.3 base rootfs with
proot. It does not install host packages or require root. See
\`provenance/BASELINE.txt\`, \`provenance/package-versions.txt\` and
\`provenance/provenance.json\` for the exact build environment and audit.

## Relinking note for LGPL components

FFmpeg and the LGPL libraries are statically linked into the two executables.
The complete source archives, exact configure switches and build scripts are
provided so the binaries can be rebuilt or relinked. This material set is
release engineering evidence, not a substitute for legal review of the intended
distribution and jurisdictions.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.verify) {
    await verifyMaterials(options.output);
    return;
  }

  const inventory = JSON.parse(await fs.readFile(options.manifest, "utf8"));
  if (inventory.schema !== SCHEMA) throw new Error(`Unexpected inventory schema: ${inventory.schema}`);
  await fs.mkdir(options.output, { recursive: true });

  const components = [];
  for (const component of inventory.components.filter(item => !item.platforms || item.platforms.includes(options.platform))) {
    const archive = await obtainArchive(component, options);
    const collectedLicenses = await collectLicenses(component, archive.path, options.output);
    components.push({ ...component, archive: { ...component.archive, obtainedFrom: archive.source, path: archive.path }, collectedLicenses });
    process.stderr.write(`ok: ${component.id}\n`);
  }

  const localAssets = [];
  for (const asset of inventory.localAssets.filter(item => !item.platforms || item.platforms.includes(options.platform))) {
    localAssets.push({ ...asset, collected: await collectLocalAssets(asset, options.output) });
    process.stderr.write(`ok: ${asset.id}\n`);
  }

  const buildPayload = await collectBuildPayload(options.output, options.artifacts);

  const manifest = {
    schema: SCHEMA,
    generator: "tools/collect-third-party-materials.mjs",
    generatedAt: new Date().toISOString(),
    platform: options.platform,
    baseline: options.platform === "linux" ? inventory.baseline : { name: "Windows x64; see exact VERSION files", acceptance: "requires actual Windows build/runtime evidence" },
    components,
    localAssets,
    buildPayload,
    knownGapsBeforePublicRelease: inventory.knownGapsBeforePublicRelease,
  };
  await fs.writeFile(path.join(options.output, "NOTICES.md"), noticesMarkdown(manifest));
  await fs.writeFile(path.join(options.output, "SOURCE-OFFER.md"), sourceOfferMarkdown(manifest));
  const materialManifest = { ...await buildManifest(options.output), platform: options.platform,
    sourcePins: components.map(item => ({ id: item.id, ...item.archive, path: undefined, obtainedFrom: undefined })) };
  await fs.writeFile(path.join(options.output, "MANIFEST.json"), `${JSON.stringify(materialManifest, null, 2)}\n`);

  await verifyMaterials(options.output);
  process.stdout.write(`Materials written to ${path.relative(ROOT, options.output) || options.output}\n`);
  process.stdout.write(`  ${components.length} source components, ${localAssets.length} application asset groups, ${buildPayload.length} build/provenance files\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
