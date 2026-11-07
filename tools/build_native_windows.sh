#!/usr/bin/env bash
#
# Build and provision the complete pinned Windows x64 native codec payload:
# FFmpeg/ffprobe (with liblc3) + ldac_helper.exe (libldac + libldacdec).
#
# Run inside an MSYS2 MINGW64 (or UCRT64/CLANG64) shell on Windows x64. This is
# the Windows counterpart of tools/build_ffmpeg.sh + tools/build_ldac_helper.sh.
#
# The prepared output is a resources root that packaging can name with
# CODEC_ABX_NATIVE_BUNDLE_DIR / --native-bundle. It is NOT a public release
# artifact and this script does not run Windows acceptance, sign anything or
# prove codec capability.
#
# Usage:
#   tools/build_native_windows.sh
#   tools/build_native_windows.sh --clean
#   tools/build_native_windows.sh --out /c/release/audivane-win-native
#   tools/build_native_windows.sh --cross --out /tmp/audivane-win-native
#
# Output default: <repo>/build/windows-native-bundle (gitignored). Component
# outputs default under build/windows-native/ and can be set with
# WINDOWS_FFMPEG_OUT / WINDOWS_LDAC_OUT. Nothing is written to the tracked
# Linux third_party/ paths unless those variables are pointed there.
#
# A Linux --cross build creates concrete PE artifacts for structural audit, but
# does not execute them and is not Windows acceptance.
#
# This recipe has NOT been executed on a Windows host in this repository yet.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${WINDOWS_NATIVE_BUNDLE_DIR:-$REPO_ROOT/build/windows-native-bundle}"
FFMPEG_OUT="${WINDOWS_FFMPEG_OUT:-$REPO_ROOT/build/windows-native/ffmpeg}"
LDAC_OUT="${WINDOWS_LDAC_OUT:-$REPO_ROOT/build/windows-native/ldac}"
CLEAN=0
BUILD_ARGS=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --clean) CLEAN=1; BUILD_ARGS+=(--clean); shift ;;
        --cross) BUILD_ARGS+=(--cross); shift ;;
        --cross-prefix=*) BUILD_ARGS+=("$1"); shift ;;
        --out)
            [ "$#" -ge 2 ] && [ -n "$2" ] || die "--out requires a directory value"
            OUT_DIR="$2"
            shift 2
            ;;
        --out=*)
            OUT_DIR="${1#--out=}"
            [ -n "$OUT_DIR" ] || die "--out requires a directory value"
            shift
            ;;
        --help|-h)
            awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
            exit 0
            ;;
        *)
            die "unknown argument: $1"
            ;;
    esac
done

if [[ " ${BUILD_ARGS[*]} " == *" --cross "* ]]; then
    [[ "$(uname -s)" == "Linux" ]] || die "--cross is implemented for a Linux cross-build host"
else
    case "${MSYSTEM:-}" in
        MINGW64|UCRT64|CLANG64) ;;
        *) die "run this script inside an MSYS2 MINGW64, UCRT64 or CLANG64 shell (MSYSTEM=${MSYSTEM:-unset}), or use --cross on Linux" ;;
    esac
fi
command -v node >/dev/null 2>&1 || die "Node.js is required for the PE/DLL audit"

if [ "$CLEAN" = 1 ]; then
    rm -rf "$REPO_ROOT/build/ffmpeg-windows" "$REPO_ROOT/build/ldac-windows"
fi

echo "==> building pinned FFmpeg/ffprobe for Windows x64"
OUT_DIR="$FFMPEG_OUT" "$REPO_ROOT/tools/build_ffmpeg_windows.sh" "${BUILD_ARGS[@]}"

echo "==> building pinned ldac_helper.exe for Windows x64"
LDAC_ARGS=("${BUILD_ARGS[@]}")
if [ "$CLEAN" = 1 ]; then
    LDAC_ARGS+=(--clean)
fi
OUT_DIR="$LDAC_OUT" "$REPO_ROOT/tools/build_ldac_helper_windows.sh" "${LDAC_ARGS[@]}"

FFMPEG_BIN="$FFMPEG_OUT/bin"
LDAC_BIN="$LDAC_OUT/bin"
FFMPEG_VERSION="$FFMPEG_OUT/VERSION.txt"
LDAC_VERSION="$LDAC_OUT/VERSION.txt"
for required in \
    "$FFMPEG_BIN/ffmpeg.exe" "$FFMPEG_BIN/ffprobe.exe" "$FFMPEG_VERSION" \
    "$LDAC_BIN/ldac_helper.exe" "$LDAC_VERSION"; do
    [ -f "$required" ] || die "expected build output is missing: $required"
done

echo "==> provisioning $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/third_party/ffmpeg/bin" "$OUT_DIR/third_party/ldac/bin"
cp "$FFMPEG_BIN/ffmpeg.exe" "$FFMPEG_BIN/ffprobe.exe" "$OUT_DIR/third_party/ffmpeg/bin/"
cp "$FFMPEG_VERSION" "$OUT_DIR/third_party/ffmpeg/VERSION.txt"
cp "$LDAC_BIN/ldac_helper.exe" "$OUT_DIR/third_party/ldac/bin/"
cp "$LDAC_VERSION" "$OUT_DIR/third_party/ldac/VERSION.txt"

# Supply any DLLs the static build unexpectedly needs rather than hiding them.
# The audit still fails if an import is neither a system DLL nor copied here.
shopt -s nullglob
for dll in "$FFMPEG_BIN"/*.dll; do
    cp "$dll" "$OUT_DIR/third_party/ffmpeg/bin/"
done
for dll in "$LDAC_BIN"/*.dll; do
    cp "$dll" "$OUT_DIR/third_party/ldac/bin/"
done
shopt -u nullglob

echo "==> auditing the prepared bundle"
node "$REPO_ROOT/tools/verification/windows-native-audit.mjs" --bundle "$OUT_DIR"
node "$REPO_ROOT/tools/verification/windows-native-audit.mjs" --bundle "$OUT_DIR" --json > "$(dirname "$OUT_DIR")/windows-native-audit.json"

cat <<EOF

Prepared Windows x64 native bundle:
  $OUT_DIR

Next steps (on an actual Windows x64 host):
  1. npm run check:native -- --native-bundle "$OUT_DIR"
     (real codec probe; requires the PE binaries to execute)
  2. Package with the Windows packaging path, then run packaged acceptance.

Structural audit is not Windows acceptance, codec conformance or a license
approval. Do not publish this developer bundle unchanged.
EOF
