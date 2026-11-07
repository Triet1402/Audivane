#!/usr/bin/env bash
#
# Build the browser's supplemental LC3/LDAC WASM codecs from the exact pinned
# sources the native tier uses, then install them (plus VERSION.txt) into
# third_party/wasm/.
#
#   lc3_codec.js/.wasm   liblc3 1.1.3 (google/liblc3) + tools/lc3_wasm.c
#   ldac_codec.js/.wasm  AOSP libldac 2.00.02 (eeee1a3f, encoder) +
#                        hegdi/libldacdec (7f3bd6cc, decoder) + tools/ldac_wasm.c
#
# Requires emsdk (no sudo); it is downloaded into $CODEC_WASM_EMSDK_DIR the
# first time. The LC3 source tarball is verified against the same SHA-256
# that tools/build_ffmpeg.sh pins, so the browser uses the exact codec bits
# as the native tier.
#
# Environment:
#   CODEC_WASM_BUILD_DIR  sources/objects (default: /tmp/opencode/codec-wasm-build)
#   CODEC_WASM_EMSDK_DIR  emsdk install location (default: /tmp/opencode/emsdk)
#   JOBS                  parallel make jobs (default: nproc)
#
# Usage:
#   tools/build_codec_wasm.sh [--clean]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${CODEC_WASM_BUILD_DIR:-/tmp/opencode/codec-wasm-build}"
EMSDK_DIR="${CODEC_WASM_EMSDK_DIR:-/tmp/opencode/emsdk}"
JOBS="${JOBS:-$(nproc)}"

LIBLC3_VERSION="1.1.3"
LIBLC3_REPO="https://github.com/google/liblc3"
# Pinned tarball SHA-256 mirrors tools/build_ffmpeg.sh (single source of truth).
LIBLC3_SHA256="$(sed -n 's/^LC3_SHA="\([^"]*\)".*/\1/p' "$ROOT/tools/build_ffmpeg.sh")"

CLEAN=0
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=1 ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

# Serialize builds with asset copying and verification. The per-pair manifest
# below also detects an install interrupted between two otherwise present files.
mkdir -p "$ROOT/build"
exec 9>"$ROOT/build/verification.lock"
flock 9

if [ "$CLEAN" = 1 ]; then
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# --- emsdk -------------------------------------------------------------------
if [ ! -x "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
    if [ ! -d "$EMSDK_DIR/.git" ]; then
        echo "==> cloning emsdk"
        git clone --quiet https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    fi
    echo "==> installing emsdk (this downloads a toolchain, once)"
    (cd "$EMSDK_DIR" && ./emsdk install latest >/dev/null)
fi
(cd "$EMSDK_DIR" && ./emsdk activate latest >/dev/null)
# Point the toolchain straight at the install (emsdk_env.sh is not safe under
# `set -u`; the layout above is stable across recent emsdk releases).
export EMSDK="$EMSDK_DIR"
export EMSDK_NODE="$(find "$EMSDK_DIR/node" -name node -type f | head -n1)"
export PATH="$EMSDK_DIR/upstream/emscripten:$EMSDK_DIR/upstream/bin:$PATH"
command -v emcc >/dev/null 2>&1 || { echo "error: emcc unavailable" >&2; exit 1; }
(command -v emcmake >/dev/null 2>&1 && emcmake --version >/dev/null) || true
emcc --version | head -n1 > "$BUILD_DIR/emcc.txt"

# --- pinned sources ----------------------------------------------------------
fetch_liblc3() {
    local tarball="liblc3-${LIBLC3_VERSION}.tar.gz"
    local src_dir="liblc3-${LIBLC3_VERSION}"
    local url="https://github.com/google/liblc3/archive/refs/tags/v${LIBLC3_VERSION}.tar.gz"
    if [ -z "$LIBLC3_SHA256" ]; then
        echo "error: cannot resolve liblc3 checksum from tools/build_ffmpeg.sh" >&2
        exit 1
    fi
    if [ ! -f "$tarball" ]; then
        echo "==> downloading $url"
        curl -fsSL "$url" -o "$tarball"
    fi
    echo "$LIBLC3_SHA256  $tarball" | sha256sum --check --quiet
    if [ ! -d "$src_dir" ]; then
        tar -xzf "$tarball"
    fi
}

fetch_repo() {
    local dir="$1" url="$2" commit="$3"
    if [ ! -d "$dir/.git" ]; then
        echo "==> cloning $( basename "$url" )"
        git clone --quiet "$url" "$dir"
    fi
    if ! git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
        git -C "$dir" fetch --quiet origin "$commit"
    fi
    git -C "$dir" checkout --quiet "$commit"
    local got
    got="$(git -C "$dir" rev-parse HEAD)"
    if [ "$got" != "$commit" ]; then
        echo "error: $(basename "$url") is at $got, expected $commit" >&2
        exit 1
    fi
}

# Read the pinned LDAC commits from the canonical native build script.
LIBLDAC_COMMIT="$(sed -n 's/^LIBLDAC_COMMIT="\([^"]*\)".*/\1/p' "$ROOT/tools/build_ldac_helper.sh")"
LIBLDACDEC_COMMIT="$(sed -n 's/^LIBLDACDEC_COMMIT="\([^"]*\)".*/\1/p' "$ROOT/tools/build_ldac_helper.sh")"
[ -n "$LIBLDAC_COMMIT" ] && [ -n "$LIBLDACDEC_COMMIT" ] \
    || { echo "error: cannot resolve libldac commits from tools/build_ldac_helper.sh" >&2; exit 1; }

fetch_liblc3
fetch_repo "$BUILD_DIR/libldac" "https://android.googlesource.com/platform/external/libldac" "$LIBLDAC_COMMIT"
fetch_repo "$BUILD_DIR/libldacdec" "https://github.com/hegdi/libldacdec" "$LIBLDACDEC_COMMIT"

COMMON_FLAGS=(-O2 -Wno-unused-parameter -Demscripten -fno-strict-aliasing)

# compile_objects OUT_DIR INCLUDE_FLAGS... SRC...
compile_objects() {
    local out_prefix="$1"; shift
    local include_flags=()
    while [ "$1" != "--" ]; do
        include_flags+=("$1"); shift
    done
    shift
    local files=("$@") pids=() src obj
    for src in "${files[@]}"; do
        obj="$out_prefix/$(basename "${src%.*}").o"
        emcc "${COMMON_FLAGS[@]}" "${include_flags[@]}" -c "$src" -o "$obj" &
        pids+=("$!")
    done
    for pid in "${pids[@]}"; do wait "$pid"; done
}

# --- LC3 module --------------------------------------------------------------
LC3_OBJ="$BUILD_DIR/lc3-objects"
rm -rf "$LC3_OBJ"; mkdir -p "$LC3_OBJ"
echo "==> compiling liblc3 (google/liblc3 v$LIBLC3_VERSION)"
compile_objects "$LC3_OBJ" -I"$BUILD_DIR/liblc3-1.1.3/include" -I"$BUILD_DIR/liblc3-1.1.3/src" -- \
    "$BUILD_DIR/liblc3-1.1.3/src/"*.c
echo "==> compiling tools/lc3_wasm.c"
emcc "${COMMON_FLAGS[@]}" -I"$BUILD_DIR/liblc3-1.1.3/include" \
    -I"$BUILD_DIR/liblc3-1.1.3/src" \
    -c "$ROOT/tools/lc3_wasm.c" -o "$LC3_OBJ/lc3_wasm.o"

echo "==> linking lc3_codec.js/.wasm"
emcc -O2 --no-entry -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createLC3Codec \
    -sENVIRONMENT=web,worker -sALLOW_TABLE_GROWTH=1 -sALLOW_MEMORY_GROWTH=1 \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU16,HEAPU32,HEAPF32 \
    -sEXPORTED_FUNCTIONS=_lc3_encoder_new,_lc3_encode_block,_lc3_frame_len,_lc3_frame_copy,_lc3_encoder_free,_lc3_decoder_new,_lc3_decode_block,_lc3_decoder_free,_malloc,_free \
    "$LC3_OBJ/"*.o -o "$BUILD_DIR/lc3_codec.js"

# --- LDAC module -------------------------------------------------------------
LDAC_OBJ="$BUILD_DIR/ldac-objects"
rm -rf "$LDAC_OBJ"; mkdir -p "$LDAC_OBJ"
echo "==> compiling AOSP libldac (encoder, $LIBLDAC_COMMIT)"
for src in ldaclib ldacBT; do
    emcc "${COMMON_FLAGS[@]}" -I"$BUILD_DIR/libldac/inc" -I"$BUILD_DIR/libldac/src" \
        -c "$BUILD_DIR/libldac/src/$src.c" -o "$LDAC_OBJ/$src.o"
done
echo "==> compiling hegdi/libldacdec ($LIBLDACDEC_COMMIT)"
for src in libldacdec bit_allocation huffCodes bit_reader utility imdct spectrum; do
    emcc "${COMMON_FLAGS[@]}" -I"$BUILD_DIR/libldacdec" \
        -c "$BUILD_DIR/libldacdec/$src.c" -o "$LDAC_OBJ/$src.o"
done
echo "==> compiling tools/ldac_wasm.c"
emcc "${COMMON_FLAGS[@]}" -I"$BUILD_DIR/libldac/inc" -I"$BUILD_DIR/libldacdec" \
    -c "$ROOT/tools/ldac_wasm.c" -o "$LDAC_OBJ/ldac_wasm.o"

echo "==> linking ldac_codec.js/.wasm"
emcc -O2 --no-entry -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createLDACCodec \
    -sENVIRONMENT=web,worker -sALLOW_TABLE_GROWTH=1 -sALLOW_MEMORY_GROWTH=1 \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU16,HEAPU32,HEAPF32 \
    -sEXPORTED_FUNCTIONS=_ldac_wasm_encoder_new,_ldac_wasm_encode_block,_ldac_wasm_encoder_flush,_ldac_wasm_frame_len,_ldac_wasm_frame_copy,_ldac_wasm_encoder_free,_ldac_wasm_decoder_new,_ldac_wasm_decode_block,_ldac_wasm_decoder_free,_malloc,_free \
    "$LDAC_OBJ/"*.o -o "$BUILD_DIR/ldac_codec.js"

# --- install -----------------------------------------------------------------
install -d "$ROOT/third_party/wasm/bin"
for module in lc3 ldac; do
    install -m 0644 "$BUILD_DIR/${module}_codec.js" "$ROOT/third_party/wasm/bin/${module}_codec.js"
    install -m 0644 "$BUILD_DIR/${module}_codec.wasm" "$ROOT/third_party/wasm/bin/${module}_codec.wasm"
    # Commit the identity of both installed halves last. A killed install leaves
    # no manifest or a hash mismatch, so the copier refuses that source pair.
    (cd "$BUILD_DIR" && sha256sum "${module}_codec.js" "${module}_codec.wasm") \
        > "$ROOT/third_party/wasm/bin/${module}_codec.sha256.tmp"
    mv "$ROOT/third_party/wasm/bin/${module}_codec.sha256.tmp" \
        "$ROOT/third_party/wasm/bin/${module}_codec.sha256"
done

cat > "$ROOT/third_party/wasm/VERSION.txt" <<EOF
supplemental browser codec WASM builds
liblc3_version=$LIBLC3_VERSION
liblc3_source_sha256=$LIBLC3_SHA256
libldac_commit=$LIBLDAC_COMMIT
libldacdec_commit=$LIBLDACDEC_COMMIT
emcc_version=$(head -n1 "$BUILD_DIR/emcc.txt")
built_by=tools/build_codec_wasm.sh
build_dir=$BUILD_DIR
EOF

for module in lc3 ldac; do
    echo "    ${module}_codec.wasm sha256 $(sha256sum "$ROOT/third_party/wasm/bin/${module}_codec.wasm" | awk '{print $1}')"
done
echo "==> installed $ROOT/third_party/wasm/bin"
