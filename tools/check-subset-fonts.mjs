// Verify the renamed bundled font subsets against third_party/fonts.json.
//
// Decodes each WOFF2 with no third-party dependencies and confirms: the
// manifest inventory matches the bundled files exactly (no missing, stale or
// duplicate entries) with its license, family list and pinned fonttools
// version intact; the recorded file hashes; the renamed primary name records
// based on the entry's recorded family and free of IBM's reserved name; the
// preserved IBM copyright and OFL license URL records plus the nameID 13
// license text and PostScript name; the OFL notice beside every font
// directory; and a content fingerprint over every stored WOFF2 table except
// `name` and the head table's checkSumAdjustment (bytes 8..11), which the
// WOFF2 format requires to change whenever the file bytes change. Copies
// sharing an upstream original must produce identical renamed results. The manifest records the
// fingerprint computed from the original IBM Plex subset as
// originalContentSha256 and the check requires the renamed subset's
// fingerprint to equal it, so the evidence is not self-attesting. Anyone
// can independently reproduce the recorded original fingerprint from the
// upstream files: `node tools/check-subset-fonts.mjs --fingerprint <file>`
// prints the fingerprint of any WOFF2, renamed or original.
//
// `--update` recomputes contentSha256 from disk after confirming every
// recorded sha256 matches and every originalContentSha256 is recorded; the
// renamed-vs-original fingerprint equality is still enforced.
// tools/rename-subset-fonts.py invokes it to finish a regeneration. Run
// directly as `npm run check:fonts`.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, brotliCompressSync } from "node:zlib";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FONT_MANIFEST = "third_party/fonts.json";
// Read by tools/rename-subset-fonts.py together with RENAMED_NAME_IDS, so
// both tools share this single source of truth.
export const FONT_DIRECTORIES = [
  "apps/client/src/assets/fonts",
  "apps/landing/public/fonts",
  "website/public/fonts",
];

// WOFF2 specification, Known Table Tags (W3C REC-WOFF2, subclause 4.1).
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ",
  "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp",
  "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF",
  "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
  "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc",
  "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx",
  "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

// Name records tools/rename-subset-fonts.py rewrites. The renamed subset must
// name the renamed Audivane Latin family and carry no reserved name in any of
// them (the rewrite always produces both the words Audivane and Latin, even
// in forms like "2.3;IBM ;AudivaneMono Latin-Medium" that are neither the
// spaced family nor its PostScript form, so both words serve as the shared
// tokens below). tools/rename-subset-fonts.py reads this list and
// FONT_DIRECTORIES from here instead of keeping its own copies.
export const RENAMED_NAME_IDS = [1, 3, 4, 6, 16, 18, 21, 25];

// Name records every bundled subset must contain, so stripping them fails
// the check instead of skipping an optional per-record validation.
const REQUIRED_NAME_IDS = [0, 14];

// nameID -> validator; a validator returns an error message naming the
// record's content, or null when the record is intact. Records that are
// absent are only reported through REQUIRED_NAME_IDS.
const NAME_ID_VALIDATIONS = new Map([
  [0, (text) => (/copyright/i.test(text) && text.includes("IBM")
    ? null
    : `nameID 0 no longer preserves the IBM copyright: ${text}`)],
  [1, (text, prefix) => (text.startsWith(prefix)
    ? null
    : `nameID 1 is not based on ${prefix}: ${text}`)],
  [6, (text, prefix) => (text.startsWith(prefix.replace(/ /g, ""))
    ? null
    : `PostScript name is not based on ${prefix.replace(/ /g, "")}: ${text}`)],
  [13, (text) => (/SIL Open Font License/i.test(text)
    ? null
    : `nameID 13 no longer carries the OFL license text: ${text}`)],
  [14, (text) => (/^https?:\/\/\S+$/.test(text)
    ? null
    : `nameID 14 is not the OFL license URL: ${text}`)],
  [16, (text, prefix) => (text.startsWith(prefix)
    ? null
    : `nameID 16 is not based on ${prefix}: ${text}`)],
]);

export function parseWoff2(bytes, label = "font") {
  if (bytes.length < 48 || bytes.readUInt32BE(0) !== 0x774f4632) {
    throw new Error(`${label}: not a WOFF2 file`);
  }
  const numTables = bytes.readUInt16BE(12);
  const totalCompressedSize = bytes.readUInt32BE(20);
  const pos = { i: 48 };
  const readUIntBase128 = () => {
    let value = 0;
    for (let n = 0; n < 5; n += 1) {
      const byte = bytes[pos.i];
      pos.i += 1;
      if (n === 0 && byte === 0x80) throw new Error(`${label}: UIntBase128 with leading zero`);
      if (value & 0xfe000000) throw new Error(`${label}: UIntBase128 overflow`);
      value = ((value << 7) | (byte & 0x7f)) >>> 0;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error(`${label}: UIntBase128 longer than five bytes`);
  };
  const tables = [];
  for (let n = 0; n < numTables; n += 1) {
    const flags = bytes[pos.i];
    pos.i += 1;
    const tagIndex = flags & 0x3f;
    const transformVersion = (flags >> 6) & 0x03;
    let tag;
    if (tagIndex === 63) {
      tag = bytes.subarray(pos.i, pos.i + 4).toString("latin1");
      pos.i += 4;
    } else {
      tag = KNOWN_TAGS[tagIndex];
    }
    const transformed = tag === "glyf" || tag === "loca" ? transformVersion !== 3 : transformVersion !== 0;
    const origLength = readUIntBase128();
    const storedLength = transformed ? readUIntBase128() : origLength;
    tables.push({ tag, transformVersion, origLength, storedLength });
  }
  const compressedStart = pos.i;
  const compressedEnd = compressedStart + totalCompressedSize;
  if (compressedEnd > bytes.length) throw new Error(`${label}: compressed block runs past the file end`);
  const stream = brotliDecompressSync(bytes.subarray(compressedStart, compressedEnd));
  const expectedLength = tables.reduce((sum, table) => sum + table.storedLength, 0);
  if (stream.length !== expectedLength) {
    throw new Error(`${label}: decompressed stream is ${stream.length} bytes, the table directory describes ${expectedLength}`);
  }
  let offset = 0;
  for (const table of tables) {
    table.bytes = stream.subarray(offset, offset + table.storedLength);
    table.streamOffset = offset;
    offset += table.storedLength;
  }
  return { tables, stream, compressedStart, compressedEnd };
}

// Re-embed a mutated decompressed table stream into a copy of the file,
// keeping the table directory and updating the two size header fields.
export function recompressWoff2(bytes, parsed, stream) {
  const compressed = brotliCompressSync(stream);
  const output = Buffer.concat([
    bytes.subarray(0, parsed.compressedStart),
    compressed,
    bytes.subarray(parsed.compressedEnd),
  ]);
  output.writeUInt32BE(output.length, 8);
  output.writeUInt32BE(compressed.length, 20);
  return output;
}

export function nameRecords(parsed, label = "font") {
  const entry = parsed.tables.find((table) => table.tag === "name");
  if (!entry) throw new Error(`${label}: font has no name table`);
  const bytes = entry.bytes;
  const count = bytes.readUInt16BE(2);
  const stringOffset = bytes.readUInt16BE(4);
  const records = [];
  for (let n = 0; n < count; n += 1) {
    const base = 6 + n * 12;
    const platformID = bytes.readUInt16BE(base);
    const nameID = bytes.readUInt16BE(base + 6);
    const length = bytes.readUInt16BE(base + 8);
    const offset = bytes.readUInt16BE(base + 10);
    const raw = bytes.subarray(stringOffset + offset, stringOffset + offset + length);
    const text = platformID === 0 || platformID === 3
      ? Buffer.from(raw).swap16().toString("utf16le")
      : raw.toString("latin1");
    records.push({ platformID, nameID, text });
  }
  return records;
}

// Fingerprint every stored table except `name`, with the head table's
// checkSumAdjustment zeroed. Fields are hashed as fixed-width big-endian
// integers so no adjacent field or table can shift another's boundary.
export function contentFingerprint(tables) {
  const hash = createHash("sha256");
  const ordered = tables.filter((table) => table.tag !== "name").sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const frame = Buffer.alloc(16);
  frame.writeUInt32BE(ordered.length, 0);
  hash.update(frame);
  for (const table of ordered) {
    hash.update(table.tag.padEnd(4, " "));
    frame.writeUInt32BE(table.transformVersion, 0);
    frame.writeUInt32BE(table.origLength, 4);
    frame.writeUInt32BE(table.storedLength, 8);
    frame.writeUInt32BE(table.bytes.length, 12);
    hash.update(frame);
    if (table.tag === "head") {
      const bytes = Buffer.from(table.bytes);
      bytes.fill(0, 8, 12); // checkSumAdjustment, required to change on any byte edit
      hash.update(bytes);
    } else {
      hash.update(table.bytes);
    }
  }
  return hash.digest("hex");
}

const hex64 = /^[0-9a-f]{64}$/;

export async function checkSubsetFonts({ root = ROOT, update = false } = {}) {
  const manifestPath = path.join(root, FONT_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.license !== "OFL-1.1") throw new Error(`${FONT_MANIFEST}: license must be OFL-1.1`);
  for (const family of ["Audivane Sans Latin", "Audivane Mono Latin"]) {
    if (!manifest.families?.includes(family)) throw new Error(`${FONT_MANIFEST}: missing family ${family}`);
  }
  if (!String(manifest.tool).startsWith("fonttools")) throw new Error(`${FONT_MANIFEST}: tool must pin fonttools`);

  const onDisk = [];
  for (const directory of FONT_DIRECTORIES) {
    for (const name of readdirSync(path.join(root, directory)).sort()) {
      if (name.endsWith(".woff2")) onDisk.push(`${directory}/${name}`);
    }
  }
  const recorded = manifest.files.map((file) => file.path);
  const missing = onDisk.filter((relative) => !recorded.includes(relative));
  const stale = recorded.filter((relative) => !onDisk.includes(relative));
  if (missing.length > 0) throw new Error(`${FONT_MANIFEST}: bundled fonts missing from the manifest: ${missing.join(", ")}`);
  if (stale.length > 0) throw new Error(`${FONT_MANIFEST}: manifest lists fonts that are not bundled: ${stale.join(", ")}`);
  if (new Set(recorded).size !== recorded.length) throw new Error(`${FONT_MANIFEST}: duplicate manifest paths`);

  const byOriginal = new Map();
  for (const file of manifest.files) {
    const label = file.path;
    if (!hex64.test(String(file.originalSha256))) throw new Error(`${label}: originalSha256 is not a SHA-256 hex digest`);
    if (!hex64.test(String(file.sha256))) throw new Error(`${label}: sha256 is not a SHA-256 hex digest`);
    if (!hex64.test(String(file.originalContentSha256))) {
      throw new Error(`${label}: originalContentSha256 is missing from the manifest`);
    }
    const bytes = readFileSync(path.join(root, file.path));
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== file.sha256) throw new Error(`${label}: file bytes do not match the recorded sha256`);
    if (file.originalSha256 === file.sha256) throw new Error(`${label}: original and renamed hashes are identical; the rename was not applied`);

    const parsed = parseWoff2(bytes, label);
    const actualFingerprint = contentFingerprint(parsed.tables);
    if (update) {
      file.contentSha256 = actualFingerprint;
    } else if (!hex64.test(String(file.contentSha256))) {
      throw new Error(`${label}: contentSha256 is missing from the manifest`);
    }
    if (actualFingerprint !== file.contentSha256) {
      throw new Error(`${label}: content fingerprint ${actualFingerprint} does not match the recorded contentSha256 ${file.contentSha256}; glyphs, metrics or other non-name font data changed`);
    }
    if (file.contentSha256 !== file.originalContentSha256) {
      throw new Error(`${label}: content fingerprint ${file.contentSha256} does not match the recorded upstream originalContentSha256 ${file.originalContentSha256}; glyphs, metrics or other non-name font data differ from the original subset`);
    }

    if (!manifest.families.includes(file.family)) {
      throw new Error(`${label}: family ${file.family} is not listed in the manifest families`);
    }
    const expectedPrefix = file.family;
    const records = nameRecords(parsed, label);
    for (const required of REQUIRED_NAME_IDS) {
      if (!records.some((record) => record.nameID === required)) {
        throw new Error(`${label}: no nameID ${required} record is present; the IBM copyright or OFL license URL record was removed`);
      }
    }
    for (const record of records) {
      if (/plex/i.test(record.text)) {
        throw new Error(`${label}: nameID ${record.nameID} still contains the reserved name: ${record.text}`);
      }
      if (RENAMED_NAME_IDS.includes(record.nameID)
        && !(record.text.includes("Audivane") && record.text.includes("Latin"))) {
        throw new Error(`${label}: nameID ${record.nameID} does not carry the renamed Audivane Latin family: ${record.text}`);
      }
      const validate = NAME_ID_VALIDATIONS.get(record.nameID);
      if (validate) {
        const failure = validate(record.text, expectedPrefix);
        if (failure) throw new Error(`${label}: ${failure}`);
      }
    }

    const original = byOriginal.get(file.originalSha256);
    if (original) {
      if (
        original.sha256 !== file.sha256
        || original.contentSha256 !== file.contentSha256
        || original.originalContentSha256 !== file.originalContentSha256
        || original.family !== file.family
      ) {
        throw new Error(`${label}: same originalSha256 as ${original.path} but a different renamed file hash, content fingerprint or family`);
      }
    } else {
      byOriginal.set(file.originalSha256, file);
    }
  }

  for (const directory of FONT_DIRECTORIES) {
    const notice = `${directory}/OFL.txt`;
    const text = readFileSync(path.join(root, notice), "utf8");
    if (!text.includes("SIL OPEN FONT LICENSE") || !text.includes("IBM")) {
      throw new Error(`${notice}: is not the IBM OFL notice`);
    }
  }

  if (update) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { files: manifest.files.length, updated: update };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--fingerprint") {
    for (const file of args.slice(1)) {
      console.log(`${contentFingerprint(parseWoff2(readFileSync(file), file).tables)}  ${file}`);
    }
  } else {
    const update = args.includes("--update");
    const summary = await checkSubsetFonts({ update });
    const note = update ? " (contentSha256 re-recorded from disk)" : "";
    console.log(`[fonts] ${summary.files} bundled subsets match ${FONT_MANIFEST}: hashes, renamed names, preserved copyright and OFL records, unchanged glyph/metric data${note}`);
  }
}
