import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function bundleDesktop() {
const output = path.join(root, 'apps/desktop/dist');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const entry of ['main', 'preload', 'runtime-worker']) await build({ entryPoints: [path.join(root, `apps/desktop/src/${entry}.ts`)], outfile: path.join(output, `${entry}.cjs`), bundle: true, platform: 'node', format: 'cjs', target: 'node24', ...(entry !== 'preload' ? { define: { 'import.meta.url': '__desktopBundleUrl' }, banner: { js: 'const __desktopBundleUrl = require("node:url").pathToFileURL(__filename).href;' } } : {}), external: ['electron'], sourcemap: true, logLevel: 'info' });
await fs.cp(path.join(root, 'apps/client/dist'), path.join(output, 'client'), { recursive: true });
// Desktop execution is native: the browser engine and its FFmpeg/LC3/LDAC
// WebAssembly modules are unreachable in this runtime. Keeping those assets
// would ship an unused GPL/WASM payload. The browser build keeps them.
await fs.rm(path.join(output, 'client/codec-assets'), { recursive: true, force: true });

}