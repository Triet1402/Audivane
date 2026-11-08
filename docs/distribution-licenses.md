# Distribution licenses and source materials

Status: **native materials implemented 2026-11-04**. The complete license,
notice, source and build payload for the pinned Linux native codec artifacts can
be generated from the repository. Browser-only and Windows obligations remain
separate.

This page records what is shipped, under which license, and where the exact
material lives. It is release engineering evidence; it does not replace legal
review of the intended channels, regions or patent exposure.

## License map

| Component | License | Role in the distribution |
| --- | --- | --- |
| Audivane application code | MIT, copyright 2026 Triet (@Triet1402) | Original source and client/desktop JavaScript |
| FFmpeg / ffprobe 9.0.2 | LGPL-2.1-or-later (`--enable-gpl`/`--enable-nonfree` absent) | Native codec executables |
| liblc3 1.1.3 | Apache-2.0 | Static dependency of FFmpeg; optional browser LC3 module |
| libsoxr 0.1.3 | LGPL-2.1-or-later | Static dependency of FFmpeg |
| libogg 1.3.5, libvorbis 1.3.7, libopus 1.5.2 | BSD-3-Clause | Static dependencies of FFmpeg |
| LAME 3.100 | LGPL-2.0-or-later | Static dependency of FFmpeg |
| TwoLAME 0.4.0 | LGPL-2.1-or-later | Static dependency of FFmpeg |
| AOSP libldac (`eeee1a3f…`) | Apache-2.0, including AOSP `NOTICE` | Static dependency of `ldac_helper`; optional browser LDAC module |
| hegdi/libldacdec (`7f3bd6cc…`) | MIT, copyright 2021 Dirk Helbig | Static dependency of `ldac_helper`; optional browser LDAC module |
| Electron 45.1.0 / Chromium / Node.js | MIT plus Chromium third-party licenses | Desktop runtime; packager preserves `LICENSE` and `LICENSES.chromium.html` |
| React / React DOM 19.3.1 | MIT | Bundled client JavaScript |
| Audivane Sans/Mono Latin (derived from IBM Plex) | SIL Open Font License 1.1 | Self-hosted fonts; `apps/client/public/ibm-plex-OFL.txt` |
| Measurement attribution | MIT notice in `packages/measurements/NOTICE.md` | Translated loudness implementation and retained comparison code |
| `@ffmpeg/ffmpeg` 0.12.15 | MIT | Browser wrapper |
| `@ffmpeg/core` 0.12.10 | GPL-2.0-or-later | Browser WASM core (not a native desktop codec) |

Do not replace any dependency license with the project's MIT license. MIT
applies to Audivane's own code only.

## Generate the native materials

`third_party/release-materials.json` pins every source archive URL and either the
archive SHA-256 or, where the upstream regenerates archive bytes (Android
Gitiles), a canonical content SHA-256. The collector downloads (or reuses) those
exact archives and verifies the pin, extracts the complete upstream
license/notice texts, copies the build payload and writes a hashed inventory:

```bash
node tools/collect-third-party-materials.mjs
# -> build/release-materials/
```

```text
build/release-materials/
  licenses/<component>/...        complete upstream license/notice files
  sources/<archive>               exact pinned source archives (verified)
  application/<component>/...     Electron, Chromium, font, measurement, JS notices
  build/...                       pinned build scripts and helper C source
  provenance/...                  VERSION, BASELINE, package versions, audits
  NOTICES.md                      human-readable notice inventory
  SOURCE-OFFER.md                 exact source URLs and rebuild/relink instructions
  MANIFEST.json                   every material file with its SHA-256
```

Useful variants:

```bash
# reuse source archives already downloaded for the baseline build
node tools/collect-third-party-materials.mjs \
  --source-cache build/source-cache

# no network; fail if an archive is missing
node tools/collect-third-party-materials.mjs --offline

# verify an existing materials tree against MANIFEST.json
node tools/collect-third-party-materials.mjs --verify
```

The collector includes the produced `VERSION.txt` files and the provenance
audit from `build/linux-baseline/` when they exist. It also includes the
Electron/Chromium, IBM Plex, measurement and React notices so application
attribution is not lost when packaging changes.

## Recorded collection

On 2026-11-04 the collector produced a verified tree for the Ubuntu 24.04
baseline build. It contained the ten pinned source components, the Electron /
Chromium, IBM Plex, measurement, React and FFmpeg-wrapper notices, the build
scripts, both `VERSION.txt` files, `BASELINE.txt`, `package-versions.txt` and the
40-check provenance audit. `--verify` confirmed every file against
`MANIFEST.json`.

The generated tree lives under `build/release-materials/` and is not committed.
Re-run the collector after changing the inventory, the build scripts or the
built artifacts so the notice and source payload stays tied to the exact bytes.

## Corresponding source and relinking

FFmpeg and the LGPL libraries are statically linked into the two native
executables. The material set provides:

- every exact source archive, pinned by archive or content SHA-256;
- the exact `./configure` line and archive hashes in `VERSION.txt`;
- the build scripts (`tools/build_ffmpeg.sh`, `tools/build_ldac_helper.sh`,
  `tools/build_linux_baseline.sh`) and the LDAC helper C source;
- the baseline audit, rootfs identity, package versions and binary hashes.

That is enough to rebuild the executables from source and to relink modified
LGPL components. A public release should place `NOTICES.md`, the license tree
and the source offer beside the binaries (or provide a durable equivalent
download offer for the same exact sources). Retain the material for as long as
the binary is distributed.

## Browser WASM and desktop exclusion

The browser build ships `@ffmpeg/core` 0.12.10, which declares
`GPL-2.0-or-later`, plus supplemental LC3/LDAC WASM built from the same pinned
native sources. The desktop application executes native codecs. Its build removes unused browser
WASM/glue assets; packaged acceptance verifies exclusion and native listening.

Consequences:

- **Desktop:** native executable licenses above apply. The browser WASM assets are excluded from desktop installers and the package
  contract checks this on actual artifact contents.
- **Web:** GPL-2.0-or-later and supplemental WASM obligations still apply even
  when a page does not execute them, because the files are served. The web
  release needs the complete corresponding source/build materials for the
  exact `@ffmpeg/core` package and the supplemental WASM builds. The native
  source archives here are necessary but not sufficient for the prebuilt
  `@ffmpeg/core` package.

## Preserved notices

Keep these with the release:

- Electron's `LICENSE` and `LICENSES.chromium.html` from the packaged runtime
  (the Electron packager copies them; do not overwrite them).
- `apps/client/public/ibm-plex-OFL.txt` beside the IBM Plex font assets.
- `packages/measurements/NOTICE.md` (packaged as
  `resources/app/measurements-NOTICE.md`).
- The project `LICENSE` and the current `THIRD_PARTY_NOTICES.md` copied into
  `resources/app` by the packager.

## Remaining gates

- [x] Pin exact native sources and build commands.
- [x] Build the Linux baseline inside Ubuntu 24.04 / glibc 2.39.
- [x] Collect complete native license/notice texts and matching source archives.
- [x] Provide a machine-checkable material manifest and provenance audit.
- [ ] Legal review of the intended channels, regions and codec patent exposure.
- [x] Collect and verify browser core and supplemental WASM source/build/license
  materials with `tools/collect-browser-materials.mjs`. Serve the matching payload
  alongside each deployed demo; see [evidence and bounds](../website/BROWSER-MATERIALS.md).
- [x] Implement and exercise packaged checks excluding unused browser WASM
  assets in recorded desktop candidates; rerun for the final packages.
- [x] Collect Windows source/notice materials for the recorded cross-produced
  candidate (see below).
- [ ] Collect and verify matching materials for the final Windows build; a native
  MSYS2 rebuild needs its own toolchain/runtime inventory.
- [ ] Review the final archive/installer contents, not only the checkout.

See [Linux native build](linux-native-build.md) for the baseline and
[third-party inventory](../THIRD_PARTY_NOTICES.md) for the short release-facing
table.

## Windows cross-produced candidate

The recorded Linux cross-produced Windows candidate additionally collects
MinGW-w64 11.0.1 (including winpthreads), its Ubuntu patches, GCC 13.2.0 runtime
source and Runtime Library Exception, the GCC MinGW build recipe, and NSIS 3.10
source plus Ubuntu patches. Their archive hashes are pinned in
`third_party/release-materials.json` and selected only with `--platform win32`.
The exact provisioned compiler/NSIS package versions, download URLs and SHA-256
values are in `third_party/windows-build-tools.json`.

```sh
node tools/collect-third-party-materials.mjs --platform win32 \
  --artifacts build/windows-native-bundle --output build/release-materials-windows
node tools/distribution/prepare-materials.mjs win32 \
  build/windows-native-bundle build/release-materials-windows
```

This supplies complete codec/runtime/installer source and notice materials for
the recorded cross candidate. It is not Windows execution acceptance. A native
MSYS2 rebuild must replace the cross compiler/runtime inventory with its own
exact package versions, sources and notices; do not describe the recorded cross
toolchain inventory as evidence for a different native MSYS2 build.
