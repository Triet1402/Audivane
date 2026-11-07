import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedBuild, withLock } from './cache.mjs';
import { run, cancellation } from './process.mjs';
import { copyWasmAssets } from '../copy-wasm-assets.mjs';
import { bundleDesktop } from './desktop-build.mjs';
import { packageDesktop } from './desktop-package.mjs';
import { resolveWindowsProcessHost } from './process-host.mjs';
import { assertNativeBundleOutsideOutputs, desktopBuildOutputDirectories, resolveNativeBundleRequest } from './native-bundle.mjs';
import { normalizePlatform, unpackedDirectory, unpackedExecutable } from '../distribution/config.mjs';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const lockPath = path.join(root, 'build/verification.lock');
const common = ['package.json', 'package-lock.json', 'tsconfig.json', 'tools', 'node_modules/.package-lock.json'];
async function dependencyVersions() {
  // Include installed manifests as well as the lock: a partial/mismatched install
  // must not silently reuse artifacts from a different installed tool version.
  const names = ['vite', 'esbuild', 'electron', '@electron/packager', '@ffmpeg/core', '@ffmpeg/ffmpeg', 'react', 'react-dom'];
  return names.map(name => `node_modules/${name}/package.json`);
}
export async function ensureArtifacts(stage, options = {}) {
  if (!['client', 'desktop', 'package'].includes(stage)) throw new Error(`Unknown build stage ${stage}`);
  const platform = normalizePlatform(options.platform ?? 'linux');
  const arch = options.arch ?? 'x64';
  const nativeBundle = stage === 'package' ? (options.nativeBundle ?? resolveNativeBundleRequest()) : null;
  if (nativeBundle) await assertNativeBundleOutsideOutputs(nativeBundle, desktopBuildOutputDirectories(root));
  await copyWasmAssets();
  const base = [...common, ...await dependencyVersions()];
  // Host/ABI versions affect esbuild, Vite and the packaged Electron runtime.
  const versionPath = path.join(root, 'build/verification-versions.json');
  const { promises: fs } = await import('node:fs');
  await fs.mkdir(path.dirname(versionPath), { recursive: true });
  await fs.writeFile(versionPath, JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, versions: process.versions }));
  base.push('build/verification-versions.json');
  // Directory traversal includes new/deleted files; generated dist trees are
  // excluded. Public codec assets are actual build inputs.
  const clientInputs = [...base, 'apps/client', 'packages'];
  await cachedBuild({ signal: cancellation.signal, root, name: 'client', inputs: clientInputs, outputs: ['apps/client/dist', 'apps/client/dist/index.html'],
    action: () => run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/client/vite.config.ts'], { cwd: root }) });
  if (stage === 'client') return;
  await cachedBuild({ signal: cancellation.signal, root, name: 'desktop', inputs: [...base, 'apps/desktop/src', 'apps/desktop/package.json', 'packages', 'apps/client/dist'], outputs: ['apps/desktop/dist', 'apps/desktop/dist/main.cjs', 'apps/desktop/dist/preload.cjs', 'apps/desktop/dist/runtime-worker.cjs'], action: bundleDesktop });
  if (stage === 'desktop') return;
  // Packaging consumes only the compiled desktop bundle and explicit native
  // resources; no interpreter tree or alternate codec bridge is staged.
  // The explicit native bundle, when present, is a real package input: its path,
  // exact file bytes and executable modes invalidate reuse just like source.
  const nativeModeRelative = `build/verification-native-mode-${platform}-${arch}.json`;
  const nativeModePath = path.join(root, nativeModeRelative);
  await fs.writeFile(nativeModePath, JSON.stringify({
    schema: 'codec-abx-verification-native-mode-v2',
    mode: nativeBundle ? 'portable-native-bundle-v1' : 'external-native-tools-v1',
    platform,
    arch,
    requireNativeBundle: options.requireNativeBundle === true,
  }));
  const output = unpackedDirectory(platform);
  const executable = unpackedExecutable(platform);
  // The Windows Job Object host is an app-owned packaging input. Its exact
  // bytes invalidate a cached package even when the rest of the tree matches.
  const processHost = platform === 'win32' ? resolveWindowsProcessHost(root) : null;
  await cachedBuild({ signal: cancellation.signal, root, name: `package-${platform}-${arch}`, inputs: [...base, 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'packages/measurements/NOTICE.md', 'apps/desktop/dist', 'assets/brand/icons', nativeModeRelative], completeInputs: [...(nativeBundle ? [nativeBundle] : []), ...(processHost ? [processHost] : [])], outputs: [path.relative(root, output), path.relative(root, executable), path.relative(root, path.join(output, 'resources/app/dist/main.cjs')), path.relative(root, path.join(output, 'resources/distribution.json'))], action: () => packageDesktop({ nativeBundle, platform, arch, requireNativeBundle: options.requireNativeBundle === true }) });
}
export function buildArtifacts(stage, options = {}) {
  return withLock(lockPath, () => ensureArtifacts(stage, options), { signal: cancellation.signal });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildArtifacts(process.argv[2] ?? 'client');
