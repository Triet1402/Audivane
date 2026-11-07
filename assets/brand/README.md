# Audivane identity

The public project name is **Audivane**. Subtitle: **Blind audio comparisons.**

The symbol is a split A: two equal vanes, two listening sides, with a continuous
open channel between them. It uses solid geometry and no effects so the same
mark works in a single color and at small icon sizes.

## Files

- [Blue symbol](audivane-mark.svg): transparent, 256 × 256 viewBox.
- [Monochrome symbol](audivane-mark-mono.svg): `currentColor`, black by default;
  set `color` when inlining, or change the fill for a standalone white export.
- [Light-background wordmark](audivane-logo.svg): blue symbol, charcoal lettering.
- [Dark-background wordmark](audivane-logo-dark.svg): pale blue symbol, light lettering.
- [Transparent PNG symbol](audivane-mark.png): 1024 × 1024 raster export.
- [Preview sheet](audivane-preview.png): light/dark wordmarks and icon sizes.

The SVGs are the source assets. All lettering is outlined, so rendering does not
depend on installed fonts, network access, embedded bitmap data or external files.
The preview and PNG were rendered from these SVGs; they are not image-generated.

## Use

Keep the internal gap open. Preserve the square symbol viewBox and leave at
least one stem-width of clear space around the visible symbol. Use the supplied
light/dark wordmark rather than putting charcoal lettering on a dark surface.
Prefer the standalone mark below a 160 px total logo width; use the supplied
simple geometry at 16/24/32 px rather than adding fine details.

Colors follow the existing workbench: primary blue `#5865f2`, dark-surface blue
`#8b96ff`, charcoal wordmark `#243044`, light wordmark `#f2f3f5`.
The wordmark is outlined from the project's IBM Plex Sans Medium font. Its
[SIL Open Font License and attribution](../../apps/client/public/ibm-plex-OFL.txt)
remain with the project; the logo requires no font installation.
The original symbol is covered by the project [MIT license](../../LICENSE).

Distribution icon exports now live in `icons/` (16–512 px PNG and Windows ICO).
Regenerate them with `npm run icons:export`; the original SVG remains the source.
The app header, browser favicon, desktop window and installer use this identity. Stable scientific/export identifiers do not need
to change with the display branding.
