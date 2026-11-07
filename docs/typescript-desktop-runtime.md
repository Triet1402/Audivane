# Desktop runtime and packaging

This describes the current desktop runtime and its setup. The
private worker uses `@codec-abx/engine-native/typescript`
(`TypeScriptNativePreparationEngine`) with direct native FFmpeg/ffprobe/codec
helpers and the shared `aligned-gain-matched-v1` policy. See
[desktop runtime](typescript-desktop-runtime.md) and
[desktop runtime](typescript-desktop-runtime.md).

The runtime uses Electron **45.1.0**, `@electron/packager` **20.3.0**, and esbuild
**0.28.2**, pinned in the project lockfile. The private worker owns one native
shared engine and the experiment service; main supervises it and retains dialogs
and fixed IPC. React receives only the versioned `DesktopBridge`
on `window.codecAbxDesktop`. The browser build remains a separate Vite target.

## Ownership and boundary

The source dialog accepts WAV, FLAC, MP3, M4A/AAC and Ogg/Opus up to 512 MiB
and thirty nominal minutes, including supported 32-bit sources; see
[audio import](audio-import.md). Main stores the resolved
path and returns a random handle, basename, and size. Selecting another source
invalidates previous source handles. Neither requests nor public errors accept
or reveal source paths. Trusted launcher configuration may set absolute native
executable paths (`CODEC_ABX_FFMPEG`, `CODEC_ABX_FFPROBE`,
`CODEC_ABX_LDAC_HELPER`); renderer requests cannot change executables or
resource roots. An explicit path is authoritative: if it is unusable the tool is
reported unavailable rather than replaced by another binary. Development runs
fall back to the checkout's vendored `third_party` builds and then `PATH`; the
packaged app never reaches back into the checkout.

Main stores preparation metadata and resolves bindings by artifact ID with its
own binary readers. Renderer-modified metadata cannot enter the service.
Candidate bindings are pinned during verification; successful replacement drops
only the old pin. Failed replacement retains the previous binding. Releasing a
bound or currently verifying artifact refuses with `artifact-in-use`. Closing
an experiment disposes its service and drops its binding; the next `configure`
explicitly creates a fresh service. Preparation artifacts remain caller-owned
until release or renderer teardown. No failed operation recreates a run.

Native jobs have unique renderer-supplied bounded IDs and main-owned abort
controllers. Cancellation waits for the prepare promise, including cleanup;
late successes are released and never published. Renderer destruction, crash,
reload/navigation attempt, window close, or application quit invalidates its
runtime and awaits engine/service cleanup. Main retains at most four artifacts,
one preparation job, and 4,096 job IDs per renderer lifetime. Concurrent capability
requests share one native probe. Progress listeners expose only job ID and public
progress, never Electron events.

Each fixed IPC channel validates an exact versioned envelope, request ID, argument
count/shape, enums and handle bounds. Main accepts only the owned WebContents,
its main frame, and the exact bundled document URL. Duplicate in-flight request
IDs and more than 64 concurrent requests refuse. No generic invoke or channel
selection crosses preload. Errors cross contextBridge as plain structured objects
with `message`, `code`, `reasons`, and `uncertain`; custom Error properties would
be lost at that boundary. Unknown answer failures and interrupted answer transport
are uncertain; explicit service refusals are definite. Native error messages are
sanitized because subprocess diagnostics may contain private paths.

The secure `codec-abx://app/index.html` origin serves realpath-contained bundled
assets only. Symlinks escaping the asset root refuse. CSP restricts scripts,
workers, connections and styles to local assets (inline React styles are allowed),
blocks frames/objects/forms, and allows local Blob audio. Node integration and
webviews are disabled; context isolation and renderer sandboxing are enabled.
Remote requests, navigation, popups and permissions refuse. Downloads accept only
single-origin local Blob JSON/text/WAV exports, with a controlled native save
dialog and sanitized suggested filename. There is no native arbitrary-file reader.

These choices follow Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
[process model](https://www.electronjs.org/docs/latest/tutorial/process-model), and
[custom protocol guidance](https://www.electronjs.org/docs/latest/api/protocol).
Local runtime custody remains self-test authority, not remote trusted custody.

## Theme and window zoom

The renderer's theme switcher selects System, Light or Dark and stores that local
preference. Window zoom belongs to Electron main: View provides Zoom In, Zoom
Out and Actual Size, with Ctrl/Cmd plus, minus and 0 shortcuts, including equals
and numpad variants. The bounded ladder runs from 80% to 200%, and main saves a
versioned `zoom.json` under the platform's application user-data directory.
Malformed preferences fall back to 100%. macOS retains standard Edit and Window
menus so native clipboard and window shortcuts continue to work. Zoom grants no
renderer IPC and does not change audio processing or OS display scaling.

## Build and launch

From the checkout:

```bash
npm ci
npm run build:desktop
npm run desktop
npm run package:desktop
npm run test:desktop
```

`build:desktop` bundles main/preload to `apps/desktop/dist/main.cjs` and
`preload.cjs`, then copies the shared client build under `dist/client`.
`package:desktop` produces the unpacked Linux x64 executable:

```text
dist/desktop/Codec ABX-linux-x64/codec-abx
```

The package includes renderer assets and the bundled main/preload/private
worker. Packaged resource resolution uses
Electron's resources directory, independent of checkout CWD. The developer
launcher derives its root from its own file location.

FFmpeg, ffprobe and the optional LDAC helper are external native prerequisites
by default (or explicit absolute environment paths). The native capability probe detects missing executables/codecs and discloses
unavailability; no simulated codec, upload or interpreter fallback exists.
Check the actual host or prepared bundle before launching:

```bash
npm run check:native
npm run check:native -- --json
npm run check:native -- --native-bundle /absolute/prepared-resources
```

A missing FFmpeg or ffprobe is a required failure; missing LDAC is only an
optional warning. The report uses real capability probes, not file existence.
See [desktop runtime](typescript-desktop-runtime.md).

For example, after packaging, launch from another directory with absolute native
tool paths:

```bash
cd /tmp
CODEC_ABX_FFMPEG=/absolute/path/to/ffmpeg \
CODEC_ABX_FFPROBE=/absolute/path/to/ffprobe \
CODEC_ABX_LDAC_HELPER=/absolute/path/to/ldac_helper \
  '/absolute/path/to/Codec_ABX_test/dist/desktop/Codec ABX-linux-x64/codec-abx'
```

The package does not discover release binaries from PATH at packaging time and
does not include them unless an explicit prepared resources tree is supplied.
The packaged app retains external-tool mode and may still use PATH at runtime
when no bundle is present. Opt in with
`CODEC_ABX_NATIVE_BUNDLE_DIR=/absolute/prepared npm run package:desktop` (or
`npm run package:desktop -- --native-bundle /absolute/prepared`). The tree is
validated, hashed, manifested and copied to packaged `resources/third_party`,
which the existing resources-path resolver finds independently of checkout/CWD.
Incomplete, non-executable, wrong-architecture or provenance-incomplete input
fails before a new package is produced. Linux requires x64 ELF; Windows requires
x64 PE32+ with source/hash and DLL-closure checks. Packaging never downloads
native binaries or copies arbitrary PATH executables.

The [distribution packaging guide](distribution-packaging.md) extends this
unpacked developer workflow with a Linux `.deb`, optional AppImage and Windows
NSIS/ZIP preparation. The Linux distribution baseline is Ubuntu 24.04 / GLIBC
2.39, with rebuilt codecs; actual platform acceptance and remaining blockers
are recorded in [development guide](development.md). Signing, updates and
physical device/human listening remain separate gates.

Packaging derives version/license from the root manifest, deliberately excludes
unused browser codec WASM/glue, and preserves fonts and project/measurement
notices. Final distribution resources also carry the full
[matching license/source inventory](distribution-licenses.md). Windows runtime
acceptance is not inferred from Linux packaging or structural PE validation.

Verification build stamps cover actual packaging inputs: the shared client and
desktop bundles, build tooling, and, when opted in, the explicit native bundle's
path, exact bytes/modes and bundle-vs-external mode. Generated native bundle
and desktop package outputs are owned build paths; packaging cleans those
trees before producing a new unpacked package.

## Development host setup and sandbox

This host initially lacked GTK3. The optional Debian/Ubuntu helper downloads
matching repository packages and extracts them **only under `build/`**:

```bash
bash tools/setup-desktop-host-libs.sh
```

Developer/test launchers automatically use these local libraries. Exact downloaded
archive checksums are recorded in `build/desktop-host-libs/debs.sha256`; the helper
follows the configured distro repositories and is not a portable redistribution
of GTK. Other Linux hosts should install their normal Electron runtime libraries.
A direct packaged launch may need the same `LD_LIBRARY_PATH` as the developer
launcher on this minimal host.

Ubuntu's AppArmor restriction on unprivileged user namespaces also blocked secure
Electron launch here. The concrete attempt used `chromiumSandbox: true`, with no
`--no-sandbox`, and aborted at Chromium's SUID fallback. Do not change the sandbox
flags or make the bundled helper setuid as a workaround. The following generates
an executable-specific, reviewable profile allowing the development and unpacked
executables to create user namespaces:

```bash
node tools/desktop-apparmor-profile.mjs > build/codec-abx-desktop.apparmor
cat build/codec-abx-desktop.apparmor
```

After user review, a host administrator can load just those two attachments:

```bash
sudo install -m 0644 build/codec-abx-desktop.apparmor /etc/apparmor.d/codec-abx-desktop
sudo apparmor_parser -r /etc/apparmor.d/codec-abx-desktop
```

The generated profile uses quoted absolute executable paths, `flags=(unconfined)`,
and the `userns` permission; it does not disable AppArmor's global restriction.
Moving the checkout/package requires regenerating the attachments. Privileged
host changes are not performed by the development/test scripts.
