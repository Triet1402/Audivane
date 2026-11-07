# Audivane 0.1.0

The first public Audivane release provides blind listening comparisons using
your own audio. Audio is processed locally, in the browser preview or the
desktop application.

## Downloads

- Ubuntu 24.04 or newer x64: Debian `.deb` package.
- Arch Linux x86_64: pacman `.pkg.tar.zst` package. `0.1.0-1` means application
  version `0.1.0`, package revision `1`.
- Windows x64: **unsigned** per-user installer and portable ZIP. Windows may
  show an unknown-publisher or SmartScreen prompt; no signing identity is claimed.
- Application source, matching codec source/build/license materials, platform
  manifests and SHA-256 checksums accompany the downloads.

macOS and AppImage downloads are not included. Verify the applicable checksum
before installation. This first release retains the testing limits below.

Audivane provides local blind audio comparisons with shared TypeScript audio
policy, native desktop codecs and explicit sample-rate/layout disclosures.
The desktop application runs without Node/npm or a developer checkout.

This release integrates the Audivane name, “Blind audio comparisons.” subtitle
and original SVG-derived icons. It prepares Linux x64 Debian/AppImage packaging
and Windows x64 portable/NSIS packaging. An Arch x86_64 pacman package is also
produced with native makepkg; installed native/sandbox/reinstall/removal checks
passed in an Arch KVM guest. See [Arch evidence and bounds](arch-distribution.md). Native releases require explicit,
hash-verified FFmpeg/ffprobe plus LC3 and LDAC resources; generic PATH codecs are
not substituted. Desktop packages exclude unused browser codec WASM assets.

Scientific policy identifiers, mono/stereo behavior, explicit rate policy,
`aligned-gain-matched-v1`, exact-byte listening binding and sandboxing are
preserved. Codec capability and numerical checks establish bounded evidence;
they do not certify audibility, Bluetooth transport or codec conformance.

Downloads include SHA-256 checksums, provenance and matching
application/native source, build and license materials. MIT covers the
project-owned code; Electron/Chromium, fonts and codec libraries retain their
own licenses. See [license materials](distribution-licenses.md).

Linux installed-path sandbox and package lifecycle passed in Ubuntu 24.04 KVM
guests. Unsigned Windows 11 x64 installer and portable builds passed bounded
install, sandboxed FLAC listening/export, repair/removal and process-lifetime
checks; see the [Windows acceptance record](windows-acceptance-0.1.0.md).
Testing still to complete includes the complete installed Windows codec matrix,
interactive/cross-version upgrade checks, a normal Linux graphical desktop, physical listening and physical-device coverage across target systems. Windows packages are unsigned. Private development history is excluded from the
new release repository. Do not describe
prepared automation or cross-produced artifacts as completed OS acceptance.

Installation, upgrade, uninstall and per-format checks are documented in
[distribution acceptance](distribution-acceptance.md). The build commands and
recorded results are maintained in [releasing](releasing.md).
