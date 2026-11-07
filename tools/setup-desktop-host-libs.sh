#!/usr/bin/env bash
# Optional Debian/Ubuntu development-host helper. Downloads/extracts libraries
# within this checkout only; never installs packages or changes host policy.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
library_root="$project_root/build/desktop-host-libs"
mkdir -p "$library_root/debs" "$library_root/root"
cd "$library_root/debs"
# Match the GTK package name of the configured distro repositories.
if apt-cache show libgtk-3-0t64 >/dev/null 2>&1; then gtk_package=libgtk-3-0t64; else gtk_package=libgtk-3-0; fi
packages=("$gtk_package" libgtk-3-common libpangocairo-1.0-0 libpangoft2-1.0-0 libcairo-gobject2 libgdk-pixbuf-2.0-0 libepoxy0 libwayland-client0 libwayland-cursor0 libwayland-egl1 libxcursor1 libxinerama1)
if apt-cache show libglycin-2-0 >/dev/null 2>&1; then packages+=(libglycin-2-0); fi
apt download "${packages[@]}"
for archive in ./*.deb; do dpkg-deb --extract "$archive" "$library_root/root"; done
# Preserve exact downloaded versions/checksums as a local setup record.
sha256sum ./*.deb > "$library_root/debs.sha256"
echo "Local GTK libraries extracted to $library_root/root; desktop/test launchers use them automatically."
echo "Other missing libraries, if any:"
LD_LIBRARY_PATH="$library_root/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$project_root/node_modules/electron/dist/electron" | awk '/not found/ { print; missing=1 } END { exit missing ? 1 : 0 }'
