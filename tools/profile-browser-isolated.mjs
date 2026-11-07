import path from 'node:path';
import { createSession } from './verification/session.mjs';
import { ensureArtifacts, root, lockPath } from './verification/build.mjs';
import { withLock } from './verification/cache.mjs';
import { run, cancellation } from './verification/process.mjs';
await withLock(lockPath, async () => {
  await ensureArtifacts('client');
  const report = await createSession(root, 'browser-performance');
  console.log(`[verification] serial browser PERFORMANCE ONLY; reports: ${report}`);
  await run(process.execPath, [path.join(root, 'tools/profile-browser.mjs'), ...process.argv.slice(2)], {
    cwd: root, env: { ...process.env, CODEC_ABX_BROWSER_PROFILE_DIR: report },
  });
}, { signal: cancellation.signal });
