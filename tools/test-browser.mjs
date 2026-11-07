import { createServer, preview } from 'vite';
import { createSession, loopbackURL } from './verification/session.mjs';
import path from 'node:path';
import { withLock } from './verification/cache.mjs';
import { ensureArtifacts, root, lockPath } from './verification/build.mjs';
import { run, cancellation } from './verification/process.mjs';

// Hold the shared-output lock until both owned servers and all workers stop.
// This intentionally queues other build/browser/desktop sessions while serving
// checkout assets; it never attaches to a user's development server.
await withLock(lockPath, async () => {
  await ensureArtifacts('client');
  const report = await createSession(root, 'browser');
  let dev;
  let production;
  try {
    dev = await createServer({ configFile: path.join(root, 'apps/client/vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
      cacheDir: path.join(report, 'vite-cache') });
    await dev.listen();
    production = await preview({ configFile: path.join(root, 'apps/client/vite.config.ts'),
      preview: { host: '127.0.0.1', port: 0, strictPort: false } });
    const args = process.argv.slice(2);
    console.log(`[verification] browser scope: ${args.length ? args.join(' ') : 'ALL dev + production tests'}; reports: ${report}`);
    await run(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...args], {
      cwd: root, env: { ...process.env, CODEC_ABX_DEV_URL: loopbackURL(dev.httpServer), CODEC_ABX_PREVIEW_URL: loopbackURL(production.httpServer), CODEC_ABX_REPORT_DIR: report },
    });
  } finally {
    const closed = await Promise.allSettled([dev?.close(), production?.close()]);
    const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned Vite server cleanup failed');
  }
}, { signal: cancellation.signal });
