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

`third_party/fonts.json` records the input and output SHA-256 for every copy.
To reproduce the metadata change, use the original WOFF2 files from the git
parent of this change, install `fonttools[woff]==4.61.1` in a Python virtual
environment and run `tools/rename-subset-fonts.py`. Do not run it on renamed
outputs. Preserve the OFL notices with redistributed fonts and include this
modification record in release materials.

This addresses font naming and notice handling. Native and browser codec
release gates remain documented in `docs/distribution-licenses.md` and
`website/BROWSER-MATERIALS.md`; generating notices alone does not certify a
published binary or settle codec patent rights.
