import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * P1 CI contract for the supplemental LC3/LDAC browser tier (see
 * docs/typescript-supplemental-codec-module.md): the mandatory, unfiltered
 * browser lane (browser-codecs) now asserts an eleven-codec build served from
 * the gitignored third_party/wasm/bin artifacts. This guards that CI
 * provisions the exact pinned builds BEFORE the mandatory browser tests, that
 * the cache key covers everything the build script implicitly reads, and that
 * the artifacts reach the served codec-assets directory through the normal
 * launcher flow.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

function job(name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${name}:`);
  assert.notEqual(start, -1, `CI job ${name} is missing`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start + 1, end).filter(line => !line.trimStart().startsWith('#')).join('\n');
}

const buildScript = readFileSync(path.join(root, 'tools/build_codec_wasm.sh'), 'utf8');
const copier = readFileSync(path.join(root, 'tools/copy-wasm-assets.mjs'), 'utf8');

test('browser-codecs provisions the pinned supplemental WASM build before test:browser', () => {
  const section = job('browser-codecs');
  assert.match(section, /npm run test:browser/, 'browser-codecs must run the mandatory browser lane');

  const build = section.indexOf('run: tools/build_codec_wasm.sh');
  assert.notEqual(build, -1, 'browser-codecs must build the pinned supplemental WASM codecs');
  // Provisioning must precede every mandatory lane that depends on the
  // artifacts: the package tests inside check:ts and the browser regression
  // suite that serves them.
  assert.ok(
    build < section.indexOf('npm run check:ts'),
    'supplemental builds must precede check:ts, whose package tests may run on the artifacts');
  assert.ok(
    build < section.indexOf('npm run test:browser'),
    'supplemental builds must precede the mandatory test:browser run');

  assert.doesNotMatch(section, /continue-on-error:/, 'provisioning must not be tolerable as optional');
  assert.match(section, /CODEC_WASM_BUILD_DIR:/, 'build intermediates must be cacheable');
  assert.match(section, /CODEC_WASM_EMSDK_DIR:/, 'emsdk must be cacheable without sudo');
  const declared = section.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(declared, 'browser-codecs must declare a timeout');
  assert.ok(Number(declared[1]) >= 60,
    'fresh-runner emsdk downloads need more room than the previous 15-minute timeout');
});

test('browser-codecs verifies a complete and real supplemental asset set before browser tests', () => {
  const section = job('browser-codecs');
  const verify = section.indexOf('Verify supplemental WASM assets before the mandatory browser tests');
  assert.notEqual(verify, -1, 'a verification step must gate the mandatory lanes');
  assert.ok(verify < section.indexOf('npm run test:browser'));
  for (const module of ['lc3', 'ldac']) {
    assert.match(section, new RegExp(`third_party/wasm/bin/\\$\\{module\\}_codec\\.wasm`),
      `the verification step must check ${module}_codec.wasm`);
  }
  assert.match(section, /0061736d/, 'each .wasm must be verified to start with the WebAssembly magic');
  assert.match(section, /sha256sum --check/, 'both module halves must match the last-published pair manifest');
  assert.match(section, /third_party\/wasm\/VERSION\.txt/, 'supplemental provenance must be present');
});

test('the supplemental cache key covers everything the build script actually pins', () => {
  const section = job('browser-codecs');
  assert.match(section, /supplemental-wasm-v1-/, 'supplemental WASM intermediates must be cached');
  assert.match(section, /hashFiles\('tools\/build_codec_wasm\.sh', 'tools\/lc3_wasm\.c', 'tools\/ldac_wasm\.c', 'tools\/build_ffmpeg\.sh', 'tools\/build_ldac_helper\.sh'\)/);

  // The glue sources and the pinned-source scripts are real build inputs: the
  // script reads the LC3 checksum from build_ffmpeg.sh and the libldac/
  // libldacdec commits from build_ldac_helper.sh, so key changes must track
  // them, not just the wasm-specific files.
  assert.match(buildScript, /sed -n .*\^LC3_SHA.*tools\/build_ffmpeg\.sh/);
  assert.match(buildScript, /LIBLDAC_COMMIT=.*tools\/build_ldac_helper\.sh/);
  assert.match(buildScript, /LIBLDACDEC_COMMIT=.*tools\/build_ldac_helper\.sh/);
  assert.match(buildScript, /tools\/lc3_wasm\.c/);
  assert.match(buildScript, /tools\/ldac_wasm\.c/);
});

test('emitted artifacts reach the served codec-assets through the normal launcher flow', () => {
  for (const name of ['lc3_codec.js', 'lc3_codec.wasm', 'ldac_codec.js', 'ldac_codec.wasm']) {
    assert.match(copier, new RegExp(`'${name}'`),
      `copy-wasm-assets must carry ${name} from third_party/wasm/bin to the served app assets`);
  }
  assert.match(copier, /apps\/client\/public\/codec-assets/, 'assets must be published to the served public directory');

  // The browser launcher (and its client build) runs this copy during
  // ensureArtifacts, so CI needs no separate copy step.
  const launcher = readFileSync(path.join(root, 'tools/test-browser.mjs'), 'utf8');
  assert.match(launcher, /ensureArtifacts\('client'\)/);
  const buildGraph = readFileSync(path.join(root, 'tools/verification/build.mjs'), 'utf8');
  assert.match(buildGraph, /copyWasmAssets\(\)/);
});

test('production-typescript runs the real LDAC allocation-failure harness before expensive builds', () => {
  const section = job('production-typescript');
  const harness = section.indexOf('Check LDAC WASM allocation failure cleanup');
  assert.ok(harness >= 0 && harness < section.indexOf('Build FFmpeg with LC3 and the LDAC helper'));
  assert.match(section, /lifecycle_test\.c tools\/ldac_wasm\.c/);
  assert.match(section, /--wrap=malloc,--wrap=calloc,--wrap=free/);
  assert.match(section, /^\s+"\$\{RUNNER_TEMP\}\/ldac-wasm-lifecycle"\s*$/m);
  assert.doesNotMatch(section, /continue-on-error:/);
});
