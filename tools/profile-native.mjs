import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'codec-abx-profile-build-'));
try {
  for (const [entry, filename, format] of [['apps/desktop/src/runtime-worker.ts', 'runtime-worker.cjs', 'cjs'], ['tools/profile-native.ts', 'profile.mjs', 'esm']]) {
    await build({ entryPoints: [path.join(root, entry)], outfile: path.join(output, filename), bundle: true, platform: 'node', format, target: 'node24', ...(format === 'cjs' ? { define: { 'import.meta.url': '__workerBundleUrl' }, banner: { js: 'const __workerBundleUrl = require("node:url").pathToFileURL(__filename).href;' } } : {}) });
  }
  const child = spawn(process.execPath, [path.join(output, 'profile.mjs'), '--run', process.argv[2] ?? 'worker', process.argv[3] ?? '10', root, path.join(output, 'runtime-worker.cjs')], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  process.exitCode = code ?? 1;
} finally { await fs.rm(output, { recursive: true, force: true }); }
