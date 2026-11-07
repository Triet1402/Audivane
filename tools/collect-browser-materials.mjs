#!/usr/bin/env node
/**
 * Collect license, notice, exact-source and build materials for the browser
 * codec assets served by the web application.
 *
 * The browser tier is a different distribution obligation from the native
 * desktop bundle. It serves:
 *
 *   @ffmpeg/core 0.12.10          GPL-2.0-or-later WASM core (prebuilt npm)
 *   lc3_codec.{js,wasm}           local liblc3 1.1.3 WASM build
 *   ldac_codec.{js,wasm}          local AOSP libldac + hegdi/libldacdec build
 *
 * This collector verifies the exact distributed bytes, downloads the source
 * archives for the inferred build provenance, extracts the complete license
 * texts and the build scripts, and writes a hashed inventory:
 *
 *   distributed/...               exact npm tarball, package files and served
 *                                 supplemental modules with their hashes
 *   sources/...                   exact upstream source archives (verified)
 *   toolchain/...                 optional Emscripten/emsdk source archives
 *   licenses/<component>/...      complete upstream license/notice files
 *   build/...                     build scripts, glue sources and extracted
 *                                 ffmpeg.wasm Dockerfile/build files
 *   provenance/...                source-ref evidence, reproduction record,
 *                                 toolchain pins and evidence bounds
 *   NOTICES.md                    human-readable notice inventory
 *   SOURCE-OFFER.md               source URLs, build and reproduction notes
 *   REPORT.json                   machine-readable source completeness and
 *                                 evidence bounds
 *   MANIFEST.json                 every material file with its SHA-256
 *
 * Usage:
 *   node tools/collect-browser-materials.mjs
 *   node tools/collect-browser-materials.mjs --output build/browser-materials
 *   node tools/collect-browser-materials.mjs --source-cache /tmp/opencode/browser-src
 *   node tools/collect-browser-materials.mjs --include-toolchain-sources
 *   node tools/collect-browser-materials.mjs --offline
 *   node tools/collect-browser-materials.mjs --bundle build/browser-materials.tar.gz
 *   node tools/collect-browser-materials.mjs --verify
 *   node tools/collect-browser-materials.mjs --require-complete
 *
 * The collector makes no claim that the browser demo is audible or conformant.
 * `--require-complete` fails only when a required source archive is missing.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCHEMA = "audivane-browser-materials-v1";
const DEFAULT_OUTPUT = path.join(ROOT, "build", "browser-materials");
const DEFAULT_CACHE = "/tmp/opencode/audivane-browser-source-cache";
const CORE_VERSION = "0.12.10";

/**
 * The npm package is the distributed authority. Its tarball hash and every
 * file hash below were observed from the package installed by package-lock.json
 * and cross-checked against the registry tarball. A changed package version or
 * changed bytes must update this table deliberately.
 */
const NPM_CORE = {
  name: "@ffmpeg/core",
  version: CORE_VERSION,
  license: "GPL-2.0-or-later",
  tarball: {
    url: `https://registry.npmjs.org/@ffmpeg/core/-/core-${CORE_VERSION}.tgz`,
    filename: `core-${CORE_VERSION}.tgz`,
    bytes: 20634719,
    sha1: "3177e88852bfbfaad5d258e9e0ac1fd9dffd3223",
    sha256: "d00089ce82e1bdf637ddbe42e0c3d41a1ba8cf4c9e825e7fa4d0bb970e844bd4",
    integrity: "sha512-dzNplnn2Nxle2c2i2rrDhqcB19q9cglCkWnoMTDN9Q9l3PvdjZWd1HfSPjCNWc/p8Q3CT+Es9fWOR0UhAeYQZA==",
  },
  files: {
    "package/package.json": "2d55b1f6df4c62955f286ae41b7ca6b27bb4165136ca7572d4101abe147695e0",
    "package/dist/esm/ffmpeg-core.js": "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3",
    "package/dist/esm/ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
    "package/dist/umd/ffmpeg-core.js": "b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21",
    "package/dist/umd/ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
  },
  source: {
    repository: "https://github.com/ffmpegwasm/ffmpeg.wasm",
    releaseCommit: "71aa99d37c02a7b4c435275ca9ef50e612f6efa1",
    releaseTag: "v12.15",
    releaseCommitTime: "2025-01-07T11:12:48+01:00",
    publishedAt: "2025-01-07T10:13:14.328Z",
    lastBuildAffectingCommit: "bd903bbf18d133dc9add2149a2e921c392309451",
    lastBuildAffectingTime: "2024-08-30T14:56:48+00:00",
    buildAffectingPaths: ["Dockerfile", "Makefile", "build/", "src/bind/", "src/fftools/"],
    tagTrap: {
      tag: "v0.12.10",
      commit: "c3a763857c5e615ae8674715ad5e4f63ff469e9d",
      packageVersionAtTag: "0.12.6",
      declaredLicenseAtTag: "MIT",
      whyWrong: "The tag named v0.12.10 is the 2023 v0.12.6-era release: its package.json says 0.12.6/MIT and its build has no ffprobe or worker-only environment. It is not the source of npm @ffmpeg/core 0.12.10.",
    },
    inference: "The npm publication has no gitHead or provenance attestation. The release commit 71aa99d (tag v12.15) is 26 seconds before the npm publish time and sets packages/core/package.json to 0.12.10/GPL-2.0-or-later. The last build-affecting change before it is bd903bb (2024-08-30); no Dockerfile/Makefile/build/src change occurs between bd903bb and 71aa99d. The published wasm embeds emcc 3.1.40 and FFmpeg 5.1.4 and the JS contains the ffprobe binding. This identifies 71aa99d as the release source and bd903bb as the last build-affecting source, but it is inference, not upstream attestation.",
  },
};

/**
 * Exact bytes currently produced by tools/build_codec_wasm.sh and copied into
 * apps/client/public/codec-assets. The .sha256 manifests in third_party/wasm/bin
 * must agree with these values; a rebuild that changes any pair requires this
 * table, the manifests, the served files and the documentation to change
 * together.
 */
const SUPPLEMENTAL = {
  version: "2026-11-01",
  emccVersion: "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.13 (e13ee988ce3d87a738dd8f3661d02223308c412a)",
  files: {
    "lc3_codec.js": "38e628d47124fbde346c219bd81417e30a6c32af2dac88b38c4ceb95267db9c0",
    "lc3_codec.wasm": "ca703c830295ba27b6c45b830e64a4f6ebcf762537703a4d70ac275183e83619",
    "ldac_codec.js": "066f71a7252e8e7a66e6b61247bba6f487fd3a7405f6dd6b90abe4633ff0c21b",
    "ldac_codec.wasm": "64b40d8932c303df83f233606e67d0361ad577dfc380a37d509a031e416d1750",
  },
  reproduction: {
    status: "reproduced-byte-identical-with-documented-conditions",
    verifiedAt: "2026-11-06",
    conditions: [
      "Emscripten 6.0.13 / emsdk 6.0.13 at emscripten commit e13ee988ce3d87a738dd8f3661d02223308c412a",
      "LC_ALL=C at build and link time (bash wildcard ordering changes wasm function/link order and therefore the LDAC bytes)",
      "CODEC_WASM_BUILD_DIR=/tmp/opencode/codec-wasm-build (the absolute source path is embedded in libldacdec.c assertion data; a different path changes ldac_codec.wasm)",
      "sources pinned by third_party/wasm/VERSION.txt and tools/build_codec_wasm.sh",
    ],
    command: "LC_ALL=C CODEC_WASM_BUILD_DIR=/tmp/opencode/codec-wasm-build CODEC_WASM_EMSDK_DIR=/tmp/opencode/emsdk tools/build_codec_wasm.sh",
    withoutLocalePin: "With the caller's normal (en_US.UTF-8) locale the LDAC link order differs and ldac_codec.wasm becomes ce39de9e03dadf19e5f9fdeb0e4f9143fb57542cb1d5e29c860b94c68c20647e. LC3 is unaffected (ca703c83...).",
    withoutPathPin: "A different CODEC_WASM_BUILD_DIR embeds a different libldacdec.c path and changes ldac_codec.wasm even under LC_ALL=C.",
  },
};

const L = (archivePath, as = path.basename(archivePath)) => ({ archivePath, as });

/**
 * Every archive below is a primary upstream source archive. `commit` is the
 * immutable object used by the upstream Dockerfile. Branch names are retained
 * only as provenance for how the Dockerfile addressed the source; the commit
 * is what the material set pins.
 */
const COMPONENTS = [
  {
    id: "ffmpeg-wasm",
    name: "ffmpeg.wasm browser build (Dockerfile, bindings and build scripts)",
    version: `0.12.10 (tag ${NPM_CORE.source.releaseTag})`,
    license: "MIT for ffmpeg.wasm glue; the built FFmpeg core is GPL-2.0-or-later",
    ref: NPM_CORE.source.releaseTag,
    commit: NPM_CORE.source.releaseCommit,
    repository: NPM_CORE.source.repository,
    role: "Build recipe and FFmpeg fftools/bind overlay for the distributed @ffmpeg/core WASM.",
    archive: {
      filename: "ffmpeg.wasm-71aa99d.tar.gz",
      url: `https://codeload.github.com/ffmpegwasm/ffmpeg.wasm/tar.gz/${NPM_CORE.source.releaseCommit}`,
      sha256: "53c5842f160cece0e39345876f9483b56aa84b966637ff6f624353a0fa884219",
    },
    licensePaths: [L("LICENSE")],
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    version: "5.1.4",
    license: "GPL-2.0-or-later for this build (configured with --enable-gpl)",
    ref: "n5.1.4",
    commit: "4729204c17f756e186d622060088371d10b34f7e",
    repository: "https://github.com/FFmpeg/FFmpeg",
    role: "FFmpeg libraries and fftools compiled into the distributed core. The upstream Dockerfile references git tag n5.1.4; this archive is that exact commit.",
    archive: {
      filename: "ffmpeg-5.1.4.tar.gz",
      url: "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/4729204c17f756e186d622060088371d10b34f7e",
      sha256: "0d7ad57d4dd851d577fc6c19e5cec5b6e5faaeb2dbd52ab76127e3c3763fec6d",
    },
    licensePaths: [
      L("COPYING.GPLv2"),
      L("COPYING.GPLv3"),
      L("COPYING.LGPLv2.1"),
      L("COPYING.LGPLv3"),
      L("LICENSE.md"),
    ],
  },
  {
    id: "x264",
    name: "ffmpegwasm/x264",
    version: "branch 4-cores at 33cac6b (x264 core)",
    license: "GPL-2.0-or-later",
    ref: "4-cores",
    commit: "33cac6b77d5b9259c552156013a817ab23119612",
    repository: "https://github.com/ffmpegwasm/x264",
    role: "Linked with --enable-gpl --enable-libx264 in the core.",
    archive: {
      filename: "x264-33cac6b.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/x264/tar.gz/33cac6b77d5b9259c552156013a817ab23119612",
      sha256: "75434a5a1f2d7d4314821c6054dd300731d69e2fa73314ba4a5ec9df38d4ec80",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "x265",
    name: "ffmpegwasm/x265",
    version: "3.4",
    license: "GPL-2.0-or-later",
    ref: "3.4",
    commit: "2bb5520e9596f361bf0ed81b3b8da0d7fd999069",
    repository: "https://github.com/ffmpegwasm/x265",
    role: "Linked with --enable-gpl --enable-libx265 in the core.",
    archive: {
      filename: "x265-3.4.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/x265/tar.gz/2bb5520e9596f361bf0ed81b3b8da0d7fd999069",
      sha256: "e5254828f5db7bc375d385e31247861d25facee87b43fa2d08ea3ab5569672ab",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "libvpx",
    name: "ffmpegwasm/libvpx",
    version: "1.13.1",
    license: "BSD-3-Clause",
    ref: "v1.13.1",
    commit: "10b9492dcf05b652e2e4b370e205bd605d421972",
    repository: "https://github.com/ffmpegwasm/libvpx",
    role: "Linked with --enable-libvpx in the core.",
    archive: {
      filename: "libvpx-1.13.1.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/libvpx/tar.gz/10b9492dcf05b652e2e4b370e205bd605d421972",
      sha256: "12181ed27342415e8b01bf09abfbf1dfa27a6a32f302fb78b48bd70efe50f702",
    },
    licensePaths: [L("LICENSE")],
  },
  {
    id: "lame",
    name: "ffmpegwasm/lame",
    version: "3.100",
    license: "LGPL-2.0-or-later",
    ref: "master",
    commit: "2badea1974ae36cb8312afe99cff1e6b3b5decee",
    repository: "https://github.com/ffmpegwasm/lame",
    role: "Linked with --enable-libmp3lame in the core.",
    archive: {
      filename: "lame-3.100.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/lame/tar.gz/2badea1974ae36cb8312afe99cff1e6b3b5decee",
      sha256: "0d97ba0776988f5730e0ce1fa936e7c5d6836c757993ba55073513fe89cf410a",
    },
    licensePaths: [L("COPYING"), L("LICENSE")],
  },
  {
    id: "libogg",
    name: "ffmpegwasm/Ogg",
    version: "1.3.4",
    license: "BSD-3-Clause",
    ref: "v1.3.4",
    commit: "bada45718453ac27b56773ae663f7e65112f6a6e",
    repository: "https://github.com/ffmpegwasm/Ogg",
    role: "Linked for Ogg container support in the core.",
    archive: {
      filename: "ogg-1.3.4.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/Ogg/tar.gz/bada45718453ac27b56773ae663f7e65112f6a6e",
      sha256: "4d61f8dfa248276c42bd5404b1a87ae9d8a0d58791f55e20018c7b39b38d8823",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "theora",
    name: "ffmpegwasm/theora",
    version: "1.1.1",
    license: "BSD-3-Clause",
    ref: "v1.1.1",
    commit: "7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf",
    repository: "https://github.com/ffmpegwasm/theora",
    role: "Linked with --enable-libtheora in the core.",
    archive: {
      filename: "theora-1.1.1.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/theora/tar.gz/7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf",
      sha256: "c38e6a3fb19566a44dcb283323c48311dd484f1416f3f34676d3e7fd252dfbc5",
    },
    licensePaths: [L("COPYING"), L("LICENSE")],
  },
  {
    id: "opus",
    name: "ffmpegwasm/opus",
    version: "1.3.1",
    license: "BSD-3-Clause",
    ref: "v1.3.1",
    commit: "e85ed7726db5d677c9c0677298ea0cb9c65bdd23",
    repository: "https://github.com/ffmpegwasm/opus",
    role: "Linked with --enable-libopus in the core.",
    archive: {
      filename: "opus-1.3.1.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/opus/tar.gz/e85ed7726db5d677c9c0677298ea0cb9c65bdd23",
      sha256: "c6d574b17d70b8c289d997a8ac81314cf1fd8c52237c421b2ee34e69cea85bf8",
    },
    licensePaths: [L("COPYING"), L("LICENSE_PLEASE_READ.txt")],
  },
  {
    id: "vorbis",
    name: "ffmpegwasm/vorbis",
    version: "1.3.3",
    license: "BSD-3-Clause",
    ref: "v1.3.3",
    commit: "7798164043197d7e33f02de4353ce2aa5b248225",
    repository: "https://github.com/ffmpegwasm/vorbis",
    role: "Linked with --enable-libvorbis in the core.",
    archive: {
      filename: "vorbis-1.3.3.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/vorbis/tar.gz/7798164043197d7e33f02de4353ce2aa5b248225",
      sha256: "69b87cafe2815d02609886a63b9d4c0b7461e1e2f6ecf3960ede04053da6e96a",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "zlib",
    name: "ffmpegwasm/zlib",
    version: "1.2.11",
    license: "Zlib",
    ref: "v1.2.11",
    commit: "cacf7f1d4e3d44d871b605da3b647f07d718623f",
    repository: "https://github.com/ffmpegwasm/zlib",
    role: "Linked with --enable-zlib in the core.",
    archive: {
      filename: "zlib-1.2.11.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/zlib/tar.gz/cacf7f1d4e3d44d871b605da3b647f07d718623f",
      sha256: "6d4d6640ca3121620995ee255945161821218752b551a1a180f4215f7d124d45",
    },
    // zlib has no LICENSE file; the full grant is the header of zlib.h and the
    // README identifies the release.
    licensePaths: [L("README"), L("zlib.h")],
  },
  {
    id: "libwebp",
    name: "ffmpegwasm/libwebp",
    version: "1.3.2",
    license: "BSD-3-Clause",
    ref: "v1.3.2",
    commit: "ca332209cb5567c9b249c86788cb2dbf8847e760",
    repository: "https://github.com/ffmpegwasm/libwebp",
    role: "Linked with --enable-libwebp in the core.",
    archive: {
      filename: "libwebp-1.3.2.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/libwebp/tar.gz/ca332209cb5567c9b249c86788cb2dbf8847e760",
      sha256: "1676107dc385f9bf6cb4c2b94d4a9359d1fd95ab6309cb587191a742df292fe2",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "freetype",
    name: "ffmpegwasm/freetype2",
    version: "2.10.4",
    license: "FreeType License / GPL-2.0-or-later",
    ref: "VER-2-10-4",
    commit: "6a2b3e4007e794bfc6c91030d0ed987f925164a8",
    repository: "https://github.com/ffmpegwasm/freetype2",
    role: "Linked with --enable-libfreetype in the core.",
    archive: {
      filename: "freetype-2.10.4.tar.gz",
      url: "https://codeload.github.com/ffmpegwasm/freetype2/tar.gz/6a2b3e4007e794bfc6c91030d0ed987f925164a8",
      sha256: "09acceb42508c65b7b744cc2ad01d7548868ca57babc39f7683ec3c0f7541e8c",
    },
    licensePaths: [L("docs/LICENSE.TXT"), L("docs/FTL.TXT"), L("docs/GPLv2.TXT")],
  },
  {
    id: "fribidi",
    name: "fribidi/fribidi",
    version: "1.0.9",
    license: "LGPL-2.1-or-later",
    ref: "v1.0.9",
    commit: "f9e8e71a6fbf4a4619481284c9f484d10e559995",
    repository: "https://github.com/fribidi/fribidi",
    role: "Linked with --enable-libfribidi in the core.",
    archive: {
      filename: "fribidi-1.0.9.tar.gz",
      url: "https://codeload.github.com/fribidi/fribidi/tar.gz/f9e8e71a6fbf4a4619481284c9f484d10e559995",
      sha256: "65ff6fb1a478c4d90ae16825da8c97b8a63e2674f8a2d6dae8800f89089640ba",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "harfbuzz",
    name: "harfbuzz/harfbuzz",
    version: "5.2.0",
    license: "MIT",
    ref: "5.2.0",
    commit: "4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde",
    repository: "https://github.com/harfbuzz/harfbuzz",
    role: "Linked with --enable-libass in the core.",
    archive: {
      filename: "harfbuzz-5.2.0.tar.gz",
      url: "https://codeload.github.com/harfbuzz/harfbuzz/tar.gz/4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde",
      sha256: "69ba7c7a42643a3654781242016dd09245cab7353fc2a02cecb710e479c9a881",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "libass",
    name: "libass/libass",
    version: "0.15.0",
    license: "ISC",
    ref: "0.15.0",
    commit: "d149636f502f5774ae1a8fb4c554b122674393b2",
    repository: "https://github.com/libass/libass",
    role: "Linked with --enable-libass in the core.",
    archive: {
      filename: "libass-0.15.0.tar.gz",
      url: "https://codeload.github.com/libass/libass/tar.gz/d149636f502f5774ae1a8fb4c554b122674393b2",
      sha256: "5cfe23562fa623a3b209d156ad469aeb2e31f69bf6b256ea737d87d9ed89301d",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "zimg",
    name: "sekrit-twc/zimg",
    version: "release-3.0.5",
    license: "WTFPL",
    ref: "release-3.0.5",
    commit: "e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87",
    repository: "https://github.com/sekrit-twc/zimg",
    role: "Linked with --enable-libzimg in the core. The googletest submodule is test-only and is not linked.",
    archive: {
      filename: "zimg-3.0.5.tar.gz",
      url: "https://codeload.github.com/sekrit-twc/zimg/tar.gz/e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87",
      sha256: "3ab062eff30067799997bc3e911c0108a5b8cbcd6e0ef14053f17ff0ecd0add8",
    },
    licensePaths: [L("COPYING")],
  },
  {
    id: "SDL",
    name: "SDL",
    version: "2.24.2 (Emscripten 3.1.40 sdl2 port)",
    license: "Zlib",
    ref: "release-2.24.2",
    commit: "55b03c7493a7abed33cf803d1380a40fa8af903f",
    repository: "https://github.com/libsdl-org/SDL",
    role: "Linked through emcc -sUSE_SDL=2. Emscripten 3.1.40 tools/ports/sdl2.py pins TAG=release-2.24.2 and the archive SHA-512 below.",
    archive: {
      filename: "SDL-2.24.2.tar.gz",
      url: "https://codeload.github.com/libsdl-org/SDL/tar.gz/55b03c7493a7abed33cf803d1380a40fa8af903f",
      sha256: "a726e31f8ad9443a2a9a649f12751442d8ca5ea78a84fde14f760c81706b4127",
    },
    port: {
      source: "https://raw.githubusercontent.com/emscripten-core/emscripten/3.1.40/tools/ports/sdl2.py",
      tag: "release-2.24.2",
      sha512: "b178bdc8f7c40271e09a72f639649d1d61953dda4dc12b77437259667b63b961fd3b2c67b0de6fdc5f9f9c80c49bfafd164e4c13715bc1056e550acc8bad5a3c",
    },
    licensePaths: [L("LICENSE.txt")],
  },
  {
    id: "liblc3",
    name: "Google liblc3",
    version: "1.1.3",
    license: "Apache-2.0",
    ref: "v1.1.3",
    commit: null,
    repository: "https://github.com/google/liblc3",
    role: "Source of the supplemental lc3_codec.wasm. Same pinned tarball as the native build.",
    archive: {
      filename: "liblc3-1.1.3.tar.gz",
      url: "https://github.com/google/liblc3/archive/refs/tags/v1.1.3.tar.gz",
      sha256: "276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af",
    },
    licensePaths: [L("LICENSE")],
  },
  {
    id: "libldac",
    name: "AOSP libldac (LDAC encoder)",
    version: "commit eeee1a3f",
    license: "Apache-2.0 (retain LICENSE and NOTICE)",
    ref: "eeee1a3f5f8df1282e3a6d297085885fd886737b",
    commit: "eeee1a3f5f8df1282e3a6d297085885fd886737b",
    repository: "https://android.googlesource.com/platform/external/libldac",
    role: "Encoder source in the supplemental ldac_codec.wasm.",
    archive: {
      filename: "libldac-eeee1a3f.tar.gz",
      url: "https://android.googlesource.com/platform/external/libldac/+archive/eeee1a3f5f8df1282e3a6d297085885fd886737b.tar.gz",
      contentSha256: "ebba69bc820b93c2ea4c49feaee9e82ffabdb604f89f6c332c2fe922ff3b4d95",
      contentSha256Algorithm: "SHA-256 over sorted relative file paths, types, sizes and bytes after extraction; Android Gitiles regenerates archive bytes per request",
    },
    licensePaths: [L("LICENSE"), L("NOTICE")],
  },
  {
    id: "libldacdec",
    name: "hegdi/libldacdec (LDAC decoder)",
    version: "commit 7f3bd6cc",
    license: "MIT, copyright 2021 Dirk Helbig",
    ref: "7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9",
    commit: "7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9",
    repository: "https://github.com/hegdi/libldacdec",
    role: "Decoder source in the supplemental ldac_codec.wasm.",
    archive: {
      filename: "libldacdec-7f3bd6cc.tar.gz",
      url: "https://github.com/hegdi/libldacdec/archive/7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9.tar.gz",
      sha256: "c6a1cde751cb18f69ccf7d8817f24972560be4e62b3fdbe75159c1207bc5a046",
    },
    licensePaths: [L("LICENSE")],
  },
];

/**
 * Toolchain archives are not part of the GPL corresponding source (the compiler
 * is not linked into the wasm), but pinning them makes the build environment
 * auditable and lets a reviewer rebuild the exact artifacts.
 */
const TOOLCHAINS = [
  {
    id: "emscripten-3.1.40",
    name: "Emscripten",
    version: "3.1.40 (core build)",
    commit: "5c27e79dd0a9c4e27ef2326841698cdd4f6b5784",
    repository: "https://github.com/emscripten-core/emscripten",
    archive: {
      filename: "emscripten-3.1.40.tar.gz",
      url: "https://codeload.github.com/emscripten-core/emscripten/tar.gz/5c27e79dd0a9c4e27ef2326841698cdd4f6b5784",
      sha256: "3eb9ea2d69052a491296eb466dbcda5fbc1c0fed4e475c58545a83558fb47d10",
    },
    licensePaths: [L("LICENSE")],
  },
  {
    id: "emsdk-3.1.40",
    name: "emsdk",
    version: "3.1.40 (core build)",
    commit: "ae245715ef50e036b68a2412a323129676bf8300",
    repository: "https://github.com/emscripten-core/emsdk",
    archive: {
      filename: "emsdk-3.1.40.tar.gz",
      url: "https://codeload.github.com/emscripten-core/emsdk/tar.gz/ae245715ef50e036b68a2412a323129676bf8300",
      sha256: "74ca62e60359fb946e297001913a1f10dbd77271ab86671f5e5c2bd1f5b89b3a",
    },
    licensePaths: [L("LICENSE")],
  },
  {
    id: "emscripten-6.0.13",
    name: "Emscripten",
    version: "6.0.13 (supplemental LC3/LDAC build)",
    commit: "e13ee988ce3d87a738dd8f3661d02223308c412a",
    repository: "https://github.com/emscripten-core/emscripten",
    archive: {
      filename: "emscripten-6.0.13.tar.gz",
      url: "https://codeload.github.com/emscripten-core/emscripten/tar.gz/e13ee988ce3d87a738dd8f3661d02223308c412a",
      sha256: "0eb45cf55702db363e5dacd06fec69b63345ce6ffe61156c0e7fcbf3ae842d4e",
    },
    licensePaths: [L("LICENSE")],
  },
  {
    id: "emsdk-6.0.13",
    name: "emsdk",
    version: "6.0.13 (supplemental LC3/LDAC build)",
    commit: "35659964bc2762fffec0d257997fb61475f765b7",
    repository: "https://github.com/emscripten-core/emsdk",
    archive: {
      filename: "emsdk-6.0.13.tar.gz",
      url: "https://codeload.github.com/emscripten-core/emsdk/tar.gz/35659964bc2762fffec0d257997fb61475f765b7",
      sha256: "e3ef5e4a46753aecc700ec72f81abda6d0601a262c5afe2669323ce2721a22b8",
    },
    licensePaths: [L("LICENSE")],
  },
];

const BUILD_PAYLOAD = [
  "tools/build_codec_wasm.sh",
  "tools/lc3_wasm.c",
  "tools/ldac_wasm.c",
  "tools/copy-wasm-assets.mjs",
  "tools/collect-browser-materials.mjs",
  "third_party/wasm/VERSION.txt",
  "third_party/wasm/bin/lc3_codec.sha256",
  "third_party/wasm/bin/ldac_codec.sha256",
  "third_party/licenses/ffmpeg-wasm-wrapper/LICENSE",
  "third_party/licenses/ffmpeg-wasm-wrapper/PROVENANCE.md",
];

const FFMPEG_WASM_BUILD_ENTRIES = [
  "Dockerfile",
  "Makefile",
  "LICENSE",
  ".github/workflows/CI.yml",
  "build",
  "src/bind",
  "src/fftools",
  "packages/core/package.json",
];

/**
 * Every repository the core Dockerfile fetches. The collector refuses to
 * report source completeness if one of these is not represented by a verified
 * archive component.
 */
const CORE_DOCKER_REPOSITORIES = [
  "ffmpegwasm/x264",
  "ffmpegwasm/x265",
  "ffmpegwasm/libvpx",
  "ffmpegwasm/lame",
  "ffmpegwasm/Ogg",
  "ffmpegwasm/theora",
  "ffmpegwasm/opus",
  "ffmpegwasm/vorbis",
  "ffmpegwasm/zlib",
  "ffmpegwasm/libwebp",
  "ffmpegwasm/freetype2",
  "fribidi/fribidi",
  "harfbuzz/harfbuzz",
  "libass/libass",
  "sekrit-twc/zimg",
  "FFmpeg/FFmpeg",
];

/**
 * Evidence bounds are not publication gates. They record where the source-ref
 * inference stops and what could not be independently observed in this
 * environment. Source matching itself is validated separately: every archive
 * named by the two build recipes is present and hash-verified, and no required
 * source is missing.
 */
const EVIDENCE_BOUNDS = [
  {
    id: "core-source-inference",
    kind: "inference",
    component: "@ffmpeg/core 0.12.10",
    sourceStatus: "complete",
    summary: "The npm package has no upstream gitHead/attestation, so the exact source ref is inferred. The complete source archival set for that inferred ref is present and verified.",
    evidence: [
      "The registry packument for @ffmpeg/core 0.12.10 has no gitHead and no npm provenance attestation.",
      "Tag v0.12.10 is commit c3a7638 (2023). Its packages/core/package.json says version 0.12.6 and license MIT; its build predates ffprobe and the worker-only environment.",
      "Release commit 71aa99d (tag v12.15, 2025-01-07T10:12:48Z) sets packages/core/package.json to 0.12.10/GPL-2.0-or-later. npm published at 2025-01-07T10:13:14Z, 26 seconds later.",
      "The last build-affecting commit is bd903bb (2024-08-30); Dockerfile, Makefile, build/, src/bind/ and src/fftools/ are unchanged between bd903bb and 71aa99d.",
      "The installed wasm embeds emcc 3.1.40 and FFmpeg 5.1.4; the JS contains the ffprobe binding introduced after the wrong tag.",
    ],
    interpretation: "Absent attestation is an evidence limit, not a missing source archive. The source set is complete for 71aa99d/bd903bb.",
  },
  {
    id: "core-byte-reproduction",
    kind: "verification-bound",
    component: "@ffmpeg/core 0.12.10",
    sourceStatus: "complete",
    summary: "The distributed core bytes were verified against npm, but no byte-for-byte rebuild was performed in this environment; bit-identical reproduction is not a publication prerequisite.",
    evidence: [
      "tools/collect-browser-materials.mjs verified the npm tarball and every distributed file but did not run the ffmpeg.wasm Dockerfile (the recorded 2026-11-06 environment had no Docker).",
      "The upstream Dockerfile uses emscripten/emsdk:3.1.40 by tag, branch names 4-cores (x264) and master (lame), and ADD of git branches/tags; the material set resolves these to immutable commits.",
      "There is no upstream build log, digest or reproducible-build attestation for these wasm bytes.",
    ],
    interpretation: "This bounds how strongly the bytes can be tied to the recipe without a rebuild. It does not indicate missing source.",
  },
  {
    id: "supplemental-build-hermeticity",
    kind: "reproducibility-note",
    component: "lc3_codec / ldac_codec supplemental WASM",
    sourceStatus: "complete",
    summary: "The supplemental bytes reproduce exactly, but only with LC_ALL=C and the original absolute build directory; tools/build_codec_wasm.sh does not pin either condition.",
    evidence: [
      "LC3 reproduces at ca703c83... in any locale/build path tested.",
      "LDAC reproduces at 64b40d89... only with LC_ALL=C and CODEC_WASM_BUILD_DIR=/tmp/opencode/codec-wasm-build.",
      "With the normal en_US.UTF-8 locale the LDAC link order changes and the wasm becomes ce39de9e...; a different build directory embeds a different libldacdec.c path and also changes the bytes.",
      "The script installs emsdk 'latest' and records only the emcc version string, not the emsdk/emscripten commit or locale.",
    ],
    interpretation: "The exact source and served bytes are present; the note concerns rebuild hermeticity for these permissively licensed modules.",
  },
  {
    id: "toolchain-scope",
    kind: "scope-note",
    component: "Emscripten toolchain",
    sourceStatus: "pinned",
    summary: "Emscripten/emsdk archives are included for reproducibility. LLVM, Binaryen and the Node runtime are recorded by version/identity but their full source trees are not part of the linked work.",
    evidence: [
      "emcc 3.1.40 and clang 17.0.0 are embedded in the core provenance; emcc 6.0.13 identifies the supplemental build.",
      "Compiler/toolchain source is not linked into the distributed WASM; only Emscripten/emsdk source archives are bundled here.",
    ],
  },
];

const SOURCE_COMPLETENESS = {
  status: "complete",
  requiredArchives: COMPONENTS.length,
  missing: [],
  statement: "Every source archive named by the ffmpeg.wasm Dockerfile and the supplemental build script is present and hash-verified. No required source archive is missing.",
  checks: [
    "All Dockerfile ADD repositories and FFmpeg n5.1.4 are mapped to pinned components.",
    "The Emscripten 3.1.40 sdl2 port source (SDL release-2.24.2) is included.",
    "liblc3, AOSP libldac and hegdi/libldacdec are included for the supplemental modules.",
  ],
};

function usage() {
  process.stdout.write(`Usage: node tools/collect-browser-materials.mjs [options]

Options:
  --output <dir>                Material output (default build/browser-materials)
  --source-cache <dir>          Reuse downloaded archives from this directory
  --include-toolchain-sources   Also download Emscripten/emsdk source archives
  --offline                     Never download; fail if a verified archive is missing
  --verify                      Verify an existing material tree against MANIFEST.json
  --bundle <file>               Also write a gzipped tar of the material tree and its .sha256
  --require-complete            Exit non-zero only if a required source archive is missing
  --help                        Show this help
`);
}

function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    cache: DEFAULT_CACHE,
    offline: false,
    verify: false,
    requireComplete: false,
    includeToolchain: false,
    bundle: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output": options.output = path.resolve(argv[++index]); break;
      case "--source-cache": options.cache = path.resolve(argv[++index]); break;
      case "--bundle": options.bundle = path.resolve(argv[++index]); break;
      case "--offline": options.offline = true; break;
      case "--verify": options.verify = true; break;
      case "--require-complete": options.requireComplete = true; break;
      case "--include-toolchain-sources": options.includeToolchain = true; break;
      case "--help": case "-h": usage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

function hasCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function sha256(filename) {
  const hash = createHash("sha256");
  const handle = await fs.open(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function hashesFor(filename) {
  const sha1 = createHash("sha1");
  const sha256Hash = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(filename)) {
    sha1.update(chunk);
    sha256Hash.update(chunk);
    sha512.update(chunk);
  }
  return {
    sha1: sha1.digest("hex"),
    sha256: sha256Hash.digest("hex"),
    sha512base64: sha512.digest("base64"),
  };
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

function archiveFlag(filename) {
  if (filename.endsWith(".tar.xz")) return "-J";
  if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) return "-z";
  if (filename.endsWith(".tar.bz2")) return "-j";
  throw new Error(`Unsupported archive type: ${filename}`);
}

async function listArchive(filename) {
  const output = await run("tar", [`${archiveFlag(filename)}tf`, filename]);
  return output.toString("utf8").split(/\r?\n/).filter((entry) => entry.length > 0);
}

async function extractArchiveFile(archive, entry) {
  const flag = archiveFlag(archive);
  return run("tar", [`${flag}xOf`, archive, "--", entry]);
}

async function topLevelPrefix(archive) {
  const entries = await listArchive(archive);
  const first = entries.find((entry) => entry.length > 0);
  if (!first) throw new Error(`Empty source archive: ${archive}`);
  const prefix = first.split("/")[0];
  if (!prefix) throw new Error(`Cannot determine archive prefix: ${archive}`);
  return prefix;
}

async function extractEntries(archive, entries, output) {
  const prefix = await topLevelPrefix(archive);
  const listing = new Set(await listArchive(archive));
  const selected = [];
  for (const entry of entries) {
    const wanted = `${prefix}/${entry.replace(/^\/+/, "")}`;
    const directory = wanted.endsWith("/") ? wanted : `${wanted}/`;
    // Select regular files only. Passing a directory member together with its
    // own descendants confuses tar --strip-components.
    const matches = [...listing].filter((name) => !name.endsWith("/") && (name === wanted || name.startsWith(directory)));
    if (matches.length === 0) throw new Error(`Archive ${path.basename(archive)} does not contain ${entry}`);
    selected.push(...matches);
  }
  await fs.mkdir(output, { recursive: true });
  const args = [`${archiveFlag(archive)}xf`, archive, "-C", output, "--strip-components=1", ...new Set(selected)];
  await run("tar", args);
}

/**
 * Android Gitiles regenerates archive bytes per request. For those components
 * the pin is the canonical extracted content, matching the native collector.
 */
async function canonicalContentSha256(archive) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-browser-content-"));
  try {
    const flag = archiveFlag(archive);
    const names = await listArchive(archive);
    for (const name of names) {
      const relative = name.replace(/\/$/, "").replace(/^\.\//, "");
      if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) {
        throw new Error("Unsafe source archive path");
      }
    }
    const listing = (await run("tar", [`${flag}tvf`, archive])).toString("utf8");
    if (listing.split(/\r?\n/).filter(Boolean).some((line) => !["-", "d"].includes(line[0]))) {
      throw new Error("Source archive links and special entries are not accepted for content hashing");
    }
    await run("tar", [`${flag}xf`, archive, "-C", directory]);
    const files = (await walk(directory)).map((relative) => relative.split(path.sep).join("/")).sort();
    const hash = createHash("sha256");
    for (const relative of files) {
      const absolute = path.join(directory, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (stat.isFile()) {
        hash.update(`f\0${relative}\0${stat.size}\0`);
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      } else {
        throw new Error(`Unsupported archive entry in ${archive}: ${relative}`);
      }
    }
    return hash.digest("hex");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function verifyArchive(spec, filename) {
  const raw = await sha256(filename);
  if (spec.archive.sha256 !== undefined) {
    return { ok: raw === spec.archive.sha256, raw, content: null, expected: spec.archive.sha256, kind: "archive SHA-256" };
  }
  if (spec.archive.contentSha256 !== undefined) {
    const content = await canonicalContentSha256(filename);
    return { ok: content === spec.archive.contentSha256, raw, content, expected: spec.archive.contentSha256, kind: "content SHA-256" };
  }
  throw new Error(`${spec.id} has no archive or content SHA-256 pin`);
}

async function fetchArchive(spec, destination) {
  const response = await fetch(spec.archive.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${spec.archive.url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(`${destination}.part`, buffer);
  await fs.rename(`${destination}.part`, destination);
}

async function obtainArchive(spec, options, destination) {
  if (await exists(destination)) {
    const verified = await verifyArchive(spec, destination);
    if (verified.ok) {
      return { filename: spec.archive.filename, path: destination, sha256: verified.raw, contentSha256: verified.content, source: "output" };
    }
    throw new Error(`Existing source archive does not match the pinned ${verified.kind}: ${destination}`);
  }
  const cached = path.join(options.cache, spec.archive.filename);
  if (await exists(cached)) {
    const verified = await verifyArchive(spec, cached);
    if (verified.ok) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(cached, destination);
      return { filename: spec.archive.filename, path: destination, sha256: verified.raw, contentSha256: verified.content, source: "cache" };
    }
    process.stderr.write(`warning: cached ${spec.archive.filename} does not match the pinned ${verified.kind}; ignoring\n`);
  }
  if (options.offline) throw new Error(`Offline and no verified archive for ${spec.id}: ${spec.archive.filename}`);
  process.stderr.write(`fetching ${spec.name} ${spec.version} source archive\n`);
  await fetchArchive(spec, destination);
  const verified = await verifyArchive(spec, destination);
  if (!verified.ok) {
    await fs.rm(destination, { force: true });
    throw new Error(`Downloaded ${spec.archive.filename} ${verified.kind} mismatch: got ${verified.content ?? verified.raw}`);
  }
  return { filename: spec.archive.filename, path: destination, sha256: verified.raw, contentSha256: verified.content, source: "download" };
}

function findLicenseEntry(entries, archivePath) {
  const wanted = archivePath.replace(/^\/+/, "");
  const matches = entries.filter((entry) => !entry.endsWith("/") && (entry === wanted || entry.endsWith(`/${wanted}`)));
  if (matches.length === 0) return null;
  return matches.sort((left, right) => left.split("/").length - right.split("/").length)[0];
}

async function collectLicenses(spec, archivePath, output, category) {
  const entries = await listArchive(archivePath);
  const collected = [];
  for (const license of spec.licensePaths) {
    const entry = findLicenseEntry(entries, license.archivePath);
    if (!entry) throw new Error(`${spec.id} archive does not contain ${license.archivePath}`);
    const contents = await extractArchiveFile(archivePath, entry);
    if (contents.length === 0) throw new Error(`${spec.id} ${license.archivePath} is empty`);
    const destination = path.join(output, "licenses", spec.id, license.as);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    collected.push({
      archiveEntry: entry,
      path: path.relative(output, destination).split(path.sep).join("/"),
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return { category, collected };
}

async function walk(directory, relative = "") {
  const files = [];
  for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
    const child = relative === "" ? name : path.join(relative, name);
    const stat = await fs.lstat(path.join(directory, child));
    if (stat.isDirectory()) files.push(...await walk(directory, child));
    else if (stat.isFile()) files.push(child);
    else throw new Error(`Unsafe non-regular material entry: ${child}`);
  }
  return files;
}

async function buildManifest(output) {
  const files = [];
  for (const relative of await walk(output)) {
    const posix = relative.split(path.sep).join("/");
    if (posix === "MANIFEST.json") continue;
    files.push({
      path: posix,
      bytes: (await fs.stat(path.join(output, relative))).size,
      sha256: await sha256(path.join(output, relative)),
    });
  }
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), files };
}

async function verifyMaterials(output) {
  const manifestPath = path.join(output, "MANIFEST.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schema !== SCHEMA) throw new Error(`Unexpected manifest schema: ${manifest.schema}`);
  const problems = [];
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || path.isAbsolute(file.path) || file.path.includes("\\") ||
        file.path.split("/").some((part) => ["", ".", ".."].includes(part)) || seen.has(file.path)) {
      throw new Error("Unsafe or duplicate material manifest path");
    }
    seen.add(file.path);
    const absolute = path.join(output, file.path);
    if (!await exists(absolute)) {
      problems.push(`missing ${file.path}`);
      continue;
    }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size !== file.bytes) problems.push(`type/size mismatch ${file.path}`);
    if (await sha256(absolute) !== file.sha256) problems.push(`hash mismatch ${file.path}`);
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const relative of await walk(output)) {
    const posix = relative.split(path.sep).join("/");
    if (posix !== "MANIFEST.json" && !listed.has(posix)) problems.push(`unlisted ${posix}`);
  }

  // Re-verify archive and distributed pins, not only the manifest's own hashes.
  const coreTarball = path.join(output, "distributed", "npm", NPM_CORE.tarball.filename);
  if (await sha256(coreTarball) !== NPM_CORE.tarball.sha256) throw new Error("npm core tarball pin mismatch");
  for (const [name, expected] of Object.entries(SUPPLEMENTAL.files)) {
    if (await sha256(path.join(output, "distributed", "supplemental", name)) !== expected) {
      throw new Error(`Distributed supplemental pin mismatch: ${name}`);
    }
  }
  for (const component of manifest.components) {
    const archive = path.join(output, "sources", component.archive.filename);
    if (!(await verifyArchive(component, archive)).ok) throw new Error(`Source pin mismatch: ${component.id}`);
  }
  for (const toolchain of manifest.toolchains) {
    const archive = path.join(output, "toolchain", toolchain.archive.filename);
    if (!(await exists(archive))) continue;
    if (!(await verifyArchive(toolchain, archive)).ok) throw new Error(`Toolchain pin mismatch: ${toolchain.id}`);
  }
  if (problems.length > 0) throw new Error(`Materials verification failed:\n- ${problems.join("\n- ")}`);
  process.stdout.write(`Materials verified: ${manifest.files.length} files match MANIFEST.json.\n`);
}

async function collectNpmCore(output, options) {
  const destination = path.join(output, "distributed", "npm", NPM_CORE.tarball.filename);
  let source = "download";
  if (await exists(destination)) {
    source = "output";
  } else {
    const cached = path.join(options.cache, NPM_CORE.tarball.filename);
    if (await exists(cached) && await sha256(cached) === NPM_CORE.tarball.sha256) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(cached, destination);
      source = "cache";
    } else {
      if (options.offline) throw new Error(`Offline and no verified npm tarball for ${NPM_CORE.name}@${NPM_CORE.version}`);
      const response = await fetch(NPM_CORE.tarball.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${NPM_CORE.tarball.url}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    }
  }
  const hashes = await hashesFor(destination);
  if (hashes.sha256 !== NPM_CORE.tarball.sha256) throw new Error(`npm tarball SHA-256 mismatch: ${hashes.sha256}`);
  if (hashes.sha1 !== NPM_CORE.tarball.sha1) throw new Error(`npm tarball SHA-1 mismatch: ${hashes.sha1}`);
  const expectedIntegrity = `sha512-${hashes.sha512base64}`;
  if (expectedIntegrity !== NPM_CORE.tarball.integrity) throw new Error(`npm tarball integrity mismatch: ${expectedIntegrity}`);

  const unpack = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-core-"));
  try {
    await run("tar", ["-xzf", destination, "-C", unpack]);
    const packageJson = JSON.parse(await fs.readFile(path.join(unpack, "package", "package.json"), "utf8"));
    if (packageJson.name !== NPM_CORE.name || packageJson.version !== NPM_CORE.version) {
      throw new Error(`unexpected package identity: ${packageJson.name}@${packageJson.version}`);
    }
    if (packageJson.license !== NPM_CORE.license) throw new Error(`unexpected package license: ${packageJson.license}`);

    const files = [];
    for (const [relative, expected] of Object.entries(NPM_CORE.files)) {
      const sourceFile = path.join(unpack, relative);
      const hash = await sha256(sourceFile);
      if (expected !== null && hash !== expected) throw new Error(`npm package file hash mismatch: ${relative}`);
      const target = path.join(output, "distributed", "npm", `core-${NPM_CORE.version}`, relative.slice("package/".length));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(sourceFile, target);
      files.push({ path: path.relative(output, target).split(path.sep).join("/"), bytes: (await fs.stat(target)).size, sha256: hash });
    }

    // The installed tree and the served copies must be the same bytes as the
    // registry package. Served bytes are the distribution authority, so any
    // difference is an error rather than a warning.
    const installedDir = path.join(ROOT, "node_modules", "@ffmpeg", "core");
    if (!await exists(path.join(installedDir, "package.json"))) throw new Error("Missing node_modules/@ffmpeg/core. Run npm install.");
    const installed = JSON.parse(await fs.readFile(path.join(installedDir, "package.json"), "utf8"));
    if (installed.version !== NPM_CORE.version) throw new Error(`installed @ffmpeg/core is ${installed.version}, expected ${NPM_CORE.version}`);
    for (const [relative, expected] of Object.entries(NPM_CORE.files)) {
      if (!relative.startsWith("package/dist/")) continue;
      const rel = relative.slice("package/".length);
      const installedHash = await sha256(path.join(installedDir, rel));
      if (installedHash !== expected) throw new Error(`installed @ffmpeg/core file mismatch: ${rel}`);
    }
    const served = [];
    for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
      const sourceFile = path.join(ROOT, "apps", "client", "public", "codec-assets", name);
      if (!await exists(sourceFile)) continue;
      const servedHash = await sha256(sourceFile);
      const expected = name.endsWith(".js") ? NPM_CORE.files["package/dist/esm/ffmpeg-core.js"] : NPM_CORE.files["package/dist/esm/ffmpeg-core.wasm"];
      if (servedHash !== expected) throw new Error(`served codec asset does not match @ffmpeg/core ${NPM_CORE.version}: ${name}`);
      served.push({ path: `apps/client/public/codec-assets/${name}`, sha256: servedHash });
    }
    return { source, ...hashes, files, installedMatches: true, served, packageJson: { name: packageJson.name, version: packageJson.version, license: packageJson.license } };
  } finally {
    await fs.rm(unpack, { recursive: true, force: true });
  }
}

async function collectSupplemental(output) {
  const bin = path.join(ROOT, "third_party", "wasm", "bin");
  const versionFile = path.join(ROOT, "third_party", "wasm", "VERSION.txt");
  const versionText = await fs.readFile(versionFile, "utf8");
  if (!versionText.includes("liblc3_version=1.1.3")) throw new Error("third_party/wasm/VERSION.txt does not pin liblc3 1.1.3");
  if (!versionText.includes("libldac_commit=eeee1a3f5f8df1282e3a6d297085885fd886737b")) throw new Error("third_party/wasm/VERSION.txt does not pin libldac");
  if (!versionText.includes("libldacdec_commit=7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9")) throw new Error("third_party/wasm/VERSION.txt does not pin libldacdec");
  if (!versionText.includes(SUPPLEMENTAL.emccVersion)) throw new Error("third_party/wasm/VERSION.txt does not record the expected emcc 6.0.13 identity");

  const files = [];
  for (const [name, expected] of Object.entries(SUPPLEMENTAL.files)) {
    const sourceFile = path.join(bin, name);
    if (!await exists(sourceFile)) throw new Error(`Missing supplemental module: ${name}`);
    const hash = await sha256(sourceFile);
    if (hash !== expected) throw new Error(`supplemental ${name} hash mismatch: ${hash}`);
    const target = path.join(output, "distributed", "supplemental", name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(sourceFile, target);
    files.push({ path: path.relative(output, target).split(path.sep).join("/"), bytes: (await fs.stat(target)).size, sha256: hash });
  }
  for (const codec of ["lc3", "ldac"]) {
    const manifestFile = path.join(bin, `${codec}_codec.sha256`);
    const manifest = await fs.readFile(manifestFile, "utf8");
    const expected = ["js", "wasm"].map((extension) => `${SUPPLEMENTAL.files[`${codec}_codec.${extension}`]}  ${codec}_codec.${extension}\n`).join("");
    if (manifest !== expected) throw new Error(`supplemental ${codec} pair manifest is stale or malformed`);
    const target = path.join(output, "distributed", "supplemental", `${codec}_codec.sha256`);
    await fs.copyFile(manifestFile, target);
    files.push({ path: path.relative(output, target).split(path.sep).join("/"), bytes: (await fs.stat(target)).size, sha256: await sha256(target) });
  }
  const versionTarget = path.join(output, "distributed", "supplemental", "VERSION.txt");
  await fs.copyFile(versionFile, versionTarget);
  files.push({ path: path.relative(output, versionTarget).split(path.sep).join("/"), bytes: (await fs.stat(versionTarget)).size, sha256: await sha256(versionTarget) });

  const served = [];
  for (const name of Object.keys(SUPPLEMENTAL.files)) {
    const sourceFile = path.join(ROOT, "apps", "client", "public", "codec-assets", name);
    if (!await exists(sourceFile)) continue;
    const hash = await sha256(sourceFile);
    if (hash !== SUPPLEMENTAL.files[name]) throw new Error(`served supplemental asset does not match the build: ${name}`);
    served.push({ path: `apps/client/public/codec-assets/${name}`, sha256: hash });
  }
  return { files, served, versionText, reproduction: SUPPLEMENTAL.reproduction };
}

async function collectBuildPayload(output, ffmpegWasmArchive) {
  const collected = [];
  for (const relative of BUILD_PAYLOAD) {
    const source = path.join(ROOT, relative);
    if (!await exists(source)) throw new Error(`Missing local build payload: ${relative}`);
    const destination = path.join(output, "build", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    collected.push({ source: relative, path: path.relative(output, destination).split(path.sep).join("/") });
  }
  const extracted = path.join(output, "build", "ffmpeg-wasm");
  await extractEntries(ffmpegWasmArchive, FFMPEG_WASM_BUILD_ENTRIES, extracted);
  for (const relative of await walk(extracted)) {
    collected.push({
      source: `ffmpeg.wasm:${relative.split(path.sep).join("/")}`,
      path: path.relative(output, path.join(extracted, relative)).split(path.sep).join("/"),
    });
  }
  return collected;
}

async function assertCoreSourceEvidence(archivePath) {
  const entries = await listArchive(archivePath);
  const find = (suffix) => entries.find((entry) => entry === suffix || entry.endsWith(`/${suffix}`));
  const dockerfile = find("Dockerfile");
  const ffmpegWasm = find("build/ffmpeg-wasm.sh");
  const corePackage = find("packages/core/package.json");
  const ffprobe = find("src/fftools/ffprobe.c");
  if (!dockerfile || !ffmpegWasm || !corePackage || !ffprobe) throw new Error("ffmpeg.wasm source archive is missing build files");
  const dockerText = (await extractArchiveFile(archivePath, dockerfile)).toString("utf8");
  const linkText = (await extractArchiveFile(archivePath, ffmpegWasm)).toString("utf8");
  const packageJson = JSON.parse((await extractArchiveFile(archivePath, corePackage)).toString("utf8"));
  const checks = [
    [/FROM emscripten\/emsdk:3\.1\.40/, "Dockerfile does not pin emscripten/emsdk:3.1.40"],
    [/ENV FFMPEG_VERSION=n5\.1\.4/, "Dockerfile does not pin FFmpeg n5.1.4"],
    [/--enable-gpl/, "Dockerfile does not enable GPL"],
    [/-sENVIRONMENT=worker/, "ffmpeg-wasm.sh does not use the worker-only environment"],
    [/src\/fftools\/ffprobe\.c/, "ffmpeg-wasm.sh does not link ffprobe"],
    [/-sUSE_SDL=2/, "ffmpeg-wasm.sh does not use the Emscripten SDL2 port"],
  ];
  for (const [pattern, message] of checks) if (!pattern.test(dockerText) && !pattern.test(linkText)) throw new Error(message);
  if (packageJson.version !== CORE_VERSION) throw new Error(`source package version is ${packageJson.version}, expected ${CORE_VERSION}`);
  if (packageJson.license !== NPM_CORE.license) throw new Error(`source package license is ${packageJson.license}`);

  // Source matching, not source inference: every fetch in the Dockerfile must
  // have a verified archive component. This catches a genuinely missing source.
  const normalise = (value) => value.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
  const available = new Set(COMPONENTS.map((component) => component.repository).filter(Boolean).map(normalise));
  const missingRepositories = CORE_DOCKER_REPOSITORIES.filter((repository) => !available.has(repository.toLowerCase()));
  if (missingRepositories.length > 0) {
    throw new Error(`No verified source component for Dockerfile repositories: ${missingRepositories.join(", ")}`);
  }
  for (const repository of CORE_DOCKER_REPOSITORIES) {
    const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`github\\.com/${escaped}\\.git`, "i").test(dockerText)) {
      throw new Error(`Dockerfile does not reference expected source repository: ${repository}`);
    }
  }
  if (!COMPONENTS.some((component) => component.id === "SDL")) throw new Error("Emscripten SDL2 port source is not in the material components");

  return {
    dockerfile: { archiveEntry: dockerfile },
    ffmpegWasm: { archiveEntry: ffmpegWasm },
    corePackage: { version: packageJson.version, license: packageJson.license },
    ffprobeBinding: true,
    gplBuild: true,
    emsdkImage: "emscripten/emsdk:3.1.40",
    ffmpegVersion: "n5.1.4",
    dockerRepositories: CORE_DOCKER_REPOSITORIES,
    missingRepositories,
    sdlPort: "release-2.24.2",
  };
}

function noticesMarkdown(report) {
  const rows = report.components.map((component) => {
    const licenses = component.licenses.collected.map((entry) => `\`${entry.path}\``).join("<br>");
    const pin = component.archive.sha256
      ? `SHA-256 \`${component.archive.sha256}\``
      : `content SHA-256 \`${component.archive.contentSha256}\` (Gitiles regenerates archive bytes)`;
    return `| ${component.name} | ${component.version} | ${component.license} | \`sources/${component.archive.filename}\`<br>${pin} | ${licenses} |`;
  }).join("\n");
  const toolchainRows = report.toolchains.map((toolchain) => {
    return `| ${toolchain.name} | ${toolchain.version} | \`toolchain/${toolchain.archive.filename}\` | ${toolchain.commit} |`;
  }).join("\n");
  return `# Audivane browser codec notices and source materials

Generated by \`tools/collect-browser-materials.mjs\`. Copyright in each component
remains with its authors. Audivane's own code is MIT; every component below
retains its own license. This is release engineering evidence, not a claim that
the demo is audible or ready for publication.

## Distributed browser core

The page serves \`@ffmpeg/core\` ${NPM_CORE.version}, which declares
\`${NPM_CORE.license}\`. The package tarball is included at
\`distributed/npm/core-${NPM_CORE.version}.tgz\` (SHA-256
\`${NPM_CORE.tarball.sha256}\`) and its extracted files are under
\`distributed/npm/core-${NPM_CORE.version}/\`. The npm package contains no license
file; the complete FFmpeg GPL/LGPL texts are extracted below from the pinned
FFmpeg source.

| Component | Version | License | Exact source (SHA-256) | Complete license text |
| --- | --- | --- | --- | --- |
${rows}

## Build toolchains

| Toolchain | Version | Archive | Commit |
| --- | --- | --- | --- |
${toolchainRows}

## Supplemental LC3 and LDAC modules

The supplemental modules are built by \`tools/build_codec_wasm.sh\` from the
pinned liblc3, AOSP libldac and hegdi/libldacdec sources above plus
\`tools/lc3_wasm.c\` and \`tools/ldac_wasm.c\`. Their exact distributed bytes are
under \`distributed/supplemental/\`. They reproduce byte-for-byte only under the
documented locale and build-directory conditions in
\`provenance/supplemental-reproduction.json\`; the current script does not pin
those conditions.

## Project and wrapper notices

- Audivane application code: MIT, copyright 2026 Triet (@Triet1402).
- \`@ffmpeg/ffmpeg\` 0.12.15 wrapper: MIT. Its license and provenance are copied
  under \`build/third_party/licenses/ffmpeg-wasm-wrapper/\`.
- \`@ffmpeg/core\` declares GPL-2.0-or-later. The GPLv2 and GPLv3 texts are
  included from the exact FFmpeg 5.1.4 source.

## Source completeness

${report.sourceCompleteness.statement}

- Required source archives: ${report.sourceCompleteness.requiredArchives}
- Missing: ${report.sourceCompleteness.missing.length === 0 ? "none" : report.sourceCompleteness.missing.join(", ")}

## Evidence bounds (not publication gates)

These record where the available evidence stops. They are not claims that a
source is missing and they are not additional approval requirements.

${report.evidenceBounds.map((entry) => `- **${entry.id}** (${entry.kind}): ${entry.summary}`).join("\n")}

Do not replace any dependency license with the project MIT license. Do not
describe this material set as proof of codec conformance.
`;
}

function sourceOfferMarkdown(report) {
  const rows = report.components.map((component) => {
    const pin = component.archive.sha256
      ? `  - Archive SHA-256: \`${component.archive.sha256}\``
      : `  - Content SHA-256: \`${component.archive.contentSha256}\` (upstream Gitiles regenerates archive bytes)`;
    const ref = component.ref ? `  - Ref: \`${component.ref}\`` : "";
    const commit = component.commit ? `  - Commit: \`${component.commit}\`` : "";
    return `- **${component.name} ${component.version}** — ${component.license}
  - Source: ${component.archive.url}
${ref}
${commit}
${pin}
  - Included as: \`sources/${component.archive.filename}\`
  - Role: ${component.role}`;
  }).join("\n");
  return `# Browser source offer and rebuild instructions

This file accompanies the browser codec assets served by the Audivane web
application. The exact source archives are under \`sources/\`; optional toolchain
archives are under \`toolchain/\`. Every archive is pinned by SHA-256 (or by
canonical extracted content for Android Gitiles). No required source archive is
missing.

${rows}

## Source completeness

${SOURCE_COMPLETENESS.statement}

The inferred source ref is documented below. An absent upstream npm
attestation is recorded as an evidence bound in \`REPORT.json\`; it is not a
missing source archive.

## Distributed core identity

- npm package: \`${NPM_CORE.name}@${NPM_CORE.version}\`
- Tarball: \`distributed/npm/core-${NPM_CORE.version}.tgz\`
- Tarball SHA-256: \`${NPM_CORE.tarball.sha256}\`
- \`dist/esm/ffmpeg-core.wasm\` SHA-256: \`${NPM_CORE.files["package/dist/esm/ffmpeg-core.wasm"]}\`
- \`dist/esm/ffmpeg-core.js\` SHA-256: \`${NPM_CORE.files["package/dist/esm/ffmpeg-core.js"]}\`
- Inferred release source: ${NPM_CORE.source.repository} commit
  \`${NPM_CORE.source.releaseCommit}\` (tag \`${NPM_CORE.source.releaseTag}\`)
- Last build-affecting source: commit \`${NPM_CORE.source.lastBuildAffectingCommit}\`
- Wrong tag: \`${NPM_CORE.source.tagTrap.tag}\` is commit
  \`${NPM_CORE.source.tagTrap.commit}\` and is not this package's source.

## Rebuilding the core

The upstream recipe is the Dockerfile included at
\`build/ffmpeg-wasm/Dockerfile\`. The single-thread production target is:

\`\`\`sh
make prd
\`\`\`

It uses \`emscripten/emsdk:3.1.40\`, FFmpeg \`n5.1.4\`, and the dependency
archives above. Recording the Docker image digest and resolved dependency
commits is optional additional evidence; a rebuild was not performed here and
bit-identical reproduction is not required by this material set.

## Rebuilding the supplemental modules

\`\`\`sh
LC_ALL=C \\
CODEC_WASM_BUILD_DIR=/tmp/opencode/codec-wasm-build \\
CODEC_WASM_EMSDK_DIR=/tmp/opencode/emsdk \\
tools/build_codec_wasm.sh
\`\`\`

The absolute build directory and \`LC_ALL=C\` are part of the observed build
identity: the LDAC WASM embeds the libldacdec source path and its link order
depends on the locale. The script does not currently enforce either condition.
With Emscripten 6.0.13 the rebuild reproduces both served modules exactly; see
\`provenance/supplemental-reproduction.json\`.

## Evidence bounds

- The npm core bytes are verified against the published tarball; the source ref
  is inferred because the npm publication has no gitHead or provenance
  attestation. The complete source archive set for that ref is included.
- No byte-for-byte rebuild of the npm core was performed here.
- Audibility and codec conformance are separate verification results, not
  claims made by this material set.
`;
}

function servingMarkdown(report) {
  return `# Serving layout for /sources/browser/

Serve this directory as the durable browser source offer, for example at
\`https://audivane.app/sources/browser/\`. Keep the relative layout unchanged so
the paths in \`NOTICES.md\` and \`SOURCE-OFFER.md\` resolve.

- Link \`NOTICES.md\` from the demo and from the site's license/source page.
- Keep \`MANIFEST.json\`; it lists every file with its size and SHA-256.
- Keep \`REPORT.json\`; it records source completeness and evidence bounds.
- \`toolchain/\` is optional for readers but required for exact toolchain
  provenance. If it is omitted from hosting, say so on the source page.
- Do not rewrite, recompress or rename the pinned archives.
- Do not add credentials, deployment manifests or mutable "latest" copies.

## Verification of a served copy

The archive extracts with a top-level \`browser-materials/\` directory. To place
the tree directly at the site path:

\`\`\`sh
tar -xzf browser-materials.tar.gz --strip-components=1 -C /path/to/site/sources/browser
\`\`\`

\`\`\`sh
node tools/collect-browser-materials.mjs --verify --output /path/to/served/browser-materials
\`\`\`

The verifier checks every file in \`MANIFEST.json\`, the npm tarball hash, the
supplemental pair hashes and every source archive pin. It does not require
network access.

## Required source archives

${report.sourceCompleteness.requiredArchives} source archives,
missing: ${report.sourceCompleteness.missing.length === 0 ? "none" : report.sourceCompleteness.missing.join(", ")}.

${report.sourceCompleteness.statement}
`;
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.verify) {
    await verifyMaterials(options.output);
    return;
  }

  const dockerAvailable = await hasCommand("docker");
  await fs.mkdir(options.output, { recursive: true });

  const core = await collectNpmCore(options.output, options);
  process.stderr.write("ok: @ffmpeg/core package bytes\n");

  const components = [];
  for (const spec of COMPONENTS) {
    const destination = path.join(options.output, "sources", spec.archive.filename);
    const archive = await obtainArchive(spec, options, destination);
    const licenses = await collectLicenses(spec, archive.path, options.output, "component");
    let sourceEvidence = null;
    if (spec.id === "ffmpeg-wasm") sourceEvidence = await assertCoreSourceEvidence(archive.path);
    components.push({ ...spec, archive: { ...spec.archive, obtainedFrom: archive.source, rawSha256: archive.sha256, contentSha256Actual: archive.contentSha256 }, licenses, sourceEvidence });
    process.stderr.write(`ok: ${spec.id}\n`);
  }

  const toolchains = [];
  for (const spec of TOOLCHAINS) {
    if (!options.includeToolchain) {
      toolchains.push({ ...spec, included: false, archive: { ...spec.archive } });
      continue;
    }
    const destination = path.join(options.output, "toolchain", spec.archive.filename);
    const archive = await obtainArchive(spec, options, destination);
    const licenses = await collectLicenses(spec, archive.path, options.output, "toolchain");
    toolchains.push({ ...spec, included: true, archive: { ...spec.archive, obtainedFrom: archive.source, rawSha256: archive.sha256 }, licenses });
    process.stderr.write(`ok: toolchain ${spec.id}\n`);
  }

  const supplemental = await collectSupplemental(options.output);
  process.stderr.write("ok: supplemental modules\n");

  const ffmpegWasmArchive = path.join(options.output, "sources", "ffmpeg.wasm-71aa99d.tar.gz");
  const buildPayload = await collectBuildPayload(options.output, ffmpegWasmArchive);
  process.stderr.write("ok: build payload\n");

  const sourceEvidence = {
    core: {
      ...NPM_CORE.source,
      npmManifest: {
        version: core.packageJson.version,
        license: core.packageJson.license,
        tarballSha1: core.sha1,
        tarballSha256: core.sha256,
        tarballIntegrity: NPM_CORE.tarball.integrity,
      },
      distributedFiles: core.files,
      served: core.served,
      sourceArchiveChecks: components.find((component) => component.id === "ffmpeg-wasm").sourceEvidence,
    },
    supplemental: {
      version: SUPPLEMENTAL.version,
      emccVersion: SUPPLEMENTAL.emccVersion,
      files: supplemental.files,
      served: supplemental.served,
      reproduction: supplemental.reproduction,
    },
    buildEnvironment: {
      dockerAvailable,
      note: dockerAvailable ? "Docker was present; no core rebuild was requested by this collector." : "Docker was not available, so no byte-for-byte core rebuild was attempted.",
      emccForSupplemental: SUPPLEMENTAL.emccVersion,
    },
    sourceCompleteness: SOURCE_COMPLETENESS,
    evidenceBounds: EVIDENCE_BOUNDS,
  };
  await writeJson(path.join(options.output, "provenance", "source-evidence.json"), sourceEvidence);
  await writeJson(path.join(options.output, "provenance", "supplemental-reproduction.json"), supplemental.reproduction);

  const report = {
    schema: `${SCHEMA}-report`,
    generatedAt: new Date().toISOString(),
    scope: "Audivane browser codec assets (@ffmpeg/core plus supplemental LC3/LDAC WASM)",
    claims: [
      "The npm tarball and installed/served core files match the pinned hashes.",
      "The supplemental pairs match the pinned build manifests and served copies.",
      "The listed source archives are the exact upstream primary sources referenced by the build recipes.",
      "Every source repository fetched by the core Dockerfile maps to a verified archive component.",
    ],
    noClaims: [
      "No claim of audio conformance or audibility.",
      "No claim that the npm core bytes are proven to come from the inferred source commit.",
      "No claim beyond the matching source/build/license materials documented here.",
    ],
    core,
    components,
    toolchains,
    supplemental,
    buildPayload,
    sourceCompleteness: SOURCE_COMPLETENESS,
    evidenceBounds: EVIDENCE_BOUNDS,
    sourceEvidencePath: "provenance/source-evidence.json",
  };

  await fs.writeFile(path.join(options.output, "NOTICES.md"), noticesMarkdown(report));
  await fs.writeFile(path.join(options.output, "SOURCE-OFFER.md"), sourceOfferMarkdown(report));
  await fs.writeFile(path.join(options.output, "SERVING.md"), servingMarkdown(report));
  await writeJson(path.join(options.output, "REPORT.json"), report);

  const manifest = {
    ...await buildManifest(options.output),
    generatedBy: "tools/collect-browser-materials.mjs",
    core: {
      name: NPM_CORE.name,
      version: NPM_CORE.version,
      license: NPM_CORE.license,
      tarballSha256: NPM_CORE.tarball.sha256,
      sourceCommit: NPM_CORE.source.releaseCommit,
      lastBuildAffectingCommit: NPM_CORE.source.lastBuildAffectingCommit,
    },
    components: components.map((component) => ({
      id: component.id,
      version: component.version,
      license: component.license,
      archive: component.archive,
      licenses: component.licenses.collected,
    })),
    toolchains: toolchains.map((toolchain) => ({ id: toolchain.id, version: toolchain.version, included: toolchain.included, archive: toolchain.archive })),
    sourceCompleteness: SOURCE_COMPLETENESS,
    evidenceBounds: EVIDENCE_BOUNDS.map((entry) => ({ id: entry.id, kind: entry.kind, summary: entry.summary })),
  };
  await writeJson(path.join(options.output, "MANIFEST.json"), manifest);

  if (options.bundle) {
    const bundle = path.resolve(options.bundle);
    if (bundle === options.output || bundle.startsWith(`${options.output}${path.sep}`)) {
      throw new Error("--bundle must be outside the material output directory");
    }
    await fs.mkdir(path.dirname(bundle), { recursive: true });
    await run("tar", ["-czf", bundle, "-C", path.dirname(options.output), path.basename(options.output)]);
    const bundleHash = await sha256(bundle);
    await fs.writeFile(`${bundle}.sha256`, `${bundleHash}  ${path.basename(bundle)}\n`);
    process.stdout.write(`Bundle: ${bundle}\n`);
    process.stdout.write(`Bundle SHA-256: ${bundleHash}\n`);
  }

  process.stdout.write(`\nBrowser materials written to ${options.output}\n`);
  process.stdout.write(`Files: ${manifest.files.length}\n`);
  process.stdout.write(`Required source archives: ${SOURCE_COMPLETENESS.requiredArchives}; missing: ${SOURCE_COMPLETENESS.missing.length}\n`);
  for (const entry of EVIDENCE_BOUNDS) process.stdout.write(`- [${entry.kind}] ${entry.id}: ${entry.summary}\n`);
  if (options.requireComplete && SOURCE_COMPLETENESS.missing.length > 0) {
    process.stderr.write("\nRequired source archives are missing; the material set is incomplete.\n");
    process.exitCode = 1;
  }
}

await main();
