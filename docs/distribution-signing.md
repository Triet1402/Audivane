# Signing preparation

All current candidates are **unsigned**. No certificate, account, signing
provider, publisher identity, timestamp endpoint or private key has been
selected or invented. [The signing template](../assets/brand/signing.example.json)
is disabled and contains environment-variable names only. It is a reviewable
plan, not an active signing configuration; packaging does not read or execute it.

The pinned Electron packager exposes `windowsSign` through
`@electron/windows-sign`. Once a real publisher/provider is selected, configure
SHA-256 and that provider's timestamp endpoint. Supply certificate paths and
passwords only through the build machine's protected environment/credential
store. Keep actual configuration, certificates and passwords out of Git,
command arguments, artifacts and logs. No credentials are needed for the local
unsigned acceptance performed here.

Sign the final application before creating ZIP/installer archives; sign the
installer after compilation. Signing a native executable changes its bytes:
retain its unsigned build digest and signed digest, update its VERSION and
native manifest provenance deliberately, then rerun PE/DLL and package/hash
checks. Never reuse an unsigned binary hash for a signed native payload.
Regenerate all release checksums/manifests and repeat installed acceptance for
the signed final candidates. Certificate validity and timestamp verification
must run on the actual Windows target. Signing alone is not runtime, scientific
or SmartScreen-reputation acceptance.

Linux may separately use a maintainer-selected detached signature over the
final checksum list. The `.deb` and AppImage do not become runtime-compatible
or scientifically valid because a checksum is signed. This session creates no
key, tag, signed release, upload or store submission.
