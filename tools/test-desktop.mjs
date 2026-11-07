import path from 'node:path';
import { existsSync } from 'node:fs';
import { createSession } from './verification/session.mjs';
import { ensureArtifacts, root, lockPath } from './verification/build.mjs';
import { withLock } from './verification/cache.mjs';
import { run, cancellation } from './verification/process.mjs';
const args = process.argv.slice(2);
const performance = args[0] === '--performance';
if (performance) args.shift();
const windows = process.platform === 'win32';
const buildPlatform = windows ? 'win32' : 'linux';
const installedExecutable = process.env.CODEC_ABX_PACKAGED_EXECUTABLE;
await withLock(lockPath, async () => {
  // An installed package is launched directly. Otherwise Linux runs the
  // packaged unpacked build; Windows functional checks use the development
  // entry point until the installer acceptance job supplies an installed path.
  await ensureArtifacts(performance || windows || installedExecutable ? 'desktop' : 'package', { platform: buildPlatform });
  const report = await createSession(root, performance ? 'desktop-performance' : 'desktop');
  const libraries = path.join(root, 'build/desktop-host-libs/root/usr/lib/x86_64-linux-gnu');
  const env = { ...process.env, CODEC_ABX_REPORT_DIR: report, CODEC_ABX_DESKTOP_PERFORMANCE: performance ? '1' : '0' };
  if (!windows && existsSync(libraries)) env.LD_LIBRARY_PATH = libraries + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
  const command = windows || process.env.DISPLAY ? process.execPath : 'xvfb-run';
  const launcher = process.env.DISPLAY || windows ? [] : ['-a', process.execPath];
  // The packaged case is platform-parametric. Without an installed executable
  // on Windows there is no PE package to test, so exclude it; with
  // CODEC_ABX_PACKAGED_EXECUTABLE it must run against the real installed tree.
  const platformFilters = windows && !performance && !installedExecutable
    ? ['--grep-invert', 'packaged Audivane'] : [];
  console.log(`[verification] desktop ${performance ? 'PERFORMANCE ONLY, serial' : 'FUNCTIONAL ONLY, serial; performance is test:performance'} scope: ${args.length ? args.join(' ') : 'ALL tests in this phase'}; reports: ${report}`);
  if (installedExecutable) console.log(`[verification] packaged acceptance executable: ${installedExecutable}`);
  else if (windows) console.log('[verification] Windows runs the development app only; set CODEC_ABX_PACKAGED_EXECUTABLE for installed/portable acceptance');
  await run(command, [...launcher, path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(root, 'apps/desktop/playwright.config.ts'), ...platformFilters, ...args], { cwd: root, env });
}, { signal: cancellation.signal });
