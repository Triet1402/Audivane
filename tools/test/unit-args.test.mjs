import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unitArguments } from '../verification/unit-args.mjs';

test('unit name filters after file arguments actually exclude other tests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'unit-filter-'));
  try {
    const filename = path.join(directory, 'scope.test.mjs');
    await writeFile(filename, "import test from 'node:test'; test('selected',()=>{}); test('unselected',()=>{throw new Error('must not run')});");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // This subprocess is a fresh runner, not a nested test file.
    for (const args of [[filename, '--test-name-pattern=^selected$'], [filename, '--test-name-pattern', '^selected$']]) {
      const parsed = unitArguments(args);
      const output = execFileSync(process.execPath, ['--test', ...parsed.options, ...parsed.files], { encoding: 'utf8', env });
      assert.match(output, /# pass 1|pass 1/);
    }
    assert.deepEqual(unitArguments(['--test-name-pattern=foo.ts']), { files: [], options: ['--test-name-pattern=foo.ts'] });
    assert.deepEqual(unitArguments([filename, '--test-name-pattern', 'foo.ts']), { files: [filename], options: ['--test-name-pattern', 'foo.ts'] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
