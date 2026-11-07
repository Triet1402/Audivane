import path from 'node:path';
import { run } from './verification/process.mjs';
import {
  assertProductionSelection,
  productionBrowserFiles,
  productionDesktopFiles,
  productionEnvironment,
  root,
} from './verification/production.mjs';

const requested = process.argv[2] ?? 'all';
const modes = new Set(['all', 'unit', 'browser', 'desktop']);
if (requested === '--help' || requested === '-h') {
  console.log('Usage: node tools/test-production.mjs [all|unit|browser|desktop]');
  console.log('Runs the selected production checks through the existing launchers.');
  process.exit(0);
}
if (!modes.has(requested)) throw new Error(`Expected production scope all, unit, browser or desktop; got ${requested}`);
const all = requested === 'all';

// The production lane must not turn a missing interpreter-independent native
// prerequisite into a skip. Check the vendored tools and every catalog codec
// before any test or package build.
assertProductionSelection();
await run(process.execPath, ['--import', 'tsx', path.join(root, 'tools/verify-production-prerequisites.mjs')], {
  cwd: root, env: productionEnvironment(),
});
console.log(`[production] scope: ${all ? 'TypeScript/native/desktop/tooling unit, production browser, audited packaged Electron' : requested}. The full development commands run the complete unit and browser selections.`);

if (all || requested === 'unit') {
  await run(process.execPath, [path.join(root, 'tools/test-unit.mjs'), '--production'], {
    cwd: root, env: productionEnvironment(),
  });
}
if (all || requested === 'browser') {
  await run(process.execPath, [path.join(root, 'tools/test-browser.mjs'), ...productionBrowserFiles], {
    cwd: root, env: productionEnvironment(),
  });
}
if (all || requested === 'desktop') {
  await run(process.execPath, [path.join(root, 'tools/test-desktop.mjs'), ...productionDesktopFiles], {
    cwd: root, env: productionEnvironment(),
  });
}
