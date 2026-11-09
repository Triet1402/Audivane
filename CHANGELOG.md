# Changelog

## Unreleased

- Added `npm run check:fonts`: verifies the renamed font subsets against
  `third_party/fonts.json` — unmodified file bytes, names free of the reserved
  font name, preserved IBM copyright/OFL records and content fingerprints
  proving the glyph and metric data are unchanged from the original subsets.
  `node tools/check-subset-fonts.mjs --fingerprint <file>` reproduces a
  recorded original fingerprint from any upstream file independently; the
  full verification list is in `docs/font-licensing.md`.
- Release documentation now reflects that 0.2.1 is published.

## 0.2.1

- Renamed bundled Latin font subsets in metadata and CSS to avoid the reserved font name.
- Preserved IBM copyright and OFL notices and added font modification hashes and reproduction instructions.
- Added the client source font license copy and website MIT license metadata.
- Rebuilt desktop downloads and the website with the corrected assets and release materials.

## 0.2.0

- Simplified Setup, Listen and Evidence with clearer statistics and fewer technical labels.
- Stable trial feedback and completion layout; reset immediately stages trial 1 paused.
- Consistent disclosure state across tabs and improved desktop and mobile scrolling.
- Fixed post-run audio previews and WAV downloads.
- Combined listening records and full diagnostics in one results download.
- Removed obsolete UI code and updated tests and design documentation.

## 0.1.0

- Local blind ABX comparisons with configurable codec chains.
- Shared browser and native desktop audio preparation, level matching and byte verification.
- Fixed-trial listening sessions and auditable exports.
