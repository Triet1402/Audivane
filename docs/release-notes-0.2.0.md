# Audivane 0.2.0

A simpler listening interface, clearer results, and fewer distractions.

## Changes

- Simplified Setup, Listen and Evidence, with prominent accuracy, score, p-value
  and confidence interval statistics.
- Correct/Incorrect feedback stays beside the trial heading without moving the
  playback controls. Completing a test keeps the controls in place.
- Reset immediately loads trial 1 paused, without an extra Start step.
- Consistent expanded/collapsed sections when switching tabs.
- Runtime capabilities remain within the main panel. Expanded content scrolls
  with the page; the desktop sidebar stays in place.
- Audio previews and WAV downloads work after a run ends.
- One **Download results** action includes both the listening record and full
  diagnostics. Active-run exports retain the existing answer redaction.
- Removed obsolete UI components, copy and styles; updated tests and design notes.

## Downloads

Planned assets: Ubuntu 24.04+ x64 `.deb`, Arch x86_64 `.pkg.tar.zst`, and
Windows x64 unsigned installer and portable ZIP. Matching application source,
codec source/build/license materials, platform manifests and SHA-256 checksums
accompany the release. No macOS or AppImage package is planned for this release.

## Verification and limits

Version consistency, TypeScript compilation and package structure/checksums are
checked during preparation. This UI release does not claim a new full browser,
installed-platform, upgrade or physical listening test pass. Historical 0.1.0
platform checks apply to those earlier artifacts only. Windows builds remain
unsigned.

Audio processing remains local. Fixed-trial scoring, preparation gates and
exact-byte verification are preserved. Listening results do not certify codec
conformance, Bluetooth transport or physical audibility.
