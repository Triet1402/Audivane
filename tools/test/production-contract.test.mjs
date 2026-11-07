import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertProductionSelection,
  productionBrowserFiles,
  productionDesktopFiles,
  productionUnitFiles,
} from '../verification/production.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;

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

test('production selection is explicit and includes required native/desktop/tooling evidence', () => {
  assert.doesNotThrow(() => assertProductionSelection());
  assert.ok(productionUnitFiles.includes('packages/engine-native/test/typescript-preparation.test.ts'));
  assert.ok(productionUnitFiles.includes('packages/preparation-policy/test/independent-policy.test.ts'));
  assert.ok(productionUnitFiles.includes('apps/desktop/test/worker-runtime.test.ts'));
  assert.ok(productionUnitFiles.includes('tools/test/verification.test.mjs'));
  assert.deepEqual(productionDesktopFiles, ['apps/desktop/test/package.electron.ts']);
  for (const id of [
    'tests/e2e/engine-contract.spec.ts',
    'tests/e2e/preparation-lab.spec.ts',
    'tests/e2e/preparation-policy.spec.ts',
    'tests/e2e/validity-canary.spec.ts',
  ]) {
    assert.ok(productionBrowserFiles.includes(id), `${id} must remain in the browser selection`);
  }
  assert.ok(!productionBrowserFiles.includes('tests/e2e/supplemental-codecs.spec.ts'),
    'the eleven-codec supplemental lane stays separate');
});

test('production scripts reuse the managed launchers and retain the full development selections', () => {
  assert.equal(scripts['test:production:unit'], 'node tools/test-production.mjs unit');
  assert.equal(scripts['test:production:browser'], 'node tools/test-production.mjs browser');
  assert.equal(scripts['test:production:desktop'], 'node tools/test-production.mjs desktop');
  assert.equal(scripts['test:production'], 'node tools/test-production.mjs');
  assert.equal(scripts['verify:production'], 'node tools/verify.mjs production');

  const runner = readFileSync(path.join(root, 'tools/test-production.mjs'), 'utf8');
  assert.match(runner, /tools\/test-unit\.mjs/);
  assert.match(runner, /tools\/test-browser\.mjs/);
  assert.match(runner, /tools\/test-desktop\.mjs/);
  assert.match(runner, /verify-production-prerequisites\.mjs/);
  assert.match(runner, /productionEnvironment/);
  assert.doesNotMatch(runner, /--no-sandbox/);

  const unit = readFileSync(path.join(root, 'tools/test-unit.mjs'), 'utf8');
  assert.match(unit, /test-reporter=junit/);
  assert.match(unit, /production unit lane must not skip tests/);

  const verify = readFileSync(path.join(root, 'tools/verify.mjs'), 'utf8');
  assert.match(verify, /node\('tools\/test-unit\.mjs'\)/,
    'verify:full must retain the complete development unit selection');
  assert.match(verify, /node\('tools\/test-browser\.mjs'\)/,
    'verify:full must retain the complete development browser selection');
});

test('required CI production job builds native prerequisites and runs the fail-closed lane', () => {
  const section = job('production-typescript');
  assert.match(section, /npm run verify:production/);
  assert.match(section, /tools\/build_ffmpeg\.sh/);
  assert.match(section, /tools\/build_ldac_helper\.sh/);
  assert.match(section, /native-codecs-v1-/);
  assert.match(section, /bash tools\/setup-desktop-host-libs\.sh/);
  assert.match(section, /node tools\/desktop-apparmor-profile\.mjs/);
  assert.match(section, /apparmor_parser -r/);
  assert.match(section, /xvfb/);
  assert.match(section, /npx playwright install --with-deps chromium/);
  assert.doesNotMatch(section, /--no-sandbox/);
  assert.doesNotMatch(section, /continue-on-error:/);
  for (const forbidden of [
    /npm run check:ts/,
    /npm run test:browser/,
  ]) {
    assert.doesNotMatch(section, forbidden, `production CI job must not run a broad comparison command: ${forbidden}`);
  }
});

test('CI workflows use least privilege and no host-specific cache paths', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m,
    'the workflow must declare contents: read at the top level');
  assert.doesNotMatch(workflow, /\/tmp\/opencode/,
    'workflow cache/build paths must use runner-provided temporary directories');
});
