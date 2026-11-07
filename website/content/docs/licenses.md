---
title: Licenses and third-party credits
description: Which licenses cover Audivane's own code, the FFmpeg and codec libraries, the fonts and the desktop runtime.
order: 5
updated: 2026-11-06
source: docs/distribution-licenses.md
source_sha256: 8876dbc0427a1a2e7a55ce0a53e4a89d5df3ca09dac0f17214c7345615c52c58
---

Audivane is built from open source, and each component keeps its own license.
The application's own code is MIT; nothing else is relabeled. Every published
release ships the complete matching source, build and license materials —
notices, pinned source archives with verified checksums and build scripts —
alongside the installers.

## License map

| Component | License | Role |
| --- | --- | --- |
| Audivane application code | MIT (© 2026 the project author) | Original source and client/desktop JavaScript |
| FFmpeg / ffprobe 9.0.2 | LGPL-2.1-or-later | Native codec executables |
| liblc3 1.1.3 | Apache-2.0 | Static dependency of FFmpeg; optional browser LC3 module |
| libsoxr 0.1.3 | LGPL-2.1-or-later | Static dependency of FFmpeg |
| libogg, libvorbis, libopus | BSD-3-Clause | Static dependencies of FFmpeg |
| LAME, TwoLAME | LGPL | Static dependencies of FFmpeg (MP2/MP3 encoding) |
| AOSP libldac and libldacdec | Apache-2.0, MIT | LDAC encode/decode for the native helper and optional browser module |
| Electron / Chromium / Node.js | MIT plus Chromium third-party licenses | Desktop runtime |
| React | MIT | Bundled client JavaScript |
| IBM Plex Sans and IBM Plex Mono | SIL Open Font License 1.1 | Self-hosted fonts, no runtime font fetch |
| `@ffmpeg/ffmpeg` | MIT | Browser wrapper |
| `@ffmpeg/core` | GPL-2.0-or-later | Browser WASM core (not used by native desktop codecs) |

Version pins above describe the current native release materials. A published
release's own materials are authoritative for the exact builds it ships.

## Source materials and reproducibility

The browser preview's [application source, codec sources, build materials and
license notices](/sources/) are available alongside the app.

For the native desktop builds, every third-party source archive is pinned by
URL and SHA-256 (or a canonical content hash where the upstream regenerates
archive bytes). The collector verifies the pins and assembles the complete
license, notice, source and build payload so any reviewer can rebuild the
codec artifacts from the same exact inputs.

## Notes

- The MIT license applies to Audivane's own code only. No dependency license is
  replaced or reinterpreted.
- LGPL components are dynamically linked where the license calls for it, and
  the corresponding object/source materials accompany the distribution so the
  LGPL obligations are exercisable.
- Codec availability does not imply patent clearance. Whether particular codecs
  and formats may be distributed or used in a given region is a legal question
  that depends on the channel and jurisdiction, and is part of release review.
