/** Validate outcomes, never hardware-dependent timings or memory ceilings. */
export function assertBrowserProfile(report) {
  const failures = [];
  const require = (condition, reason) => { if (!condition) failures.push(reason); };
  const rows = report.rows ?? [];
  const expected = ['cold-1s-raw-noop-opus', 'warm-1s-raw-noop-opus',
    'warm-1s-prepared-canary', 'repeat-1-1s-raw-noop-opus',
    'repeat-2-1s-raw-noop-opus', 'repeat-3-1s-raw-noop-opus',
    'warm-10s-raw-noop-opus', 'warm-10s-prepared-canary', 'retry-after-cancel-1s-raw'];
  for (const label of expected) require(rows.filter(row => row.label === label).length === 1, `${label}: missing or duplicated scenario`);
  for (const row of rows) {
    if (row.label === 'cancel-10s-intermediate-stage') continue;
    require(row.error === null && row.delivered?.bytes > 44, `${row.label}: preparation failed`);
    require(/^[a-f0-9]{64}$/.test(row.delivered?.wavSha256 ?? '') &&
      row.delivered?.shaPrefix === row.delivered.wavSha256.slice(0, 8), `${row.label}: missing delivered-byte hash`);
    require(typeof row.readAfterRelease === 'string' && row.readAfterRelease !== 'unexpectedly-readable', `${row.label}: released audio remained readable`);
    require(row.artifactMapSize === 0, `${row.label}: retained artifact leak`);
  }
  const cancelled = rows.filter(row => row.label === 'cancel-10s-intermediate-stage');
  require(cancelled.length === 1 && cancelled[0].error?.name === 'AbortError' &&
    Number.isFinite(cancelled[0].cancelledLatencyMs) && cancelled[0].cancelledLatencyMs >= 0 &&
    cancelled[0].workers?.active === 0, 'intermediate cancellation did not finish cleanup');
  require(report.afterCancelRun?.label === 'retry-after-cancel-1s-raw' &&
    report.afterCancelRun.error === null, 'explicit retry failed');
  const workers = report.shutdown?.workers;
  require(workers?.active === 0 && Number.isInteger(workers?.created) && workers.created > 0 &&
    workers.created === workers.terminated, 'disposal left workers alive');
  require(Array.isArray(report.pageErrors) && report.pageErrors.length === 0, 'uncaught browser errors');
  if (failures.length) throw new Error(`Browser profile acceptance failed:\n${failures.join('\n')}`);
}
