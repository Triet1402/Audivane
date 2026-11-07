# Audivane landing page

Standalone static landing page for `https://audivane.app/`, deployed directly
to the owner's Cloudflare account with Workers Static Assets. No codec assets,
user audio, repository history or local build reports are published here.

Authenticate and deploy from the repository root:

```sh
npx --yes wrangler@4.158.0 login --device --browser=false
npx --yes wrangler@4.158.0 deploy --config apps/landing/wrangler.jsonc --dry-run
npx --yes wrangler@4.158.0 deploy --config apps/landing/wrangler.jsonc
```

Wrangler manages credentials outside the repository. The custom domain must be
an active Cloudflare zone in the authenticated account. Inspect existing DNS
and Worker ownership before deploying; do not replace an unrelated service.
Deployment creates the custom-domain route and certificate. Only `public/`
is uploaded. Existing source and desktop distribution workflows are independent.

The page preserves Audivane's IBM Plex typography, neutral surfaces and blue
accent. It introduces ABX, explains local processing and states release status.
Linux developer testing is user-reported, not a claim of platform certification.
Add download links only after final artifacts have been published and verified.
The browser runtime remains a separate release with its own codec materials.

Check local asset and fragment links, desktop/mobile layout, keyboard focus,
and HTTP status, CSP, fonts and TLS on the final public origin after deployment.
Self-hosted IBM Plex files retain their [OFL license](public/fonts/OFL.txt).

## Deployment record

Published to `https://audivane.app/` on 2026-11-06 as Cloudflare Worker
`audivane-landing`, version `85c44e4a-b0b9-4f19-8720-a9d18b5eef48`.
The domain was active with no existing Worker domains or scripts before creation.
Cloudflare manages the custom-domain route and HTTPS certificate.

Initial live verification caught an automatically injected Cloudflare analytics
script blocked by CSP. The response now uses `Cache-Control: no-transform` to
prevent that injection without permitting third-party scripts. The initial
failure is retained in the session record. Final verification reports and
responsive captures are local under `build/landing-*`, excluded from publication.
