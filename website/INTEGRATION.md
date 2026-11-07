# Integration contract — website + /demo/ browser app

Owner of this file: the `/website` content site. Counterparties: the
`apps/client` build agent and the parent that wires the deployment. This
site deliberately **has no `/demo/` route**; the real client is served there.

## Final tree

The parent composes one static tree for the Cloudflare zone:

```
<site>/                ← Astro output: website/dist/
├── index.html …       ← home, docs/, guides/, downloads/, sitemap, robots
├── fonts/ mark.svg
└── demo/              ← apps/client build output (NOT built by Astro)
    ├── index.html     ← the real workbench + its hashed JS/WASM assets
    └── …
```

- The website links to `/demo/` (nav "Open app", home, footer, downloads
  row). Trailing slash matters: Vite builds use `base: "/"`, so the app
  expects to be served from a root it can address absolutely. If the client
  is placed at `/demo/` rather than `/`, its Vite config needs
  `base: "/demo/"` and a rebuild — coordinate with the client agent before
  first deploy; do not assume a copy alone works.
- Astro's sitemap, robots and canonical/OG URLs never include `/demo/`.

## Demo must stay out of search

The website cannot inject meta tags into the app's `index.html`. The client
build (or the host) must ensure **both**:

1. `<meta name="robots" content="noindex">` in the demo app's `index.html`, and
2. `X-Robots-Tag: noindex` on `/demo/*` responses
   (`_headers` file or Cloudflare rule).

`website/public/robots.txt` already references only the site sitemap.
Heavy browser-app assets (WASM codecs, workers) must load only under
`/demo/` — the site pages ship zero app JS.

## Dev preview without the app

`npm run dev` / `npm run build` work standalone; `/demo/` links 404 locally
until the parent copies a client build in (e.g.
`vite build --config apps/client/vite.config.ts` with `base: "/demo/"` into
`<site>/demo/`, then serve the combined tree with
`npx wrangler pages dev` or any static host that honors `_headers`).

## Content sync discipline (website ↔ docs/)

`content/docs/*` and `content/guides/*` are curated user-facing renderings.
Claims pages are **fingerprint-gated**, so summaries can never drift silently:

- Each docs page's frontmatter records `source:` (the repository document its
  claims come from) and `source_sha256:` (that document's SHA-256 at the time
  the summary was last reviewed).
- `src/provenance.mjs` verifies every pin whenever the site is synced, served
  or built (`astro sync/dev/build/check`), and the build **fails** with an
  actionable report when a source document changed.
- Resolution: re-read the source, update the public summary where claims
  moved (keeping the validity-vs-audibility wording and the
  completed/sealed/early-ended lifecycle distinctions exact), bump `updated:`
  and `description:` if the summary changed, then run `npm run sources:pin`
  to re-record fingerprints. Reviewers see a one-line diff per reviewed page.
- Guides record `source:` for review context only (workflow copy, not claim
  text) and are not fingerprinted.
- Never bulk-copy `docs/` into `content/` — developer, verification and
  packaging notes stay unpublished.

## Dependencies owned elsewhere

Root workspace wiring, lockfile, CI scripts under `website/scripts`, and
tests belong to the parent/other agents. This site needs only the
dependencies listed in `website/package.json`.
