# Bundled font licensing

The bundled Latin subsets derived from IBM Plex Sans and IBM Plex Mono are
licensed under SIL OFL 1.1, separately from Audivane's MIT code. IBM's copyright,
Reserved Font Name declaration and full license are preserved in each public
font directory and in `apps/client/public/ibm-plex-OFL.txt`; the client source
font directory also includes `OFL.txt`.

The subsets now use the primary names **Audivane Sans Latin** and **Audivane
Mono Latin**, including internal family, unique, full and PostScript names and
CSS aliases. Glyphs, outlines, metrics and character coverage are unchanged.
Existing asset filenames identify their origin and remain stable. These are
project derivatives, not new IBM releases. Copyright and license fields are
unchanged. The wordmark's outlined artwork is unaffected.

The audit's proposed CSS alias `IBM Plex Sans` still includes the reserved name
`Plex`; a CSS-only rename would also leave internal font names unchanged.
The approach here follows the OFL guidance for modified webfont subsets:
https://openfontlicense.org/webfonts-and-reserved-font-names/

`third_party/fonts.json` records, for every copy: the input, output and
content SHA-256, and the family the copy belongs to (`family`). `npm run
check:fonts` (`tools/check-subset-fonts.mjs`, also part of the unit and
production lanes) decodes each bundled WOFF2 with no third-party dependencies
and verifies:

- the manifest inventory matches the bundled files exactly — fonts on disk
  missing from the manifest, manifest entries without a bundled file and
  duplicate paths all fail — and the manifest's license, family list and
  pinned fonttools version remain intact;
- the recorded file hashes match the bytes on disk, every copy belongs to a
  listed family, and copies that share an upstream original produce identical
  renamed file hashes, content fingerprints and families;
- the renamed name records name the renamed Audivane Latin family and carry
  no reserved font name, the IBM copyright (nameID 0) and OFL license URL
  (nameID 14) records are required to be present, and the family, PostScript
  and OFL license text records, where present, must be based on the copy's
  recorded family and keep the OFL license text;
- an OFL notice sits beside every font directory; and
- a content fingerprint over every stored table except the name table and the
  head table's checkSumAdjustment, which the format requires to change with
  any file edit, matches the manifest's `contentSha256`, which must equal the
  `originalContentSha256` recorded from the pre-rename subset, so the glyph
  and metric data are proven byte-identical to the original subsets and the
  evidence is not self-attesting.

Anyone can reproduce a recorded original fingerprint from the upstream file
with `node tools/check-subset-fonts.mjs --fingerprint <file>`.
To reproduce the metadata change, use the original WOFF2 files from the git
parent of this change, install `fonttools[woff]==4.61.1` in a Python virtual
environment and run `tools/rename-subset-fonts.py`; it fingerprints the
originals, then invokes `node tools/check-subset-fonts.mjs --update` to
record the renamed content hashes and verify the result. Both tools read the
font directories and the rewritten name-record IDs from
`tools/check-subset-fonts.mjs`, the shared source of truth. Do not run it on
renamed outputs. Preserve the OFL notices with redistributed fonts and
include this modification record in release materials.

This addresses font naming and notice handling. Native and browser codec
release gates remain documented in `docs/distribution-licenses.md` and
`website/BROWSER-MATERIALS.md`; generating notices alone does not certify a
published binary or settle codec patent rights.
