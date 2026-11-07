import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withLock } from '../verification/cache.mjs';
import { root } from './config.mjs';

/** Capture shared build outputs under their gate, compress only private copies,
 * then publish under the gate. Same-format jobs serialize; other formats overlap.
 * Keep the lock order format -> shared everywhere, including failed jobs.
 */
export async function withReleaseWorkspace(platform, { capture, build, publish,
  sharedLock = path.join(root, 'build/verification.lock'),
  workspaceRoot = path.join(root, 'build/release-work'), signal } = {}) {
  if (!['linux', 'arch', 'win32'].includes(platform)) throw new Error('Unknown release workspace platform');
  return withLock(path.join(workspaceRoot, `${platform}.lock`), async () => {
    const workspace = await fs.mkdtemp(path.join(workspaceRoot, `${platform}-`));
    try {
      const snapshot = await withLock(sharedLock, () => capture(workspace), { signal });
      signal?.throwIfAborted();
      const built = await build(snapshot, workspace);
      signal?.throwIfAborted();
      return await withLock(sharedLock, () => publish(built, snapshot, workspace), { signal });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, { signal });
}
