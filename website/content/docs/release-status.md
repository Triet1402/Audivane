---
title: Release status
description: Audivane 0.2.0 downloads, changes and verification status.
order: 4
updated: 2026-11-08
source: docs/release-notes-0.2.0.md
source_sha256: 54245686e1a21b9ccc580cbc5ff3f885227ade15841bfad94fd7cfc5aecb3504
---

## 0.2.0 — available

Audivane 0.2.0 is [published on GitHub](https://github.com/Triet1402/Audivane/releases/tag/0.2.0).
Get the desktop app from the [downloads page](/downloads/) or use the updated
[browser app](/demo/).

### What changes

- Simpler Setup, Listen and Evidence pages with clearer statistics.
- Stable trial feedback and completion layout.
- Reset loads trial 1 paused immediately.
- Consistent disclosure state across tabs and improved scrolling.
- Audio previews and WAV downloads after a test ends.
- One results download containing the listening record and full diagnostics.

### Downloads

| Platform | Format |
| --- | --- |
| Ubuntu 24.04+ x64 | `.deb` |
| Arch x86_64 | `.pkg.tar.zst` |
| Windows x64 | Unsigned installer and portable ZIP |

Matching source, codec materials, manifests and SHA-256 checksums accompany
published packages. macOS and AppImage downloads are not planned for 0.2.0.

### Verification

Release preparation passed version consistency, TypeScript compilation, package
structure and checksum checks. No new full installed-platform, upgrade or physical
listening pass is claimed. Previous 0.1.0 checks apply to those earlier artifacts.
Windows builds remain unsigned. Audio processing stays local, and the existing
preparation gates and fixed-trial scoring remain in place.
