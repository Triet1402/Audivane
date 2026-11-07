import { globSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { root } from './verification/build.mjs';
import { run } from './verification/process.mjs';
import { createSession } from './verification/session.mjs';
import { unitArguments } from './verification/unit-args.mjs';
import {
  assertProductionSelection,
  productionEnvironment,
  productionUnitFiles,
} from './verification/production.mjs';
const production = process.argv.includes('--production');
const args = process.argv.slice(2).filter(arg => arg !== '--production');
const parsed = unitArguments(args);
if (production) {
  if (parsed.files.length > 0) throw new Error('test:production:unit does not accept file filters; keep the required production selection explicit');
  assertProductionSelection();
}
const explicitFiles = parsed.files.length > 0;
const files = production
  ? [...productionUnitFiles]
  : explicitFiles ? parsed.files : [...globSync(['packages/*/test/*.test.ts', 'apps/client/test/*.test.ts', 'apps/desktop/test/*.test.ts', 'tools/test/*.test.mjs'], { cwd: root })].sort();
console.log(`[verification] unit scope: ${production ? 'PRODUCTION TypeScript/native/desktop/tooling tests (explicit fail-closed selection)' : explicitFiles ? args.join(' ') : 'ALL TypeScript, desktop unit, tooling and Node tests'}`);
const reportDirectory = production ? await createSession(root, 'production-unit') : null;
const reportPath = reportDirectory ? path.join(reportDirectory, 'unit.xml') : null;
const options = reportPath
  ? [...parsed.options, '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=junit', `--test-reporter-destination=${reportPath}`]
  : parsed.options;
await run(process.execPath, ['--import', 'tsx', '--test', ...options, ...files], {
  cwd: root,
  ...(production ? { env: productionEnvironment() } : {}),
});
if (reportPath) {
  const xml = await fs.readFile(reportPath, 'utf8');
  const count = tag => (xml.match(new RegExp(`<${tag}(?:\\s|>)`, 'g')) ?? []).length;
  const executed = count('testcase');
  const skipped = count('skipped');
  const failures = count('failure') + count('error');
  console.log(`[verification] production unit evidence: ${executed} executed, ${skipped} skipped, ${failures} failed; report: ${reportPath}`);
  if (executed === 0) throw new Error('production unit lane executed no tests');
  if (skipped !== 0) throw new Error(`production unit lane must not skip tests (${skipped} skipped)`);
  if (failures !== 0) throw new Error(`production unit lane retained ${failures} failed test cases`);
}
