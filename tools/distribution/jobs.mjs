import { availableParallelism } from 'node:os';

/** Per release process, not a global budget across simultaneous builds. */
export function packageJobs(requested = process.env.AUDIVANE_PACKAGE_JOBS) {
  if (requested !== undefined) {
    if (!/^[1-9]\d*$/.test(String(requested)) || Number(requested) > 32) {
      throw new Error('AUDIVANE_PACKAGE_JOBS/--jobs must be an integer between 1 and 32');
    }
    return Number(requested);
  }
  const memory = process.availableMemory();
  return Math.max(1, Math.min(16, availableParallelism() - 2, Math.floor(memory / (512 * 1024 * 1024))));
}
