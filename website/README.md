# Audivane website

Static Astro site for `https://audivane.app/` and the real browser client at
`/demo/`. The site is separate from the installed desktop apps and the npm
package. The guides in `docs/` remain the documentation source of truth.

The intended deployment is a build on this development machine, served on
loopback only and published through a named Cloudflare Tunnel. This document and
the files under `deploy/` do not deploy anything, change DNS or create a tunnel.
Audio is processed in the visitor's browser; the host serves static files only.

## Build

Prerequisites:

- Node >= 22.12, matching the repository engine (tested here with Node 26).
- Installed dependencies at the repository root, because the demo compiles the
  client workspace and shared packages.
- Installed dependencies under `website/` for the Astro site.

```sh
npm ci                        # repository root: client, shared packages, build tools
npm ci --prefix website       # website: Astro and site dependencies
cd website
npm run build                 # Astro content + real /demo/ app, serially locked
npm run package:sources       # verified codec materials + exact application snapshot
npm run verify:seo
npm run test:browser
```

After deployment, run the same browser acceptance on the actual HTTPS origin:

```sh
CODEC_ABX_WEBSITE_PUBLIC_URL=https://audivane.app/ npm run test:browser --prefix website
```

The combined build runs Astro first and the demo second under the shared output
lock. `build:content` alone clears `dist/`; rerun the combined build afterward.
Rebuild the demo
whenever the client or shared product UI changes. `website/dist` is generated
output: never commit it, and serve it rather than the checkout.

The demo is not a mock or a separate reimplementation. `build-demo.mjs` compiles
the repository client and packages, so codec assets must be current exactly as
for `npm run dev` or `npm run build:client`. The website build does not rebuild
codec WASM or native codecs; use the existing asset workflow when those change.
Do not copy the checkout or `apps/client/dist` by hand in place of this build.

The build owns the exact demo entry and asset layout under
`website/dist/demo/`; use the generated output rather than assuming a file name.

## Local check

Serve only the generated `website/dist` tree. The local server must bind to
loopback, never to every interface:

```sh
cd website
HOST=127.0.0.1 PORT=8088 node scripts/serve.mjs
```

`scripts/serve.mjs` serves only `dist/`; it defaults to `127.0.0.1:8088` and
honours `HOST`, `PORT` and `CANONICAL_HOST`. It redirects `www` to the canonical
host, adds the demo `noindex` header and applies separate content and demo
security policies. Then check:

```sh
curl -fsSI http://127.0.0.1:8088/
curl -fsSI http://127.0.0.1:8088/demo/
```

Open both URLs in a browser. For the demo, confirm that it loads only from this
origin, that no request goes to a hub, CDN or third-party API, and that a local
audio file can be imported, prepared, played in an ABX trial and exported.
Check the generated assets, WASM MIME types, console errors and cancelled
preparation. A loopback pass is necessary but is not public-origin acceptance.

Stop the server with `Ctrl+C`. If port 8088 is occupied, find the owner before
changing the port; the systemd and tunnel examples assume 8088.

## Source version evidence

Record the source and build identity with every deployment candidate:

```sh
git rev-parse HEAD
git status --porcelain
node --version
npm --version
sha256sum website/dist/index.html
find website/dist/demo/ -type f -print0 | sort -z | xargs -0 sha256sum
```

Prefer a committed revision. If the tree contains local changes, record them
exactly instead of presenting the revision as a clean release. The workspace and client manifests report version `0.2.1`; keep deployment
metadata consistent with those manifests.

Keep the evidence local (for example under the ignored `build/` directory) or
in the deployment record below. Do not publish source history, local build
reports, test results, user audio or tunnel credentials with the site.

## Systemd user services

Templates live in `website/deploy/`:

- `audivane-website.service.example` serves `website/dist` on
  `127.0.0.1:8088`.
- `audivane-website-tunnel.service.example` runs the Cloudflare Tunnel.
- `cloudflared.example.yml` is the tunnel ingress template.

Install copies outside the repository. The `%h` specifier in the units expands
to the user's home directory; adjust `WorkingDirectory` if the checkout is
elsewhere. Run these commands from the repository root.

```sh
mkdir -p ~/.config/systemd/user
cp website/deploy/audivane-website.service.example \
  ~/.config/systemd/user/audivane-website.service
cp website/deploy/audivane-website-tunnel.service.example \
  ~/.config/systemd/user/audivane-website-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now audivane-website.service
loginctl enable-linger "$USER"
```

Enable the tunnel unit only after its configuration exists and the loopback
service passes the local check. Lingering keeps both user services available
after logout and at boot.

```sh
systemctl --user status audivane-website.service audivane-website-tunnel.service
journalctl --user -u audivane-website.service -n 30
journalctl --user -u audivane-website-tunnel.service -n 30
ss -ltnp | grep 8088
```

After a rebuild, restart the site service; no tunnel restart is needed. From the
repository root:

```sh
npm run build --prefix website
(cd website && node scripts/build-demo.mjs)
systemctl --user restart audivane-website.service
```

The units contain no credentials and no account identifiers. Keep the real
tunnel configuration and credential files in `~/.cloudflared/`, outside the
repository.

## Cloudflare Tunnel and cutover

The initial cutover was completed on 2026-11-06, as recorded in
[DEPLOYMENT.md](DEPLOYMENT.md). The site and browser preview are served through
the tunnel; the `audivane-landing` Worker is retained for rollback (version
`85c44e4a-b0b9-4f19-8720-a9d18b5eef48`). The steps below document that
one-time cutover and disaster recovery; routine content updates use
`npm run publish:local` after building and verifying the matching source materials.

Prepare the tunnel outside the repository:

```sh
cloudflared tunnel login       # writes cert.pem to ~/.cloudflared/
cloudflared tunnel create audivane-website
```

Copy `deploy/cloudflared.example.yml` to `~/.cloudflared/audivane-website.yml`,
replace the tunnel UUID and home-directory placeholders, and protect it:

```sh
chmod 600 ~/.cloudflared/audivane-website.yml \
  ~/.cloudflared/REPLACE_WITH_TUNNEL_UUID.json ~/.cloudflared/cert.pem
```

The ingress routes `audivane.app` and `www.audivane.app` to
`http://127.0.0.1:8088`. The site server must redirect `www` to the apex (or use
an equivalent Cloudflare redirect rule); otherwise remove the `www` hostname
from the ingress. The tunnel makes outbound connections only, so no inbound
port, firewall opening or router forwarding is required.

Cut over in this order, after the local check and evidence record. A hostname
cannot point at the Worker custom domain and the tunnel at the same time, so
expect a short cutover window; do not perform it while an unrelated deployment
is in progress. If the previous page persists after cutover, purge the
Cloudflare cache for the hostname.

1. Keep `apps/landing/` unchanged as the rollback artifact and note its current
   Worker version. Commit or archive that directory with the deployment source;
   rollback should not depend on an untracked working-tree copy.
2. Detach the Worker custom domain in the Cloudflare dashboard (Workers & Pages
   -> `audivane-landing` -> Settings -> Domains & Routes). Detaching the route
   does not delete the Worker script.
3. Route DNS to the tunnel and start the tunnel service:

   ```sh
   cloudflared tunnel route dns audivane-website audivane.app
   # Only if the www ingress is kept:
   cloudflared tunnel route dns audivane-website www.audivane.app
   systemctl --user enable --now audivane-website-tunnel.service
   ```

   Do not run these routes while the Worker custom domain still owns the
   hostnames; the conflicting record cannot be created.

4. Verify the public origin over HTTPS:

   ```sh
   curl -fsSI https://audivane.app/
   curl -fsSI https://audivane.app/demo/
   ```

   Confirm HTTP 200, valid TLS, the intended content, working `www` redirect and
   the security headers. The zone's SSL/TLS mode must suit a tunnel origin
   (Full or Full strict; not Flexible). In a browser, repeat the demo
   import/prepare/play/export check on the public origin and verify that codec
   assets load from the same origin. Check tunnel logs for a connected,
   error-free session.

5. Only after verification, update the deployment record below with the source
   revision, artifact hashes, verification result and the Worker version kept
   for rollback. Record any deviation; do not backdate evidence.

### Rollback to the landing Worker

Rollback restores the last known public page from `apps/landing/`. It does not
require deleting the local site or its build.

1. Stop the tunnel so it no longer owns the hostname, and disable it so a reboot
   does not bring it back before DNS is restored:

   ```sh
   systemctl --user disable --now audivane-website-tunnel.service
   ```

2. Remove the tunnel DNS records for `audivane.app` and `www.audivane.app` in
   the Cloudflare dashboard.
3. Reattach the Worker custom domain by deploying the unchanged landing
   configuration from the repository root:

   ```sh
   npx --yes wrangler@4.158.0 deploy --config apps/landing/wrangler.jsonc
   ```

   `wrangler.jsonc` declares `custom_domain: true`, so this restores the route
   and certificate. If the previous Worker version must be restored exactly,
   use the Cloudflare versions/deployments view for `audivane-landing` to roll
   back to the recorded `85c44e4a-...` version, then confirm the custom domain.
4. Verify `https://audivane.app/` returns the landing page, then keep or stop the
   loopback site service independently. Re-check TLS, content and headers; a
   detached custom domain can take a short time to become active again.

## Secret exclusion

Never commit or publish:

- `~/.cloudflared/cert.pem`, `<TUNNEL-UUID>.json` or a populated `config.yml`;
- Cloudflare API tokens, account IDs, zone IDs, tunnel UUIDs used as
  credentials, or dashboard session data;
- `.env` files, signing material or private host configuration.

Only the placeholder files in `website/deploy/` belong in the repository. The
systemd units reference the user's home-directory configuration and contain no
secrets. Redact tunnel and account identifiers from logs, screenshots or issue
reports. If a credential file is exposed, rotate or delete the tunnel rather
than editing history in place.

## Availability and local processing

The site is available only while this machine is powered and online, with user
lingering enabled and the tunnel connected. Reboots, sleep, network or ISP
outages and Cloudflare account problems take it down; there is no CDN
guarantee, redundancy or uptime commitment. The tunnel reconnects automatically
and systemd restarts failed units, but neither provides high availability.
Static responses may be edge-cached, while new builds reach visitors only when
the origin is reachable.

Serving the site does not move audio processing to this machine. The host sends
HTML, JavaScript, fonts, codec WASM and notices. Import, preparation, ABX
playback, scoring and export run in the visitor's browser, subject to that
browser's codec support, memory and CPU. There are no accounts, uploads,
server-side codecs, databases or persisted sessions. Large local files can still
fail in a constrained browser; the host cannot compensate for client limits.

## Content licenses and publication gates

Project website content and application code remain under the repository's MIT
license unless a file says otherwise. Self-hosted fonts, React, codec binaries
and other dependencies keep their own licenses and notices; do not relicense
them or drop the attribution files from the build output.

Publishing `/demo/` serves the GPL-2.0-or-later `@ffmpeg/core` package and the
supplemental LC3/LDAC WASM even if a visitor does not run every codec. The
browser release still needs the complete corresponding source/build materials
for those exact assets and acceptance on the actual public origin. Loopback
checks, a tunnel and a custom domain do not waive either gate. The general web
publication steps remain in the
[distribution strategy](../docs/distribution-strategy.md) and
[license guide](../docs/distribution-licenses.md).

The demo build keeps `/demo/` out of the sitemap and marks it `noindex`. Keep
those markers while the web release gates are open, and do not present `/demo/`
as a released download or a completed browser release.

Do not add download links, platform certification, release tags or launch
claims until the release gates have their own evidence. See the current release status and downloads page for published versions.

## Deployment record

The deployment command copies the tested output to an immutable directory under
`~/.local/share/audivane-website/releases/`, then atomically updates `current`
and restarts `audivane-website.service`. The running server reads that snapshot,
so rebuilding the checkout cannot interrupt the live site. Keep the previous
directory for rollback. The deployment record is local and records:

- source revision and exact dirty/untracked state;
- build time in UTC, Node and npm versions;
- SHA-256 of `website/dist/index.html` and every file under
  `website/dist/demo/`;
- tunnel name and non-secret route details, plus the Worker version kept for
  rollback;
- loopback and public-origin check results, including any failed check that was
  retained rather than hidden.

The Cloudflare custom-domain cutover is a separate one-time operation. The
original Worker and its source remain available for rollback.

See [the initial deployment record](DEPLOYMENT.md) for the verified cutover.
For DNS-management commands, pass the origin certificate authorized specifically
for `audivane.app` with `--origincert`. A certificate selected for another zone
can append that zone to the requested hostname. Tunnel runtime credentials are
separate; retain other sites' certificates and running services.
