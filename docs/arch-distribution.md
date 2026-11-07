# Arch Linux package

The bundled binary package is `audivane-bin`, providing and conflicting with
`audivane`. It installs the application under `/opt/audivane`, with a launcher,
desktop entry, icons and dependency notices.

## Build

Prepare the complete Linux native/resources tree and matching source/license
materials described in [packaging](distribution-packaging.md). On Arch, install
`base-devel`, Node/npm and repository dependencies, then run as a normal user:

```bash
npm run dist:arch
npm run dist:verify -- --platform arch
```

The launcher writes a hash-pinned recipe under `build/arch/recipe` and invokes
`makepkg`. It never invokes sudo or installs host packages. `--jobs N` controls
payload compression; final package compression follows `makepkg.conf`.

From another distribution, prepare the recipe and copy it to an Arch builder:

```bash
npm run dist:arch -- --prepare-only
# On Arch, in the copied recipe directory:
makepkg --force --noconfirm
# Return the resulting package to the original build host:
npm run dist:arch -- --arch-package /absolute/path/to/package.pkg.tar.zst
```

Use the generated manifest and checksums for the actual version and hash.
Release artifacts live under `dist/release`. Do not transfer acceptance from
older packages to a rebuilt artifact.

## Install and remove

Verify checksums, then install the versioned package:

```bash
sha256sum -c SHA256SUMS-arch.txt
sudo pacman -U ./audivane-bin-VERSION-x86_64.pkg.tar.zst
audivane
# Later:
sudo pacman -R audivane-bin
```

Replace `VERSION` with the generated filename. Pacman resolves system runtime
dependencies. Users need no development checkout, Node/npm, system Electron or
PATH codec tools. Removal preserves user exports and settings/cache.

## Runtime and release checks

The package reuses the Linux native codec bundle and its exact source/license
materials. Every shipped ELF is audited against the selected glibc floor.
`makepkg` stripping is disabled to retain binary provenance. Dependencies keep
their own licenses.

Renderer sandboxing remains enabled. The package uses native user namespaces
and does not install an Ubuntu AppArmor policy or bypass hardened host policy.
Keep Arch upgraded normally and validate the actual target environment.

Before release, complete the [installed acceptance matrix](distribution-acceptance.md),
including normal graphical login, codec/listening/dialog/export checks,
cross-version upgrade, cancellation/cleanup, removal and physical listening.
A container build or headless VM result alone cannot establish those claims.
No AUR submission or repository publication is performed by these commands.
