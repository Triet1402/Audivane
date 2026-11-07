# Product context — audivane.app website

Written for this implementation task from the repository's existing truth
(`README.md`, `DESIGN.md`, `docs/`, live `apps/landing`); assumptions are
labeled below rather than invented.

## What this is

The root content website for Audivane at `https://audivane.app` — a static
Astro site (home, docs, guides, downloads) that becomes the public home and
SEO surface, eventually served alongside the real browser app at `/demo/`
behind a self-managed Cloudflare zone. The existing single-file landing is
the incumbent look and stays intact until the parent migrates.

## Who it serves

Curious listeners and light-audio skeptics evaluating codec claims (ABX
novices and technically careful listeners), plus search readers arriving at
"ABX test", "codec blind test", "is [codec] transparent" style questions.
Developers and release engineers keep using the repository docs; the website
publishes only curated user-facing pages.

## Job to be done

1. Explain blind ABX honestly and get a visitor to an honest first test.
2. State release status truthfully — including that downloads do not exist yet.
3. Give search engines well-described, canonical, lasting pages.
4. Link to the real browser app at `/demo/` without pretending the public
   release is finished.

## Non-goals

No blog/CMS, no accounts, no application runtime on content pages (only the saved theme picker), no fabricated release artifacts, no
developer/verification docs.

## Scientific guardrails (carry into every page)

- Validity ≠ audibility; numerical checks never certify audibility, codec
  conformance, tamper-proof operation or exclusive output.
- Fixed trial count; early-ended/sealed/completed runs stay visibly distinct.
- All audio processing local; the site never implies uploads.
- Claims trace to `docs/methodology.md`, `docs/audio-import.md`,
  `docs/release-notes-0.1.0.md`, `docs/distribution-strategy.md`,
  `docs/distribution-licenses.md` (per-page `source` frontmatter).

## Assumptions to confirm with the owner

- `https://audivane.app` is the production origin (from `wrangler.jsonc`).
- The real browser app will be served at `/demo/` in the same deployment
  (this task's brief); the site links it and keeps it out of sitemaps.
- Public author identity is withheld on the site until the release repository
  identity gate in `docs/release-notes-0.1.0.md` is decided.
