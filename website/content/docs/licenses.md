---
title: Licenses and third-party credits
description: Which licenses cover Audivane's own code, the FFmpeg and codec libraries, the fonts and the desktop runtime.
order: 5
updated: 2026-11-08
source: docs/distribution-licenses.md
source_sha256: 3365e9e794d58ce39272d164c4321bc2043d94cb1aa5a73e5134891a144a5c8e
---

Audivane's own code is MIT; every dependency keeps its own license, and
nothing is relabeled. Published releases ship the complete matching source,
build and license materials with verified checksums.

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
| Audivane Sans/Mono Latin (derived from IBM Plex) | SIL Open Font License 1.1 | Self-hosted fonts, no runtime font fetch |
| `@ffmpeg/ffmpeg` | MIT | Browser wrapper |
| `@ffmpeg/core` | GPL-2.0-or-later | Browser WASM core (not used by native desktop codecs) |

## Notes

- Every third-party source archive used by the desktop builds is pinned by URL
  and SHA-256, so any reviewer can rebuild the codec artifacts from the same
  exact inputs. The browser preview's [source and codec
  materials](/sources/) accompany the app.
- LGPL components are dynamically linked where the license requires it, with
  the corresponding materials shipped alongside.
- Codec availability does not imply patent clearance; distribution rights
  depend on jurisdiction and channel.
