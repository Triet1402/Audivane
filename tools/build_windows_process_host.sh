#!/usr/bin/env bash
#
# Build apps/desktop/native/process-host.c for Windows x64.
#
# This helper owns the two production Job Objects that bound the whole desktop:
# a kill-on-close guard around the Electron main process and a per-codec job
# entered while the codec is still suspended. Packaging refuses a win32
# distribution without the resulting executable.
#
# Usage:
#   tools/build_windows_process_host.sh
#   tools/build_windows_process_host.sh --out build/windows-process-host/bin
#   tools/build_windows_process_host.sh --cross
#
# Run inside an MSYS2 MINGW64/UCRT64/CLANG64 shell on Windows, or use --cross
# from Linux with an x86_64-w64-mingw32 toolchain. A cross build produces a
# structural PE artifact only; it is not Windows execution acceptance.
#
set -euo pipefail
export LC_ALL=C
export TZ=UTC

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/build/windows-process-host/bin}"
BUILD_DIR="${PROCESS_HOST_BUILD_DIR:-$REPO_ROOT/build/windows-process-host}"
HOST_VERSION="1.0.0"
CROSS=0
CROSS_PREFIX="${CROSS_PREFIX:-x86_64-w64-mingw32-}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --clean)
            rm -rf "$BUILD_DIR"
            shift
            ;;
        --cross)
            CROSS=1
            shift
            ;;
        --cross-prefix=*)
            CROSS_PREFIX="${1#--cross-prefix=}"
            CROSS=1
            shift
            ;;
        --out)
            [ "$#" -ge 2 ] && [ -n "$2" ] || die "--out requires a directory"
            OUT_DIR="$2"
            shift 2
            ;;
        --out=*)
            OUT_DIR="${1#--out=}"
            [ -n "$OUT_DIR" ] || die "--out requires a directory"
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

if [ "$CROSS" = 1 ]; then
    [[ "$(uname -s)" == "Linux" ]] || die "--cross is implemented for a Linux cross-build host"
    CC="${CC:-${CROSS_PREFIX}gcc}"
else
    case "${MSYSTEM:-}" in
        MINGW64|UCRT64|CLANG64) ;;
        *) die "run this script inside an MSYS2 MINGW64, UCRT64 or CLANG64 shell (MSYSTEM=${MSYSTEM:-unset}), or use --cross on Linux" ;;
    esac
    CC="${CC:-gcc}"
fi
[[ "$(uname -m)" == "x86_64" ]] || die "Windows x64 build requires an x86_64 host"
command -v "$CC" >/dev/null 2>&1 || die "C compiler '$CC' not found"
command -v node >/dev/null 2>&1 || die "Node.js is required for the PE audit"
TARGET_TRIPLE="$("$CC" -dumpmachine 2>/dev/null || true)"
case "$TARGET_TRIPLE" in
    x86_64-w64-mingw32*) ;;
    *) die "compiler '$CC' targets '$TARGET_TRIPLE', expected x86_64-w64-mingw32" ;;
esac

mkdir -p "$BUILD_DIR" "$OUT_DIR"
echo "==> compiling audivane-process-host.exe"
"$CC" -O2 -std=gnu11 -Wall -Wextra -Werror -static -municode \
    -DUNICODE -D_UNICODE \
    "$REPO_ROOT/apps/desktop/native/process-host.c" \
    -o "$BUILD_DIR/audivane-process-host.exe"

echo "==> auditing the process host PE image"
node "$REPO_ROOT/tools/verification/windows-native-audit.mjs" \
    --file "$BUILD_DIR/audivane-process-host.exe"

BIN_SHA="$(sha256sum "$BUILD_DIR/audivane-process-host.exe" | awk '{print $1}')"
cat > "$BUILD_DIR/VERSION.txt" <<EOF
audivane_process_host $HOST_VERSION
target=windows-x64
source=apps/desktop/native/process-host.c
binary_sha256=$BIN_SHA
built_with=$("$CC" --version | head -n1)
built_by=tools/build_windows_process_host.sh
build_kind=$([ "$CROSS" = 1 ] && echo "Linux x86_64 cross build; PE not executed" || echo "native Windows x64 build")
EOF

install -d "$OUT_DIR"
install -m 0755 "$BUILD_DIR/audivane-process-host.exe" "$OUT_DIR/audivane-process-host.exe"
install -m 0644 "$BUILD_DIR/VERSION.txt" "$OUT_DIR/VERSION.txt"
echo "==> installed $OUT_DIR/audivane-process-host.exe"
echo "    sha256 $BIN_SHA"
