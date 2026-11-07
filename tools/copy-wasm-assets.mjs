import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Directory overrides exist only so tests can reconcile disposable temporary
// trees; production callers always use the repository layout.
export async function copyWasmAssets({
  coreSourceDir = path.join(root, 'node_modules/@ffmpeg/core/dist/esm'),
  supplementalDir = path.join(root, 'third_party/wasm/bin'),
  targetDir = path.join(root, 'apps/client/public/codec-assets'),
} = {}) {
  await mkdir(targetDir, { recursive: true });
  for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    const source = path.join(coreSourceDir, name);
    const target = path.join(targetDir, name);
    const bytes = await readFile(source).catch(() => { throw new Error(`Missing ${source}. Run npm install; browser runtime assets must be local.`); });
    const targetBytes = await readFile(target).catch(() => null);
    if (targetBytes && digest(bytes) === digest(targetBytes)) {
      console.log(`codec-assets: ${name} is current (${bytes.length} bytes)`);
    } else {
      await copyFile(source, target);
      console.log(`codec-assets: copied ${name} (${bytes.length} bytes)`);
    }
  }
  // Supplemental LC3/LDAC codecs are optional pinned WASM builds produced by
  // tools/build_codec_wasm.sh into third_party/wasm/bin. Absence (or an
  // incomplete build) still must not fail the build: the client always
  // configures the supplemental URLs, and the engine honestly reports those
  // codecs as unconfigured when the asset cannot be validated. But a missing
  // source is not neutral: each module is one version-paired js/wasm unit, so
  // a previously copied public asset is stale once its build disappears, and
  // a partial rebuild would otherwise mix a new glue file with an old module
  // half (or the reverse). Each codec's public pair is therefore reconciled as
  // a unit: the build's last-written SHA-256 manifest binds both source files.
  // Missing files or a missing/mismatched manifest remove both public copies,
  // including after an interrupted install that left both halves present.
  const pairs = [
    ['lc3', ['lc3_codec.js', 'lc3_codec.wasm']],
    ['ldac', ['ldac_codec.js', 'ldac_codec.wasm']],
  ];
  for (const [codec, files] of pairs) {
    const sources = await Promise.all(files.map(name => readFile(path.join(supplementalDir, name)).catch(() => null)));
    const missing = files.filter((_, index) => sources[index] === null);
    const manifest = await readFile(path.join(supplementalDir, `${codec}_codec.sha256`), 'utf8').catch(() => null);
    const expectedManifest = missing.length === 0
      ? files.map((name, index) => `${digest(sources[index])}  ${name}\n`).join('')
      : null;
    if (missing.length > 0 || manifest === null || manifest !== expectedManifest) {
      const state = missing.length === 0
        ? 'unverified (missing or mismatched pair manifest)'
        : missing.length === files.length
        ? 'not present'
        : `incomplete (no ${missing.join(', ')})`;
      for (const name of files) {
        await rm(path.join(targetDir, name), { force: true });
      }
      console.log(`codec-assets: optional ${codec} public pair absent; supplemental build ${state}`);
      continue;
    }
    for (const [index, name] of files.entries()) {
      const target = path.join(targetDir, name);
      const targetBytes = await readFile(target).catch(() => null);
      if (targetBytes && digest(sources[index]) === digest(targetBytes)) {
        console.log(`codec-assets: supplemental ${name} is current (${sources[index].length} bytes)`);
      } else {
        // Publish the bytes that were hashed, not a second read of a source
        // path that might have changed since validation.
        await writeFile(target, sources[index]);
        console.log(`codec-assets: copied supplemental ${name} (${sources[index].length} bytes)`);
      }
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withLock } = await import('./verification/cache.mjs');
  const { cancellation } = await import('./verification/process.mjs');
  await withLock(path.join(root, 'build/verification.lock'), copyWasmAssets, { signal: cancellation.signal });
}
