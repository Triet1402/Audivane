# Audivane 0.2.2

Codified font subset verification; desktop package and website rebuilds.

## Changes

- Added `npm run check:fonts` (`tools/check-subset-fonts.mjs`): verifies the
  bundled renamed font subsets against `third_party/fonts.json` — file bytes,
  renamed names free of the reserved font name, preserved IBM copyright and
  OFL license URL records, and content fingerprints proving the glyph and
  metric data are unchanged from the recorded original subsets. Manifest
  entries record the copy's family, and `node tools/check-subset-fonts.mjs
  --fingerprint <file>` reproduces a recorded original fingerprint from any
  upstream file independently. The full verification list is in the
  repository's font licensing documentation.
- Rebuilt desktop packages, source/license materials and website assets.
- Fixed a stale playback unit test asserting a completion notice that the
  0.2.0 listening revamp removed; completion surfaces through the session
  lifecycle.

## Downloads

Ubuntu 24.04+ x64 `.deb`, Arch x86_64 `.pkg.tar.zst`, and Windows x64 unsigned
installer and portable ZIP. Matching application source, codec source/build/
license materials, platform manifests and SHA-256 checksums accompany these
artifacts. No macOS or AppImage package is provided.

## Verification and limits

Font checks confirm unchanged glyph, metric and copyright data across all
12 bundled files, codified as `npm run check:fonts`. Distribution/provenance
tests, version consistency, TypeScript compilation, builds and
structural/checksum verification cover this patch. No new full
installed-platform, upgrade or physical listening pass is claimed. Windows
builds remain unsigned. Codec patent/distribution review is separate from
these verification and packaging corrections.
