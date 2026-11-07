// Builds the website demo: compiles the existing apps/client source through the
// same apps/client/vite.config.ts under base "/demo/" into website/dist/demo.
//
// Contract:
// - No application component is copied or reimplemented; the demo is the real
//   client bundle served from a subpath, with Vite's publicDir mechanism
//   carrying the codec runtime assets. The shared tool
//   tools/copy-wasm-assets.mjs reconciles those assets first, under the same
//   verification lock as every other owned build, so supplemental LC3/LDAC
//   pairs stay version-consistent.
// - The default client/desktop builds are unchanged: apps/client/vite.config.ts
//   keeps base "/" and outDir "dist" unless CODEC_ABX_WEBSITE_DEMO_BASE and
//   CODEC_ABX_WEBSITE_DEMO_OUT_DIR are set, and only this script's Vite child
//   receives those variables. The shared build/verification-cache stamps keep
//   their identities; this build adds the separate "website-demo" stamp.
// - Only the compiled demo index.html receives a noindex robots meta. The
//   source app HTML and the desktop/production client output stay indexable.
// - website/dist/release.json binds the served demo to the app version and the
//   git commit it was compiled from, reporting a dirty worktree honestly
//   instead of pretending to be reproducible. The version/git snapshot is a
//   fingerprinted build input, so moving HEAD or dirtying sources forces
//   release.json to be regenerated with the artifact it describes.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedBuild, currentLockDescriptor, withLock } from '../../tools/verification/cache.mjs';
import { cancellation, run } from '../../tools/verification/process.mjs';
import { copyWasmAssets } from '../../tools/copy-wasm-assets.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const websiteDemoBase = '/demo/';
const lockPath = path.join(root, 'build/verification.lock');
const gitSnapshotEntry = 'build/verification-demo-git.json';
const noindexMeta = '<meta name="robots" content="noindex">';

// Installed tool versions that actually produce the demo bundle or its runtime
// assets. A partial or mismatched install must not reuse another install's demo.
const dependencyManifests = ['vite', 'esbuild', 'react', 'react-dom', '@ffmpeg/core', '@ffmpeg/ffmpeg']
  .map(name => `node_modules/${name}/package.json`);

// Honest source provenance: the commit plus two separate dirt observations.
// Concurrent website content edits make the whole worktree dirty; they must
// not mask whether the app sources that compile into the demo match HEAD.
export function gitProvenance(repository = root) {
  const git = args => {
    try {
      return execFileSync('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    } catch { return null; }
  };
  const commit = git(['rev-parse', 'HEAD'])?.trim() ?? null;
  if (commit === null) return { commit: null, dirty: null, appSourcesDirty: null };
  const status = paths => (git(['status', '--porcelain', ...paths]) ?? '').trim() !== '';
  return {
    commit,
    dirty: status([]),
    appSourcesDirty: status(['--', 'apps/client', 'packages', 'package.json', 'package-lock.json', 'tsconfig.json']),
  };
}

export function releaseDocument({ version, base, commit, dirty, appSourcesDirty }) {
  return { schema: 'codec-abx-website-release-v1', version, commit, dirty, appSourcesDirty, base };
}

// Demo-output-only robots policy. A pre-existing robots meta is respected when
// it already forbids indexing and refused otherwise, rather than silently
// rewriting a policy this script does not own.
export function withNoindex(html) {
  const robots = html.match(/<meta\s[^>]*name=["']robots["'][^>]*>/i);
  if (robots) {
    if (/noindex/i.test(robots[0])) return html;
    throw new Error('The demo HTML already declares a robots meta without noindex; refusing to overwrite it');
  }
  const head = html.match(/<head[^>]*>/i);
  if (!head) throw new Error('The demo HTML has no <head> to receive the noindex meta');
  return `${html.slice(0, head.index + head[0].length)}\n    ${noindexMeta}${html.slice(head.index + head[0].length)}`;
}

function assertDistinctFromSharedArtifacts(outDir) {
  // The demo compiles from source into its own tree. Any overlap with the
  // shared client/desktop artifact outputs would corrupt their stamped bytes;
  // an outDir equal to or above the repository root catches those too.
  for (const shared of [path.join(root, 'apps/client/dist'), path.join(root, 'apps/desktop/dist')]) {
    for (const relative of [path.relative(outDir, shared), path.relative(shared, outDir)]) {
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
        throw new Error(`Website demo output ${outDir} must not overlap the shared artifact ${shared}`);
    }
  }
}

export async function buildDemo({
  base = websiteDemoBase,
  outDir = path.join(root, 'website/dist/demo'),
  releasePath = path.join(root, 'website/dist/release.json'),
  stampName = 'website-demo',
  stampDirectory = 'build/verification-cache',
  lock = lockPath,
  signal = cancellation.signal,
  lockHeld = false,
} = {}) {
  if (lockHeld && currentLockDescriptor() === undefined) throw new Error('lockHeld requires the owning verification lock');
  const absoluteOut = path.resolve(outDir);
  const absoluteRelease = path.resolve(releasePath);
  assertDistinctFromSharedArtifacts(absoluteOut);
  const outputs = [
    path.relative(root, absoluteOut),
    path.join(path.relative(root, absoluteOut), 'index.html'),
    path.relative(root, absoluteRelease),
  ];
  const inputs = [
    'package.json', 'package-lock.json', 'tsconfig.json', 'node_modules/.package-lock.json',
    ...dependencyManifests, 'apps/client', 'packages', 'website/scripts/build-demo.mjs', gitSnapshotEntry,
  ];
  const action = async () => {
    const snapshot = {
      base,
      version: JSON.parse(await fs.readFile(path.join(root, 'apps/client/package.json'), 'utf8')).version,
      ...gitProvenance(),
    };
    // cachedBuild refuses actions that rewrite their own inputs, so the
    // snapshot release.json will describe is written here: inside the shared
    // verification lock (so concurrent owners cannot race it) but before
    // cachedBuild fingerprints it.
    await fs.mkdir(path.join(root, path.dirname(gitSnapshotEntry)), { recursive: true });
    await fs.writeFile(path.join(root, gitSnapshotEntry), JSON.stringify(snapshot));
    await copyWasmAssets();
    const built = await cachedBuild({ signal, root, name: stampName, stampDirectory, inputs, outputs,
      action: async () => {
        // The same configuration and invocation as the shared client stage, so
        // the demo compiles the real app; only env-supplied base/outDir differ.
        await run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/client/vite.config.ts'], {
          cwd: root,
          env: { ...process.env, CODEC_ABX_WEBSITE_DEMO_BASE: base, CODEC_ABX_WEBSITE_DEMO_OUT_DIR: absoluteOut },
        });
        const htmlPath = path.join(absoluteOut, 'index.html');
        await fs.writeFile(htmlPath, withNoindex(await fs.readFile(htmlPath, 'utf8')));
        await fs.mkdir(path.dirname(absoluteRelease), { recursive: true });
        await fs.writeFile(absoluteRelease, `${JSON.stringify(releaseDocument(snapshot), null, 2)}\n`);
      } });
    return { built, snapshot };
  };
  const result = await (lockHeld ? action() : withLock(lock, action, { signal }));
  return { ...result, outDir: absoluteOut, releasePath: absoluteRelease };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { built, outDir, releasePath, snapshot } = await buildDemo();
  console.log(`[website-demo] ${built ? 'built' : 'cache verified'} ${path.relative(root, outDir)} from ${path.join('apps', 'client')}`);
  console.log(`[website-demo] release metadata: ${path.relative(root, releasePath)} (version ${snapshot.version})`);
  if (snapshot.commit === null)
    console.error('[website-demo] warning: git provenance is unavailable; release.json records commit null');
  else if (snapshot.dirty)
    console.error(`[website-demo] warning: worktree is dirty (compiled app sources ${snapshot.appSourcesDirty ? 'are dirty' : 'match HEAD'}); commit the final source before deploying`);
}
