# Audivane release preparation

Status: **0.1.0 publication preparation**. The owner has requested publication
of the available packages with the testing limits recorded below. Version `0.1.0`
is assigned consistently across workspace manifests, internal dependency ranges,
the lockfile, application metadata and artifact filenames. There is no release
tag, upload, pushed branch or public support claim from this work.

## Release route

The first public source release will be a **clean snapshot with one initial
commit**, prepared in an isolated repository. Keep development history private
and intact. Review the [publication checklist](publication-review.md) before
building final downloads.

| Gate | Current evidence | Remaining work |
| --- | --- | --- |
| Shared application | Integrated automated acceptance recorded | Check changes and build the final snapshot |
| Linux `.deb` / Arch | Bounded KVM install, sandbox and lifecycle checks | Full final installed UI, normal desktop and physical listening; Arch cross-version upgrade |
| Windows | Unsigned 0.1.0 NSIS/ZIP tested on Windows 11 x64: install, FLAC listening/export, repair/removal and process lifetime | Full installed codec matrix, interactive/cross-version upgrade checks and physical listening |
| AppImage | Staging/tooling | Produce and test only if shipping |
| Public web | Verified browser source/build materials; real app compiled under `/demo/` | Final deployed-origin acceptance; see [browser evidence](../website/BROWSER-MATERIALS.md) |
| Publication | Local preparation tooling | Final content audit, identity, signing decision and matching attachments |

The [Windows 0.1.0 acceptance record](windows-acceptance-0.1.0.md) identifies the
exact tested downloads and the limits of those checks. The website is deployed
as a browser preview; it is not a tagged desktop release.

Recorded results apply to their exact revision and artifact hashes. New packages
need their own verification against the [installed acceptance matrix](distribution-acceptance.md).

For the recommended formats, publication sequence and web hosting choices, see
[distribution strategy](distribution-strategy.md). These are recommendations;
Flatpak, Snap and macOS packaging are not implemented.

## Build inputs and local commands

Native distribution is explicit: packaging does not discover executables on
PATH or download native codec binaries. All eleven codec IDs require the pinned
FFmpeg/ffprobe build with liblc3 plus `ldac_helper`. Codec execution is native in
the private worker; installed users need no Node/npm or checkout.

For Linux x64, the selected baseline is Ubuntu 24.04 LTS / glibc 2.39. Build with
[the baseline recipe](linux-native-build.md), then collect exact source, full
license texts and build/provenance materials:

```sh
tools/build_linux_baseline.sh
node tools/collect-third-party-materials.mjs \
  --artifacts build/linux-baseline/artifacts
node tools/distribution/prepare-materials.mjs linux \
  build/linux-baseline/artifacts build/release-materials
npm run check:native -- --native-bundle "$PWD/build/distribution-resources/linux"
npm run dist:linux -- \
  --native-bundle "$PWD/build/distribution-resources/linux"
```

The `.deb` builder audits **every shipped ELF**, including Electron libraries,
against the selected GLIBC ceiling. A wrapper cannot fix a newer libc
requirement, and an environment override cannot lower the claim. GTK3, NSS,
ALSA, desktop and graphics runtime dependencies are declared in the package.
The package adds a narrow AppArmor `userns` attachment for its installed
executable. It does not add a setuid sandbox helper or change global host policy.

AppImage staging/build is available through the same release tool with
`--appimage --appimagetool /absolute/path/to/appimagetool`, plus
`--appimage-runtime /absolute/path/to/runtime --appimage-runtime-sha256 HASH`.
Both tool and hash-pinned runtime must be explicitly provisioned; staging an
AppDir is not a produced or tested AppImage.
The Ubuntu installed-path user-namespace/AppArmor behavior must pass under its
actual final launch environment before distribution. See
[installed acceptance](distribution-acceptance.md).

For Windows x64, see [the pinned native recipe](windows-native-build.md). On an
actual Windows build host, build/audit the complete PE/DLL bundle, collect its
own matching materials into a separate directory, then use:

```sh
npm run package:desktop -- --platform win32 --native-bundle /prepared/windows-resources
npm run dist:windows -- --native-bundle /prepared/windows-resources
```

The Windows path prepares a portable ZIP and per-user NSIS installer. `MAKENSIS`
selects the explicit NSIS compiler; packaging never invents signing credentials.
Do not infer Windows execution acceptance from a Linux cross-package. A local
unsigned candidate must be labelled unsigned. Public signing identity and
SmartScreen behavior remain separate from an application's correctness.

Use `npm run dist:verify` to check versioned artifact bytes against the
platform manifests and inspect package contents. Retain the per-platform
`release-manifest-*.json` and `SHA256SUMS-*.txt` beside the actual files.
Local generated artifacts live in `dist/release/` and are not committed.

## Exact notices and matching source

MIT covers the [project-owned code](../LICENSE), copyright
`2026 Triet (@Triet1402)`. Each dependency retains its own license. The
[third-party inventory](../THIRD_PARTY_NOTICES.md) and
[material guide](distribution-licenses.md) describe the full license texts,
source archives, exact pins, build scripts and binary provenance.

Desktop deliberately excludes unused browser FFmpeg/LC3/LDAC WASM and glue
assets. Acceptance inspects the actual packaged files and completes native
listening without them. Electron/Chromium notices, IBM Plex OFL, translated
measurement attribution, React/Scheduler and the MIT FFmpeg wrapper notice
remain required. Browser publication still needs exact corresponding source
for the GPL-declared `@ffmpeg/core` and its build; desktop exclusion does not
complete web redistribution materials.

Prepare source attachments from the final clean release repository after its
source and binaries have been reviewed. The existing attachment command is:

```sh
node tools/prepare-publication.mjs linux build/release-materials
```

Use `arch` or `win32` with matching platform materials. Review the source
archive, codec notices/build materials and checksums against the exact binaries.
This command prepares local attachments; it does not publish or initialize Git.

## Arch Linux x86_64

`npm run dist:arch` builds a pacman package with native makepkg. Non-Arch hosts
use `--prepare-only`, build the pinned recipe on Arch, and return it with
`--arch-package FILE`. Verify with `npm run dist:verify -- --platform arch`.
See [Arch distribution](arch-distribution.md) for install commands, actual KVM
acceptance, source materials and remaining bounds. No AUR submission is implied.

## Acceptance and publication gates

[Distribution acceptance](distribution-acceptance.md) gives exact install,
upgrade, uninstall, final-path launch, dialogs/exports and cleanup checks for
each format. Keep physical listening distinct from digital capture. Numerical
and codec gates preserve analytical/independent and exact-served-byte evidence;
old test success is not a correctness authority.

Build success, structural archive inspection, host packaged execution,
clean-machine installed execution and physical listening are separate results.
Do not promote a candidate until its required target-platform checks pass.

Remaining gates include the complete installed Windows codec matrix, interactive
installer/cross-version upgrade checks, final installed Linux UI/dialog/export acceptance and
physical listening, Arch cross-version upgrade if shipping Arch, chosen public
repository/publisher identity, a signing decision and review of the final copied
source and downloads. The private development history is excluded from the new
snapshot repository; it does not need publication cleanup. If signing is chosen,
configure credentials and repeat acceptance on the signed artifacts. Do not work
around sandbox failures with `--no-sandbox`, a setuid helper or a global AppArmor relaxation.

GitHub Releases is the intended first binary/source channel, without a
fabricated public URL. Flathub is the preferred later Linux catalog and WinGet
the preferred Windows listing after installer acceptance. npm publication is
not needed for desktop users. No stores, releases or repository settings are
changed by these build commands. The [release notes](release-notes-0.1.0.md)
remain a local draft.
