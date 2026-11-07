---
title: Release status
description: Where Audivane 0.1.0 stands — platform readiness, the download formats planned first, and what is not available yet.
order: 4
updated: 2026-11-07
source: docs/release-notes-0.1.0.md
source_sha256: 4033ec179df6d7788a3ba65e1412657b5be5511fb4bcfe82c744a197c4533f19
---

Audivane 0.1.0 is the first public release, available for Linux and Windows. This page states
what is ready, what is in progress, and what simply does not exist yet.
Downloads include checksums and matching source materials. The testing limits
below remain disclosed; publication does not imply completion of every check. See the
[downloads page](/downloads/) for the current availability summary.

## Desktop app

- **Linux (x64).** Tested by the developer. Version 0.1.0 packages are available with the testing limits below. The initial target baseline is Ubuntu 24.04
  x64; the installed app's sandbox and package lifecycle have been checked in
  Ubuntu 24.04 virtual machines. An Arch x86_64 package is produced with native
  tooling and passed its install, sandbox and removal checks in an Arch virtual
  machine, with its remaining acceptance still open. Linux testing to date is
  development-host evidence, not a claim of distribution-wide certification.
- **Windows (x64).** Unsigned installer and portable builds have been tested on
  Windows 11 x64. Installation, sandboxed FLAC listening and exports,
  repair/removal and process cleanup passed. The complete installed codec
  matrix, interactive/cross-version upgrade checks and physical listening remain
  open. Unsigned Windows downloads are available.
- **macOS.** Deferred. No release packaging or acceptance is implemented, so no
  macOS build should be expected in the 0.1.0 timeframe.

## Browser app

The browser app is in preparation for public release. A working preview is
served at [/demo/](/demo/). It shares the audio policy with the desktop app and
runs local WASM codecs. [Application source and verified codec source/build
materials](/sources/) accompany the preview. Desktop version 0.1.0 is available on the downloads page.

## Version 0.1.0 downloads

Version 0.1.0 downloads are on the
[downloads page](/downloads/) per platform:

| Target | Download |
| --- | --- |
| Ubuntu 24.04 x64 | `.deb` package |
| Arch x86_64 | Optional `.pkg.tar.zst` package |
| Windows x64 | Per-user `.exe` installer; optional portable `.zip` |

Every published artifact will ship with SHA-256 checksums, provenance, and the
complete matching source, build and license materials described on the
[licenses page](/docs/licenses/). Additional formats — Flatpak, AUR, WinGet —
are later-channel projects that each need their own acceptance; they are not
available now.

## What has not changed

Release work does not soften the scientific policy. Preparation validity,
delivered-byte verification, fixed-trial scoring and the validity-versus-audibility
boundary described in the [scientific policy](/docs/scientific-policy/) are
part of every build.
