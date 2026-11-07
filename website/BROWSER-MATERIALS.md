# Browser WASM release materials

Status: **materials complete for the matching source/build/license gate**. This
page records the exact browser codec bytes served by the demo, the upstream
sources they are inferred to come from, the verified source archive set, and
the evidence bounds that remain. Publishing is authorized by the project owner;
this page is release engineering evidence, not a claim that the demo is audible
or codec-conformant.

The desktop material set does not close this gate. The browser serves
`@ffmpeg/core` 0.12.10 (GPL-2.0-or-later) plus locally built LC3/LDAC WASM, so
the web release needs its own corresponding-source/build payload. The parent
integration will serve this material tree under `/sources/browser/` and link
`NOTICES.md` from the demo.

## Exact bytes in the browser tier

| Asset | SHA-256 | Evidence |
| --- | --- | --- |
| `@ffmpeg/core` 0.12.10 npm tarball | `d00089ce82e1bdf637ddbe42e0c3d41a1ba8cf4c9e825e7fa4d0bb970e844bd4` | Registry tarball re-downloaded and verified; SHA-1 `3177e888…`, npm integrity `sha512-dzNp…` |
| `dist/esm/ffmpeg-core.js` | `67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3` | npm tarball == `node_modules` == `apps/client/public/codec-assets` |
| `dist/esm/ffmpeg-core.wasm` | `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7` | Same three copies; 32,232,419 bytes |
| `dist/umd/ffmpeg-core.js` | `b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21` | npm tarball |
| `dist/umd/ffmpeg-core.wasm` | `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7` | Same wasm as ESM |
| `lc3_codec.js` | `38e628d47124fbde346c219bd81417e30a6c32af2dac88b38c4ceb95267db9c0` | `third_party/wasm/bin` manifest == served copy |
| `lc3_codec.wasm` | `ca703c830295ba27b6c45b830e64a4f6ebcf762537703a4d70ac275183e83619` | Same; reproduced byte-for-byte |
| `ldac_codec.js` | `066f71a7252e8e7a66e6b61247bba6f487fd3a7405f6dd6b90abe4633ff0c21b` | Same |
| `ldac_codec.wasm` | `64b40d8932c303df83f233606e67d0361ad577dfc380a37d509a031e416d1750` | Same; reproduced only under the conditions below |

The installed package and the served copies were compared, not just the
lockfile. `apps/client/public/codec-assets/` currently matches these hashes.

## Source references

`@ffmpeg/core` 0.12.10 is **not** built from the tag named `v0.12.10`.

| Reference | Value | Why it matters |
| --- | --- | --- |
| Wrong tag `v0.12.10` | `c3a763857c5e615ae8674715ad5e4f63ff469e9d` (2023) | Its `packages/core/package.json` says `0.12.6`/MIT and its build has no ffprobe or worker-only environment |
| Release metadata commit | `71aa99d37c02a7b4c435275ca9ef50e612f6efa1` (tag `v12.15`) | Sets `packages/core/package.json` to `0.12.10`/GPL-2.0-or-later; 26 seconds before the npm publish |
| Last build-affecting commit | `bd903bbf18d133dc9add2149a2e921c392309451` (2024-08-30) | No `Dockerfile`, `Makefile`, `build/`, `src/bind/` or `src/fftools/` change between it and the release commit |
| npm publish time | `2025-01-07T10:13:14.328Z` | Matches the release sequence; npm records no `gitHead` |

The published wasm embeds `emcc 3.1.40` and FFmpeg version `5.1.4`; the JS
contains the ffprobe binding introduced after the wrong tag. That is strong
inference, not attestation: the packument has no `gitHead`, no npm provenance
attestation, and the package was published from a local `file:` tarball
(`_from: file:ffmpeg-core-0.12.10.tgz`).

The core build recipe (`71aa99d`) uses `emscripten/emsdk:3.1.40`, FFmpeg
`n5.1.4`, and these dependency refs. All are now pinned to immutable commits:

| Component | Ref used by Dockerfile | Pinned commit | Archive SHA-256 |
| --- | --- | --- | --- |
| FFmpeg 5.1.4 | `n5.1.4` | `4729204c17f756e186d622060088371d10b34f7e` | `0d7ad57d4dd851d577fc6c19e5cec5b6e5faaeb2dbd52ab76127e3c3763fec6d` |
| x264 | branch `4-cores` | `33cac6b77d5b9259c552156013a817ab23119612` | `75434a5a1f2d7d4314821c6054dd300731d69e2fa73314ba4a5ec9df38d4ec80` |
| x265 3.4 | `3.4` | `2bb5520e9596f361bf0ed81b3b8da0d7fd999069` | `e5254828f5db7bc375d385e31247861d25facee87b43fa2d08ea3ab5569672ab` |
| libvpx 1.13.1 | `v1.13.1` | `10b9492dcf05b652e2e4b370e205bd605d421972` | `12181ed27342415e8b01bf09abfbf1dfa27a6a32f302fb78b48bd70efe50f702` |
| LAME 3.100 | branch `master` | `2badea1974ae36cb8312afe99cff1e6b3b5decee` | `0d97ba0776988f5730e0ce1fa936e7c5d6836c757993ba55073513fe89cf410a` |
| Ogg 1.3.4 | `v1.3.4` | `bada45718453ac27b56773ae663f7e65112f6a6e` | `4d61f8dfa248276c42bd5404b1a87ae9d8a0d58791f55e20018c7b39b38d8823` |
| Theora 1.1.1 | `v1.1.1` | `7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf` | `c38e6a3fb19566a44dcb283323c48311dd484f1416f3f34676d3e7fd252dfbc5` |
| Opus 1.3.1 | `v1.3.1` | `e85ed7726db5d677c9c0677298ea0cb9c65bdd23` | `c6d574b17d70b8c289d997a8ac81314cf1fd8c52237c421b2ee34e69cea85bf8` |
| Vorbis 1.3.3 | `v1.3.3` | `7798164043197d7e33f02de4353ce2aa5b248225` | `69b87cafe2815d02609886a63b9d4c0b7461e1e2f6ecf3960ede04053da6e96a` |
| zlib 1.2.11 | `v1.2.11` | `cacf7f1d4e3d44d871b605da3b647f07d718623f` | `6d4d6640ca3121620995ee255945161821218752b551a1a180f4215f7d124d45` |
| libwebp 1.3.2 | `v1.3.2` | `ca332209cb5567c9b249c86788cb2dbf8847e760` | `1676107dc385f9bf6cb4c2b94d4a9359d1fd95ab6309cb587191a742df292fe2` |
| FreeType 2.10.4 | `VER-2-10-4` | `6a2b3e4007e794bfc6c91030d0ed987f925164a8` | `09acceb42508c65b7b744cc2ad01d7548868ca57babc39f7683ec3c0f7541e8c` |
| FriBidi 1.0.9 | `v1.0.9` | `f9e8e71a6fbf4a4619481284c9f484d10e559995` | `65ff6fb1a478c4d90ae16825da8c97b8a63e2674f8a2d6dae8800f89089640ba` |
| HarfBuzz 5.2.0 | `5.2.0` | `4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde` | `69ba7c7a42643a3654781242016dd09245cab7353fc2a02cecb710e479c9a881` |
| libass 0.15.0 | `0.15.0` | `d149636f502f5774ae1a8fb4c554b122674393b2` | `5cfe23562fa623a3b209d156ad469aeb2e31f69bf6b256ea737d87d9ed89301d` |
| zimg 3.0.5 | `release-3.0.5` | `e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87` | `3ab062eff30067799997bc3e911c0108a5b8cbcd6e0ef14053f17ff0ecd0add8` |
| SDL 2.24.2 | Emscripten 3.1.40 `sdl2` port | `55b03c7493a7abed33cf803d1380a40fa8af903f` | `a726e31f8ad9443a2a9a649f12751442d8ca5ea78a84fde14f760c81706b4127` |
| Emscripten 3.1.40 | `emscripten/emsdk:3.1.40` | emscripten `5c27e79dd0a9c4e27ef2326841698cdd4f6b5784`, emsdk `ae245715ef50e036b68a2412a323129676bf8300` | `3eb9ea2d…` / `74ca62e6…` |

SDL's source is fixed by Emscripten 3.1.40's
`tools/ports/sdl2.py` (`TAG=release-2.24.2`, SHA-512 `b178bdc8…`), not by the
ffmpeg.wasm Dockerfile.

The supplemental modules use liblc3 1.1.3
(`276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af`), AOSP
libldac `eeee1a3f…` (canonical content hash
`ebba69bc820b93c2ea4c49feaee9e82ffabdb604f89f6c332c2fe922ff3b4d95`), and
hegdi/libldacdec `7f3bd6cc…`
(`c6a1cde751cb18f69ccf7d8817f24972560be4e62b3fdbe75159c1207bc5a046`), plus
`tools/lc3_wasm.c`, `tools/ldac_wasm.c` and `tools/build_codec_wasm.sh`. The
toolchain is Emscripten/emsdk 6.0.13 (emscripten
`e13ee988ce3d87a738dd8f3661d02223308c412a`, emsdk
`35659964bc2762fffec0d257997fb61475f765b7`).

## Collector and artifacts

`tools/collect-browser-materials.mjs` verifies the npm tarball, installed
package, served codec assets and supplemental pair manifests; checks that every
source repository fetched by the core Dockerfile maps to a verified archive
component; downloads the pinned source archives; extracts complete license
texts and the ffmpeg.wasm Dockerfile/bind/fftools build payload; and writes a
hashed inventory plus a machine-readable completeness/evidence report.

```sh
# full evidence tree and deployable archive, including optional compiler sources
node tools/collect-browser-materials.mjs \
  --source-cache /tmp/opencode/browser-src \
  --output build/browser-materials \
  --include-toolchain-sources \
  --bundle build/browser-materials.tar.gz

node tools/collect-browser-materials.mjs --verify \
  --output build/browser-materials

# exits 0: every required source archive is present
node tools/collect-browser-materials.mjs --require-complete \
  --offline --output build/browser-materials --include-toolchain-sources
```

Current run: 132 files, 21 required source archives, 4 toolchain archives, all
hashes verified, **missing sources: none**. `--require-complete` exits 0. The
tree lives under ignored `build/browser-materials/` (~220 MB with toolchains,
~160 MB without). The deployable archive is
`build/browser-materials.tar.gz` (174 MB, SHA-256
`f1e37af4902661a6094886934075dec8d7a4d4cac7f9503c5c38cee8d15f3d72`); its
sidecar is `build/browser-materials.tar.gz.sha256`. No source archive is
committed or placed under `website/public`; the collector is the reproducible
way to regenerate the tree, and the parent will serve it at
`/sources/browser/`.

Key artifacts:

- `build/browser-materials/REPORT.json` — source completeness and evidence bounds
- `build/browser-materials/MANIFEST.json` — every file with size and SHA-256
- `build/browser-materials/NOTICES.md` — license inventory
- `build/browser-materials/SOURCE-OFFER.md` — source URLs and rebuild notes
- `build/browser-materials/SERVING.md` — layout for `/sources/browser/`
- `build/browser-materials/distributed/` — exact npm and supplemental bytes
- `build/browser-materials/provenance/source-evidence.json` — source-ref inference
- `build/browser-materials/provenance/supplemental-reproduction.json` — LC3/LDAC reproduction conditions

## Supplemental WASM reproduction

Both supplemental modules reproduce byte-for-byte with the recorded Emscripten
6.0.13 toolchain and the exact pinned sources, but only when:

```sh
LC_ALL=C \
CODEC_WASM_BUILD_DIR=/tmp/opencode/codec-wasm-build \
CODEC_WASM_EMSDK_DIR=/tmp/opencode/emsdk \
tools/build_codec_wasm.sh
```

Two non-obvious inputs are part of the build identity:

1. **Locale.** Under the normal `en_US.UTF-8` locale, the bash wildcard link
   order differs. LC3 is unchanged, but `ldac_codec.wasm` becomes
   `ce39de9e03dadf19e5f9fdeb0e4f9143fb57542cb1d5e29c860b94c68c20647e` instead of
   the served `64b40d89…`.
2. **Absolute build directory.** `libldacdec.c` assertion data embeds the source
   path. A different `CODEC_WASM_BUILD_DIR` changes `ldac_codec.wasm` even under
   `LC_ALL=C`.

`tools/build_codec_wasm.sh` currently installs emsdk `latest`, records only the
`emcc --version` string, and sets neither variable. The exact sources and served
bytes are therefore collected and reproducible, but a clean-room rebuild is not
hermetic with the script as written. This is recorded as a reproducibility note,
not a claim that the permissively licensed LC3/LDAC source is missing.

## Source completeness and serving

- **21 required source archives are present and hash-verified; none are
  missing.** The collector validates that every repository fetched by the core
  Dockerfile maps to a verified component, that the Emscripten 3.1.40 SDL2 port
  source is included, and that the supplemental LC3/LDAC sources are included.
- The deployable archive is `build/browser-materials.tar.gz` (174 MB, SHA-256
  `f1e37af4902661a6094886934075dec8d7a4d4cac7f9503c5c38cee8d15f3d72`). It
  contains `sources/`, `licenses/`, `build/`, `distributed/`, `toolchain/`,
  `provenance/`, `NOTICES.md`, `SOURCE-OFFER.md`, `SERVING.md`, `REPORT.json`
  and `MANIFEST.json`.
- The parent integration will serve the tree at `/sources/browser/` and link
  `NOTICES.md` from the demo. `SERVING.md` records the required layout.
- `--require-complete` exits 0 and the collector aborts if a required archive is
  missing or does not match its pin.

## Evidence bounds (not publication gates)

1. **Core source ref is inferred.** The npm package has no `gitHead` or
   provenance attestation, so `71aa99d`/`bd903bb` is identified from the publish
   time, package metadata and embedded emcc/FFmpeg versions. The complete source
   archive set for that inferred ref is present. This bounds certainty about the
   byte/source link; it does not mean a source archive is missing.
2. **No byte-for-byte core rebuild was performed here.** The recorded
   environment had no Docker. Bit-identical reproduction is not required by the
   matching-materials gate; it would only add an independent byte/source check.
3. **Supplemental rebuild conditions are documented.** `LC_ALL=C` and the exact
   build directory are part of the observed build identity. Both modules were
   rebuilt byte-for-byte under those conditions; the sources and served bytes
   are complete.
4. **Toolchain source scope.** Emscripten/emsdk archives are included. LLVM,
   Binaryen and Node are recorded by version/identity but their full source
   trees are not bundled; they are compilers, not linked work.

## Publication status

No credential access, deployment, branch push, commit or public claim was made
by this task. The parent owns the demo deployment and the `/sources/browser/`
serving decision. This page does not claim audio conformance or audibility.

## What is closed

- Exact npm tarball, installed package and served `ffmpeg-core` bytes match.
- The wrong `v0.12.10` tag was identified and replaced with the inferred
  `v12.15`/`71aa99d` release source and `bd903bb` build-affecting source.
- Every dependency used by the core Dockerfile is pinned to an immutable commit
  with a verified source archive; the GPL/LGPL and permissive license texts are
  extracted. No required source is missing.
- The supplemental LC3/LDAC pairs, source refs, toolchain pins and served bytes
  match, and both modules were rebuilt byte-for-byte under documented
  conditions.
- A collector with `--verify`, `--require-complete` and `--bundle` makes the
  matching-materials gate machine-checkable and produces the deployable archive.

## Reproduction checks

```sh
# machine identity
node -e "console.log(require('./node_modules/@ffmpeg/core/package.json').version)"
sha256sum node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm

# registry tarball identity (matches package-lock.json integrity)
curl -fsSL https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz \
  -o /tmp/core-0.12.10.tgz
sha256sum /tmp/core-0.12.10.tgz   # d00089ce82e1bdf637ddbe42e0c3d41a1ba8cf4c9e825e7fa4d0bb970e844bd4

# supplemental pair identity
sha256sum third_party/wasm/bin/*.js third_party/wasm/bin/*.wasm

# collector verification
node tools/collect-browser-materials.mjs --verify --output build/browser-materials
```

This page does not claim audio conformance, audibility or codec readiness.
