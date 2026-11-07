import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSession, loopbackURL } from '../verification/session.mjs';
import { acquirePipeLock, cachedBuild, fingerprint, lockResourceName, withLock } from '../verification/cache.mjs';
import { taskkillExecutable } from '../verification/windows.mjs';
const WINDOWS = process.platform === 'win32';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codec-verification-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('content stamps hit only with unchanged inputs and intact outputs; same-size edits, additions and deletions invalidate', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/a'), 'one');
  let builds = 0;
  const options = { root, name: 'fixture', inputs: ['src'], outputs: ['out'], action: async () => {
    builds++;
    await fs.mkdir(path.join(root, 'out/dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'out/dist/asset'), 'artifact');
  } };
  assert.equal(await cachedBuild(options), true);
  assert.equal(await cachedBuild(options), false);
  await fs.writeFile(path.join(root, 'src/a'), 'two');
  assert.equal(await cachedBuild(options), true);
  await fs.writeFile(path.join(root, 'src/b'), 'new');
  assert.equal(await cachedBuild(options), true);
  await fs.rm(path.join(root, 'src/b'));
  assert.equal(await cachedBuild(options), true);
  await fs.writeFile(path.join(root, 'out/dist/asset'), 'tampered');
  assert.equal(await cachedBuild(options), true);
  await fs.rm(path.join(root, 'out/dist/asset'));
  assert.equal(await cachedBuild(options), true);
  assert.equal(builds, 6);
});

test('complete resource inputs invalidate reuse for names excluded from repository sources', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'prepared/dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'prepared/dist/NOTICE'), 'one');
  let builds = 0;
  const options = { root, name: 'resources', inputs: [], completeInputs: ['prepared'], outputs: ['package'], action: async () => {
    builds++;
    await fs.writeFile(path.join(root, 'package'), await fs.readFile(path.join(root, 'prepared/dist/NOTICE')));
  } };
  assert.equal(await cachedBuild(options), true);
  assert.equal(await cachedBuild(options), false);
  await fs.writeFile(path.join(root, 'prepared/dist/NOTICE'), 'two');
  assert.equal(await cachedBuild(options), true);
  assert.equal(await fs.readFile(path.join(root, 'package'), 'utf8'), 'two');
  assert.equal(builds, 2);
});

test('failed or source-racing builds remove old stamps and must rerun', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'source'), 'a');
  let fail = false;
  let race = false;
  let builds = 0;
  const options = { root, name: 'failure', inputs: ['source'], outputs: ['output'], action: async () => {
    builds++;
    await fs.writeFile(path.join(root, 'output'), 'output');
    if (fail) throw new Error('build failed');
    if (race) await fs.writeFile(path.join(root, 'source'), 'changed while building');
  } };
  await cachedBuild(options);
  await fs.writeFile(path.join(root, 'source'), 'b');
  fail = true;
  await assert.rejects(cachedBuild(options), /build failed/);
  await assert.rejects(fs.access(path.join(root, 'build/verification-cache/failure.json')));
  fail = false;
  race = true;
  await assert.rejects(cachedBuild(options), /source changed during build/);
  race = false;
  await cachedBuild(options);
  assert.equal(await cachedBuild(options), false);
  assert.equal(builds, 4);
});

test('missing required inputs and output modes affect fingerprints', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'tool'), 'same bytes');
  const first = await fingerprint(root, ['tool']);
  // Windows reports only a coarse mode word (mostly the read-only bit), so a
  // POSIX-style executable bit change cannot be observed there.
  if (!WINDOWS) {
    await fs.chmod(path.join(root, 'tool'), 0o700);
    assert.notEqual(await fingerprint(root, ['tool']), first);
  }
  await assert.rejects(fingerprint(root, ['missing']));
});

test('linked source bytes invalidate builds and directory cycles refuse fingerprinting', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'real.ts'), 'first');
  let linked = true;
  try { await fs.symlink('../real.ts', path.join(root, 'src/link.ts')); }
  catch (error) {
    // Windows only permits file symlinks with Developer Mode or elevation.
    if (WINDOWS && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) linked = false;
    else throw error;
  }
  if (linked) {
    let builds = 0;
    const options = { root, name: 'symlink', inputs: ['src'], outputs: ['output'], action: async () => {
      builds++;
      await fs.writeFile(path.join(root, 'output'), await fs.readFile(path.join(root, 'src/link.ts')));
    } };
    await cachedBuild(options);
    await fs.writeFile(path.join(root, 'real.ts'), 'later');
    assert.equal(await cachedBuild(options), true);
    assert.equal(builds, 2);
    assert.equal(await fs.readFile(path.join(root, 'output'), 'utf8'), 'later');
    assert.equal(await cachedBuild(options), false);
  } else t.diagnostic('file symlinks require Windows Developer Mode; linked-source invalidation not exercised');
  // Junctions do not need the file-symlink privilege and still prove cycle refusal.
  const cycle = path.join(root, 'src/cycle');
  try { await fs.symlink(WINDOWS ? path.join(root, 'src') : '.', cycle, WINDOWS ? 'junction' : undefined); }
  catch (error) {
    if (WINDOWS && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.diagnostic('directory links are unavailable on this Windows host; cycle refusal not exercised');
      return;
    }
    throw error;
  }
  await assert.rejects(fingerprint(root, ['src']), /Cyclic build directory/);
});

test('kernel lock serializes independent owners and releases after a crashed process', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  const lock = path.join(root, 'shared.lock');
  const marker = path.join(root, 'entered');
  let firstEntered;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = withLock(lock, async () => { firstEntered(); await gate; });
  await entered;
  let secondEntered = false;
  const second = withLock(lock, async () => { secondEntered = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(secondEntered, false);
  release();
  await first;
  await second;
  assert.equal(secondEntered, true);
  const module = new URL('../verification/cache.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { withLock } from ${JSON.stringify(module)}; import { writeFile } from 'node:fs/promises'; await withLock(${JSON.stringify(lock)}, async () => { await writeFile(${JSON.stringify(marker)}, 'yes'); process.exit(7); });`]);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 7);
  assert.equal(await fs.readFile(marker, 'utf8'), 'yes');
  await withLock(lock, async () => assert.ok(true));
});

test('Windows descendant termination resolves taskkill without trusting PATH', () => {
  assert.equal(taskkillExecutable({ SystemRoot: 'C:\\Windows', PATH: '' }),
    path.join('C:\\Windows', 'System32', 'taskkill.exe'));
  assert.equal(taskkillExecutable({ windir: 'D:\\Win' }),
    path.join('D:\\Win', 'System32', 'taskkill.exe'));
  assert.equal(taskkillExecutable({}), 'taskkill.exe');
});

test('lock resources keep distinct output paths apart, including spaces and non-ASCII names', () => {
  const base = path.join(os.tmpdir(), 'codec lock');
  const first = lockResourceName(path.join(base, 'verification.lock'), 'linux');
  const second = lockResourceName(path.join(base, 'other lock.lock'), 'linux');
  assert.notEqual(first, second);
  assert.match(first, /^[a-z0-9-]+$/);
  assert.equal(lockResourceName(path.join(base, 'Ünïcode lock.lock'), 'linux'), lockResourceName(path.join(base, 'Ünïcode lock.lock'), 'linux'));
  // Only Windows folds case; Linux keeps case-sensitive path identity.
  assert.equal(lockResourceName(path.join(base, 'Case.lock'), 'win32'), lockResourceName(path.join(base, 'case.lock'), 'win32'));
  assert.notEqual(lockResourceName(path.join(base, 'Case.lock'), 'linux'), lockResourceName(path.join(base, 'case.lock'), 'linux'));
});

test('a lock under a spaced/non-ASCII directory serializes and releases after an error', async t => {
  const root = await fixture(t);
  const directory = path.join(root, 'shared outputs ß');
  await fs.mkdir(directory);
  const lock = path.join(directory, 'verification.lock');
  await assert.rejects(withLock(lock, async () => { throw new Error('action failed'); }), /action failed/);
  let entered = false;
  await withLock(lock, async () => { entered = true; });
  assert.equal(entered, true);
});

test('unique session directories prevent report and output collisions', async t => {
  const root = await fixture(t);
  const sessions = await Promise.all(Array.from({ length: 8 }, () => createSession(root, 'browser')));
  assert.equal(new Set(sessions).size, 8);
  await Promise.all(sessions.map((directory, index) => fs.writeFile(path.join(directory, 'report.json'), String(index))));
  assert.deepEqual(await Promise.all(sessions.map(directory => fs.readFile(path.join(directory, 'report.json'), 'utf8'))), ['0', '1', '2', '3', '4', '5', '6', '7']);
});

test('an interrupted build cannot publish a reusable success stamp', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'source'), 'input');
  const cancellation = new AbortController();
  await assert.rejects(cachedBuild({ root, name: 'abort', inputs: ['source'], outputs: ['output'], signal: cancellation.signal, action: async () => {
    await fs.writeFile(path.join(root, 'output'), 'partial or completed output');
    cancellation.abort(new Error('interrupted'));
  } }), /interrupted/);
  await assert.rejects(fs.access(path.join(root, 'build/verification-cache/abort.json')));
});


test('simultaneous sessions own distinct ephemeral loopback servers and clean up independently', async t => {
  const servers = [createServer((request, response) => response.end('first')), createServer((request, response) => response.end('second'))];
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const urls = servers.map(loopbackURL);
  assert.notEqual(urls[0], urls[1]);
  assert.deepEqual(await Promise.all(urls.map(async url => (await fetch(url)).text())), ['first', 'second']);
  await new Promise(resolve => servers[0].close(resolve));
  await assert.rejects(fetch(urls[0]));
  assert.equal(await (await fetch(urls[1])).text(), 'second');
});

test('owned commands retain the output gate if their launcher is killed', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  const lock = path.join(root, 'shared.lock');
  const started = path.join(root, 'started');
  const completed = path.join(root, 'completed');
  const cacheModule = new URL('../verification/cache.mjs', import.meta.url).href;
  const processModule = new URL('../verification/process.mjs', import.meta.url).href;
  const command = `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(started)}, 'started'); await new Promise(resolve => setTimeout(resolve, 400)); await writeFile(${JSON.stringify(completed)}, 'completed');`;
  const source = `import { withLock } from ${JSON.stringify(cacheModule)}; import { run } from ${JSON.stringify(processModule)}; await withLock(${JSON.stringify(lock)}, () => run(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(command)}]));`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  while (!await fs.access(started).then(() => true).catch(() => false)) await new Promise(resolve => setTimeout(resolve, 10));
  const exited = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await exited;
  await withLock(lock, async () => assert.equal(await fs.readFile(completed, 'utf8'), 'completed'));
});

test('desktop packaging and production import graph use the staged native bundle', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const packageScript = await fs.readFile(path.join(root, 'tools/verification/desktop-package.mjs'), 'utf8');
  // An explicit native bundle is the only extraResource source. It is staged,
  // validated and hash-checked rather than discovered from PATH.
  assert.match(packageScript, /stageNativeBundle/);
  assert.match(packageScript, /verifyPackagedNativeBundle/);
  assert.match(packageScript, /extraResource[\s\S]*staged\.extraResource/);
  const buildScript = await fs.readFile(path.join(root, 'tools/verification/build.mjs'), 'utf8');
  assert.match(buildScript, /build\/verification-native-mode-\$\{platform\}-\$\{arch\}\.json/);
  assert.match(buildScript, /resolveNativeBundleRequest/);
  for (const file of ['main.ts', 'runtime-worker.ts', 'worker-runtime.ts', 'runtime.ts', 'prepared-artifact.ts']) {
    const source = await fs.readFile(path.join(root, 'apps/desktop/src', file), 'utf8');
    assert.doesNotMatch(source, /@codec-abx\/engine-native"/, `${file} must use the separate TypeScript export`);
  }
});


test('pipe lock holder retains the gate in a build after its launcher dies', { timeout: 15_000 }, async t => {
  const root = await fixture(t);
  const endpoint = WINDOWS ? `\\\\.\\pipe\\${lockResourceName(path.join(root, 'gate'), 'win32')}` : path.join(root, 'gate.sock');
  const started = path.join(root, 'started');
  const completed = path.join(root, 'completed');
  const module = new URL('../verification/cache.mjs', import.meta.url).href;
  const command = `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(started)}, 'started'); await new Promise(resolve => setTimeout(resolve, 600)); await writeFile(${JSON.stringify(completed)}, 'completed');`;
  // A detached fixture survives Windows' parent-owned libuv job, so the test
  // actually proves lock retention while an orphaned command keeps writing.
  const source = `import { acquirePipeLock } from ${JSON.stringify(module)}; import { spawn } from 'node:child_process'; const lock = await acquirePipeLock(${JSON.stringify(endpoint)}); const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(command)}], { stdio: ['ignore', 'ignore', 'ignore', lock.writer], detached: true }); await new Promise(resolve => child.once('close', resolve)); await lock.release();`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  while (!await fs.access(started).then(() => true, () => false)) {
    if (owner.exitCode !== null) throw new Error('Fixture launcher failed before starting its build');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const exited = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await exited;
  const next = await acquirePipeLock(endpoint);
  try { assert.equal(await fs.readFile(completed, 'utf8'), 'completed'); }
  finally { await next.release(); }
});

// Windows can keep a child's stdout handle open after stdout.end(). Reproduce
// that behavior on every host; readiness must not depend on handle closure.
test('pipe lock readiness is a line message while helper stdout remains open', async t => {
  const directory = await fixture(t);
  const preload = path.join(directory, 'keep-stdout-open.mjs');
  await fs.writeFile(preload, `if (process.argv[1]?.endsWith('pipe-lock-holder.mjs')) process.stdout.end = message => process.stdout.write(message);`);
  const endpoint = WINDOWS ? `\\\\.\\pipe\\${lockResourceName(path.join(directory, 'gate'), 'win32')}` : path.join(directory, 'gate.sock');
  const module = new URL('../verification/cache.mjs', import.meta.url).href;
  const source = `import { acquirePipeLock } from ${JSON.stringify(module)}; const lock = await acquirePipeLock(${JSON.stringify(endpoint)}); console.log('acquired'); await lock.release();`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(preload).href)}` },
    timeout: 4000,
  });
  assert.match(stdout, /acquired/);
});
