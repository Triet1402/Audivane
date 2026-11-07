# Pre-release preparation — 2026-11-07

This source folder remains uninitialized: no Git repository, commit, release tag
or public desktop download has been created.

## Source selection

An offline pattern scan of 454 non-ignored source files found no matches for
common provider tokens, private-key headers, credential URLs or the developer's
home path. Selection uses `rg --files --hidden --no-require-git`, applying ignore
rules even outside a Git repository. Ignored build materials and dependencies
are excluded. The local report is in
`build/release-preparation/source-audit-2026-11-07.json`.
This bounded scan does not replace final manual review or a credential scanner.

## Candidate preparation

Linux native resources and matching third-party materials were copied from the
original development checkout into this folder's ignored build directories.
Fresh packages are engineering candidates; final publication artifacts must be
rebuilt against the eventual reviewed initial source snapshot.

The Arch laptop runs EndeavourOS and has `audivane-bin 0.1.0beta.1-1` installed.
SSH works, but sudo requires interactive authentication. Product testing and
physical listening are reserved for the owner. Installing a candidate does not
complete its acceptance matrix.

## Website

The public downloads page still described Windows testing as pending. Local
copy now reflects the recorded Windows 11 installer, portable FLAC/export and
cleanup evidence, with the installed codec matrix and interactive/cross-version
upgrade checks still open. Linux text distinguishes bounded VM checks from
final desktop acceptance. The source packager now supports an uninitialized
snapshot folder and retains ignore rules.

## Remaining decisions and human checks

- Public repository and author identity; explicit signed/unsigned Windows choice.
- Manual product testing, dialogs, exports and physical listening on each target.
- Windows installed codec matrix and interactive/cross-version upgrades.
- Final source/download review, initial commit when authorized, and a rebuild of
  matching binaries, application source, codec materials and checksums.
- Publish only the platform downloads whose acceptance is complete.
