# Distribution and hosting strategy

This is the recommended release sequence for the initial public snapshot, not
evidence that new formats or hosting have been implemented. The authoritative
gate summary is in [release preparation](releasing.md); each shipped format
must pass its [installed acceptance](distribution-acceptance.md).

## Desktop formats and channels

Start with downloadable assets on a GitHub Release for `0.1.0`. Publish only
accepted platforms; a Linux release need not wait for Windows. Users install those assets directly. Store submissions, automatic
updates and maintaining an apt repository are separate later work.

| Target | Initial download | Later channel or format |
| --- | --- | --- |
| Ubuntu 24.04 x64 baseline | `.deb`, after final installed acceptance | Flatpak through Flathub for broader Linux coverage |
| Arch x86_64 | Optional `.pkg.tar.zst`, after its remaining acceptance | AUR recipe if maintenance demand justifies it |
| Windows x64 | Per-user NSIS `.exe`; optional portable `.zip`, after real Windows acceptance | WinGet after installer acceptance and stable public URLs |
| macOS | Defer: no release packaging or acceptance is implemented | Signed and notarized `.app` in a `.dmg`, with native codec builds and architecture-specific acceptance |

Future macOS distribution should follow the [Electron signing and notarization
guide](https://www.electronjs.org/docs/latest/tutorial/code-signing).

The `.deb` baseline is Ubuntu 24.04 / glibc 2.39. Do not advertise all Debian
derivatives or older Ubuntu versions as supported merely because they accept
`.deb` packages. Additional distributions and architectures require evidence.

## Linux: Flatpak, Snap or AppImage

Prefer **Flatpak/Flathub as the next Linux distribution project**, while keeping
the existing `.deb` for the initial release. Flatpak supplies a defined runtime
and a catalog/update channel. It still requires a manifest, a selected app ID,
native codec/material integration and acceptance of the actual packaged app.
The [official Electron guide](https://docs.flatpak.org/en/latest/electron.html)
uses a Zypak wrapper. Validate renderer isolation, native worker/process cleanup,
file chooser/export portals, audio output and least-privilege permissions in
that environment; the existing `.deb` sandbox evidence does not transfer.

Defer **Snap** unless there is specific user demand. It adds another confinement
and store maintenance path. Audio playback and access to files on removable
media use interfaces with different connection behavior; see the official
[interface reference](https://snapcraft.io/docs/reference/interfaces/). File
import/export and Chromium isolation need their own acceptance. Preserve the
project's sandbox requirements in any packaging integration.

Keep **AppImage** optional, rather than making it the default Linux download.
Existing tooling still needs a provisioned appimagetool and hash-pinned runtime,
then actual mounted-runtime acceptance. The current binaries retain their
glibc baseline; wrapping them does not make them run on older distributions.
The [AppImage guidance](https://docs.appimage.org/reference/best-practices.html)
requires building for the oldest intended base system. This project's Ubuntu
user-namespace/AppArmor requirements also need validation at the mounted path;
the `.deb` attachment does not cover it. See [packaging](distribution-packaging.md).

## GitHub Release publication sequence

1. Prepare and audit the isolated source snapshot without private development
   history. Create its reviewed initial commit using the chosen public identity.
2. Install dependencies and rebuild from that repository. Run `npm run verify:full`
   and retain the reports; run performance phases without competing heavy jobs.
3. Build each intended distribution and matching third-party materials. Complete
   its installed target-OS and physical-listening acceptance. If signing, sign
   before final hashes and repeat the required acceptance on the signed bytes.
4. Run `npm run dist:verify` and prepare the matching attachments using
   `tools/prepare-publication.mjs`. Inspect final source/material archives and
   downloads for credentials, private content and correct notices.
5. Create the version tag and a draft GitHub Release in the public repository.
   Attach accepted binaries, platform checksums/manifests, exact application
   source, matching codec source/build/license materials and reviewed release
   notes. Verify the uploaded files against local SHA-256 before publishing the
   release. State supported OS/architecture, unsigned status where applicable,
   installation steps, known limitations and where users can report issues.

GitHub's automatic repository source archives do not replace the separately
collected codec materials. Keep binary downloads in Releases instead of the
source tree or website deployment. See [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
This guide does not create a repository, tag, upload or release.

## Web hosting

The current plan is a static website plus the actual browser client at `/demo/`,
built from this repository, served on the development machine's loopback
interface and published through a named Cloudflare Tunnel at
`https://audivane.app/`. The [website guide](../website/README.md) owns the
build, the loopback port, the systemd and cloudflared templates, source-version
evidence, cutover and rollback. The existing `apps/landing` Worker remains the
rollback target until the owner performs and verifies the cutover; this guide
and those templates do not deploy, create a tunnel or change DNS.

This is still static hosting. The host sends HTML, JavaScript, fonts, codec WASM
and notices; import, preparation, playback and scoring run in the visitor's
browser. There is no server-side codec execution, account, upload, database or
persistence. Availability depends on the host staying powered and online, with
user lingering, a working network and a connected tunnel. It is not a CDN or a
high-availability service. The
[local audio runtime decision](adr/0001-local-audio-runtime.md) records the
processing boundary.

Build the site first, then run `website/scripts/build-demo.mjs` to produce
`website/dist/demo/`, and serve only `website/dist`. Do not publish the checkout,
local build reports, test results or user audio. Serve codec modules from the
site's own origin. Validate HTTPS, worker loading, WASM MIME types, all enabled
codecs, import/prepare/play/export, cancellation and exact delivered-byte
evidence on the actual public origin. A loopback pass alone does not establish
hosting acceptance. Do not assume a SharedArrayBuffer requirement from desktop
code: the present browser build uses the single-thread `@ffmpeg/core`; a future
threaded core needs a separate cross-origin-isolation/hosting review.

The hostname and hosting mechanism are independent. A static host such as
**GitHub Pages** remains an alternative for the site and demo when a
static-only deployment is preferred. The demo must be built for the path where
it is served: verify its generated asset and codec URLs under `/demo/`. A
project site at `https://OWNER.github.io/REPOSITORY/` adds another path
segment, so the site base and the demo base and URLs need rechecking. A
user/organization site or dedicated custom domain serving the app at `/` avoids
that extra segment. Keep within the current
[Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
See GitHub's
[custom-domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
and
[HTTPS guide](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https).
Pointing a domain at Pages with HTTPS does not require running this machine.
Nginx or Caddy can likewise serve the same static tree with HTTPS, at the cost
of maintaining the server, TLS and availability; codec processing remains
local either way.

Publishing the site does not complete the browser release gates. `/demo/` serves
`@ffmpeg/core` (`GPL-2.0-or-later`) and the supplemental LC3/LDAC WASM even
when a visitor does not run every codec. The exact corresponding source/build
materials for those assets and public-origin browser acceptance remain
required. Project content stays under the repository's MIT license; fonts,
dependencies and codec binaries keep their own licenses and notices. The demo
stays `noindex` and outside the sitemap while these gates are open. A tunnel,
a custom domain or a local build does not waive these gates or turn the
unpublished `0.1.0` candidate into a release.
