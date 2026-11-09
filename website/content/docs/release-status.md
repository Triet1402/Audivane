---
title: Release status
description: Audivane 0.2.2 downloads, changes and verification status.
order: 4
updated: 2026-11-09
source: docs/release-notes-0.2.2.md
source_sha256: 86db4893c1419bc349782696c86e2d243dc7dd90e88911c17d1afade2710dd65
---

## 0.2.2 — available

Audivane 0.2.2 is [published on GitHub](https://github.com/Triet1402/Audivane/releases/tag/0.2.2).
Get the desktop app from the [downloads page](/downloads/) or use the updated
[browser app](/demo/).

### What changes

- Codified font subset checks as `npm run check:fonts`, with per-copy family
  records and content fingerprints against the recorded originals.
- Rebuilt desktop packages, source/license materials and website assets.

### Downloads

| Platform | Format |
| --- | --- |
| Ubuntu 24.04+ x64 | `.deb` |
| Arch x86_64 | `.pkg.tar.zst` |
| Windows x64 | Unsigned installer and portable ZIP |

Matching source, codec materials, manifests and SHA-256 checksums accompany
published packages. macOS and AppImage downloads are not planned for 0.2.2.

### Verification

Release preparation passed version consistency, TypeScript compilation, package
structure and checksum checks, plus `npm run check:fonts` verifying the bundled
subsets against the recorded hashes and content fingerprints in
`third_party/fonts.json`. No new full installed-platform, upgrade or physical
listening pass is claimed. Previous 0.1.0–0.2.1 checks apply to those earlier
artifacts. Windows builds remain unsigned. Audio processing stays local, and
the existing preparation gates and fixed-trial scoring remain in place.
