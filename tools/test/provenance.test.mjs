import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT = path.join(ROOT, "tools/audit-native-provenance.mjs");
const COLLECT = path.join(ROOT, "tools/collect-third-party-materials.mjs");
const INVENTORY = path.join(ROOT, "third_party/release-materials.json");

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

test("release material inventory pins unique, hashed native sources", async () => {
  const inventory = JSON.parse(await fs.readFile(INVENTORY, "utf8"));
  assert.equal(inventory.schema, "audivane-third-party-materials-v1");
  assert.ok(inventory.components.length >= 10);
  const ids = new Set();
  const filenames = new Set();
  for (const component of inventory.components) {
    assert.match(component.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(component.id), `duplicate component id ${component.id}`);
    ids.add(component.id);
    assert.match(component.archive.url, /^https:\/\//);
    const pin = component.archive.sha256 ?? component.archive.contentSha256;
    assert.match(pin, /^[0-9a-f]{64}$/);
    assert.ok(!filenames.has(component.archive.filename), `duplicate archive ${component.archive.filename}`);
    filenames.add(component.archive.filename);
    assert.ok(component.licenseFiles.length > 0);
    assert.ok(component.buildScripts.every((script) => script.startsWith("tools/")));
  }
});

test("release material inventory references local application notices", async () => {
  const inventory = JSON.parse(await fs.readFile(INVENTORY, "utf8"));
  for (const asset of inventory.localAssets) {
    for (const relative of asset.paths) {
      const stat = await fs.stat(path.join(ROOT, relative));
      assert.ok(stat.isFile(), `${asset.id}: ${relative} is not a file`);
      assert.ok(stat.size > 0, `${asset.id}: ${relative} is empty`);
    }
  }
  const ids = inventory.localAssets.map((asset) => asset.id);
  for (const required of ["electron", "ibm-plex", "measurements"]) {
    assert.ok(ids.includes(required), `missing preserved notice group ${required}`);
  }
});

test("native build scripts parse", { skip: process.platform === "win32" }, () => {
  for (const script of ["tools/build_ffmpeg.sh", "tools/build_ldac_helper.sh", "tools/build_linux_baseline.sh"]) {
    const result = run("bash", ["-n", path.join(ROOT, script)]);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("provenance audit refuses an unsafe baseline argument", () => {
  const result = run(process.execPath, [AUDIT, "--baseline-glibc", "2"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /baseline-glibc/);
});

test("provenance audit fails an empty bundle instead of assuming support", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-audit-empty-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = run(process.execPath, [AUDIT, "--bundle", directory, "--skip-functional"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"ok": false/);
});

test("materials collector exposes verify mode", () => {
  const result = run(process.execPath, [COLLECT, "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--verify/);
});

test('material verification rejects tampering, unlisted files and unsafe paths', async t => {
  const { createHash } = await import('node:crypto');
  const { verifyMaterials } = await import('../collect-third-party-materials.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-materials-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('exact source license');
  const record = { path: 'LICENSE', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const manifest = { schema: 'audivane-third-party-materials-v1', files: [record] };
  const save = value => fs.writeFile(path.join(directory, 'MANIFEST.json'), JSON.stringify(value));
  await fs.writeFile(path.join(directory, 'LICENSE'), bytes);
  await save(manifest);
  await verifyMaterials(directory);
  await fs.writeFile(path.join(directory, 'LICENSE'), 'changed license');
  await assert.rejects(verifyMaterials(directory), /hash mismatch/);
  await fs.writeFile(path.join(directory, 'LICENSE'), bytes);
  await fs.writeFile(path.join(directory, 'unlisted'), 'unexpected');
  await assert.rejects(verifyMaterials(directory), /unlisted/);
  await fs.rm(path.join(directory, 'unlisted'));
  await save({ ...manifest, files: [{ ...record, path: '../LICENSE' }] });
  await assert.rejects(verifyMaterials(directory), /Unsafe/);
  await save({ ...manifest, files: [record, record] });
  await assert.rejects(verifyMaterials(directory), /duplicate/);
});

test('source pin verification refuses a self-consistent archive replacement and a wrong platform', async t => {
  const { createHash } = await import('node:crypto');
  const { verifyMaterialPins } = await import('../collect-third-party-materials.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-source-pins-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const relative = 'sources/ffmpeg-9.0.2.tar.xz';
  const bytes = Buffer.from('wrong source bytes with an internally consistent manifest');
  await fs.mkdir(path.join(directory, 'sources'));
  await fs.writeFile(path.join(directory, relative), bytes);
  await fs.writeFile(path.join(directory, 'MANIFEST.json'), JSON.stringify({ schema: 'audivane-third-party-materials-v1', platform: 'linux',
    files: [{ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  await assert.rejects(verifyMaterialPins(directory, 'win32'), /platform/);
  await assert.rejects(verifyMaterialPins(directory, 'linux'), /Source pin mismatch/);
});
