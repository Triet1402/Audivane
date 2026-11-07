# Audivane website design system

Mode: the home page is Persuade; docs, guides and downloads are Read.
The visual world expands the original landing: self-hosted IBM Plex, warm
paper and copper, slate and blue, or olive and brass; a hairline system and
a dark comparison instrument with an illustrative waveform.

This file is the record for `website/` only. The workbench UI's own design
record remains `apps/client/DESIGN.md`.

## Tokens

The CSS variables in `src/styles/global.css` are authoritative. A persisted
header picker offers System, Daylight, Midnight and Studio. System follows
`prefers-color-scheme`. The original palette table below is historical.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f1f2f5` | `#1e1f22` | page ground |
| `--surface` | `#ffffff` | `#2b2d31` | skip link, cards |
| `--raised` | `#e9ebf1` | `#313338` | bands, hovers, code fill |
| `--ink` | `#1a1d24` | `#f2f3f5` | text |
| `--muted` | `#555d6d` | `#b5bac1` | secondary text (≥4.5:1 on both grounds) |
| `--line` | `#d7dbe3` | `#3f4147` | hairlines |
| `--line-strong` | `#c4c9d3` | `#4a4d54` | emphasized rules |
| `--blue` / `--blue-hover` | `#4053c9` / `#2f41b0` | `#5865f2` / `#4752c4` | primary fill |
| `--accent-text` | `#3a4cb6` | `#8b96ff` | links, focus, current nav |
| `--screen*` | `#1e1f22` ground figure | `#26272b` + border | comparison figure, dark in both themes |

Selection, caret, scrollbars, focus rings and tabular numerals are themed
from the same palette. Focus is a 2px `--accent-text` outline, 3px offset.

## Type

- IBM Plex Sans 400/600/700, IBM Plex Mono 500, self-hosted from
  `public/fonts/` (OFL license retained). No runtime font fetch.
- Display: `clamp(44px, 5.2vw, 74px)` hero, −0.04em tracking floor;
  section h2 `clamp(30px, 3.3vw, 44px)`.
- Prose is 16.5px/1.75 capped at 68ch; tables sit full article width with
  tabular numerals. Mono is reserved for code, file names and artifact
  names — never as a "technical" costume.

## Layout

- `.wrap` is `min(1280px, 100% − 96px)` (64/40px gutters at 1000/700px),
  identical to the landing.
- Home: hero (text + rotated comparison figure), raised local-processing
  band, how-it-works with hairline-stepped articles, learn columns (hairline
  list rows, not cards), raised release-status band with platform `<dl>`,
  evidence-limits section.
- Docs/guides shell: sticky 224px section rail + article + 208px on-page TOC;
  collapses to a wrap-rail at 860px and hides the TOC at 1180px. Breadcrumbs
  above every article; prev/next pager below.
- The masthead is the landing masthead plus an `Open app` pill linking
  `/demo/` (the real client — see INTEGRATION.md). No JS menus; the nav wraps.

## Motion

One authored moment: the hero intro and figure rise once (`0.6s`,
`cubic-bezier(.16,1,.3,1)`, opacity + translate) under
`prefers-reduced-motion: no-preference`. Everything else is static.

## Voice and claims

Scientific wording preserves the repository policy exactly: validity is not
audibility; early-ended, sealed and completed runs stay visibly distinct; no
claim of audibility, conformance or certification; downloads exist only after
acceptance, so no fabricated links. Status copy mirrors
`docs/release-notes-0.1.0.md` and `docs/distribution-strategy.md`.

## Content pipeline

`content.config.ts` defines `docs` and `guides` collections over
`content/**` with required frontmatter (`title`, `description`, `order`,
`updated`, `source`). `source` names the repository document each page was
produced from; claims pages also carry `source_sha256`, verified by
`src/provenance.mjs` on every sync/dev/build/check — a changed source fails
the build until the public summary is re-reviewed and re-pinned
(`npm run sources:pin`). Only curated files exist in `content/`, so developer
notes are never published automatically. Sync discipline: INTEGRATION.md.

## Verification

Build with `npm run build` (Astro static). Check keyboard focus, both themes
at 1440/768/390/320px, sitemap and robots, and every internal link
including `/demo/` reachability after the app copy step.


## November 2026 visual refinement

The website now uses warm paper and copper for Daylight, slate and blue for
Midnight, and olive charcoal and brass for Studio. System follows the OS.
The header picker persists locally, independently of the audio workbench.
Its small inline script is authorized by an exact SHA-256 CSP hash; no general
script origin or evaluation permission is added to content routes.
The homepage retains its factual copy and self-hosted Plex typography, with
larger display type, a geometric illustrative waveform (not measured audio),
a dark listening instrument figure and a high-contrast local-processing band.
