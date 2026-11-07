# Third-party software and release inventory

The project's original code is licensed under [MIT](LICENSE), copyright
2026 Triet (@Triet1402). Dependencies, fonts and codec binaries retain their
own licenses and attribution. MIT does not cover the shipped dependencies.

The **native desktop** license, notice, source and build payload is generated
from pinned archives by `tools/collect-third-party-materials.mjs`; see
[distribution licenses](docs/distribution-licenses.md) and
[Linux native build](docs/linux-native-build.md). The **browser WASM** core is
a separate distribution obligation and is not covered by the native payload.

## Application and browser assets

| Component | Evidence and license | Distribution work |
| --- | --- | --- |
| Electron 45.1.0 / Chromium / Node.js | Electron's `LICENSE` and `LICENSES.chromium.html` accompany the packaged runtime. | Preserve both files for the actual Electron distribution; never replace them with the project MIT license. |
| React / React DOM 19.3.1 | Installed package licenses: MIT. | Bundled client JavaScript; the material collector copies both license texts. |
| `@ffmpeg/ffmpeg` 0.12.15 | MIT wrapper; see the [upstream FAQ](https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm). | Browser only; collect bundled JavaScript licenses for web distribution. |
| `@ffmpeg/core` 0.12.10 | Installed `package.json` declares `GPL-2.0-or-later`; [release package metadata](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/71aa99d37c02a7b4c435275ca9ef50e612f6efa1/packages/core/package.json). | Matching source archives, build scripts and notices are collected by `tools/collect-browser-materials.mjs` and offered with the browser preview at `/sources/`. See [browser evidence and bounds](website/BROWSER-MATERIALS.md). The npm tarball alone is not a source bundle. Desktop excludes unused browser codec assets. |
| Supplemental LC3 WASM | Google liblc3 1.1.3, Apache-2.0, built by `tools/build_codec_wasm.sh`. | Browser only while the desktop excludes WASM assets. Native material includes the liblc3 source and license. |
| Supplemental LDAC WASM | Pinned AOSP libldac, Apache-2.0, and hegdi/libldacdec, MIT. | Browser only while the desktop excludes WASM assets. Native material includes both sources, licenses and the AOSP `NOTICE`. |
| IBM Plex fonts | [Bundled SIL Open Font License and copyright](apps/client/public/ibm-plex-OFL.txt). | Keep this file with the font assets; the material collector also includes it. |
| Measurement implementation attribution | [pyloudnorm notice and full MIT text](packages/measurements/NOTICE.md). | Preserve this attribution; desktop packaging includes a copy as `measurements-NOTICE.md`. |
| glibc / libm | System libraries, dynamically linked and not redistributed. | Declare the runtime dependency floor (`glibc >= 2.39` for the Ubuntu 24.04 baseline); do not claim the binaries are fully static. |

## Native codec bundle

The Linux x64 release baseline is Ubuntu 24.04 LTS / glibc 2.39. Versions,
configuration and binary hashes are recorded in
[FFmpeg provenance](third_party/ffmpeg/VERSION.txt) and
[LDAC provenance](third_party/ldac/VERSION.txt) after a build. The pinned
source inventory is [third_party/release-materials.json](third_party/release-materials.json).

| Component | Exact pinned source | License |
| --- | --- | --- |
| FFmpeg / ffprobe 9.0.2 | [ffmpeg-9.0.2.tar.xz](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz), SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` | LGPL-2.1-or-later (built without `--enable-gpl` or `--enable-nonfree`) |
| liblc3 1.1.3 | [v1.1.3](https://github.com/google/liblc3/tree/v1.1.3), SHA-256 `276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af` | Apache-2.0 |
| libsoxr 0.1.3 | [0.1.3](https://github.com/chirlu/soxr/tree/0.1.3), SHA-256 `db6ca1b1e8405c6ef92f8294fc123d910abf0a114003b3f0f13fa57a95fd62d0` | LGPL-2.1-or-later |
| libogg 1.3.5 / libvorbis 1.3.7 / libopus 1.5.2 | [Xiph](https://www.xiph.org/licenses/), pinned archive hashes in `VERSION.txt` and the materials manifest | BSD-3-Clause |
| LAME 3.100 / TwoLAME 0.4.0 | [LAME](https://lame.sourceforge.io/) / [TwoLAME](https://www.twolame.org/), pinned archive hashes in `VERSION.txt` and the materials manifest | LGPL-2.0-or-later / LGPL-2.1-or-later |
| AOSP libldac | [commit eeee1a3f](https://android.googlesource.com/platform/external/libldac/+/eeee1a3f5f8df1282e3a6d297085885fd886737b), content SHA-256 `ebba69bc820b93c2ea4c49feaee9e82ffabdb604f89f6c332c2fe922ff3b4d95` (Gitiles regenerates archive bytes; extracted content is pinned) | Apache-2.0; retain `LICENSE` and `NOTICE` |
| hegdi/libldacdec | [commit 7f3bd6cc](https://github.com/hegdi/libldacdec/tree/7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9), archive SHA-256 `c6a1cde751cb18f69ccf7d8817f24972560be4e62b3fdbe75159c1207bc5a046` | MIT, copyright 2021 Dirk Helbig |

FFmpeg statically links the codec libraries and dynamically links glibc/libm.
The complete license texts, exact source archives and build scripts are
collected together so the binaries can be rebuilt and LGPL components relinked.
A VERSION file or binary hash alone is not the source offer.

The recorded 2026-11-04 Ubuntu 24.04 baseline build required at most glibc
**2.38**, passed a 40-check provenance audit and exposed all eleven codec IDs in
the readiness probe. See [Linux native build](docs/linux-native-build.md) for
the artifact hashes and environment.

Generate and verify the payload:

```bash
node tools/collect-third-party-materials.mjs
node tools/collect-third-party-materials.mjs --verify
```

The generated `build/release-materials/` tree contains `NOTICES.md`,
`SOURCE-OFFER.md`, `licenses/`, `sources/`, `build/` and `provenance/` plus a
`MANIFEST.json` with every file hash. Keep it with the release assets.

## Desktop/browser separation

The desktop executes native codecs. Browser WASM codec assets are intended to
be excluded from desktop packages; that change is owned by the root packaging
work and must be verified in the installed artifact. Until it is verified, do
not state that a desktop package excludes them.

The web application still serves the GPL `@ffmpeg/core` and supplemental WASM,
so web publication has a separate corresponding-source obligation even if the
desktop package is native-only.

## Before public distribution

- [x] Pin exact native sources, licenses and build commands.
- [x] Build against the documented Ubuntu 24.04 / glibc 2.39 baseline.
- [x] Collect full native license texts, matching sources and a hashed manifest.
- [ ] Review the final archive/installer contents, not only the checkout.
- [ ] Verify desktop exclusion of unused browser WASM assets.
- [ ] Provide the exact `@ffmpeg/core` and supplemental-WASM corresponding
  source/build payload before public web distribution.
- [ ] Complete Windows x64 native source/notice/provenance for its own build.
- [ ] Obtain legal review of codec patent/distribution requirements for the
  intended regions and channels.
- [ ] Keep a per-release file/hash inventory and durable source offer beside the
  binaries and web app.

See the [release plan](docs/releasing.md) for the remaining release gates.

Windows cross-produced candidates also include MinGW-w64/winpthreads runtime
notices (mixed permissive licenses), GCC runtime notices and its Runtime Library
Exception, and NSIS installer component notices. The Windows material inventory
includes their pinned sources/patches and exact build-package hashes; see
[Windows material scope](docs/distribution-licenses.md#windows-cross-produced-candidate).
These are separate from the project's MIT license and from Windows system DLLs,
which are provided by Windows and are not copied into the native bundle.
