import path from 'node:path';
import { buildArtifacts, root } from './verification/build.mjs';
import { run } from './verification/process.mjs';
const mode = process.argv[2];
if (!['quick', 'full', 'production'].includes(mode)) throw new Error('Expected explicit verification mode: quick, full or production');
const full = mode === 'full';
const production = mode === 'production';
const node = (file, args = []) => run(process.execPath, [path.join(root, file), ...args], { cwd: root });
const typecheck = () => node('node_modules/typescript/bin/tsc', ['--noEmit']);
if (production) {
  if (process.argv.length > 3) throw new Error('verify:production does not accept filters; use the scoped production test commands');
  console.log('[verification] PRODUCTION scope: strict typecheck then the explicit TypeScript/native/desktop/tooling unit selection, production browser files and audited packaged Electron acceptance. The full development commands run the complete unit and browser selections.');
  await typecheck();
  await node('tools/test-production.mjs');
} else if (!full) {
  console.log('[verification] QUICK scope: strict typecheck + unit tests only. Browser, packaged Electron and performance require verify:full or their explicit commands.');
  const results = await Promise.allSettled([typecheck(), node('tools/test-unit.mjs', process.argv.slice(3))]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
} else {
  if (process.argv.length > 3) throw new Error('verify:full does not accept filters; use the scoped test commands');
  console.log('[verification] FULL scope: builds; concurrent typecheck/unit/browser; packaged Electron functional; serial Electron and browser performance. Tests always execute.');
  await buildArtifacts('package');
  const results = await Promise.allSettled([
    typecheck(), node('tools/test-unit.mjs'), node('tools/test-browser.mjs'),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  await node('tools/test-desktop.mjs');
  await node('tools/test-desktop.mjs', ['--performance']);
  await node('tools/profile-browser-isolated.mjs');
}
