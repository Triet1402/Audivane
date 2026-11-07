# Linux x64 native build baseline

Status: **implemented 2026-11-04**. The supported Linux release baseline is
**Ubuntu 24.04 LTS x64, glibc 2.39**. The pinned native codec executables are
built inside an Ubuntu 24.04.3 base rootfs, audited for their actual glibc
symbol requirement, and left under `build/linux-baseline/` for packaging.

This document covers the native codec artifacts only. The installer format,
clean-machine installation, AppImage/`.deb` metadata and Windows packaging are
separate distribution work.

## Why this baseline

The previous developer build was produced on Ubuntu 26.10 and required
`GLIBC_2.44`. Statically linked codec libraries do not make glibc static, so an
AppImage or `.deb` wrapper around that binary cannot run on older systems.
Ubuntu 24.04 is the oldest practical LTS baseline for the pinned Electron 45
and current GCC/FFmpeg toolchains:

| Item | Baseline |
| --- | --- |
| Distribution | Ubuntu 24.04 LTS (Noble) |
| Rootfs used | Ubuntu 24.04.3 base `amd64` |
| glibc | 2.39 |
| Standard support | Through April 2029 |
| Build architecture | x86_64, generic baseline ISA |
| Installer floor | `glibc >= 2.39` (declare it; do not infer it from static codecs) |

The resulting binaries run on Ubuntu 24.04 and newer distributions with an equal
or newer glibc. Building on the 26.10 host was explicitly rejected as a release
baseline.

## Build method

`tools/build_linux_baseline.sh` downloads a pinned Ubuntu base rootfs and a
pinned Ubuntu `proot` package, then runs the existing pinned build scripts
inside that rootfs:

```bash
tools/build_linux_baseline.sh
```

Properties:

- **No root, no host package install, no global policy change.** The Ubuntu
  24.04 userspace runs under `proot`; only the cache, the checkout and the
  build output are written. The host's GCC, glibc and package database are not
  used by the build.
- **Pinned rootfs.** The base tarball URL and SHA-256 are fixed in the script.
- **Pinned sources.** `tools/build_ffmpeg.sh` and
  `tools/build_ldac_helper.sh` verify every source archive/commit before use.
- **Recorded environment.** The exact Ubuntu package versions installed in the
  rootfs are written to `package-versions.txt`; the rootfs, proot, toolchain and
  commands are recorded in `BASELINE.txt`.
- **No PATH discovery.** The packaging input is the explicit output directory;
  no native executable is copied from `PATH`.
- **One build per cache.** A `flock` guard refuses concurrent runs that would
  share the same baseline build tree.

The host requirement is Linux x86_64 with glibc >= 2.38, because the pinned
Ubuntu `proot` package needs it. Network access is required the first time for
the rootfs, proot, source archives and Ubuntu package setup; later runs reuse
the cache and rootfs. Set `PROOT_BIN` to use an existing proot executable.

### Output layout

```text
build/linux-baseline/
  artifacts/
    third_party/ffmpeg/bin/ffmpeg
    third_party/ffmpeg/bin/ffprobe
    third_party/ffmpeg/VERSION.txt
    third_party/ldac/bin/ldac_helper
    third_party/ldac/VERSION.txt
  provenance.json        # audivane-native-provenance-v1
  readiness.json         # native-readiness-v1 when node_modules/tsx exists
  package-versions.txt   # dpkg versions inside the baseline rootfs
  BASELINE.txt           # rootfs/proot hashes, toolchain, commands
```

Generated artifacts stay under the gitignored `build/` tree. They are not
committed and are never uploaded automatically.

### Useful variants

```bash
# separate output, more/fewer jobs, clean build trees
tools/build_linux_baseline.sh --output /tmp/audivane-baseline --jobs 16 --rebuild

# re-extract the rootfs after a failed interrupted setup
tools/build_linux_baseline.sh --reset-rootfs

# use an existing proot
PROOT_BIN=/usr/bin/proot tools/build_linux_baseline.sh

# audit an already-built bundle without rebuilding
node tools/audit-native-provenance.mjs \
  --bundle build/linux-baseline/artifacts \
  --baseline-glibc 2.39 \
  --json build/linux-baseline/provenance.json
```

## Provenance audit

`tools/audit-native-provenance.mjs` independently checks the exact bytes:

1. x86-64 little-endian ELF executables and executable file modes;
2. SHA-256 values recorded in the FFmpeg and LDAC `VERSION.txt` files;
3. `DT_NEEDED` entries limited to the system C runtime (`libc`, `libm`, and
   similar baseline libraries);
4. the highest required `GLIBC_x.y` symbol version is not newer than 2.39;
5. FFmpeg reports LGPL (not GPL/nonfree) and has no `--enable-gpl`/
   `--enable-nonfree` build flag;
6. FFmpeg provides every required encoder, decoder, muxer and demuxer for the
   eleven application codec IDs;
7. `ffprobe` runs, and the LDAC helper reports its pinned commits and completes
   a 48 kHz stereo encode/decode round trip that preserves the declared sample
   count.

The machine-readable result is `provenance.json`; a failure is a non-zero exit,
not a warning. A build-cache hit is not accepted as test evidence.

### Codec coverage claimed by this build

| Application codec | Native implementation |
| --- | --- |
| Opus, AAC, Ogg Vorbis, MP3, MP2, LC3, SBC, aptX, aptX HD | FFmpeg/ffprobe with the pinned external libraries |
| LDAC | `ldac_helper` (AOSP libldac encoder, hegdi/libldacdec decoder) |
| No-op passthrough | PCM path inside the application |

FFmpeg is built without `--enable-gpl` or `--enable-nonfree`. LC3 is provided by
`liblc3`; a generic FFmpeg build is not a substitute. The baseline build keeps
mono/stereo and explicit sample-rate policy in the application layer; this
document only covers artifact provenance.

## Recorded baseline build

A build was completed on 2026-11-04 with this tooling. It is local evidence, not
a published artifact:

| Item | Result |
| --- | --- |
| Rootfs | Ubuntu 24.04.3 base, SHA-256 `6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9` |
| proot package | `5.4.0-3`, SHA-256 `8520a33632dc721ec9404eb8bb0079834dcced02f6e861510238bf636cc629e7` |
| Compiler | gcc 13.3.0, GNU ld 2.42 |
| FFmpeg | 9.0.2, SHA-256 `38c2653c10dd2bd8e71ada87d1c5eafb9477c1e6805c725e175c90f9b9b737ee` |
| ffprobe | 9.0.2, SHA-256 `5e8b313fec0c7aae2453d7bf366e971fdf9822f96813f7400e91b9386dca3ae3` |
| ldac_helper | 1.0.0, SHA-256 `4c784d19fe8493519ea4bbca35ce2ad4f3d8058cb2bf76ecbd4ef88cc5961c61` |
| Highest glibc requirement | 2.38 (FFmpeg/ffprobe); 2.34 (ldac_helper) |
| Dynamic dependencies | `libc.so.6`, `libm.so.6`, `libmvec.so.1` for FFmpeg/ffprobe; `libc.so.6`, `libm.so.6` for the helper |
| Provenance audit | 40 checks passed |
| Readiness probe | all eleven codec IDs available, no warnings |

The binaries require glibc **2.38**, not 2.44, and therefore satisfy the Ubuntu
24.04 / glibc 2.39 floor. The generated files remain under
`build/linux-baseline/`; they are not committed. The local (gitignored)
`third_party/ffmpeg/bin`, `third_party/ldac/bin` and
`build/release-test-resources` were refreshed from this build so the tracked
`VERSION.txt` files and local readiness checks describe the same bytes.

## Packaging use

Point the existing explicit bundle path at the produced artifacts:

```bash
npm run check:native -- --native-bundle "$PWD/build/linux-baseline/artifacts"
npm run package:desktop -- --native-bundle "$PWD/build/linux-baseline/artifacts"
CODEC_ABX_NATIVE_BUNDLE_DIR="$PWD/build/linux-baseline/artifacts" \
  npm run test:desktop
```

Do **not** copy the old host-built binaries or a generic distribution FFmpeg.
The bundle validator hashes every supplied file, requires Linux x64 ELF and
provenance, and re-checks the packaged copy.

## Evidence boundaries

This is a reproducible build and provenance result, not clean-machine
installation acceptance:

- `proot` executes the real Ubuntu 24.04 userspace, but it is not a VM. The
  rootfs package versions are recorded; the build has not yet been repeated on
  a physical clean Ubuntu 24.04 machine.
- The audit proves byte identity, linkage and capability tables. It does not
  establish audible quality, codec conformance or patent licensing.
- The final `.deb` subsequently passed [release guide](releasing.md),
  including dependencies and sandboxing. AppImage and human listening remain
  separate gates.
- Windows x64 is not covered. It must build the same pinned sources on its own
  baseline and be audited as PE, not inferred from this ELF build.

For the corresponding source and notice payload, see
[distribution licenses](distribution-licenses.md). For the release gates, see
[releasing](releasing.md).
