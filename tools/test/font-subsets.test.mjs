import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FONT_DIRECTORIES,
  FONT_MANIFEST,
  ROOT,
  checkSubsetFonts,
  contentFingerprint,
  nameRecords,
  parseWoff2,
  recompressWoff2,
} from "../check-subset-fonts.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-font-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of FONT_DIRECTORIES) {
    await fs.cp(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
  }
  await fs.cp(path.join(ROOT, FONT_MANIFEST), path.join(root, FONT_MANIFEST));
  return root;
}

function manifestPath(root) {
  return path.join(root, FONT_MANIFEST);
}

function readManifest(root) {
  return JSON.parse(readFileSync(manifestPath(root), "utf8"));
}

// Rewrite one decompressed table byte inside the font, re-embed the stream,
// and optionally re-record only the file sha256 so the content fingerprint
// check is the gate that must fail.
function tamperFont(root, relative, { updateFileHash = false, mutate }) {
  const file = path.join(root, relative);
  const bytes = readFileSync(file);
  const parsed = parseWoff2(bytes, relative);
  const stream = Buffer.from(parsed.stream);
  mutate(stream, parsed);
  const output = recompressWoff2(bytes, parsed, stream);
  writeFileSync(file, output);
  if (updateFileHash) {
    const manifest = readManifest(root);
    const entry = manifest.files.find((item) => item.path === relative);
    entry.sha256 = createHash("sha256").update(output).digest("hex");
    writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

test("bundled renamed font subsets match the recorded manifest and preserve glyph, metric and copyright data", async () => {
  const summary = await checkSubsetFonts();
  assert.equal(summary.files, readManifest(ROOT).files.length);
  assert.equal(summary.files, 12, "expected the full 12-file bundled font inventory");
  assert.equal(summary.updated, false);
  for (const file of readManifest(ROOT).files) {
    assert.equal(file.contentSha256, file.originalContentSha256, `${file.path}: renamed content fingerprint must equal the recorded upstream fingerprint`);
  }
});

test("the font check rejects changed glyph outline bytes even when the file hash was re-recorded", async (t) => {
  const root = await fixture(t);
  const target = "apps/client/src/assets/fonts/ibm-plex-sans-latin-400.woff2";
  tamperFont(root, target, { updateFileHash: true, mutate(stream, parsed) {
    const glyf = parsed.tables.find((table) => table.tag === "glyf");
    assert.ok(glyf, "expected a glyf table in the bundled subset");
    stream[glyf.streamOffset + 100] ^= 0xff;
  } });
  await assert.rejects(checkSubsetFonts({ root }), /content fingerprint .* does not match the recorded contentSha256/);
});

test("the font check rejects a name record that re-introduces the reserved IBM Plex name", async (t) => {
  const root = await fixture(t);
  const target = "website/public/fonts/ibm-plex-sans-latin-600.woff2";
  const original = Buffer.from("Audivane", "utf16le").swap16();
  tamperFont(root, target, { updateFileHash: true, mutate(stream, parsed) {
    const name = parsed.tables.find((table) => table.tag === "name");
    assert.ok(name, "expected a name table in the bundled subset");
    const index = stream.indexOf(original, name.streamOffset);
    assert.notEqual(index, -1, "expected the renamed family string inside the name table");
    Buffer.from("IBM Plex", "utf16le").swap16().copy(stream, index);
  } });
  await assert.rejects(checkSubsetFonts({ root }), /still contains the reserved name/);
});

test("the font check rejects a stripped IBM copyright record", async (t) => {
  const root = await fixture(t);
  const target = "apps/landing/public/fonts/ibm-plex-sans-latin-400.woff2";
  tamperFont(root, target, { updateFileHash: true, mutate(stream, parsed) {
    const name = parsed.tables.find((table) => table.tag === "name");
    assert.ok(name, "expected a name table in the bundled subset");
    // Retarget the one copyright record (nameID 0) to an unvalidated ID.
    let retargeted = 0;
    const count = name.bytes.readUInt16BE(2);
    for (let n = 0; n < count; n += 1) {
      const where = name.streamOffset + 6 + n * 12 + 6;
      if (stream.readUInt16BE(where) === 0) {
        stream.writeUInt16BE(255, where);
        retargeted += 1;
      }
    }
    assert.ok(retargeted > 0, "expected a nameID 0 copyright record in the bundled subset");
  } });
  await assert.rejects(checkSubsetFonts({ root }), /no nameID 0 record is present/);
});

test("the font check rejects a name record truncated to the family word", async (t) => {
  const root = await fixture(t);
  const target = "apps/client/src/assets/fonts/ibm-plex-sans-latin-400.woff2";
  tamperFont(root, target, { updateFileHash: true, mutate(stream, parsed) {
    const name = parsed.tables.find((table) => table.tag === "name");
    assert.ok(name, "expected a name table in the bundled subset");
    // NameID 4 (full name) is unvalidated by content, so shrinking it to the
    // family word alone must fail the renamed-family requirement.
    const full = Buffer.from("Audivane Sans Latin Regular", "utf16le").swap16();
    const index = stream.indexOf(full, name.streamOffset);
    assert.notEqual(index, -1, "expected the renamed full name inside the name table");
    Buffer.from("Audivane".padEnd(full.length / 2, " "), "utf16le").swap16().copy(stream, index);
  } });
  await assert.rejects(checkSubsetFonts({ root }), /does not carry the renamed/);
});

test("--fingerprint reports the manifest's recorded fingerprint for a bundled subset", () => {
  const manifest = readManifest(ROOT);
  const file = manifest.files.find((entry) => entry.path.includes("apps/client"));
  const actual = contentFingerprint(parseWoff2(readFileSync(path.join(ROOT, file.path)), file.path).tables);
  assert.equal(actual, file.contentSha256);
});
