# Audivane 0.2.1

Font naming and license notice corrections.

## Changes

- Bundled Latin subsets now use Audivane Sans Latin and Audivane Mono Latin
  in internal font metadata and CSS, avoiding IBM's reserved font name.
- IBM copyright and SIL OFL 1.1 notices remain intact. Added the missing OFL
  copy beside client source fonts and recorded input/output font hashes and
  reproduction instructions.
- Added MIT license metadata to the website package and lockfile.
- Rebuilt desktop packages, source/license materials and website assets.

## Downloads

Ubuntu 24.04+ x64 `.deb`, Arch x86_64 `.pkg.tar.zst`, and Windows x64 unsigned
installer and portable ZIP. Matching application source, codec source/build/
license materials, platform manifests and SHA-256 checksums accompany these
artifacts. No macOS or AppImage package is provided.

## Verification and limits

Font checks confirm unchanged glyph, metric and copyright data across all
12 bundled files. Distribution/provenance tests, version consistency,
TypeScript compilation, builds and structural/checksum verification cover this
patch. No new full installed-platform, upgrade or physical listening pass is
claimed. Windows builds remain unsigned. Codec patent/distribution review is
separate from these font and notice corrections.
