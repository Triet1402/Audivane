import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
const lockContext = new AsyncLocalStorage();
export const currentLockDescriptor = () => lockContext.getStore();
const WINDOWS = process.platform === 'win32';
const WINDOWS_LOCK_RETRY_MS = 100;

const ignored = new Set(['node_modules', 'dist', '.vite', '.git']);
export async function fingerprint(root, entries, { missing = false, ignore = ignored } = {}) {
  const hash = createHash('sha256');
  async function visit(relative, ancestors = new Set()) {
    // Release inputs such as an explicitly supplied native bundle may live
    // outside the repository. Their absolute spelling is part of the stamp.
    const absolute = path.isAbsolute(relative) ? relative : path.join(root, relative);
    const stat = await fs.lstat(absolute).catch(error => {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) { hash.update(`missing:${relative}\0`); return; }
    hash.update(`${relative}\0${stat.mode & 0o777}\0${stat.isFile() ? `file:${stat.size}` : stat.isDirectory() ? 'directory' : 'link'}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${await fs.readlink(absolute)}\0`);
      // The build consumes the target's bytes, not just the link's spelling.
      const target = await fs.realpath(absolute);
      await visit(path.isAbsolute(relative) ? target : path.relative(root, target), ancestors);
      return;
    }
    if (stat.isDirectory()) {
      const real = await fs.realpath(absolute);
      if (ancestors.has(real)) throw new Error(`Cyclic build directory: ${relative}`);
      const nested = new Set(ancestors).add(real);
      for (const name of (await fs.readdir(absolute)).sort()) {
        if (!ignore.has(name)) await visit(path.join(relative, name), nested);
      }
    } else if (stat.isFile()) {
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      hash.update('\0');
    } else throw new Error(`Unsupported build input: ${absolute}`);
  }
  for (const entry of [...entries].sort()) await visit(entry);
  return hash.digest('hex');
}

// The caller owns the build lock. Stamps record artifacts, never test results.
export async function cachedBuild({ root, name, inputs, completeInputs = [], outputs, action, stampDirectory = 'build/verification-cache', signal }) {
  signal?.throwIfAborted();
  const stamp = path.join(root, stampDirectory, `${name}.json`);
  const inputFingerprint = async () => createHash('sha256')
    .update(await fingerprint(root, inputs, { missing: true }))
    .update(await fingerprint(root, completeInputs, { missing: true, ignore: new Set() }))
    .digest('hex');
  const inputHash = await inputFingerprint();
  const previous = await fs.readFile(stamp, 'utf8').then(JSON.parse).catch(() => null);
  const outputHash = await fingerprint(root, outputs, { ignore: new Set() }).catch(() => null);
  if (previous?.inputHash === inputHash && outputHash && previous.outputHash === outputHash) {
    console.log(`[build] ${name}: verified cache hit`);
    return false;
  }
  await fs.rm(stamp, { force: true });
  console.log(`[build] ${name}: rebuilding`);
  await action();
  signal?.throwIfAborted();
  if (await inputFingerprint() !== inputHash) throw new Error(`${name}: source changed during build; rerun to verify a consistent build`);
  const builtHash = await fingerprint(root, outputs, { ignore: new Set() });
  await fs.mkdir(path.dirname(stamp), { recursive: true });
  const temporary = `${stamp}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ inputHash, outputHash: builtHash }));
    signal?.throwIfAborted();
    await fs.rename(temporary, stamp);
    if (signal?.aborted) { await fs.rm(stamp, { force: true }); signal.throwIfAborted(); }
  } finally { await fs.rm(temporary, { force: true }); }
  return true;
}

// A distinct kernel-owned lock name per output path. Windows paths are
// case-insensitive, so the digest folds case there and nowhere else. Hashing
// keeps spaces and non-ASCII checkout paths out of platform object names.
export function lockResourceName(filename, platform = process.platform) {
  const absolute = path.resolve(filename);
  const key = platform === 'win32' ? absolute.toLowerCase() : absolute;
  return `codec-abx-verification-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// A kernel pipe endpoint serializes Windows owners. A separate helper holds
// the endpoint until its stdin reaches EOF. Commands inherit the writer as fd 3,
// so a killed launcher cannot release the gate while its build still writes.
// Exported for the same lifetime test using a Unix socket on non-Windows hosts.
export async function acquirePipeLock(endpoint, signal) {
  for (;;) {
    signal?.throwIfAborted();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./pipe-lock-holder.mjs', import.meta.url)), endpoint], {
      stdio: ['pipe', 'pipe', 'inherit'], detached: true, windowsHide: true,
    });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    // Register rejection handling immediately, before the readiness handshake.
    void completion.catch(() => undefined);
    child.stdin.on('error', () => undefined);
    // Read the newline-delimited message, not stdout EOF: on Windows the
    // helper's stdout handle can remain open for the lifetime of the lock.
    const ready = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      child.once('error', reject);
      child.stdout.once('error', reject);
      lines.once('line', line => {
        try { resolve(JSON.parse(line)); } catch { reject(new Error('Lock holder sent an invalid readiness handshake')); }
        lines.close();
      });
      lines.once('close', () => reject(new Error('Lock holder exited without a valid readiness handshake')));
    }).catch(async error => {
      child.stdin.end();
      await completion.catch(() => undefined);
      throw error;
    });
    if (ready.ready === true) {
      return {
        writer: child.stdin,
        async release() {
          child.stdin.end();
          const code = await completion;
          if (code !== 0) throw new Error(`Verification lock holder exited ${code}`);
        },
      };
    }
    child.stdin.end();
    await completion;
    if (ready.error !== 'EADDRINUSE') throw new Error(`Unable to acquire verification lock: ${ready.error}`);
    await waitForRetry(WINDOWS_LOCK_RETRY_MS, signal);
  }
}

// Linux flock locks the open file description inherited as fd 3. The parent
// retains that description for the action; closing it (including process death)
// releases the kernel lock. No stale PID files or timeout-based eviction.
// Windows retains a writer handle in owned commands via the pipe holder above.
export async function withLock(filename, action, { signal } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  signal?.throwIfAborted();
  if (WINDOWS) {
    console.log(`[verification] acquiring shared output lock: ${filename}`);
    const endpoint = `\\\\.\\pipe\\${lockResourceName(filename, 'win32')}`;
    const holder = await acquirePipeLock(endpoint, signal);
    try {
      signal?.throwIfAborted();
      return await lockContext.run(holder.writer, action);
    } finally { await holder.release(); }
  }
  const handle = await fs.open(filename, 'a+');
  try {
    signal?.throwIfAborted();
    console.log(`[verification] acquiring shared output lock: ${filename}`);
    await new Promise((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '3'], { stdio: ['ignore', 'inherit', 'inherit', handle.fd], ...(signal ? { signal } : {}) });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`flock exited ${code}; Linux util-linux flock is required`)));
    });
    signal?.throwIfAborted();
    return await lockContext.run(handle.fd, action);
  } finally { await handle.close(); }
}
