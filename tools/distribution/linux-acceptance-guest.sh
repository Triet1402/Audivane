#!/bin/bash
# Guest-side installed-package probe for the Audivane Linux x64 .deb.
#
# Run inside a disposable Ubuntu 24.04 VM with a normal security policy. It
# installs the supplied .deb with apt, verifies the installed tree, exercises
# the bundled native codecs from their installed paths without a checkout or
# PATH codecs, attempts a sandboxed launch, then removes/purges the package.
#
# It never passes --no-sandbox/--disable-setuid-sandbox and never makes a
# sandbox helper setuid. A sandbox refusal is recorded as an outcome, not
# suppressed. Output is a stream of "RESULT key=value" lines for the host
# orchestrator; raw logs stay under --out.
#
# Usage:
#   bash linux-acceptance-guest.sh --deb /path/audivane.deb \
#     [--expected-sha256 HEX] [--upgrade-deb /path/newer.deb] \
#     [--out "$HOME/linux-acceptance"] [--display :99] [--keep-installed]

set -u

DEB=""
EXPECTED_SHA=""
UPGRADE_DEB=""
OUT="${HOME}/linux-acceptance"
DISPLAY_VALUE="${DISPLAY:-:99}"
KEEP_INSTALLED=0
FAILURES=0

usage() {
  sed -n '2,22p' "$0" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deb) DEB="${2:-}"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --upgrade-deb) UPGRADE_DEB="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --display) DISPLAY_VALUE="${2:-}"; shift 2 ;;
    --keep-installed) KEEP_INSTALLED=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$DEB" ] || { echo "--deb is required" >&2; exit 2; }
DEB=$(readlink -f "$DEB") || exit 2
mkdir -p "$OUT"
OUT=$(readlink -f "$OUT")
LOG="${OUT}/guest.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

record() { printf 'RESULT %s=%s\n' "$1" "$2"; }
fail() { record "$1" "fail"; FAILURES=$((FAILURES + 1)); }
pass() { record "$1" "pass"; }
check() { # key condition description
  local key="$1"; shift
  if "$@"; then pass "$key"; else fail "$key"; fi
}
value() { # key value
  local key="$1"; shift
  record "$key" "$(printf '%s' "$*" | tr '\n' '|' | tr -d '\r' | cut -c1-800)"
}
section() { printf '\n== %s ==\n' "$*"; }

SUDO="sudo"
if [ "$(id -u)" -eq 0 ]; then SUDO=""; fi

# ---------------------------------------------------------------- environment
section environment
value env.os "$(. /etc/os-release && printf '%s %s' "${NAME:-}" "${VERSION_ID:-}")"
value env.kernel "$(uname -srm)"
value env.glibc "$(ldd --version 2>/dev/null | head -1)"
value env.timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
value env.user "$(id -un)"
if [ -e /dev/kvm ]; then value env.kvm present; else value env.kvm absent; fi
if command -v systemd-detect-virt >/dev/null 2>&1; then
  value env.virtualization "$(systemd-detect-virt 2>/dev/null || true)"
fi
value env.apparmor_userns_restrict "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo unavailable)"
if unshare -Ur true >/dev/null 2>&1; then
  pass env.unprivileged_userns
else
  record env.unprivileged_userns blocked
fi
value env.path_codecs "$(PATH=/usr/bin:/bin command -v ffmpeg ffprobe ldac_helper 2>/dev/null | tr '\n' ' ' || true)"

# ------------------------------------------------------------------- artifact
section artifact
value deb.path "$(basename "$DEB")"
value deb.bytes "$(stat -c %s "$DEB")"
ACTUAL_SHA=$(sha256sum "$DEB" | awk '{print $1}')
value deb.sha256 "$ACTUAL_SHA"
if [ -n "$EXPECTED_SHA" ]; then
  if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then pass deb.sha256_match; else fail deb.sha256_match; fi
else
  record deb.sha256_match not-requested
fi
value deb.package_version "$(dpkg-deb -f "$DEB" Version)"
value deb.depends "$(dpkg-deb -f "$DEB" Depends)"

# --------------------------------------------------------------- apt install
section install
$SUDO apt-get update -qq >"$OUT/apt-update.log" 2>&1
UPDATE_EXIT=$?
value install.apt_update_exit "$UPDATE_EXIT"
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$DEB" >"$OUT/apt-install.log" 2>&1
INSTALL_EXIT=$?
value install.apt_exit "$INSTALL_EXIT"
if [ "$INSTALL_EXIT" -eq 0 ]; then pass install.completed; else fail install.completed; fi
value install.dpkg_status "$(dpkg-query -W -f='${Status} ${Version}' audivane 2>/dev/null || echo absent)"
value install.conffiles "$(dpkg-query -W -f='${Conffiles}' audivane 2>/dev/null || true)"

# ---------------------------------------------------------------- file checks
section installed-files
APP=/opt/audivane
FFMPEG="$APP/resources/third_party/ffmpeg/bin/ffmpeg"
FFPROBE="$APP/resources/third_party/ffmpeg/bin/ffprobe"
LDAC="$APP/resources/third_party/ldac/bin/ldac_helper"
DESKTOP=/usr/share/applications/audivane.desktop
COMMAND=/usr/bin/audivane

check files.executable test -x "$APP/audivane"
check files.command test -L "$COMMAND"
value files.command_target "$(readlink "$COMMAND" 2>/dev/null || true)"
check files.desktop test -f "$DESKTOP"
check files.apparmor_profile test -f /etc/apparmor.d/audivane
if $SUDO grep -Eq '^audivane \(' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
  pass install.apparmor_profile_loaded
else
  record install.apparmor_profile_loaded not-loaded
fi
check files.icon256 test -f /usr/share/icons/hicolor/256x256/apps/audivane.png
check files.icon_scalable test -f /usr/share/icons/hicolor/scalable/apps/audivane.svg
check files.ffmpeg test -x "$FFMPEG"
check files.ffprobe test -x "$FFPROBE"
check files.ldac test -x "$LDAC"
check files.distribution_manifest test -f "$APP/resources/distribution.json"
check files.native_manifest test -f "$APP/resources/native-bundle-manifest.json"
check files.third_party_notices test -f /usr/share/doc/audivane/THIRD_PARTY_NOTICES.md
check files.project_license test -f "$APP/LICENSE"
check files.chromium_licenses test -f "$APP/LICENSES.chromium.html"

SANDBOX_MODE=$(stat -c %a "$APP/chrome-sandbox" 2>/dev/null || echo absent)
value files.chrome_sandbox_mode "$SANDBOX_MODE"
if [ "$SANDBOX_MODE" = "755" ]; then pass files.chrome_sandbox_not_setuid; else fail files.chrome_sandbox_not_setuid; fi

if [ -f "$APP/resources/distribution.json" ]; then
  value files.browser_codec_assets "$(grep -o '"browserCodecAssets": *"[^"]*"' "$APP/resources/distribution.json" | head -1 | sed 's/.*"browserCodecAssets": *"//; s/"$//')"
  value files.native_mode "$(grep -o '"mode": *"[^"]*"' "$APP/resources/native-bundle-manifest.json" 2>/dev/null | head -1 | sed 's/.*"mode": *"//; s/"$//')"
fi

FORBIDDEN=$(find "$APP/resources" -maxdepth 2 \( -name 'codec-assets' -o -name 'ffmpeg-core.wasm' -o -name 'lc3_codec.wasm' -o -name 'ldac_codec.wasm' \) -print 2>/dev/null | head -10)
value files.forbidden_resources "$FORBIDDEN"
if [ -z "$FORBIDDEN" ]; then pass files.no_browser_or_developer_assets; else fail files.no_browser_or_developer_assets; fi

if grep -q -- '--no-sandbox\|--disable-setuid-sandbox' "$DESKTOP" 2>/dev/null; then
  fail files.desktop_sandbox_flags
else
  pass files.desktop_sandbox_flags
fi
STARTUP_WM_CLASS=$(sed -n 's/^StartupWMClass=//p' "$DESKTOP" 2>/dev/null | head -1)
value files.desktop_startup_wm_class "$STARTUP_WM_CLASS"

$SUDO dpkg -V audivane >"$OUT/dpkg-verify.log" 2>&1
VERIFY_EXIT=$?
value install.dpkg_verify_exit "$VERIFY_EXIT"
value install.dpkg_verify_output "$(tr '\n' '|' <"$OUT/dpkg-verify.log" | cut -c1-500)"
if [ "$VERIFY_EXIT" -eq 0 ] && [ ! -s "$OUT/dpkg-verify.log" ]; then pass install.files_match; else fail install.files_match; fi

# --------------------------------------------------------- native execution
section native-runtime
# Deliberately run from a path with spaces and non-ASCII characters, with no
# checkout, no developer library path and no codec tools on PATH.
WORK="$OUT/runtime path ü"
rm -rf "$WORK"; mkdir -p "$WORK"
CLEAN=(env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8
  CODEC_ABX_NATIVE_BUNDLE_DIR= CODEC_ABX_FFMPEG= CODEC_ABX_FFPROBE= CODEC_ABX_LDAC_HELPER=)

if (cd "$WORK" && "${CLEAN[@]}" "$FFMPEG" -hide_banner -version >"$OUT/ffmpeg-version.log" 2>&1); then pass native.ffmpeg_runs; else fail native.ffmpeg_runs; fi
value native.ffmpeg_version "$(head -1 "$OUT/ffmpeg-version.log" 2>/dev/null)"
if (cd "$WORK" && "${CLEAN[@]}" "$FFPROBE" -hide_banner -version >"$OUT/ffprobe-version.log" 2>&1); then pass native.ffprobe_runs; else fail native.ffprobe_runs; fi
value native.ffprobe_version "$(head -1 "$OUT/ffprobe-version.log" 2>/dev/null)"
if (cd "$WORK" && "${CLEAN[@]}" "$LDAC" --version >"$OUT/ldac-version.log" 2>&1); then pass native.ldac_runs; else fail native.ldac_runs; fi
value native.ldac_version "$(head -1 "$OUT/ldac-version.log" 2>/dev/null)"

(cd "$WORK" && "${CLEAN[@]}" "$FFMPEG" -hide_banner -encoders >"$OUT/encoders.log" 2>&1)
(cd "$WORK" && "${CLEAN[@]}" "$FFMPEG" -hide_banner -decoders >"$OUT/decoders.log" 2>&1)
ENCODERS="libopus aac libvorbis libmp3lame libtwolame liblc3 sbc aptx aptx_hd"
DECODERS="opus aac vorbis mp3float mp2float liblc3 sbc aptx aptx_hd"
MISSING_ENC=""
for codec in $ENCODERS; do grep -Eq "(^|[[:space:]])${codec}([[:space:]]|$)" "$OUT/encoders.log" || MISSING_ENC="$MISSING_ENC $codec"; done
MISSING_DEC=""
for codec in $DECODERS; do grep -Eq "(^|[[:space:]])${codec}([[:space:]]|$)" "$OUT/decoders.log" || MISSING_DEC="$MISSING_DEC $codec"; done
value native.missing_encoders "$MISSING_ENC"
value native.missing_decoders "$MISSING_DEC"
if [ -z "$MISSING_ENC" ]; then pass native.all_encoders; else fail native.all_encoders; fi
if [ -z "$MISSING_DEC" ]; then pass native.all_decoders; else fail native.all_decoders; fi

LDAC_IN="$OUT/ldac-input.pcm"; LDAC_ENC="$OUT/ldac-roundtrip.ldac"; LDAC_OUT="$OUT/ldac-output.pcm"
${CLEAN[@]} "$FFMPEG" -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.1" -ac 2 -c:a pcm_s16le -f s16le -y "$LDAC_IN" >/dev/null 2>&1
if "${CLEAN[@]}" "$LDAC" encode --rate 48000 --channels 2 --bitrate 660 --in "$LDAC_IN" --out "$LDAC_ENC" >"$OUT/ldac-encode.log" 2>&1 &&
   "${CLEAN[@]}" "$LDAC" decode --rate 48000 --channels 2 --bitrate 660 --in "$LDAC_ENC" --out "$LDAC_OUT" >"$OUT/ldac-decode.log" 2>&1; then
  IN_BYTES=$(stat -c %s "$LDAC_IN"); OUT_BYTES=$(stat -c %s "$LDAC_OUT")
  value native.ldac_sample_bytes "$OUT_BYTES/$IN_BYTES"
  if [ "$IN_BYTES" = "$OUT_BYTES" ]; then pass native.ldac_roundtrip; else fail native.ldac_roundtrip; fi
else
  fail native.ldac_roundtrip
fi

MISSING_LIBS=""
ELF_COUNT=0
while IFS= read -r binary; do
  [ -n "$binary" ] || continue
  magic=$(head -c 4 "$binary" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  [ "$magic" = "7f454c46" ] || continue
  ELF_COUNT=$((ELF_COUNT + 1))
  found=$(ldd "$binary" 2>&1 | grep 'not found' || true)
  [ -n "$found" ] && MISSING_LIBS="$MISSING_LIBS ${binary#"$APP"/}:$(printf '%s' "$found" | tr '\n' '|')"
done <<EOF
$(find "$APP" -type f \( -perm -u+x -o -name '*.so' -o -name '*.so.*' \) -print 2>/dev/null | sort)
EOF
value native.elf_objects_checked "$ELF_COUNT"
value native.missing_libraries "$MISSING_LIBS"
if [ -z "$MISSING_LIBS" ]; then pass native.linkage; else fail native.linkage; fi

GLIBC_FLOOR=""
for binary in "$APP/audivane" "$FFMPEG" "$FFPROBE" "$LDAC"; do
  floor=$(grep -ao 'GLIBC_2\.[0-9]\+' "$binary" 2>/dev/null | sed 's/GLIBC_//' | sort -Vu | tail -1)
  [ -n "$floor" ] && GLIBC_FLOOR="$GLIBC_FLOOR $floor"
done
value native.glibc_symbol_versions "$(printf '%s\n' $GLIBC_FLOOR | sort -Vu | tr '\n' ' ')"
MAX_GLIBC=$(printf '%s\n' $GLIBC_FLOOR | sort -Vu | tail -1)
value native.glibc_floor "$MAX_GLIBC"
if [ -n "$MAX_GLIBC" ] && [ "$(printf '%s\n%s\n' 2.39 "$MAX_GLIBC" | sort -Vu | tail -1)" = "2.39" ]; then
  pass native.glibc_floor_within_baseline
else
  fail native.glibc_floor_within_baseline
fi

# ------------------------------------------------------------------- launch
section installed-launch
DISPLAY="$DISPLAY_VALUE"
export DISPLAY
if ! xdpyinfo >/dev/null 2>&1; then
  if command -v Xvfb >/dev/null 2>&1; then
    Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
    XVFB_PID=$!
    sleep 2
    value launch.xvfb "started pid $XVFB_PID"
  else
    value launch.xvfb unavailable
  fi
else
  value launch.xvfb existing
fi
if xdpyinfo >/dev/null 2>&1; then pass launch.display; else fail launch.display; fi

LAUNCH_HOME="$OUT/clean-home"
rm -rf "$LAUNCH_HOME"; mkdir -p "$LAUNCH_HOME"
chmod 700 "$LAUNCH_HOME"
RUNTIME_DIR="$OUT/xdg-runtime"
rm -rf "$RUNTIME_DIR"; mkdir -p "$RUNTIME_DIR"; chmod 700 "$RUNTIME_DIR"
LAUNCH_LOG="$OUT/launch.log"
: > "$LAUNCH_LOG"
setsid env -i HOME="$LAUNCH_HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 DISPLAY="$DISPLAY" \
    XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    /usr/bin/dbus-run-session -- /opt/audivane/audivane --enable-logging=stderr \
  >"$LAUNCH_LOG" 2>&1 &
RUNNER_PID=$!
APP_PID=""
for _ in $(seq 1 20); do
  APP_PID=$(pgrep -u "$(id -u)" -f '^/opt/audivane/audivane' 2>/dev/null | head -1 || true)
  [ -n "$APP_PID" ] && break
  kill -0 "$RUNNER_PID" 2>/dev/null || break
  sleep 1
done
sleep 3
APP_STATE=""
if [ -n "$APP_PID" ]; then APP_STATE=$(ps -o stat= -p "$APP_PID" 2>/dev/null | tr -d ' ' || true); fi
if [ -n "$APP_PID" ] && [ -n "$APP_STATE" ] && [ "${APP_STATE#Z}" = "$APP_STATE" ]; then
  LAUNCH_RUNNING=1
else
  LAUNCH_RUNNING=0
fi
value launch.app_pid "$APP_PID"
value launch.command "/opt/audivane/audivane --enable-logging=stderr (sandbox unchanged; background + SIGTERM probe)"
tail -c 4000 "$LAUNCH_LOG" | tr -d '\r' >"$OUT/launch-tail.log"

if [ "$LAUNCH_RUNNING" -eq 1 ]; then
  RENDERER_PID=$(pgrep -u "$(id -u)" -f -- '--type=renderer' 2>/dev/null | head -1 || true)
  value launch.renderer_pid "$RENDERER_PID"
  if [ -n "$RENDERER_PID" ]; then
    RENDERER_STATUS="/proc/$RENDERER_PID/status"
    NNP=$(awk '/^NoNewPrivs:/{print $2}' "$RENDERER_STATUS" 2>/dev/null || true)
    SECCOMP=$(awk '/^Seccomp:/{print $2}' "$RENDERER_STATUS" 2>/dev/null || true)
    NS_SELF=$(readlink /proc/self/ns/user 2>/dev/null || true)
    NS_RENDERER=$(readlink "/proc/$RENDERER_PID/ns/user" 2>/dev/null || true)
    value launch.renderer_no_new_privs "$NNP"
    value launch.renderer_seccomp "$SECCOMP"
    value launch.renderer_user_namespace "$NS_RENDERER"
    value launch.shell_user_namespace "$NS_SELF"
    if [ "$NNP" = "1" ] && [ "$SECCOMP" = "2" ]; then pass launch.renderer_sandbox; else fail launch.renderer_sandbox; fi
    if [ -n "$NS_RENDERER" ] && [ "$NS_RENDERER" != "$NS_SELF" ]; then pass launch.renderer_user_namespace_distinct; else record launch.renderer_user_namespace_distinct same-or-unavailable; fi
  else
    record launch.renderer_sandbox not-observed
  fi
  record launch.outcome running-sandboxed
  value launch.exit_code "running"
  WM_WINDOW=$(xdotool search --onlyvisible --name '^Audivane' 2>/dev/null | head -1 || true)
  if [ -n "$WM_WINDOW" ] && command -v xprop >/dev/null 2>&1; then
    WM_CLASS_LINE=$(xprop -id "$WM_WINDOW" WM_CLASS 2>/dev/null || true)
    value launch.wm_class "$WM_CLASS_LINE"
    ACTUAL_WM_CLASS=$(printf '%s' "$WM_CLASS_LINE" | sed -n 's/.*= "\([^"]*\)", "\([^"]*\)".*/\2/p')
    value launch.wm_class_instance "$ACTUAL_WM_CLASS"
    if [ -n "$ACTUAL_WM_CLASS" ] && [ -n "$STARTUP_WM_CLASS" ]; then
      if [ "$ACTUAL_WM_CLASS" = "$STARTUP_WM_CLASS" ]; then
        pass files.desktop_wm_class_matches
      else
        record files.desktop_wm_class_matches mismatch
      fi
    else
      record files.desktop_wm_class_matches not-observed
    fi
  else
    record files.desktop_wm_class_matches not-observed
  fi
  kill -TERM "$APP_PID" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$APP_PID" 2>/dev/null; then kill -KILL "$APP_PID" 2>/dev/null || true; fi
  wait "$RUNNER_PID" 2>/dev/null || true
else
  wait "$RUNNER_PID" 2>/dev/null
  LAUNCH_EXIT=$?
  value launch.exit_code "$LAUNCH_EXIT"
  if grep -Eq 'Failed to move to new namespace|SUID sandbox helper|No usable sandbox|namespace sandbox|sandbox_linux|Operation not permitted' "$LAUNCH_LOG"; then
    record launch.outcome sandbox-blocked
  else
    record launch.outcome exited-without-sandbox-message
  fi
fi
value launch.first_error "$(grep -m1 -Ei 'fatal|failed to|error|no usable sandbox|not configured|operation not permitted' "$LAUNCH_LOG" 2>/dev/null | cut -c1-500)"

# The app must never be started with these; record that the probe did not.
if grep -q -- '--no-sandbox\|--disable-setuid-sandbox' "$OUT/launch.log"; then
  fail launch.no_sandbox_workaround
else
  pass launch.no_sandbox_workaround
fi

sleep 2
LEFTOVERS=""
ZOMBIES=""
while read -r owned; do
  [ -n "$owned" ] || continue
  state=$(ps -o stat= -p "$owned" 2>/dev/null | tr -d ' ' || true)
  case "$state" in
    Z*) ZOMBIES="$ZOMBIES $owned" ;;
    "") ;;
    *) LEFTOVERS="$LEFTOVERS $(ps -o pid=,comm=,args= -p "$owned" 2>/dev/null | head -1)" ;;
  esac
done <<EOF
$(pgrep -u "$(id -u)" -x 'audivane|codec-abx|ldac_helper|ffmpeg|ffprobe' 2>/dev/null || true)
EOF
value cleanup.processes "$LEFTOVERS"
value cleanup.zombies "$ZOMBIES"
if [ -z "$LEFTOVERS" ]; then pass cleanup.no_owned_processes; else fail cleanup.no_owned_processes; fi
if [ -n "${XVFB_PID:-}" ]; then kill "$XVFB_PID" 2>/dev/null || true; fi

# --------------------------------------------------------------- reinstall
section reinstall
STALE="$APP/resources/acceptance-stale-marker"
$SUDO sh -c "printf stale > '$STALE'" 2>/dev/null || true
check reinstall.stale_marker_created test -f "$STALE"
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y "$DEB" >"$OUT/apt-reinstall.log" 2>&1
REINSTALL_EXIT=$?
value reinstall.apt_exit "$REINSTALL_EXIT"
if [ "$REINSTALL_EXIT" -eq 0 ]; then pass reinstall.completed; else fail reinstall.completed; fi
if [ -f "$STALE" ]; then
  record reinstall.stale_marker retained-unowned-file
else
  record reinstall.stale_marker removed
fi
$SUDO rm -f "$STALE"

if [ -n "$UPGRADE_DEB" ]; then
  UPGRADE_DEB=$(readlink -f "$UPGRADE_DEB")
  printf 'unowned upgrade marker\n' | $SUDO tee "$STALE" >/dev/null
  value upgrade.artifact_sha256 "$(sha256sum "$UPGRADE_DEB" | awk '{print $1}')"
  OLD_VERSION=$(dpkg-query -W -f='${Version}' audivane 2>/dev/null || true)
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$UPGRADE_DEB" >"$OUT/apt-upgrade.log" 2>&1
  UPGRADE_EXIT=$?
  NEW_VERSION=$(dpkg-query -W -f='${Version}' audivane 2>/dev/null || true)
  value upgrade.exit_code "$UPGRADE_EXIT"
  value upgrade.old_version "$OLD_VERSION"
  value upgrade.new_version "$NEW_VERSION"
  if $SUDO dpkg -V audivane >"$OUT/dpkg-verify-upgrade.log" 2>&1 && [ ! -s "$OUT/dpkg-verify-upgrade.log" ]; then pass upgrade.installed_bytes; else fail upgrade.installed_bytes; fi
  if [ "$UPGRADE_EXIT" -eq 0 ] && dpkg --compare-versions "$NEW_VERSION" gt "$OLD_VERSION"; then pass upgrade.completed; else fail upgrade.completed; fi
  if [ -f "$STALE" ]; then record upgrade.stale_marker retained-unowned-file; else record upgrade.stale_marker removed; fi
  $SUDO rm -f "$STALE"
else
  record upgrade.outcome not-run-no-second-version-artifact
fi

# ------------------------------------------------------------ remove / purge
section remove
EXPORT="$HOME/audivane-acceptance-export.wav"
printf 'audivane acceptance export marker\n' >"$EXPORT"
EXPORT_SHA=$(sha256sum "$EXPORT" | awk '{print $1}')
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get remove -y audivane >"$OUT/apt-remove.log" 2>&1
REMOVE_EXIT=$?
value remove.apt_exit "$REMOVE_EXIT"
if [ "$REMOVE_EXIT" -eq 0 ]; then pass remove.completed; else fail remove.completed; fi
if [ -e "$APP" ]; then fail remove.install_tree_gone; else pass remove.install_tree_gone; fi
if [ -e "$COMMAND" ]; then fail remove.command_gone; else pass remove.command_gone; fi
if [ -e "$DESKTOP" ]; then fail remove.desktop_gone; else pass remove.desktop_gone; fi
if [ -f /etc/apparmor.d/audivane ]; then record remove.apparmor_conffile retained-conffile; else record remove.apparmor_conffile removed; fi
$SUDO grep -Eq '^audivane \(' /sys/kernel/security/apparmor/profiles >/dev/null 2>&1
REMOVE_PROFILE_STATUS=$?
if [ "$REMOVE_PROFILE_STATUS" -eq 1 ]; then
  pass remove.apparmor_profile_unloaded
else
  fail remove.apparmor_profile_unloaded
fi
value remove.dpkg_status "$(dpkg-query -W -f='${Status}' audivane 2>/dev/null || echo absent)"
if [ -f "$EXPORT" ] && [ "$(sha256sum "$EXPORT" | awk '{print $1}')" = "$EXPORT_SHA" ]; then pass remove.user_export_preserved; else fail remove.user_export_preserved; fi

$SUDO env DEBIAN_FRONTEND=noninteractive apt-get purge -y audivane >"$OUT/apt-purge.log" 2>&1
PURGE_EXIT=$?
value purge.apt_exit "$PURGE_EXIT"
if [ "$PURGE_EXIT" -eq 0 ]; then pass purge.completed; else fail purge.completed; fi
if dpkg-query -W audivane >/dev/null 2>&1; then fail purge.no_dpkg_record; else pass purge.no_dpkg_record; fi
if [ -e "$APP" ] || [ -e "$COMMAND" ] || [ -e "$DESKTOP" ]; then fail purge.no_package_files; else pass purge.no_package_files; fi
$SUDO grep -Eq '^audivane \(' /sys/kernel/security/apparmor/profiles >/dev/null 2>&1
PURGE_PROFILE_STATUS=$?
if [ ! -f /etc/apparmor.d/audivane ] && [ "$PURGE_PROFILE_STATUS" -eq 1 ]; then
  pass purge.apparmor_profile_gone
else
  fail purge.apparmor_profile_gone
fi
if [ -f "$EXPORT" ]; then pass purge.user_export_preserved; else fail purge.user_export_preserved; fi
$SUDO rm -f "$EXPORT"

if [ "$KEEP_INSTALLED" -eq 1 ]; then
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$DEB" >"$OUT/apt-reinstall-final.log" 2>&1 || true
fi

section summary
value summary.failures "$FAILURES"
value summary.log "$LOG"
if [ "$FAILURES" -eq 0 ]; then
  record summary.status complete
  exit 0
else
  record summary.status completed-with-failures
  exit 1
fi
