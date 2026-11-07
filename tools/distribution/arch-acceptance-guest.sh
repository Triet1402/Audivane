#!/usr/bin/env bash
# Execute only in a disposable Arch Linux KVM guest as a normal sudo user.
# Installs a local package, verifies native/sandbox/desktop integration, then
# reinstalls and removes it. Exports remain user-owned; no host policy changes.
# Usage: bash arch-acceptance-guest.sh /path/audivane-bin-*.pkg.tar.zst [OUT]
set -euo pipefail
. /etc/os-release
[ "$ID" = arch ] && [ "$(systemd-detect-virt)" = kvm ] && [ "$(id -u)" -ne 0 ] || { echo 'Requires a disposable Arch KVM guest and a normal sudo user' >&2; exit 2; }
PACKAGE=$(realpath "${1:?Supply a package}")
OUT=$(realpath -m "${2:-$HOME/arch-acceptance}")
mkdir -p "$OUT"
exec > >(tee "$OUT/guest.log") 2>&1
record() { printf 'RESULT %s=%s\n' "$1" "$2"; }
APP=/opt/audivane
FFMPEG=$APP/resources/third_party/ffmpeg/bin/ffmpeg
FFPROBE=$APP/resources/third_party/ffmpeg/bin/ffprobe
LDAC=$APP/resources/third_party/ldac/bin/ldac_helper
RUNNER_PID= XVFB_PID=
cleanup() {
  if [ -n "$RUNNER_PID" ]; then kill -TERM -- "-$RUNNER_PID" 2>/dev/null || true; wait "$RUNNER_PID" 2>/dev/null || true; fi
  if [ -n "$XVFB_PID" ]; then kill "$XVFB_PID" 2>/dev/null || true; wait "$XVFB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
record env.os "$PRETTY_NAME"
record env.kernel "$(uname -r)"
record env.glibc "$(getconf GNU_LIBC_VERSION)"
record artifact.sha256 "$(sha256sum "$PACKAGE" | cut -d' ' -f1)"
record artifact.package "$(basename "$PACKAGE")"
pacman -Q > "$OUT/packages-before.txt"
sudo pacman -U --noconfirm "$PACKAGE"
record install.completed pass
sudo pacman -Qkk audivane-bin > "$OUT/pacman-verify.txt" 2>&1
record install.files_match pass
[ "$(stat -c %a "$APP")" = 755 ] && [ "$(stat -c %a "$APP/audivane")" = 755 ]
[ ! -u "$APP/chrome-sandbox" ] && [ ! -g "$APP/chrome-sandbox" ]
[ "$(readlink /usr/bin/audivane)" = /opt/audivane/audivane ]
[ ! -e /etc/apparmor.d/audivane ]
test -f /usr/share/applications/audivane.desktop
test -f /usr/share/icons/hicolor/256x256/apps/audivane.png
test -f /usr/share/licenses/audivane-bin/LICENSE
test -f "$APP/resources/notices/SOURCE-OFFER.md"
record files.desktop_icons_licenses pass
record files.no_setuid_or_policy_install pass
for tool in node npm ffmpeg ffprobe ldac_helper; do
  if command -v "$tool" >/dev/null 2>&1; then echo "Unexpected PATH executable: $tool" >&2; exit 1; fi
done
record files.no_developer_path_tools pass
mkdir -p "$OUT/foreign cwd üß"
cd "$OUT/foreign cwd üß"
env -i PATH= "$FFMPEG" -version > "$OUT/ffmpeg-version.txt"
env -i PATH= "$FFPROBE" -version > "$OUT/ffprobe-version.txt"
env -i PATH= "$LDAC" --version > "$OUT/ldac-version.txt"
"$FFMPEG" -hide_banner -encoders > "$OUT/encoders.txt" 2>&1
"$FFMPEG" -hide_banner -decoders > "$OUT/decoders.txt" 2>&1
for codec in libopus aac libvorbis libmp3lame libtwolame liblc3 sbc aptx aptx_hd; do grep -Eq "[[:space:]]$codec[[:space:]]" "$OUT/encoders.txt"; done
for codec in opus aac vorbis mp3float mp2float liblc3 sbc aptx aptx_hd; do grep -Eq "[[:space:]]$codec[[:space:]]" "$OUT/decoders.txt"; done
record native.codec_tables pass
"$FFMPEG" -v error -y -f lavfi -i 'sine=frequency=437:sample_rate=48000:duration=0.1' -ac 2 -f s16le "$OUT/input.pcm"
"$LDAC" encode --in "$OUT/input.pcm" --out "$OUT/test.ldac" --rate 48000 --channels 2 --bitrate 660
"$LDAC" decode --in "$OUT/test.ldac" --out "$OUT/output.pcm" --rate 48000 --channels 2 --bitrate 660
test "$(stat -c %s "$OUT/input.pcm")" -eq "$(stat -c %s "$OUT/output.pcm")"
record native.ldac_roundtrip pass
ELFS=0
: > "$OUT/linkage.txt"
while IFS= read -r -d '' file; do
  if [ "$(head -c4 "$file" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ]; then
    ELFS=$((ELFS+1))
    printf '\n%s\n' "$file" >> "$OUT/linkage.txt"
    ldd "$file" >> "$OUT/linkage.txt" 2>&1
  fi
done < <(find "$APP" -type f -print0)
[ "$ELFS" -ge 9 ] && ! grep -q 'not found' "$OUT/linkage.txt"
record native.elf_objects_checked "$ELFS"
record native.linkage pass
export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 2
xdpyinfo >/dev/null
mkdir -p "$OUT/runtime" "$OUT/clean-home"
chmod 700 "$OUT/runtime" "$OUT/clean-home"
setsid env -i HOME="$OUT/clean-home" PATH= LANG=C.UTF-8 DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$OUT/runtime" \
  /usr/bin/dbus-run-session --dbus-daemon=/usr/bin/dbus-daemon -- /opt/audivane/audivane --enable-logging=stderr > "$OUT/launch.log" 2>&1 &
RUNNER_PID=$!
for attempt in $(seq 1 30); do
  RENDERER=$(pgrep -u "$(id -u)" -f '^/opt/audivane/audivane --type=renderer' | head -1 || true)
  [ -n "$RENDERER" ] && break
  sleep 1
done
[ -n "${RENDERER:-}" ]
[ "$(awk '/^NoNewPrivs:/{print $2}' "/proc/$RENDERER/status")" = 1 ]
[ "$(awk '/^Seccomp:/{print $2}' "/proc/$RENDERER/status")" = 2 ]
[ "$(readlink "/proc/$RENDERER/ns/user")" != "$(readlink /proc/self/ns/user)" ]
cat "/proc/$RENDERER/status" > "$OUT/renderer-status.txt"
record launch.renderer_no_new_privs 1
record launch.renderer_seccomp 2
record launch.distinct_user_namespace pass
record launch.outcome running-sandboxed
WINDOW=$(xdotool search --onlyvisible --name '^Audivane' | head -1)
xprop -id "$WINDOW" WM_CLASS > "$OUT/wm-class.txt"
grep -q '"audivane", "audivane"' "$OUT/wm-class.txt"
record launch.wm_class pass
MAIN=$(pgrep -u "$(id -u)" -f '^/opt/audivane/audivane --enable-logging=stderr$' | head -1)
kill -TERM "$MAIN"
wait "$RUNNER_PID" || true
RUNNER_PID=
sleep 2
if pgrep -u "$(id -u)" -f '^/opt/audivane/' > "$OUT/leftover-pids.txt"; then exit 1; fi
record cleanup.no_owned_processes pass
printf 'preserve this user export\n' > "$OUT/user-export.txt"
sudo pacman -U --noconfirm "$PACKAGE"
sudo pacman -Qkk audivane-bin > "$OUT/reinstall-verify.txt" 2>&1
record reinstall.completed pass
sudo pacman -R --noconfirm audivane-bin
[ ! -e "$APP" ] && [ ! -e /usr/bin/audivane ] && [ ! -e /usr/share/applications/audivane.desktop ] && [ ! -e /usr/share/licenses/audivane-bin ]
[ ! -e /usr/share/icons/hicolor/256x256/apps/audivane.png ]
if pacman -Q audivane-bin >/dev/null 2>&1; then exit 1; fi
test -s "$OUT/user-export.txt"
record remove.package_files_gone pass
record remove.user_export_preserved pass
pacman -Q > "$OUT/packages-after.txt"
record summary.status passed
