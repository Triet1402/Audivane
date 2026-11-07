import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { packageJobs } from './jobs.mjs';

/** Bounded CPU workers return entries in source order regardless of completion. */
export async function compressZipEntries(directory, files, { jobs, signal } = {}) {
  const count = Math.min(packageJobs(jobs), files.length);
  signal?.throwIfAborted();
  if (count === 0) return [];
  const workers = [];
  const entries = new Array(files.length);
  let next = 0;
  let completed = 0;
  let stopped = false;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      const fail = error => { if (!stopped) { stopped = true; reject(error); } };
      abort = () => fail(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const dispatch = worker => {
        if (stopped || next === files.length) return;
        const index = next++;
        worker.currentIndex = index;
        worker.postMessage({ index, filename: path.join(directory, files[index]) });
      };
      for (let index = 0; index < count; index++) {
        const worker = new Worker(new URL('./zip-entry-worker.mjs', import.meta.url), {
          // Pure ESM workers need no parent loader, inspector or test flags.
          execArgv: [],
        });
        workers.push(worker);
        worker.on('error', fail);
        worker.on('exit', code => {
          if (!stopped) fail(new Error(`ZIP compression worker exited unexpectedly (${code})`));
        });
        worker.on('message', entry => {
          if (stopped) return;
          if (entry.index !== worker.currentIndex) { fail(new Error('ZIP worker returned an unexpected entry')); return; }
          if (entry.error) { fail(new Error(`ZIP ${files[entry.index]}: ${entry.error}`)); return; }
          entries[entry.index] = { ...entry, data: Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength) };
          completed++;
          if (completed === files.length) { stopped = true; resolve(entries); }
          else dispatch(worker);
        });
        dispatch(worker);
      }
    });
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
}
