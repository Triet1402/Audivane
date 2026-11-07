import { spawn } from 'node:child_process';
import { currentLockDescriptor } from './cache.mjs';
import { taskkillExecutable } from './windows.mjs';

const WINDOWS = process.platform === 'win32';

export const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cancellation.abort(new Error(`Verification interrupted by ${signal}`));
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
});

// Node has no process-group signal on Windows. taskkill /T walks the
// parent-child tree; /F is the SIGKILL equivalent. Exit 128 means the process
// is already gone, which is a successful cleanup. The returned promise resolves
// only after taskkill itself has finished so a release cannot race the
// descendant teardown.
function terminateWindowsTree(pid, signal, errors) {
  return new Promise(resolve => {
    let killer;
    try {
      killer = spawn(taskkillExecutable(), ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
        stdio: 'ignore', windowsHide: true,
      });
    } catch (error) { errors.push(new Error(`taskkill ${signal} failed: ${error.message}`)); resolve(); return; }
    const timeout = setTimeout(() => {
      try { killer.kill(); } catch { /* command already gone */ }
      errors.push(new Error(`taskkill ${signal} timed out; descendant cleanup is unconfirmed`));
      resolve();
    }, 5000);
    killer.once('error', error => { clearTimeout(timeout); errors.push(new Error(`taskkill ${signal} failed: ${error.message}`)); resolve(); });
    killer.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 && code !== 128) errors.push(new Error(`taskkill ${signal} exited ${code}`));
      resolve();
    });
  });
}

function terminateTree(child, signal, errors) {
  if (child.pid === undefined) return Promise.resolve();
  if (WINDOWS) return terminateWindowsTree(child.pid, signal, errors);
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') errors.push(error); }
  return Promise.resolve();
}

export function run(command, args, options = {}) {
  cancellation.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const descriptor = currentLockDescriptor();
    // Retain the kernel lock in an owned command if its launcher is killed.
    const stdio = descriptor === undefined ? 'inherit' : ['inherit', 'inherit', 'inherit', descriptor];
    const child = spawn(command, args, { stdio, ...options, detached: !WINDOWS });
    const errors = [];
    const pending = new Set();
    let timer;
    let aborting = false;
    const kill = signal => {
      const done = terminateTree(child, signal, errors);
      pending.add(done);
      void done.finally(() => pending.delete(done)).catch(() => undefined);
    };
    const abort = () => {
      if (aborting) return;
      aborting = true;
      kill('SIGTERM');
      timer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    cancellation.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); cancellation.signal.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', async (code, signal) => {
      cleanup();
      // Windows descendant termination is asynchronous; do not report the
      // command closed until taskkill has observed the whole tree.
      await Promise.allSettled([...pending]);
      if (errors.length) reject(new AggregateError(errors, `${command} exited ${code ?? signal}; cleanup failed`));
      else if (code === 0 && !aborting) resolve();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}
