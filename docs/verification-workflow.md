# Verification

Run checks for the changed module and its callers while editing. Run one full
integration check after the combined change is ready. Documentation-only edits
need local-link and diff checks.

## Commands

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Strict TypeScript checking |
| `npm run check:fonts` | Bundled renamed font subsets against `third_party/fonts.json` |
| `npm run test:unit -- packages/experiment/test/chain.test.ts` | Selected unit file |
| `npm run test:desktop:unit` | Desktop boundaries and lifecycle |
| `npm run test:browser -- --project chromium-dev tests/e2e/ui-codec-chains.spec.ts` | Selected browser acceptance |
| `npm run test:desktop -- listening.electron.ts` | Selected sandboxed Electron acceptance |
| `npm run verify:quick` | Typing and unit/tooling checks |
| `npm run verify:full` | Integrated functional and performance acceptance |
| `npm run test:performance` | Serial desktop performance |
| `npm run profile:browser` | Browser workload and cleanup profiling |
| `npm run test:audio-output` | Separate live digital capture |

Install Chromium with `npx playwright install chromium`. Native tests require
the pinned codec tools; desktop tests also need the
[host libraries and sandbox setup](typescript-desktop-runtime.md).

Do not weaken codec coverage, failure reporting or numerical tolerances to make
a check pass. Validate scientific behavior using analytical fixtures,
independent evidence and exact delivered audio. See [methodology](methodology.md).

## Efficient checks

Rerun failing cases first after a bounded fix. Broaden testing when changes,
failures or unresolved concerns justify it. A build-cache hit is not a test
pass: requested tests must always execute. Preserve failure artifacts.

Performance checks run separately and serially. Stop competing CPU-heavy jobs
before comparing timings. Profiling validates workload, cancellation, retry,
release and worker cleanup; there are no universal host timing guarantees.

Digital capture needs `npm run setup:virtual-audio` first. It owns a private
user-mode audio server and verifies digital output, not physical listening.

## Launchers, locks and reports

Use the repository browser/desktop launchers. They own builds, output locks,
server cleanup and run-specific reports. Browser runs start their own loopback
servers on ephemeral ports and close them afterward.

Linux uses `flock` on `build/verification.lock` to protect shared artifacts.
Owned commands retain the lock until they exit. Windows uses a named-pipe lock
holder. Actual Windows handle/process behavior requires Windows acceptance.
Do not bypass sandboxing to make a desktop check run.

Browser and desktop reports use unique directories under `test-results`.
Performance reports use separate directories. Retain reports you need before
cleaning ignored outputs. Electron tests stay at one worker. Browser workers
are bounded by CPU and memory; override deliberately with
`CODEC_ABX_BROWSER_WORKERS=4` or Playwright `--workers=1`.

Release packaging captures isolated package copies under the shared lock, then
compresses independent formats outside it. Final artifact/checksum/manifest
replacement takes the lock again. See [packaging](distribution-packaging.md).

## Build reuse

The build graph is assets → client → desktop bundle → unpacked package.
Fingerprints cover source bytes and directory entries, public assets, locks,
tool/configuration inputs, platform versions and output bytes/modes. Required
entry files must exist. Failed or interrupted builds cannot publish valid stamps.

Unchanged builds rehash their outputs. Source changes during a build refuse
publication. Tests and performance results are never cached. Remove
`build/verification-cache` to force fresh builds. Manual modifications inside
`node_modules` are outside the supported installation workflow.

## Release acceptance

Build success, automated functional checks, installed target-OS execution and
physical listening are separate results. Rebuilt artifacts need evidence bound
to their own source identity and hashes. Use the
[installed acceptance matrix](distribution-acceptance.md) before distribution.
