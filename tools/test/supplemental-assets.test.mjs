import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { copyWasmAssets } from '../copy-wasm-assets.mjs';

const coreNames = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];
const supplementalFiles = {
  lc3: ['lc3_codec.js', 'lc3_codec.wasm'],
  ldac: ['ldac_codec.js', 'ldac_codec.wasm'],
};
const allSupplementalNames = Object.values(supplementalFiles).flat();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codec-supplemental-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coreSourceDir = path.join(root, 'core/esm');
  const supplementalDir = path.join(root, 'supplemental/bin');
  const targetDir = path.join(root, 'public/codec-assets');
  await fs.mkdir(coreSourceDir, { recursive: true });
  for (const [index, name] of coreNames.entries()) {
    await fs.writeFile(path.join(coreSourceDir, name), `required-core-${index}-${name}`);
  }
  return { root, coreSourceDir, supplementalDir, targetDir };
}

async function writePair(supplementalDir, codec, tag) {
  let manifest = '';
  for (const name of supplementalFiles[codec]) {
    await fs.mkdir(supplementalDir, { recursive: true });
    const bytes = `${codec}-${name}-${tag}`;
    await fs.writeFile(path.join(supplementalDir, name), bytes);
    manifest += `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`;
  }
  await fs.writeFile(path.join(supplementalDir, `${codec}_codec.sha256`), manifest);
}

const targetBytes = async (targetDir, name) =>
  fs.readFile(path.join(targetDir, name)).catch(() => null);

const publicMissing = async (targetDir, name) =>
  (await targetBytes(targetDir, name)) === null;

test('required core is copied; an initially missing supplemental build stays optional', async t => {
  const { coreSourceDir, supplementalDir, targetDir } = await fixture(t);
  await copyWasmAssets({ coreSourceDir, supplementalDir, targetDir });
  for (const name of coreNames) {
    assert.equal((await targetBytes(targetDir, name)).toString(), `required-core-${coreNames.indexOf(name)}-${name}`);
  }
  for (const name of allSupplementalNames) {
    assert.ok(await publicMissing(targetDir, name), `${name} must not appear when its build was never produced`);
  }
});

test('missing required core assets still fail the build', async t => {
  const options = await fixture(t);
  await assert.rejects(
    copyWasmAssets({ ...options, coreSourceDir: path.join(options.root, 'core/absent') }),
    /Missing .*Run npm install/,
  );
});

test('complete supplemental builds are copied byte-exactly for both codec pairs', async t => {
  const options = await fixture(t);
  await writePair(options.supplementalDir, 'lc3', 'b1');
  await writePair(options.supplementalDir, 'ldac', 'b1');
  await copyWasmAssets(options);
  for (const codec of ['lc3', 'ldac']) {
    for (const name of supplementalFiles[codec]) {
      const bytes = await targetBytes(options.targetDir, name);
      assert.ok(bytes, `${name} must be copied when the pair is complete`);
      assert.equal(bytes.toString(), `${codec}-${name}-b1`, `${name} must equal its exact source bytes`);
    }
  }
});

test('a build that disappears after a previous copy removes the stale public pair', async t => {
  const options = await fixture(t);
  await writePair(options.supplementalDir, 'lc3', 'old');
  await writePair(options.supplementalDir, 'ldac', 'old');
  await copyWasmAssets(options);
  // The pinned supplemental build is a gitignored local artifact; simulates a
  // fresh checkout or emsdk rebuild attempt that did not produce the modules.
  await fs.rm(options.supplementalDir, { recursive: true, force: true });
  await copyWasmAssets(options);
  for (const name of allSupplementalNames) {
    assert.ok(await publicMissing(options.targetDir, name), `${name} is stale once its build is gone`);
  }
  for (const [index, name] of coreNames.entries()) {
    assert.equal((await targetBytes(options.targetDir, name)).toString(), `required-core-${index}-${name}`);
  }
});

test('a partial rebuild removes the whole pair so a new glue never serves with an old module half', async t => {
  const options = await fixture(t);
  await writePair(options.supplementalDir, 'lc3', 'old');
  await writePair(options.supplementalDir, 'ldac', 'old');
  await copyWasmAssets(options);
  // Partial rebuild: lc3 produced only glue, ldac produced only the module.
  await writePair(options.supplementalDir, 'lc3', 'new');
  await fs.rm(path.join(options.supplementalDir, 'lc3_codec.wasm'), { force: true });
  await writePair(options.supplementalDir, 'ldac', 'new');
  await fs.rm(path.join(options.supplementalDir, 'ldac_codec.js'), { force: true });
  await copyWasmAssets(options);
  for (const name of [...supplementalFiles.lc3, ...supplementalFiles.ldac]) {
    assert.ok(await publicMissing(options.targetDir, name), `${name} must not be served from a mixed pair`);
  }
  for (const [index, name] of coreNames.entries()) {
    assert.equal((await targetBytes(options.targetDir, name)).toString(), `required-core-${index}-${name}`);
  }
  // Completing the build recovers both pairs on the next reconciliation.
  await writePair(options.supplementalDir, 'lc3', 'new');
  await writePair(options.supplementalDir, 'ldac', 'new');
  await copyWasmAssets(options);
  for (const codec of ['lc3', 'ldac']) {
    for (const name of supplementalFiles[codec]) {
      assert.equal((await targetBytes(options.targetDir, name)).toString(), `${codec}-${name}-new`);
    }
  }
});

test('an interrupted install with both halves present removes the mixed pair and recovers', async t => {
  const options = await fixture(t);
  await writePair(options.supplementalDir, 'lc3', 'old');
  await writePair(options.supplementalDir, 'ldac', 'old');
  await copyWasmAssets(options);
  // Killed after installing new glue, before installing its matching WASM
  // and publishing the new manifest. Both paths still exist.
  await fs.writeFile(path.join(options.supplementalDir, 'lc3_codec.js'), 'new-glue');
  await copyWasmAssets(options);
  for (const name of supplementalFiles.lc3) {
    assert.ok(await publicMissing(options.targetDir, name));
  }
  assert.equal((await targetBytes(options.targetDir, 'ldac_codec.wasm')).toString(), 'ldac-ldac_codec.wasm-old');
  await writePair(options.supplementalDir, 'lc3', 'new');
  await copyWasmAssets(options);
  assert.equal((await targetBytes(options.targetDir, 'lc3_codec.js')).toString(), 'lc3-lc3_codec.js-new');
});

test('complete files without a valid pair manifest remove previously served copies', async t => {
  const options = await fixture(t);
  await writePair(options.supplementalDir, 'lc3', 'old');
  await copyWasmAssets(options);
  await fs.rm(path.join(options.supplementalDir, 'lc3_codec.sha256'));
  await copyWasmAssets(options);
  for (const name of supplementalFiles.lc3) assert.ok(await publicMissing(options.targetDir, name));
  await fs.writeFile(path.join(options.supplementalDir, 'lc3_codec.sha256'), 'invalid');
  await copyWasmAssets(options);
  for (const name of supplementalFiles.lc3) assert.ok(await publicMissing(options.targetDir, name));
});

test('unchanged pairs are left byte-identical; changed files alone are recopied', async t => {
  const options = await fixture(t);
  await writePair(options.supplementalDir, 'lc3', 'old');
  await writePair(options.supplementalDir, 'ldac', 'old');
  await copyWasmAssets(options);
  await writePair(options.supplementalDir, 'ldac', 'fresh');
  await copyWasmAssets(options);
  // lc3 sources did not change: its public copies stay exactly as served.
  assert.equal((await targetBytes(options.targetDir, 'lc3_codec.js')).toString(), 'lc3-lc3_codec.js-old');
  assert.equal((await targetBytes(options.targetDir, 'lc3_codec.wasm')).toString(), 'lc3-lc3_codec.wasm-old');
  assert.equal((await targetBytes(options.targetDir, 'ldac_codec.js')).toString(), 'ldac-ldac_codec.js-fresh');
  assert.equal((await targetBytes(options.targetDir, 'ldac_codec.wasm')).toString(), 'ldac-ldac_codec.wasm-fresh');
});

test('the CLI entry keeps reconciling under the shared verification output lock', async t => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../copy-wasm-assets.mjs'), 'utf8');
  assert.match(source, /withLock\(\s*path\.join\(root,\s*'build\/verification\.lock'\)/);
  assert.match(source, /cancellation\.signal/);
  // The build graph reconciles assets before every stage, so a failed or
  // partial rebuild cannot leave stale public pairs behind even if
  // copy-wasm-assets.mjs was not run standalone.
  const buildScript = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../verification/build.mjs'), 'utf8');
  assert.match(buildScript, /await copyWasmAssets\(\);/);
});
