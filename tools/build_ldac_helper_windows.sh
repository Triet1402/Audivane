#!/usr/bin/env bash
#
# Build tools/ldac_helper.c for Windows x64 against pinned AOSP libldac
# (encoder) and pinned hegdi/libldacdec (decoder). Run inside an MSYS2
# MINGW64 (or UCRT64/CLANG64) shell on Windows x64.
#
# Result:
#   third_party/ldac/bin/ldac_helper.exe
#   third_party/ldac/VERSION.txt
#
# The Linux equivalent is tools/build_ldac_helper.sh. Source commits are the
# same; the Windows recipe links the MinGW runtime statically so the helper
# does not require libgcc/libwinpthread DLLs.
#
# Prerequisites (MSYS2 MINGW64 shell):
#   pacman -S --needed base-devel mingw-w64-x86_64-toolchain git tar xz
# Node.js is required only for the post-build PE/DLL audit.
#
# A Linux cross build is supported for a concrete artifact:
#   PATH=/path/to/mingw-w64/bin:$PATH tools/build_ldac_helper_windows.sh --cross
# It compiles and audits the PE but does not execute it; runtime containment
# remains unverified until an actual Windows run.
#
# This recipe has NOT been executed on a Windows host in this repository yet.
#
# Environment:
#   LDAC_BUILD_DIR   source/object directory (default: <repo>/build/ldac-windows)
#   OUT_DIR          install directory (default: third_party/ldac, or
#                    build/ldac-windows/out/ldac for --cross)
#   JOBS             parallel compile jobs (default: nproc)
#   CC               C compiler (default: gcc)
#
# Usage:
#   tools/build_ldac_helper_windows.sh [--clean] [--cross]
#
set -euo pipefail
export LC_ALL=C
export TZ=UTC

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${LDAC_BUILD_DIR:-$REPO_ROOT/build/ldac-windows}"
OUT_DIR="${OUT_DIR:-}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
CROSS=0
CROSS_PREFIX="${CROSS_PREFIX:-x86_64-w64-mingw32-}"

LIBLDAC_REPO="https://android.googlesource.com/platform/external/libldac"
LIBLDAC_COMMIT="eeee1a3f5f8df1282e3a6d297085885fd886737b"
LIBLDACDEC_REPO="https://github.com/hegdi/libldacdec"
LIBLDACDEC_COMMIT="7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

CLEAN=0
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=1 ;;
        --cross) CROSS=1 ;;
        --cross-prefix=*) CROSS_PREFIX="${arg#--cross-prefix=}"; CROSS=1 ;;
        -h|--help)
            awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
            exit 0
            ;;
        *) die "unknown argument: $arg" ;;
    esac
done
if [ "$CLEAN" = 1 ]; then
    rm -rf "$BUILD_DIR"
fi

if [ "$CROSS" = 1 ]; then
    [[ "$(uname -s)" == "Linux" ]] || die "--cross is implemented for a Linux cross-build host"
    CC="${CC:-${CROSS_PREFIX}gcc}"
    AR="${AR:-${CROSS_PREFIX}ar}"
    RANLIB="${RANLIB:-${CROSS_PREFIX}ranlib}"
    export CC AR RANLIB
    OUT_DIR="${OUT_DIR:-$BUILD_DIR/out/ldac}"
else
    case "${MSYSTEM:-}" in
        MINGW64|UCRT64|CLANG64) ;;
        *) die "run this script inside an MSYS2 MINGW64, UCRT64 or CLANG64 shell (MSYSTEM=${MSYSTEM:-unset}), or use --cross on Linux" ;;
    esac
    CC="${CC:-gcc}"
    AR="${AR:-ar}"
    RANLIB="${RANLIB:-ranlib}"
    OUT_DIR="${OUT_DIR:-$REPO_ROOT/third_party/ldac}"
fi
[[ "$(uname -m)" == "x86_64" ]] || die "Windows x64 build requires an x86_64 host"
command -v "$CC" >/dev/null 2>&1 || die "C compiler '$CC' not found"
TARGET_TRIPLE="$("$CC" -dumpmachine 2>/dev/null || true)"
case "$TARGET_TRIPLE" in
    x86_64-w64-mingw32*) ;;
    *) die "compiler '$CC' targets '$TARGET_TRIPLE', expected x86_64-w64-mingw32" ;;
esac
for tool in git make ar sha256sum node; do
    command -v "$tool" >/dev/null 2>&1 || die "required build tool '$tool' was not found"
done
if [ "$CROSS" = 1 ]; then
    for tool in "$CC" "$AR" "$RANLIB"; do
        command -v "$tool" >/dev/null 2>&1 || die "cross toolchain command '$tool' was not found"
    done
fi

mkdir -p "$BUILD_DIR"

fetch_repo() {
    local url="$1" dir="$2" commit="$3" name="$4"
    if [ ! -d "$dir/.git" ]; then
        echo "==> cloning $name"
        rm -rf "$dir"
        git clone --quiet "$url" "$dir"
    fi
    if ! git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
        echo "==> fetching pinned commit for $name"
        git -C "$dir" fetch --quiet origin "$commit"
    fi
    git -C "$dir" checkout --quiet "$commit"
    local got
    got="$(git -C "$dir" rev-parse HEAD)"
    if [ "$got" != "$commit" ]; then
        die "$name is at $got, expected $commit"
    fi
}

LIBLDAC_DIR="$BUILD_DIR/libldac"
LIBLDACDEC_DIR="$BUILD_DIR/libldacdec"
OBJ_DIR="$BUILD_DIR/obj"
LIB_DIR="$BUILD_DIR/lib"
rm -rf "$OBJ_DIR" "$LIB_DIR"
mkdir -p "$OBJ_DIR" "$LIB_DIR"

fetch_repo "$LIBLDAC_REPO" "$LIBLDAC_DIR" "$LIBLDAC_COMMIT" "AOSP libldac"
fetch_repo "$LIBLDACDEC_REPO" "$LIBLDACDEC_DIR" "$LIBLDACDEC_COMMIT" "hegdi/libldacdec"

CFLAGS=(-O2 -std=gnu11 -Wall -Wextra -fno-strict-aliasing)
ENC_CFLAGS=("${CFLAGS[@]}" -I"$LIBLDAC_DIR/inc" -I"$LIBLDAC_DIR/src")
DEC_CFLAGS=("${CFLAGS[@]}" -I"$LIBLDACDEC_DIR")

pids=()
run_cc() {
    "$CC" "$@" &
    pids+=("$!")
}

echo "==> compiling libldac encoder (AOSP $LIBLDAC_COMMIT)"
for src in ldaclib ldacBT; do
    run_cc "${ENC_CFLAGS[@]}" -c "$LIBLDAC_DIR/src/$src.c" -o "$OBJ_DIR/$src.o"
done

echo "==> compiling libldacdec ($LIBLDACDEC_COMMIT)"
for src in libldacdec bit_allocation huffCodes bit_reader utility imdct spectrum; do
    run_cc "${DEC_CFLAGS[@]}" -c "$LIBLDACDEC_DIR/$src.c" -o "$OBJ_DIR/$src.o"
done

for pid in "${pids[@]}"; do
    wait "$pid"
done

echo "==> archiving static libraries"
"$AR" rcs "$LIB_DIR/libldacenc.a" "$OBJ_DIR/ldaclib.o" "$OBJ_DIR/ldacBT.o"
"$AR" rcs "$LIB_DIR/libldacdec.a" \
    "$OBJ_DIR/libldacdec.o" "$OBJ_DIR/bit_allocation.o" \
    "$OBJ_DIR/huffCodes.o" "$OBJ_DIR/bit_reader.o" \
    "$OBJ_DIR/utility.o" "$OBJ_DIR/imdct.o" "$OBJ_DIR/spectrum.o"

echo "==> linking ldac_helper.exe"
"$CC" -O2 -std=gnu11 -Wall -Wextra -Werror -static \
    -DLDAC_HELPER_VERSION='"1.0.0"' \
    -DLDAC_HELPER_LIBLDAC_COMMIT='"'"$LIBLDAC_COMMIT"'"' \
    -DLDAC_HELPER_LIBLDACDEC_COMMIT='"'"$LIBLDACDEC_COMMIT"'"' \
    -I"$LIBLDAC_DIR/inc" -I"$LIBLDACDEC_DIR" \
    "$REPO_ROOT/tools/ldac_helper.c" \
    -L"$LIB_DIR" -lldacenc -lldacdec -lm -lshell32 \
    -o "$BUILD_DIR/ldac_helper.exe"

if [ "$CROSS" = 1 ]; then
    echo "==> cross build: skipping helper --version execution (PE cannot run on this host)"
else
    "$BUILD_DIR/ldac_helper.exe" --version >/dev/null
fi

BIN_SHA="$(sha256sum "$BUILD_DIR/ldac_helper.exe" | awk '{print $1}')"
CC_VERSION="$("$CC" --version | head -n1)"
cat > "$BUILD_DIR/VERSION.txt" <<EOF
ldac_helper 1.0.0
container_version 1
target=windows-x64
libldac_repo=$LIBLDAC_REPO
libldac_commit=$LIBLDAC_COMMIT
libldac_version=2.00.02
libldac_source_archive=$LIBLDAC_REPO/+archive/$LIBLDAC_COMMIT.tar.gz
libldacdec_repo=$LIBLDACDEC_REPO
libldacdec_commit=$LIBLDACDEC_COMMIT
libldacdec_source_archive=$LIBLDACDEC_REPO/archive/$LIBLDACDEC_COMMIT.tar.gz
binary_sha256=$BIN_SHA
built_with=$CC_VERSION
built_by=tools/build_ldac_helper_windows.sh
build_kind=$([ "$CROSS" = 1 ] && echo "Linux x86_64 cross build; PE not executed" || echo "native Windows x64 build")
EOF

# Audit before installing into the repository.
AUDIT_DIR="$BUILD_DIR/audit-bundle"
rm -rf "$AUDIT_DIR"
mkdir -p "$AUDIT_DIR/third_party/ldac/bin"
cp "$BUILD_DIR/ldac_helper.exe" "$AUDIT_DIR/third_party/ldac/bin/ldac_helper.exe"
cp "$BUILD_DIR/VERSION.txt" "$AUDIT_DIR/third_party/ldac/VERSION.txt"
echo "==> auditing PE headers, provenance and DLL imports"
node "$REPO_ROOT/tools/verification/windows-native-audit.mjs" --bundle "$AUDIT_DIR" --component ldac

echo "==> installing"
install -d "$OUT_DIR/bin"
install -m 0755 "$BUILD_DIR/ldac_helper.exe" "$OUT_DIR/bin/ldac_helper.exe"
install -m 0644 "$BUILD_DIR/VERSION.txt" "$OUT_DIR/VERSION.txt"

echo "==> installed $OUT_DIR/bin/ldac_helper.exe"
echo "    sha256 $BIN_SHA"
