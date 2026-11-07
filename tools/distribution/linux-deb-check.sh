#!/usr/bin/env bash
# Inspect a built Audivane .deb without root, then optionally install, run the
# packaged acceptance test and uninstall it on a real clean Ubuntu host/VM.
#
# This script never disables the Chromium sandbox, never makes chrome-sandbox
# setuid and never edits global AppArmor policy. The .deb itself deploys one
# narrow /opt/audivane/audivane userns attachment at install time. If the
# installed path is still blocked, the script reports the blocker and exits 3
# so the acceptance gap is explicit.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
INSTALL=false
DEB=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) INSTALL=true ;;
    --deb) DEB="${2:-}"; shift ;;
    --help|-h)
      echo "Usage: tools/distribution/linux-deb-check.sh [--install] [--deb PATH]" >&2
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$DEB" ]; then
  DEB="$(find "$ROOT/dist/release" -maxdepth 1 -name 'audivane_*_amd64.deb' -print | sort | tail -n 1)"
fi
if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "No .deb found. Build one with: npm run dist:linux -- --resources build/distribution-resources/linux" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/audivane-deb-check.XXXXXX")"
UNINSTALL=false
cleanup() {
  if [ "$UNINSTALL" = true ]; then
    if [ "$(id -u)" -eq 0 ]; then dpkg -r audivane || true; else sudo dpkg -r audivane || true; fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "[deb-check] inspecting $DEB"
dpkg-deb --info "$DEB" > "$TMP/info"
dpkg-deb --contents "$DEB" > "$TMP/contents"
grep -Eq '^ Package: audivane$' "$TMP/info"
grep -Eq '^ Architecture: amd64$' "$TMP/info"
grep -Eq '^ Depends: .*libc6 \(>= ' "$TMP/info"
grep -Eq '^ Depends: .*libgtk-3-0' "$TMP/info"
mkdir -p "$TMP/root"
dpkg-deb -x "$DEB" "$TMP/root"
APP="$TMP/root/opt/audivane"
test -x "$APP/audivane"
test -f "$APP/resources/distribution.json"
test -f "$APP/resources/native-bundle-manifest.json"
test -f "$APP/resources/third_party/ffmpeg/bin/ffmpeg"
test -f "$APP/resources/third_party/ffmpeg/bin/ffprobe"
test -f "$APP/resources/third_party/ldac/bin/ldac_helper"
test -f "$TMP/root/usr/share/applications/audivane.desktop"
test -f "$TMP/root/usr/share/icons/hicolor/256x256/apps/audivane.png"
test -f "$TMP/root/usr/share/doc/audivane/THIRD_PARTY_NOTICES.md"
test -f "$TMP/root/etc/apparmor.d/audivane"
grep -q 'profile audivane "/opt/audivane/audivane" flags=(unconfined)' "$TMP/root/etc/apparmor.d/audivane"
grep -Eq '^[[:space:]]*userns,$' "$TMP/root/etc/apparmor.d/audivane"
! grep -Eq '/\*\*|flags=\((complain|enforce)\)' "$TMP/root/etc/apparmor.d/audivane"
mkdir -p "$TMP/control"
dpkg-deb -e "$DEB" "$TMP/control"
grep -q 'apparmor_parser -r /etc/apparmor.d/audivane' "$TMP/control/postinst"
grep -q 'remove|deconfigure' "$TMP/control/prerm"
grep -q 'apparmor_parser -R /etc/apparmor.d/audivane' "$TMP/control/prerm"
! grep -q 'apparmor_parser -R' "$TMP/control/postrm"
grep -q '^/etc/apparmor.d/audivane$' "$TMP/control/conffiles"
if [ -e "$APP/resources/app/dist/client/codec-assets" ]; then
  echo "[deb-check] browser codec assets were not excluded from the desktop package" >&2
  exit 1
fi
if find "$APP/resources" -type f \( -name '*.wasm' -o -name 'ffmpeg-core.js' -o -name '*.py' \) -print | grep -q .; then
  echo "[deb-check] package contains browser-only or developer files" >&2
  exit 1
fi
MODE="$(stat -c '%a' "$APP/chrome-sandbox")"
if [ $((8#$MODE & 8#4000)) -ne 0 ]; then
  echo "[deb-check] chrome-sandbox is setuid; this package must retain the userns sandbox" >&2
  exit 1
fi
grep -q 'Exec=/opt/audivane/audivane' "$TMP/root/usr/share/applications/audivane.desktop"
if grep -q -- '--no-sandbox' "$TMP/root/usr/share/applications/audivane.desktop"; then
  echo "[deb-check] desktop launcher disables the sandbox" >&2
  exit 1
fi
node --input-type=module - "$APP/resources/distribution.json" <<'NODE'
import { readFileSync } from "node:fs";
const distribution = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (distribution.executable !== "audivane") throw new Error("installed executable metadata is not audivane");
if (distribution.browserCodecAssets !== "excluded-native-only") throw new Error("browser asset exclusion is not recorded");
NODE
echo "[deb-check] package contents passed"

if [ "$INSTALL" != true ]; then
  echo "[deb-check] install/launch acceptance not requested; run with --install on a disposable Ubuntu 24.04 VM"
  exit 0
fi

if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi
profile_loaded() {
  [ -e /sys/kernel/security/apparmor/profiles ] &&
    "${SUDO[@]}" grep -Eq '^audivane( |$)' /sys/kernel/security/apparmor/profiles 2>/dev/null
}
"${SUDO[@]}" dpkg -i "$DEB"
UNINSTALL=true
test -x /opt/audivane/audivane
test -f /etc/apparmor.d/audivane
if [ -n "${DISPLAY:-}" ]; then TEST=(npm run test:desktop -- package.electron.ts); else TEST=(xvfb-run -a npm run test:desktop -- package.electron.ts); fi
set +e
( cd "$ROOT" && CODEC_ABX_PACKAGED_EXECUTABLE=/opt/audivane/audivane "${TEST[@]}" ) 2>&1 | tee "$TMP/acceptance.log"
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ]; then
  if grep -Eiq 'SUID sandbox|user namespace|AppArmor|namespace sandbox|No usable sandbox' "$TMP/acceptance.log"; then
    echo "[deb-check] BLOCKED: the installed path could not create a Chromium sandbox under the host AppArmor policy." >&2
    echo "[deb-check] No policy was changed and no --no-sandbox/setuid workaround was attempted. Record this as an unverified clean-install launch." >&2
    exit 3
  fi
  echo "[deb-check] packaged acceptance failed; see $TMP/acceptance.log" >&2
  exit 1
fi
"${SUDO[@]}" dpkg -r audivane
if [ -e /opt/audivane ]; then
  echo "[deb-check] uninstall left /opt/audivane behind" >&2
  exit 1
fi
if profile_loaded; then
  echo "[deb-check] remove left the audivane AppArmor profile loaded" >&2
  exit 1
fi
"${SUDO[@]}" dpkg --purge audivane
UNINSTALL=false
if [ -e /etc/apparmor.d/audivane ]; then
  echo "[deb-check] purge left the AppArmor conffile behind" >&2
  exit 1
fi
if profile_loaded; then
  echo "[deb-check] purge left the audivane AppArmor profile loaded" >&2
  exit 1
fi
echo "[deb-check] install, packaged acceptance, remove/purge and profile cleanup passed"
