import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withLock } from '../verification/cache.mjs';
import { packageJobs } from '../distribution/jobs.mjs';
import { parseReleaseArguments } from '../distribution/release.mjs';
import { withReleaseWorkspace } from '../distribution/release-work.mjs';
import { compressZipEntries } from '../distribution/zip-compression.mjs';
import { writeZipFromDirectory, verifyZip } from '../distribution/zip.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-release-pipeline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('package job budgets validate CLI/env values and use a bounded host default', () => {
  assert.equal(packageJobs(1), 1);
  assert.equal(packageJobs('32'), 32);
  for (const invalid of [0, -1, 33, 2.5, '', 'auto', '2x', 'Infinity']) assert.throws(() => packageJobs(invalid), /integer between/);
  assert.equal(parseReleaseArguments(['arch', '--jobs', '12', '--prepare-only']).jobs, 12);
  assert.throws(() => parseReleaseArguments(['linux', '--jobs', '0']), /integer between/);
  const old = process.env.AUDIVANE_PACKAGE_JOBS;
  try {
    process.env.AUDIVANE_PACKAGE_JOBS = '3';
    assert.equal(parseReleaseArguments(['windows']).jobs, 3);
    assert.equal(parseReleaseArguments(['windows', '--jobs', '2']).jobs, 2);
    delete process.env.AUDIVANE_PACKAGE_JOBS;
    assert.ok(packageJobs() >= 1 && packageJobs() <= 16);
  } finally {
    if (old === undefined) delete process.env.AUDIVANE_PACKAGE_JOBS;
    else process.env.AUDIVANE_PACKAGE_JOBS = old;
  }
});

test('ZIP jobs preserve exact archive bytes, entry hashes, ordering and modes', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'sub'), { recursive: true });
  await fs.writeFile(path.join(source, 'z-empty'), '');
  await fs.writeFile(path.join(source, 'sub/音声.txt'), 'stereo payload '.repeat(10000));
  await fs.writeFile(path.join(source, 'a-executable'), Buffer.from([0, 1, 2, 255]), { mode: 0o755 });
  const old = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1700000000';
  try {
    const serial = await writeZipFromDirectory(source, path.join(root, 'serial.zip'), { jobs: 1 });
    const parallel = await writeZipFromDirectory(source, path.join(root, 'parallel.zip'), { jobs: 4 });
    assert.equal(serial.sha256, parallel.sha256);
    assert.deepEqual(await fs.readFile(serial.path), await fs.readFile(parallel.path));
    assert.deepEqual((await verifyZip(parallel.path)).entries, parallel.entries);
    assert.deepEqual(parallel.entries.map(e => e.name), ['a-executable', 'sub/音声.txt', 'z-empty']);
  } finally {
    if (old === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = old;
  }
});

test('failed/aborted ZIP work drains its workers and preserves a previous archive', async t => {
  const root = await fixture(t);
  await assert.rejects(compressZipEntries(root, ['missing'], { jobs: 2 }), /missing.*ENOENT|ENOENT.*missing/);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'large'), Buffer.alloc(16 * 1024 * 1024, 42));
  const output = path.join(root, 'archive.zip');
  await fs.writeFile(output, 'previous complete archive');
  const controller = new AbortController();
  const pending = writeZipFromDirectory(source, output, { jobs: 2, signal: controller.signal });
  setImmediate(() => controller.abort(new Error('stop compression')));
  await assert.rejects(pending, /stop compression/);
  assert.equal(await fs.readFile(output, 'utf8'), 'previous complete archive');
  assert.ok(!(await fs.readdir(root)).some(name => name.endsWith('.tmp')));
  // A new pool still completes after the failure/cancellation paths.
  await verifyZip((await writeZipFromDirectory(source, output, { jobs: 1 })).path);
});

test('different platform archives overlap while captures/publish and same-format jobs serialize', { timeout: 15000 }, async t => {
  const root = await fixture(t);
  const sharedLock = path.join(root, 'shared.lock');
  const workspaceRoot = path.join(root, 'work');
  const shared = path.join(root, 'shared-package');
  await fs.writeFile(shared, 'first package');
  const firstEntered = deferred(), secondEntered = deferred(), finish = deferred();
  const events = [];
  const run = (platform, label, entered, wait = finish.promise) => withReleaseWorkspace(platform, {
    sharedLock, workspaceRoot,
    capture: async workspace => {
      events.push(label + ':capture');
      await fs.copyFile(shared, path.join(workspace, 'snapshot'));
      return { snapshot: path.join(workspace, 'snapshot') };
    },
    build: async snapshot => {
      entered.resolve();
      await wait;
      return fs.readFile(snapshot.snapshot, 'utf8');
    },
    publish: async value => { events.push(label + ':publish'); return value; },
  });
  const first = run('linux', 'first', firstEntered);
  await firstEntered.promise;
  // Shared build/verification work runs while Linux compression is blocked.
  await withLock(sharedLock, () => fs.writeFile(shared, 'second package'));
  const second = run('win32', 'second', secondEntered);
  await secondEntered.promise;
  const third = run('linux', 'third', deferred(), Promise.resolve());
  finish.resolve();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results, ['first package', 'second package', 'second package']);
  assert.ok(events.indexOf('second:capture') < events.indexOf('first:publish'));
  assert.ok(events.indexOf('first:publish') < events.indexOf('third:capture'));
  assert.deepEqual((await fs.readdir(workspaceRoot)).filter(name => !name.endsWith('.lock')), []);
});

test('release failures clean private outputs and never enter the publish phase', async t => {
  const root = await fixture(t);
  let published = false;
  const workspaceRoot = path.join(root, 'work');
  await assert.rejects(withReleaseWorkspace('arch', {
    sharedLock: path.join(root, 'shared.lock'), workspaceRoot,
    capture: async workspace => { await fs.writeFile(path.join(workspace, 'capture'), 'data'); },
    build: async () => { throw new Error('compressor failed'); },
    publish: async () => { published = true; },
  }), /compressor failed/);
  assert.equal(published, false);
  assert.deepEqual((await fs.readdir(workspaceRoot)).filter(name => !name.endsWith('.lock')), []);
});
