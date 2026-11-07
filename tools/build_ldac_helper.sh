#!/usr/bin/env bash
#
# Build tools/ldac_helper.c against pinned AOSP libldac (encoder) and
# pinned hegdi/libldacdec (decoder), then install only the helper binary
# and VERSION.txt into OUT_DIR (default third_party/ldac/).
#
# AOSP libldac is encoder-only and has no CMakeLists.txt, so the objects
# are compiled directly.  No sudo, cmake, ninja, or system dev packages
# are required; only gcc, make, git, and the C library.
#
# Environment:
#   LDAC_BUILD_DIR   source/object directory (default: /tmp/opencode/ldac-build)
#   OUT_DIR          install directory (default: <repo>/third_party/ldac)
#   JOBS             parallel compile jobs (default: nproc)
#   CC               C compiler (default: gcc)
#   BASELINE_NAME    recorded build baseline (e.g. Ubuntu 24.04.3 LTS)
#   BASELINE_KIND    recorded baseline method
#   BASELINE_TOOLCHAIN  recorded toolchain summary
#
# Usage:
#   tools/build_ldac_helper.sh [--clean]
#
set -euo pipefail
export LC_ALL=C
export TZ=UTC

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${LDAC_BUILD_DIR:-/tmp/opencode/ldac-build}"
OUT_DIR="${OUT_DIR:-$ROOT/third_party/ldac}"
JOBS="${JOBS:-$(nproc)}"
CC="${CC:-gcc}"
BASELINE_NAME="${BASELINE_NAME:-}"
BASELINE_KIND="${BASELINE_KIND:-}"
BASELINE_TOOLCHAIN="${BASELINE_TOOLCHAIN:-}"

LIBLDAC_REPO="https://android.googlesource.com/platform/external/libldac"
LIBLDAC_COMMIT="eeee1a3f5f8df1282e3a6d297085885fd886737b"
LIBLDACDEC_REPO="https://github.com/hegdi/libldacdec"
LIBLDACDEC_COMMIT="7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9"

CLEAN=0
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=1 ;;
        -h|--help)
            awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
            exit 0
            ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ "$CLEAN" = 1 ]; then
    rm -rf "$BUILD_DIR"
fi

command -v "$CC" >/dev/null 2>&1 || { echo "error: C compiler '$CC' not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "error: git not found" >&2; exit 1; }

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
        echo "error: $name is at $got, expected $commit" >&2
        exit 1
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

# Compile in parallel and fail if any object fails.
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
ar rcs "$LIB_DIR/libldacenc.a" "$OBJ_DIR/ldaclib.o" "$OBJ_DIR/ldacBT.o"
ar rcs "$LIB_DIR/libldacdec.a" \
    "$OBJ_DIR/libldacdec.o" "$OBJ_DIR/bit_allocation.o" \
    "$OBJ_DIR/huffCodes.o" "$OBJ_DIR/bit_reader.o" \
    "$OBJ_DIR/utility.o" "$OBJ_DIR/imdct.o" "$OBJ_DIR/spectrum.o"

echo "==> linking ldac_helper"
"$CC" -O2 -std=gnu11 -Wall -Wextra -Werror \
    -DLDAC_HELPER_VERSION='"1.0.0"' \
    -DLDAC_HELPER_LIBLDAC_COMMIT='"'"$LIBLDAC_COMMIT"'"' \
    -DLDAC_HELPER_LIBLDACDEC_COMMIT='"'"$LIBLDACDEC_COMMIT"'"' \
    -I"$LIBLDAC_DIR/inc" -I"$LIBLDACDEC_DIR" \
    "$ROOT/tools/ldac_helper.c" \
    -L"$LIB_DIR" -lldacenc -lldacdec -lm \
    -o "$BUILD_DIR/ldac_helper"

# Sanity check: the helper must not depend on libldac at runtime.
if command -v ldd >/dev/null 2>&1; then
    if ldd "$BUILD_DIR/ldac_helper" | grep -qi 'ldac'; then
        echo "error: helper still links a libldac shared library" >&2
        ldd "$BUILD_DIR/ldac_helper" >&2
        exit 1
    fi
fi
"$BUILD_DIR/ldac_helper" --version >/dev/null

echo "==> installing"
install -d "$OUT_DIR/bin"
install -m 0755 "$BUILD_DIR/ldac_helper" "$OUT_DIR/bin/ldac_helper"
BIN_SHA="$(sha256sum "$OUT_DIR/bin/ldac_helper" | awk '{print $1}')"
CC_VERSION="$("$CC" --version | head -n1)"
BASELINE_LINES=""
if [ -n "$BASELINE_NAME" ]; then
    BASELINE_LINES+="build_baseline=${BASELINE_NAME}"$'\n'
    BASELINE_LINES+="build_baseline_method=${BASELINE_KIND:-unspecified}"$'\n'
    BASELINE_LINES+="build_baseline_toolchain=${BASELINE_TOOLCHAIN:-$CC_VERSION}"$'\n'
fi
cat > "$OUT_DIR/VERSION.txt" <<EOF
ldac_helper 1.0.0
container_version 1
libldac_repo=$LIBLDAC_REPO
libldac_commit=$LIBLDAC_COMMIT
libldac_version=2.00.02
libldac_source_archive=$LIBLDAC_REPO/+archive/$LIBLDAC_COMMIT.tar.gz
libldacdec_repo=$LIBLDACDEC_REPO
libldacdec_commit=$LIBLDACDEC_COMMIT
libldacdec_source_archive=$LIBLDACDEC_REPO/archive/$LIBLDACDEC_COMMIT.tar.gz
binary_sha256=$BIN_SHA
built_with=$CC_VERSION
${BASELINE_LINES}build_dir=$BUILD_DIR
EOF

echo "==> installed $OUT_DIR/bin/ldac_helper"
echo "    sha256 $BIN_SHA"
