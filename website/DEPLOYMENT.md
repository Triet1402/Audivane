# Initial local deployment — 2026-11-06

The content website and real browser preview are served from this machine:

- Public home: <https://audivane.app/>
- Actual application: <https://audivane.app/demo/>
- Documentation: <https://audivane.app/docs/>
- Source and codec materials: <https://audivane.app/sources/>
- Local origin: `http://127.0.0.1:8088`

`audivane-website.service` serves an immutable snapshot selected by
`~/.local/share/audivane-website/current`. `audivane-website-tunnel.service`
publishes it through Cloudflare Tunnel; both are enabled user services with
lingering. `www.audivane.app` redirects to the apex. Rigscope uses separate
services and its original origin certificate. Real credentials are outside Git.

The built preview identifies itself as `0.1.0`, commit
`001dde2dbcf56cee5d3a7ed6cc2f163acbd948d6`, with `dirty: true` and
`appSourcesDirty: true`: pre-existing release manifest/documentation changes
were preserved rather than folded into the website commits. The matching source
archive contains the actual working-tree files, not just that commit. This is
a preview, not a tagged release. Runtime files, source archives and checksums
were captured together in the local deployment snapshot.

## Verification

- Astro: zero errors, warnings or hints.
- SEO/static HTTP: 13 indexable pages, sitemap, canonical URLs, metadata, links,
  redirects, MIME types, missing paths and security headers passed.
- Website acceptance: nine Chromium tests passed, including 320–1440px layouts,
  keyboard navigation, script-free content, same-origin codec workers, a real
  analytical-audio ABX run and exported exact-source/delivered-audio evidence.
- Public HTTPS acceptance: the same nine tests passed on `audivane.app` after
  routing propagation. Both content and the real audio workflow were exercised;
  `www` redirects to the apex, and source download responses return 200.
- Repository `npm run verify:full`: 705 unit/tooling tests, 230 browser tests,
  five desktop functional tests, one desktop performance test and the browser
  workload/cleanup profile passed. Performance phases ran serially.
- Browser codec material manifest: 132 files, 21 required source archives,
  verified before packaging. Upstream source-reference inference and reproduction
  limits remain disclosed in [browser evidence](BROWSER-MATERIALS.md).

Reports remain in ignored `build/website-*` logs and run-specific
`test-results/` directories. Initial failures were retained: a content-layout
type mismatch, test assumptions, supplemental-loader CSP, and a full build
refused because source changed during collection. Corrections were checked
before the final full pass. During DNS cutover the first public run saw mixed
old/new routing; that failure is retained separately from the final public run.

The original `audivane-landing` Worker remains for rollback, with its domain
attachment removed. Its code is preserved under `apps/landing/`. The transient
incorrect DNS aliases under Rigscope were removed before the final cutover.
