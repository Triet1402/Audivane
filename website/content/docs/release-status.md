---
title: Release status
description: Audivane 0.2.1 downloads, changes and verification status.
order: 4
updated: 2026-11-09
source: docs/release-notes-0.2.1.md
source_sha256: 792e6010423d476b640d8c530575cbd53b093e7ca542b463d1e5350813e2cc2a
---

## 0.2.1 — available

Audivane 0.2.1 is [published on GitHub](https://github.com/Triet1402/Audivane/releases/tag/0.2.1).
Get the desktop app from the [downloads page](/downloads/) or use the updated
[browser app](/demo/).

### What changes

- Renamed font subsets in metadata and CSS while preserving IBM copyright and OFL.
- Added the client source font license copy and font modification provenance.
- Added website MIT license metadata and rebuilt release assets.

### Downloads

| Platform | Format |
| --- | --- |
| Ubuntu 24.04+ x64 | `.deb` |
| Arch x86_64 | `.pkg.tar.zst` |
| Windows x64 | Unsigned installer and portable ZIP |

Matching source, codec materials, manifests and SHA-256 checksums accompany
published packages. macOS and AppImage downloads are not planned for 0.2.1.

### Verification

Release preparation passed version consistency, TypeScript compilation, package
structure and checksum checks. The font checks are now codified as
`npm run check:fonts`, verifying the bundled subsets against the recorded
hashes and content fingerprints in `third_party/fonts.json`. No new full
installed-platform, upgrade or physical listening pass is claimed. Previous
0.1.0 checks apply to those earlier artifacts.
Windows builds remain unsigned. Audio processing stays local, and the existing
preparation gates and fixed-trial scoring remain in place.
