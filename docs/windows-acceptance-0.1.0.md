# Windows 0.1.0 acceptance — 2026-11-07

Status: unsigned local candidate, unpublished. Tested on Windows 11 Pro x64,
build 26200, under a limited interactive user token with sandboxing enabled.

## Exact tested downloads

| Artifact | SHA-256 |
| --- | --- |
| `Audivane-Setup-0.1.0-x64.exe` | `4c63dea6e886cc7e9ecb1deb01902e0e4122d3c8c3f5c93969601f10fb63e978` |
| `Audivane-0.1.0-win32-x64.zip` | `009d16d644dfc6879c39d31ac87713fd2c504d1629526b7243c22e13a920268d` |

Transferred hashes matched before testing and match the final local release
manifest. Later rebuilds require their own byte-bound acceptance.

## Passed checks

- Per-user NSIS installation: ownership marker, version, resources, registration,
  Desktop and Start Menu shortcuts; locked uninstall refusal, repair and clean
  uninstall. The final reinstall left the current candidate installed.
- Installed and portable sandboxed FLAC listening, running/completed exports,
  foreign working directory and excluded PATH codecs.
- Three native process-host lifetime cases: main-process death without tree kill,
  early codec-leader exit, and per-codec host termination.
- Four Windows verification-lock cases: serialization/crash recovery,
  spaces/non-ASCII path, surviving-child ownership, and readiness while stdout
  remains open.
- Local integrated verification: strict typecheck, 706 unit/tooling tests,
  230 browser tests, five desktop functional tests, serial desktop performance
  and browser workload/cleanup profiling.

The installer now releases its staging working directory before replacement and
clears stale error flags before recreating retry markers. The verification lock
reads its readiness line without waiting for pipe EOF. Regression tests cover
these failures. The existing Windows distribution CI invokes these shared
scripts; GitHub Actions was not rerun as part of this local acceptance.

## Bounds and remaining work

The full eleven-codec installed-Windows scientific matrix and physical headphone
listening were not performed. Interactive installer flows and cross-version
upgrades need their own acceptance. This machine had a test harness and the
Microsoft VC runtime installed; these checks do not establish every clean-machine
prerequisite. No signing, SmartScreen reputation or distribution-wide claim is
made. The [acceptance matrix](distribution-acceptance.md) remains the release gate.

Detailed logs and retained failures are local under
`build/minipc-acceptance/`, including `RESOLVED.md`, `final-windows/`,
`full-integration-final.log` and `rebuild-repair.log`. Private host/account
information and raw test reports are excluded from the public source snapshot.
