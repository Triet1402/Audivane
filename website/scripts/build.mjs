import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock } from '../../tools/verification/cache.mjs';
import { cancellation, run } from '../../tools/verification/process.mjs';
import { buildDemo } from './build-demo.mjs';

const website = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(website, '..');
// Own the entire combined output: Astro clears dist before the real client is
// built below it. Browser checks and other builds must never see that interval.
await withLock(path.join(root, 'build/verification.lock'), async () => {
  await run(process.execPath, [path.join(website, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: website });
  await buildDemo({ lockHeld: true });
}, { signal: cancellation.signal });
