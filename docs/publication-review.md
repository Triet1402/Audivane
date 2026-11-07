# Publication review

Prepare a clean source tree for a new initial release. Copy source files to the
new folder without `.git`; existing development history stays in this repository.
Copying files does not carry commit authorship. Public Git identity is chosen
when creating commits in the new repository.

## Keep and exclude

Keep application source, meaningful tests, build scripts, lockfiles, scientific
policy, current guides, licenses and attribution. Exclude generated outputs,
installed dependencies, test reports, uploads, local tool state, agent notes,
private host configuration and `.git`.

Inspect the copied tree, check documentation links and build/test it before
making final binaries. Match source, codec materials and checksums to those
binaries. No snapshot generator or Git initialization is needed for this cleanup.

## Source audit — 2026-11-05

Audited the current public source selection: tracked working-tree files plus
non-ignored new files, excluding deleted paths. The selection contains application
source, tests, scripts, docs, lockfiles, fonts/icons and dependency provenance.
No tracked uploads, generated builds, installed dependencies, local agent state,
credential files or symlinks were found; `uploads/.gitkeep` is an empty placeholder.

Checks performed:

- Credential/provider-token, private-key, credential-URL, private-home-path and
  private-hostname pattern scans, plus an independent entropy scan.
- `detect-secrets` 1.5.0 with its default detectors and entropy rules, using
  `--no-verify` so candidate values are not sent to providers. All flagged values
  were reviewed: dependency/source hashes, deterministic test fixtures, file
  signatures, public license filenames and signing environment-variable names.
  No credential finding remains unresolved.
- Binary inventory: intended font, PNG and ICO assets only. PNG chunks contain
  image data and structural chunks, without text or EXIF metadata. Original
  font licensing and other attribution remain intact.
- Ignore rules checked for generated outputs and local state; local environment
  files and signing keys/certificates are now excluded. Removed a host-specific
  hardware detail and local asset-exploration commentary from public guides.

Generic temporary build paths and exact historical build provenance are retained
because they are reproducibility information, not private home paths. Public
copyright and upstream author information are intentionally retained. Synthetic
prerelease-version fixtures remain in packaging tests to cover version conversion;
release metadata and documentation now use `0.1.0`.

This is an offline source-content review, not provider validation or an audit of
private development history, ignored local files or final binary downloads.
The scanner report is local under `build/public-source-audit/`. Recheck the actual
copied tree and final downloads before publication; this audit does not transfer
to later edits or a different file selection.

## Release gates

- Complete installed Windows codec matrix and interactive/cross-version upgrade
  acceptance; bounded installer, FLAC workflow and process-lifetime checks passed
  on Windows 11 x64. See [Windows evidence](windows-acceptance-0.1.0.md).
- Final installed Linux UI/dialog/export checks, normal graphical login and
  physical listening; Arch also needs cross-version upgrade acceptance.
- Mounted-runtime and sandbox checks if shipping AppImage.
- Exact corresponding FFmpeg and supplemental WASM source/build materials if
  publishing the web version.
- Final content/credential review of the copied tree, new initial commit and
  downloads, publisher identity and signing decision. Private development
  history stays excluded; no cleanup of that history is required for this route.

See [installed acceptance](distribution-acceptance.md) and [release guide](releasing.md).

Use the [distribution strategy](distribution-strategy.md) to choose which formats
to publish. Complete only the platform gates for the artifacts actually shipped.
