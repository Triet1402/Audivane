# Desktop distribution packaging

This is the implementation record for Audivane Linux x64 and Windows x64
distribution artifacts. It is not a publication approval and does not replace
clean-machine, physical-listening or Windows acceptance.

## Identity and version

- Product: **Audivane**
- Subtitle: **Blind audio comparisons.**
- Version: the root `package.json` version (`0.1.0` at this checkpoint).
- License: MIT for project code; third-party licenses remain separate.
- No publisher URL, reverse-DNS app ID or signing credential is invented.
- `npm run dist:check` verifies workspace manifests, internal dependency
  references, the lockfile and the exported brand icons.

Brand icon sources are the SVGs in `assets/brand/`. Raster and Windows ICO
exports are under `assets/brand/icons/`; regenerate them with
`npm run icons:export`. The client title/header/favicon, Electron window name,
package metadata and Linux desktop entry use the Audivane identity. Scientific
schemas, IPC channel names and `aligned-gain-matched-v1` identifiers are
unchanged.

## Why browser codec assets are absent

Desktop processing runs the native TypeScript engine. `desktop-build.mjs`
removes `client/codec-assets` (FFmpeg WASM core and LC3/LDAC glue/modules) from
the desktop bundle. The packaged test asserts the directory and all `.wasm`
modules are absent, while preparing and listening with native codecs from the
foreign package path and returning native engine provenance. The browser build
continues to include those assets; public hosting remains gated on matching
source/build materials.

## Prepare the exact resources

Final distribution packages use `build/distribution-resources/{linux,win32}`,
produced from the verified native bundle and the complete materials collector:

```bash
# Linux baseline (Ubuntu 24.04 LTS; glibc 2.39)
tools/build_linux_baseline.sh --output build/linux-baseline
node tools/collect-third-party-materials.mjs \
  --artifacts build/linux-baseline/artifacts --output build/release-materials
node tools/distribution/prepare-materials.mjs linux \
  build/linux-baseline/artifacts build/release-materials

# Windows bundle (MSYS2 MINGW64/UCRT64/CLANG64)
tools/build_native_windows.sh --out build/windows-native-bundle
node tools/collect-third-party-materials.mjs \
  --platform win32 --artifacts build/windows-native-bundle --output build/release-materials-windows
node tools/distribution/prepare-materials.mjs win32 \
  build/windows-native-bundle build/release-materials-windows
```

Packaging never discovers codec binaries on `PATH` and never downloads native
tools. An explicit `--native-bundle`/`--resources` directory can override the
default prepared path. Both packaged modes use portability, provenance and hash
validation before any previous output is replaced.

## Linux .deb

```bash
npm run dist:linux -- --resources build/distribution-resources/linux
npm run dist:verify -- --platform linux
tools/distribution/linux-deb-check.sh \
  --deb "dist/release/audivane_0.1.0_amd64.deb"
```

Outputs:

- `dist/release/audivane_0.1.0_amd64.deb`
- `dist/release/SHA256SUMS-linux.txt`
- `dist/release/release-manifest-linux.json`

Install layout:

- `/opt/audivane/audivane` (renamed from the unpacked technical executable)
- `/opt/audivane/resources` with `third_party` and the prepared notices
- `/usr/bin/audivane` symlink
- `/usr/share/applications/audivane.desktop`
- `/usr/share/icons/hicolor/.../audivane.png` and scalable SVG
- `/usr/share/doc/audivane` with project/Electron notices and
  `distribution-resources/notices/`

The package declares GTK3, NSS, X11/XCB, GBM/DRM, ALSA, ATK-bridge, CUPS,
Pango/Cairo and `xdg-utils` runtime dependencies. It declares `libc6 (>= 2.39)`
after auditing **every shipped ELF object**, including Electron helpers and
`resources/third_party` tools, against the supported Ubuntu 24.04 baseline.
The audit fails if any object requires a newer GLIBC symbol; setting
`CODEC_ABX_DEB_GLIBC_FLOOR` is deliberately rejected so the declared floor
cannot be lowered by environment.

`chrome-sandbox` is installed mode `0755`, never setuid. The application keeps
`chromiumSandbox: true`; the package does not contain `--no-sandbox`. The .deb
ships a narrowly scoped `/etc/apparmor.d/audivane` attachment for exactly
`/opt/audivane/audivane` with `flags=(unconfined)` and the `userns` permission;
`postinst` loads it with `apparmor_parser` when AppArmor is active, and a load
failure is not hidden. `prerm` unloads it on `remove`/`deconfigure` while the
conffile still exists, leaves it untouched for upgrades, and `postrm` never
tries to unload after dpkg has removed the conffile. `linux-deb-check.sh
--install` verifies the profile is absent from the loaded policy after `dpkg -r`
and after purge. This grants user namespaces to the installed executable only.
It is not a global `kernel.apparmor_restrict_unprivileged_userns` change, not a
broad profile and not a setuid workaround. If the installed path is still
blocked (for example on a host that prevents profile loading),
`linux-deb-check.sh --install` reports the blocker instead of changing host
policy.

Unprivileged content inspection is always safe. `--install` uses `dpkg -i`,
runs the packaged acceptance test against `/opt/audivane/audivane`, then
`dpkg -r audivane`, and fails if the install tree or registry state remains.
Use a disposable Ubuntu 24.04 VM for the installed check.

### AppImage

`--appimage` stages `build/appimage/Audivane.AppDir` and produces a real
AppImage only when `APPIMAGETOOL`/`--appimagetool` points at an explicitly
supplied tool **and** an explicit runtime is pinned with both
`--appimage-runtime FILE` and `--appimage-runtime-sha256 HASH` (or the matching
`APPIMAGETOOL_RUNTIME_FILE`/`APPIMAGETOOL_RUNTIME_SHA256` variables). Modern
appimagetool versions fetch the latest type2 runtime when no runtime is given;
Audivane refuses to run appimagetool without the pinned file and verifies its
SHA-256 before invocation, passing `--runtime-file` explicitly. The repository
does not download the tool or runtime and does not claim an AppImage artifact
when they are absent. AppDir renames the executable and updates
`distribution.json` to the installed command. AppImage deployment still needs
the same executable-specific userns AppArmor attachment as the .deb; the .deb
ships it, while an AppImage path requires an explicit host/user policy.

## Windows installer and ZIP

```powershell
npm run package:desktop:win -- --native-bundle build/distribution-resources/win32
npm run dist:windows -- --resources build/distribution-resources/win32
npm run dist:verify -- --platform win32
```

Outputs:

- `dist/release/Audivane-Setup-0.1.0-x64.exe`
- `dist/release/Audivane-0.1.0-win32-x64.zip`
- `dist/release/SHA256SUMS-windows.txt`
- `dist/release/release-manifest-windows.json`
- `build/nsis/audivane.nsi` (written even with `--no-installer`)

The NSIS installer is per-user and fixed under
`$LOCALAPPDATA\Programs\Audivane`; there is no directory page, so it never runs
`RMDir /r` against an arbitrary user-selected path. It:

- refuses an existing directory without the `.audivane-install` ownership
  marker;
- copies into a sibling staging directory, verifies the executable and
  `resources/distribution.json`, then activates it;
- aborts with an error level on partial copy, failed removal or a locked
  running installation instead of silently continuing (`/SD IDOK` keeps silent
  installs from blocking);
- writes quoted `UninstallString`/`QuietUninstallString` values for paths with
  spaces;
- preserves the ownership marker when an uninstall fails so a retry can finish;
- removes only the fixed directory, shortcuts and `HKCU` uninstall key.

`windows-install-check.ps1` performs install, metadata/registry verification,
the packaged Playwright acceptance, an optional locked-uninstall probe, and
uninstall on an actual Windows runner. Cross-packaging or Wine is not Windows
evidence. The CI job uses `windows-latest`, builds the pinned PE/DLL bundle and
runs that script; no signing credentials or publication steps are present.

## Release verification

`npm run dist:verify [-- --platform linux|win32]` holds the shared build lock
while it:

- rejects missing, duplicate, absolute or traversal artifact names;
- requires each manifest's version to match the current workspace version;
- verifies each artifact's size and SHA-256 (including `.exe` and `.AppImage`);
- cross-checks `SHA256SUMS-<platform>.txt` against the manifest;
- re-inspects `.deb` package metadata/content and `.zip` CRC/entries;
- verifies the generated NSIS contract when present.

Linux and Windows write separate manifests/checksum files
(`release-manifest-linux.json`/`SHA256SUMS-linux.txt` and the `windows`
counterparts), so building one platform cannot overwrite the other's evidence.

## Arch Linux

[Arch distribution](arch-distribution.md) adds a native makepkg/pacman binary
package using the same provenance-bound Linux Electron/native payload, Arch
dependencies and pacman desktop/icon hooks. It does not convert the `.deb` or
install its Ubuntu AppArmor policy. Actual Arch KVM install/sandbox/cleanup
checks passed; the full installed audio matrix remains a separate gate.

## Remaining release blockers

- Installed Linux launch depends on the package's narrow
  `/opt/audivane/audivane` AppArmor userns attachment loading successfully. A
  host that refuses profile loading can still block the sandboxed launch; no
  global host policy is changed.
- Final installed Linux UI/dialog/export acceptance, normal graphical desktop
  execution and physical listening remain open. Arch also needs cross-version
  upgrade acceptance. Bounded Ubuntu/Arch KVM sandbox and lifecycle checks
  already passed for recorded candidates.
- Windows artifacts require actual Windows execution acceptance and an explicit
  signing decision. Signed distribution needs signing setup and acceptance of
  the final signed bytes; an unsigned beta must disclose its status.
- Matching source archives and publication notes are prepared locally with
  `tools/prepare-publication.mjs`; final review and publication remain gated.

## Packaging concurrency and job budgets

`AUDIVANE_PACKAGE_JOBS` or `--jobs N` sets a **per-process** packaging budget
(1–32). The default reserves two available CPUs, allows approximately 512 MiB
available memory per job, and caps at 16. Separate simultaneous release processes each have their own
budget; choose smaller budgets when running several heavy builds together.

```bash
npm run dist:arch -- --prepare-only --jobs 12
npm run dist:linux -- --jobs 12
AUDIVANE_PACKAGE_JOBS=12 npm run dist:windows
```

The setting controls ZIP worker count, Arch **payload** zstd threads, and the
Debian compression ceiling. An explicit `DPKG_DEB_THREADS_MAX` retains priority
for Debian. The final pacman archive's compressor remains controlled by the
Arch builder's `makepkg.conf` (`COMPRESSZST`); configure that independently when
building the returned recipe in a VM. Compiler `JOBS` and browser test workers
are separate settings. This does not parallelize NSIS's solid zlib stream.

Windows ZIP entries are compressed and hashed in a bounded worker pool, then
assembled in sorted order with the existing timestamps, level 9 deflate, CRCs
and executable modes. Worker completion order does not change archive bytes.
Failed or cancelled compression drains the workers and preserves any previous
complete ZIP. A temporary ZIP is renamed only after its complete write.

Shared client/desktop builds and Electron packaging still run under
`build/verification.lock`. Native and Electron staging/mode stamps are scoped
by platform and architecture. Each release captures a private package under
`build/release-work/<platform>-*/` while holding that lock. Compression and
format verification then operate on that captured copy **outside** the lock.
Different formats may overlap; each format has its own gate. A final shared
lock protects artifact replacement, checksums and the last-written manifest,
so existing verification/publication readers cannot observe an in-progress
replacement. An interrupted replacement fails checksum validation. Source
changes during capture/compression refuse publication of the mixed build.
Private work directories are cleaned after success or failure. Generated
Arch recipes and NSIS inspection scripts keep their established paths.

No `ccache` dependency is added. The native scripts already retain build trees
and dependency stamps, and ordinary UI releases reuse exact audited native
binaries. `ccache` is an additional **compiler-result** cache: it becomes useful
for repeated clean native builds, switching native branches or flags, and
rebuilding many unchanged translation units. It does not accelerate ZIP,
NSIS, UI bundling or linking. It costs cache storage and configuration; a cold
cache still compiles. For the current UI/package workload, it adds little.
If native development becomes frequent, add it as an optional, bounded cache
on persistent NVMe, separately per pinned compiler/target environment, with
normal hash/provenance and scientific checks retained. See the
[ccache manual](https://ccache.dev/manual/latest.html).
