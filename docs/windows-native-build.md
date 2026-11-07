# Windows x64 native codec build and bundle audit

Status: **cross-build recipe and bundle audit implemented.** The pins match the
tested Linux build. Concrete PE binaries, DLL audits, ZIP and unsigned NSIS
artifacts were produced on Linux. The 0.1.0 packages subsequently passed bounded
Windows 11 x64 installer, FLAC workflow and process-lifetime checks; see the
[acceptance record](windows-acceptance-0.1.0.md). That runtime evidence does not
establish a native MSYS2 recipe run or complete installed codec acceptance.

This slice prepares the native part only:

- a pinned, from-source MSYS2/MinGW-w64 recipe for `ffmpeg.exe` and
  `ffprobe.exe` with liblc3, libsoxr, libopus, libvorbis, libmp3lame and
  libtwolame;
- a pinned Windows build of the LDAC helper (`ldac_helper.exe`) from the same
  AOSP libldac and hegdi/libldacdec commits as Linux;
- platform-aware native-bundle validation that accepts Windows x64 PE32+
  payloads, parses their import tables and fails closed on missing or
  unrecognized DLLs;
- readiness support for a Windows x64 host.

Packaging, launch locking, Windows process-tree ownership, installers, signing
and Windows acceptance remain separate work; see the
[release plan](releasing.md) and [release guide](releasing.md).

## Why a dedicated build is required

Ordinary Windows FFmpeg downloads do not reliably include LC3, and they cannot
provide the LDAC encoder/decoder helper this application uses. The desktop
engine probes real encoder/decoder/muxer/demuxer capability; a file that merely
answers `-version` is not accepted. The prepared payload must therefore come
from a provenance-controlled build of the same pinned sources used elsewhere.

The pinned native-bundle contract is:

```text
prepared-resources/
  third_party/
    ffmpeg/
      VERSION.txt
      bin/ffmpeg.exe
      bin/ffprobe.exe
      bin/*.dll            # only if an import genuinely needs one
    ldac/
      VERSION.txt
      bin/ldac_helper.exe
      bin/*.dll            # only if an import genuinely needs one
```

`third_party/ldac/` is optional for the application as a whole, but an
eleven-codec release claim requires it.

## Exact source pins

The source versions and archive hashes are identical to
[`tools/build_ffmpeg.sh`](../tools/build_ffmpeg.sh) and
[`tools/build_ldac_helper.sh`](../tools/build_ldac_helper.sh). They were read
back from the current Linux `third_party/ffmpeg/VERSION.txt` and
`third_party/ldac/VERSION.txt` before writing the Windows recipe.

| Component | Pin | SHA-256 / commit |
| --- | --- | --- |
| FFmpeg | 9.0.2 | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| liblc3 | 1.1.3 | `276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af` |
| libsoxr | 0.1.3 | `db6ca1b1e8405c6ef92f8294fc123d910abf0a114003b3f0f13fa57a95fd62d0` |
| libogg | 1.3.5 | `c4d91be36fc8e54deae7575241e03f4211eb102afb3fc0775fbbc1b740016705` |
| libvorbis | 1.3.7 | `b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b` |
| libopus | 1.5.2 | `65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1` |
| LAME | 3.100 | `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e` |
| libtwolame | 0.4.0 | `cc35424f6019a88c6f52570b63e1baf50f62963a3eac52a03a800bb070d7c87d` |
| AOSP libldac | `eeee1a3f` | `eeee1a3f5f8df1282e3a6d297085885fd886737b` |
| hegdi/libldacdec | `7f3bd6cc` | `7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9` |

Build-tool versions are recorded in the generated `VERSION.txt`; they are not
claimed to produce reproducible bytes. The Windows build uses the MSYS2
toolchain supplied by the host rather than a committed compiler.

## Prerequisites

- Windows 10/11 x64 (the support baseline still needs explicit selection and
  clean-machine testing).
- [MSYS2](https://www.msys2.org/) with an **MINGW64**, **UCRT64** or
  **CLANG64** shell. The MSYS shell (`MSYSTEM=MSYS`) is refused: it would
  produce binaries that depend on `msys-2.0.dll`.
- Node.js (repository requirement) for the post-build audit.
- Build tools inside MSYS2, installed without administrator rights:

```bash
pacman -S --needed base-devel \
  mingw-w64-x86_64-toolchain mingw-w64-x86_64-cmake \
  mingw-w64-x86_64-meson mingw-w64-x86_64-ninja \
  mingw-w64-x86_64-pkgconf git curl tar xz
```

The scripts verify `gcc -dumpmachine` starts with `x86_64-w64-mingw32` and
refuse other targets. They never install binaries from `PATH` into the bundle:
only the freshly built files from the pinned sources are copied.

## Build commands

From the repository root in the MSYS2 MINGW64 shell:

```bash
# Build both components into build/windows-native/, audit, then provision
# build/windows-native-bundle. The tracked Linux third_party tree is untouched.
tools/build_native_windows.sh

# Keep an explicit prepared bundle outside generated build output.
tools/build_native_windows.sh --out /c/release/audivane-win-native

# Clean rebuild.
tools/build_native_windows.sh --clean
```

Individual component scripts:

```bash
tools/build_ffmpeg_windows.sh
tools/build_ldac_helper_windows.sh
```

Intermediate sources and the static dependency prefix stay under
`build/ffmpeg-windows` and `build/ldac-windows` (gitignored). The default
prepared output is `build/windows-native-bundle`; component outputs default
under `build/windows-native/ffmpeg` and `build/windows-native/ldac` and can be
overridden with `OUT_DIR`, `WINDOWS_FFMPEG_OUT` or `WINDOWS_LDAC_OUT`. Use
`--out` for a bundle you intend to retain for packaging.

The native defaults preserve the historical `third_party/` layout when a
component script is run directly on Windows. Cross builds never write there by
default. This matters because the Linux developer baseline lives in the same
tracked `third_party/` paths; a cross build must not replace its `VERSION.txt`.

### Linux cross build

For a concrete, structurally auditable Windows artifact without a Windows host,
the scripts support `--cross` with an extracted or distro mingw-w64 toolchain on
Linux x64:

```bash
export PATH=/path/to/mingw-w64/bin:$PATH
tools/build_native_windows.sh --cross
tools/build_native_windows.sh --cross --out /tmp/audivane-win-native
```

The cross build compiles all pinned sources, writes PE32+ executables, hashes
them, enforces the exact pins, runs the PE/DLL audit, and labels the artifact as
not executed. It needs x86_64-w64-mingw32 `{gcc,ar,ranlib,strip,nm,windres}` and
the normal host `make pkg-config curl tar sha256sum install node meson ninja
cmake` tools. `--cross-prefix=<prefix>` selects another tool prefix. Codec
availability in a cross build is compile-configuration evidence only; the
smoke encoder/license probe is skipped because a PE cannot run on Linux.

Both component scripts also accept `--cross` individually. The default cross
outputs are under the component build directory, never the tracked
`third_party/` paths.

FFmpeg is configured with `--disable-autodetect`, `--disable-shared`,
`--enable-static` and `-static`, so the dependency libraries and MinGW runtime
are linked into the executable. If the build unexpectedly emits shared DLLs in
the prefix, the script fails instead of shipping a hybrid payload.

## Windows decoder containment

The Linux helper decodes inside a `fork()` child and kills/reaps it on
cancellation or crash. Windows has no `fork()` or POSIX signals, so
`tools/ldac_helper.c` now has a Windows-only child-process branch:

- the parent creates a sibling temporary output and launches this same
  `ldac_helper.exe` with the internal `--decode-child <input> <temp>` mode;
- the child is created suspended, placed in a kill-on-close Job Object, and
  only then resumed. Failure to create or assign the job terminates the
  suspended child and fails closed; there is no unconfined fallback;
- the process command line is built with Windows argv quoting, so paths with
  spaces and quotes survive. `argv` is rebuilt from `GetCommandLineW`, and file,
  temp, replace and process operations use UTF-16 wide APIs, so non-ASCII paths
  do not depend on the ANSI code page;
- a console control handler sets a cancellation flag and the parent terminates
  the job, then refuses to publish the temporary output;
- a zero child exit installs the finished file with an atomic Windows
  `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`; nonzero or crash status refuses
  output;
- input/output alias detection compares Win32 volume serial + file index from
  open handles, so case aliases and hard links are caught rather than compared
  as path strings;
- temporary files use `GetTempFileNameW` in the destination directory rather
  than POSIX `mkstemp`/`fchmod`.

The POSIX branch is unchanged. The Windows branch is cross-compiled and passes
the PE/DLL audit, but its runtime containment and cancellation behavior remain
**unverified** until it runs on Windows. That is not a substitute for the
Windows process-lifetime acceptance in the release plan.

## Provenance

`third_party/ffmpeg/VERSION.txt` records the FFmpeg version, Windows x64 target,
source archive, archive SHA-256, build date, compiler and build-tool versions,
the exact configure line, static dependency pins and the LC3 container notes.
`third_party/ldac/VERSION.txt` records `target=windows-x64`, the libldac and
libldacdec repositories/commits, the helper binary SHA-256 and compiler.

Windows validation requires those target markers in addition to exact source
pins: FFmpeg 9.0.2, its archive URL and SHA-256, liblc3 1.1.3 and its archive
SHA-256, and the fixed libldac and libldacdec repository/commit lines must match
literally. A Linux VERSION file
renamed beside a `.exe` is refused, and a Windows-looking file must still
describe the exact sources above.

A Windows bundle must also record the exact executable bytes:

```text
Binary SHA-256 (ffmpeg):  <64 hex>
Binary SHA-256 (ffprobe): <64 hex>
# ldac VERSION
binary_sha256=<64 hex>
```

Those values are recomputed from the supplied files and must match. A missing
field, a stale value after rebuilding, or an edited binary fails validation.
Linux prepared bundles that predate the binary-hash fields remain readable for
compatibility; if either FFmpeg binary-hash line is present it must be complete
and correct, and an existing `binary_sha256=` entry is likewise verified.

## PE x64 validation and DLL audit

`tools/verification/native-bundle.mjs` treats the platform explicitly. Linux
behaviour (ELF x64, executable bits, same VERSION contract) is unchanged.
Windows mode (`platform: "win32"`) requires `ffmpeg.exe`, `ffprobe.exe`,
`ldac_helper.exe` when supplied, and verifies:

- the DOS `MZ` header, PE signature, COFF machine `0x8664` and PE32+ optional
  header magic `0x20b`; PE32, i386, ARM64 and non-PE files fail;
- executables do not have the `IMAGE_FILE_DLL` characteristic, while supplied
  `*.dll` files do;
- import descriptors and DLL names are bounds-checked while parsing; malformed
  tables fail closed;
- delay-load imports are parsed and audited like static imports, because the
  loader can resolve them after process start; old-style VA-based delay
  descriptors are refused until a specific audit exists;
- every imported or delay-loaded DLL is either supplied beside the image
  (case-insensitive, as on Windows) or is a recognized Windows system DLL/API
  set;
- imports of supplied DLLs are audited too, so a bundled DLL that needs a
  missing runtime DLL cannot pass;
- MSVC/MinGW runtime redistributables (`vcruntime140.dll`, `msvcp140.dll`,
  `libgcc_s_seh-1.dll`, `libwinpthread-1.dll`, ...) are **not** assumed to be
  system files. Ship the exact DLL or fail;
- a bundled DLL that shadows a Windows system DLL name is refused;
- every supplied file is still hashed, and packaged copies are re-hashed.

The system-DLL allowlist lives in `WINDOWS_SYSTEM_DLLS` in
[`native-bundle.mjs`](../tools/verification/native-bundle.mjs). An import that
is genuinely part of the chosen Windows baseline but is not listed is an audit
failure: review it and add it deliberately with evidence rather than disabling
the audit.

Structural audit without execution (works on Linux against a prepared Windows
tree, and on Windows):

```bash
node tools/verification/windows-native-audit.mjs --bundle /absolute/prepared-win
node tools/verification/windows-native-audit.mjs --bundle /absolute/prepared-win --json
node tools/verification/windows-native-audit.mjs --file /absolute/prepared-win/third_party/ffmpeg/bin/ffmpeg.exe
```

The audit prints each import and whether it resolves to `system`, `bundle` or
`missing`. `--stage <dir>` copies a valid all-component bundle and writes the
same deterministic `native-bundle-manifest.json` used by packaging. It does not
execute the binaries; it cannot establish codec capability or Windows runtime
behaviour.

## Readiness on Windows

On an actual Windows x64 host, the normal readiness probe executes the tools:

```bash
npm run check:native -- --native-bundle /c/release/audivane-win-native
npm run check:native -- --native-bundle /c/release/audivane-win-native --json
```

`native-readiness-v1` now treats Windows x64 as a supported target, resolves
`.exe` names, keeps LDAC optional and reports Windows-specific remediation. It
still requires real encoder/decoder/muxer/demuxer probes: passing the structural
audit is necessary but not sufficient. A Windows bundle named on Linux is
refused with the audit command instead of being probed as a host toolchain; the
inverse Linux-on-Windows case is refused too.

Packaging is a separate owner. Once the Windows packager exists, the prepared
tree is selected the same way as Linux, for example
`CODEC_ABX_NATIVE_BUNDLE_DIR=<prepared>` or `--native-bundle <prepared>`, and
the packaged copy is verified against the manifest.

## Desktop process lifetime

Build the app-owned process host before packaging Windows:

```bash
tools/build_windows_process_host.sh
# Linux MinGW build, producing a PE without executing it:
tools/build_windows_process_host.sh --cross
```

The output is `build/windows-process-host/bin/audivane-process-host.exe`.
`CODEC_ABX_PROCESS_HOST` can select an explicit absolute trusted helper path.
Packaging audits its x64 PE/system imports, stages it in
`resources/process-host`, and records its exact hash.

The guard assigns Electron main to a kill-on-close Job Object before app
windows, workers or codecs are created. Main-process exit or guard death closes
the job and terminates remaining members. Each codec starts suspended inside
its own job before execution, so descendants cannot survive early leader exit.
Missing helpers or failed assignment refuse startup; there is no uncontained
fallback. Electron bootstrap helpers that precede the guard need confirmation
on the real Windows runner.

On actual Windows, run:

```bash
npm run test:windows-lifetime
npm run test:unit -- packages/engine-native/test/typescript-codecs-process.test.ts
```

The lifetime harness covers main-only death, early codec-leader exit and host
cancellation. It requires the built helper. Also run packaged installer/ZIP
acceptance, including sandbox and nested-job compatibility, locked-file cleanup,
Unicode paths, dialogs, exports, codec/audio behavior and physical listening.
See [distribution acceptance](distribution-acceptance.md).

The lifetime host cross-compiles with MinGW and passes the x64 PE/system-DLL
audit. Linux unit/package results and PE cross-builds do not establish Windows
runtime acceptance. Signing and SmartScreen behavior remain separate release gates.

## Licenses and notices

Building the payload does not complete redistribution obligations. Desktop packaging now deliberately removes unused browser codec WASM/glue;
the separate web build still ships the GPL-declared `@ffmpeg/core` asset. Complete the per-artifact license, notice,
corresponding-source and build/relink materials before public Windows or web
distribution. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the
[release plan](releasing.md). MIT covers the project's own code only.
