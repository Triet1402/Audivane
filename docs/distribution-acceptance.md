# Audivane distribution acceptance

This checklist separates artifact inspection from execution on the target OS.
A build produced on Linux is not Windows runtime evidence. A rootfs codec build
is not a clean Ubuntu desktop install. Keep the Chromium sandbox enabled in all
runs; never use a setuid helper or a global AppArmor relaxation to complete a run.

Current bounded results and remaining gaps are recorded in the
[release guide](releasing.md). The [distribution strategy](distribution-strategy.md)
separates the recommended first release from later formats.

## Linux x64

The selected codec build baseline is Ubuntu 24.04 LTS / glibc 2.39.
Use a disposable, fully updated Ubuntu 24.04 desktop VM with its normal security
policy, audio service and graphical login. Copy only the versioned artifacts and
checksums into it; do not mount the checkout or developer library directories.

1. Verify SHA-256 against the manifest. Install the `.deb` using
   `sudo apt install ./audivane_0.1.0_amd64.deb`, which resolves its declared
   GTK/audio/desktop dependencies. Record the OS/kernel/package versions.
2. Launch from the application menu and `/usr/bin/audivane`, from a directory
   containing spaces and non-ASCII characters, with Node/npm and PATH
   codec tools absent. Record the actual `/opt/audivane/audivane` executable and
   native manifest hashes. Verify renderer sandbox state and narrow IPC.
3. Complete the functional matrix below using the installed app. Repeat after
   upgrading the same package; verify a stale resource deliberately added only
   to the prior installed version is removed or explicitly accounted for.
4. Close the app during native preparation and while idle. Verify no owned
   codec/helper/renderer processes or temporary source/preparation files remain.
5. Run `sudo apt remove audivane`, verify the menu, command and `/opt/audivane`
   package files disappear, and repeat with `sudo apt purge audivane`. Preserve
   user-created exports. User settings/cache are separate from package files.

The `.deb` supplies a narrow AppArmor `userns` attachment for exactly
`/opt/audivane/audivane` and loads it during installation when AppArmor is active.
Verify that attachment is loaded, applies only to the installed executable and
is unloaded during package removal. This is package-owned integration in the
disposable test VM; the build command does not modify host security policy.
If normal policy prevents loading it, retain the actual sandbox error as a
blocker. A developer-path launch cannot satisfy this installed-path gate.

AppImage additionally needs a real launch via its mounted runtime and the same
matrix. Extracting it or checking an AppDir alone does not establish AppImage
support. Record FUSE/runtime dependencies and final sandbox behavior.

## Arch Linux x86_64

Use the [Arch recipe, installed KVM evidence and probe](arch-distribution.md).
Verify the `.pkg.tar.zst` hash, install using pacman and observe the real
installed renderer sandbox. Reinstall, remove, verify desktop/icon/license
cleanup and preserve user exports. Complete the functional matrix below on
the intended graphical desktop, including cross-version upgrade. The package
uses native user namespaces and installs no Ubuntu AppArmor policy.

## Windows x64

Use an actual Windows 11 x64 runner and a clean interactive Windows VM. Preserve
normal Defender, UAC and Chromium sandbox settings. Record the exact OS build.

1. Verify installer/ZIP hashes, PE x64 architecture, DLL closure, provenance and
   signature status. Unsigned local builds must be labelled unsigned.
2. Install NSIS as a standard user into its dedicated per-user Audivane folder.
   Exercise interactive and `/S` installs, Start Menu/Desktop shortcuts and
   uninstall registration. No administrator prompt should be required.
3. Test paths containing spaces and non-ASCII characters; launch the installed
   executable and a separately extracted portable ZIP without checkout, Node,
   npm, PATH codecs or a developer MSYS2 environment.
4. Complete the matrix below. In particular, close/crash the renderer, worker
   and main process during long preparation, cancel during encode/decode, retry,
   and verify descendants and locked files are released. `taskkill /T` alone is
   not proof of custody after an early leader/main exit; retain that blocker
   until a Job Object or equivalent lifetime mechanism is accepted on Windows.
5. Upgrade a previous install while closed. Attempt an upgrade while running:
   it must refuse safely or close the application by an explicit supported flow,
   never report a partially copied install as success. Verify unrelated files
   outside the owned install tree survive.
6. Uninstall interactively and silently. Verify shortcuts, registered uninstall
   entry and application files disappear. Preserve user exports; document the
   separate optional removal of app settings/cache. Test ZIP cleanup with no
   files held open.

Prepared CI is evidence only after its actual run and retained result. Do not
advertise tested Windows support from a Linux cross-build or Wine smoke test.

## Functional matrix for each installed format

- All eleven catalog codec IDs, including LC3 and LDAC; missing capabilities
  refuse explicitly. No aliases, substitution or weakened numerical gates.
- Mono and stereo (including anti-phase and channel-isolation material), input
  44.1/48/96 kHz, preserve-input policy and explicit forced session rates.
- Lossless analytical fixtures with known gains/delays/nonzero nulls; lossy
  chains with independent evidence where applicable. Retain exact final served
  WAV hashes, channels/rate/frame counts and byte-binding/refusal results.
- Prepare test stages trial 1 paused; explicit Play, A/B/X switching, fixed-N
  completion, optional calibration, token retry and running/completed exports.
- Native source dialog, cancel dialog, long/non-ASCII filename, save/export
  dialog and overwrite handling. Inspect redacted running exports.
- Cancel/reprepare, worker failure, renderer teardown, restart and temporary-file
  cleanup, including Windows locked-file failures. Report unconfirmed cleanup.
- Physical headphone/device routing and human listening separately from digital
  loopback capture. A scientific validity pass is not an audibility claim.

## Publication preparation

Keep release notes and checksums local. The draft release should attach each
accepted binary, its platform manifest, exact application source, and matching
codec source/build/license materials. Verify that final archives contain no
private paths, private fixtures or credentials; retain intended public test fixtures. Audit the actual copied source tree, its new initial commit and final downloads
for credentials and private material. The private development history stays out
of the snapshot repository; audit any additional history only if it will be published. No release tags, uploads, store submissions or
repository setting changes are implied by these commands.
