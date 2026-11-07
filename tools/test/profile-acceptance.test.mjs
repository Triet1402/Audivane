import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserProfile } from '../verification/profile-acceptance.mjs';

function valid() {
  const labels = ['cold-1s-raw-noop-opus', 'warm-1s-raw-noop-opus', 'warm-1s-prepared-canary',
    'repeat-1-1s-raw-noop-opus', 'repeat-2-1s-raw-noop-opus', 'repeat-3-1s-raw-noop-opus',
    'warm-10s-raw-noop-opus', 'warm-10s-prepared-canary', 'retry-after-cancel-1s-raw'];
  return {
    rows: [...labels.map(label => ({ label, error: null, delivered: { bytes: 384044,
      wavSha256: 'a'.repeat(64), shaPrefix: 'a'.repeat(8) }, readAfterRelease: 'Unknown artifact', artifactMapSize: 0 })),
      { label: 'cancel-10s-intermediate-stage', error: { name: 'AbortError' }, cancelledLatencyMs: 2, workers: { active: 0 } }],
    shutdown: { workers: { active: 0, created: 11, terminated: 11 } },
    afterCancelRun: { label: 'retry-after-cancel-1s-raw', error: null }, pageErrors: [],
  };
}
test('browser profile accepts measured success, confirmed cancellation, retry and cleanup', () => {
  assert.doesNotThrow(() => assertBrowserProfile(valid()));
});
test('browser profile refuses failed workloads and false cleanup/provenance claims', () => {
  const corruptions = [
    report => { report.rows[7].error = { name: 'Error', message: '10s failed' }; report.rows[7].delivered = null; },
    report => { report.rows.pop(); },
    report => { report.rows.at(-1).error = null; },
    report => { report.rows.at(-1).workers.active = 1; },
    report => { report.rows.at(-1).cancelledLatencyMs = null; },
    report => { report.afterCancelRun.error = { name: 'Error' }; },
    report => { report.rows[0].readAfterRelease = 'unexpectedly-readable'; },
    report => { report.rows[0].artifactMapSize = 1; },
    report => { report.rows[0].delivered.shaPrefix = 'random-id'; },
    report => { report.shutdown.workers.active = 1; },
    report => { report.shutdown.workers.terminated = 10; },
    report => { report.pageErrors.push('uncaught'); },
  ];
  for (const corrupt of corruptions) {
    const report = valid(); corrupt(report);
    assert.throws(() => assertBrowserProfile(report), /Browser profile acceptance failed/);
  }
});
