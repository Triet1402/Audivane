#!/usr/bin/env bash
#
# Reproducible, from-source FFmpeg build with LC3 (liblc3) support for
# Codec_ABX_test / Audivane.
#
# Result (OUT_DIR defaults to third_party/ffmpeg):
#   $OUT_DIR/bin/ffmpeg
#   $OUT_DIR/bin/ffprobe
#   $OUT_DIR/VERSION.txt
#
# Everything else (sources, static dependency prefix) stays under $BUILD_DIR,
# which defaults to /tmp/opencode/ffmpeg-build.
#
# No sudo is required. Required host tools: bash, curl, tar, gcc, make,
# pkg-config, meson, ninja and cmake. Build-tool versions are recorded in
# VERSION.txt.
#
# Usage:
#   tools/build_ffmpeg.sh
#   BUILD_DIR=/tmp/opencode/some-other-dir tools/build_ffmpeg.sh
#   OUT_DIR=/tmp/opencode/ffmpeg-out JOBS=16 tools/build_ffmpeg.sh
#
# For the supported Ubuntu 24.04/glibc 2.39 release baseline, use
# tools/build_linux_baseline.sh instead of running this script directly on a
# newer host. That wrapper sets the BASELINE_* metadata recorded below and
# audits the produced ELF requirement.
#
# Optional provenance metadata (recorded verbatim in VERSION.txt):
#   BASELINE_NAME   e.g. "Ubuntu 24.04.3 LTS (x86_64, glibc 2.39)"
#   BASELINE_KIND   e.g. "Ubuntu base rootfs under proot"
#   BASELINE_TOOLCHAIN  e.g. "gcc 13.3.0, binutils 2.42"
#
# To force a completely clean rebuild, remove $BUILD_DIR first:
#   rm -rf /tmp/opencode/ffmpeg-build
#
set -euo pipefail
export LC_ALL=C
export TZ=UTC

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/opencode/ffmpeg-build}"
SRC_DIR="$BUILD_DIR/src"
PREFIX="$BUILD_DIR/prefix"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/third_party/ffmpeg}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
BASELINE_NAME="${BASELINE_NAME:-}"
BASELINE_KIND="${BASELINE_KIND:-}"
BASELINE_TOOLCHAIN="${BASELINE_TOOLCHAIN:-}"

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# ---------------------------------------------------------------------------
# Pinned versions. These are the exact sources used for the checked-in
# binaries. Checksums are of the downloaded archives as served on 2026-10-28.
# ---------------------------------------------------------------------------
FFMPEG_VERSION="9.0.2"
LC3_VERSION="1.1.3"
SOXR_VERSION="0.1.3"
OGG_VERSION="1.3.5"
VORBIS_VERSION="1.3.7"
OPUS_VERSION="1.5.2"
LAME_VERSION="3.100"
TWOLAME_VERSION="0.4.0"

FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"

LC3_URL="https://github.com/google/liblc3/archive/refs/tags/v${LC3_VERSION}.tar.gz"
LC3_SHA="276752ff54ce6a77d54ec133397b9d7e71f90caf3d9afa32d8b0e891b8ecb8af"

SOXR_URL="https://github.com/chirlu/soxr/archive/refs/tags/${SOXR_VERSION}.tar.gz"
SOXR_SHA="db6ca1b1e8405c6ef92f8294fc123d910abf0a114003b3f0f13fa57a95fd62d0"

OGG_URL="https://downloads.xiph.org/releases/ogg/libogg-${OGG_VERSION}.tar.xz"
OGG_SHA="c4d91be36fc8e54deae7575241e03f4211eb102afb3fc0775fbbc1b740016705"

VORBIS_URL="https://downloads.xiph.org/releases/vorbis/libvorbis-${VORBIS_VERSION}.tar.xz"
VORBIS_SHA="b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b"

OPUS_URL="https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz"
OPUS_SHA="65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1"

LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
LAME_SHA="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"

TWOLAME_URL="https://downloads.sourceforge.net/twolame/twolame-${TWOLAME_VERSION}.tar.gz"
TWOLAME_SHA="cc35424f6019a88c6f52570b63e1baf50f62963a3eac52a03a800bb070d7c87d"

mkdir -p "$SRC_DIR" "$PREFIX"

log() { printf '\n==> %s\n' "$*"; }

download() {
    local url="$1" file="$2" sha="$3"
    if [ ! -f "$SRC_DIR/$file" ]; then
        log "Downloading $file"
        curl -fL --retry 3 --connect-timeout 30 -o "$SRC_DIR/$file.part" "$url"
        mv "$SRC_DIR/$file.part" "$SRC_DIR/$file"
    fi
    log "Verifying $file"
    ( cd "$SRC_DIR" && printf '%s  %s\n' "$sha" "$file" | sha256sum -c - )
}

extract() {
    local archive="$1" dir="$2"
    if [ ! -d "$SRC_DIR/$dir" ]; then
        log "Extracting $archive"
        tar -C "$SRC_DIR" -xf "$SRC_DIR/$archive"
    fi
}

# ---------------------------------------------------------------------------
# Build tools: system meson, ninja and cmake. Fail early with an actionable
# message instead of silently selecting unrelated binaries from PATH.
# ---------------------------------------------------------------------------
for tool in meson ninja cmake; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: required build tool '$tool' was not found" >&2
        exit 1
    }
done
MESON_VERSION="$(meson --version)"
NINJA_VERSION="$(ninja --version)"
CMAKE_VERSION="$(cmake --version | head -n1)"
log "Build tools: meson ${MESON_VERSION}, ninja ${NINJA_VERSION}, ${CMAKE_VERSION}"
CMAKE_POLICY_ARGS=()
# CMake 4 rejects projects declaring cmake_minimum_required below 3.5.
CMAKE_MAJOR="$(cmake --version | head -n1 | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if [ "${CMAKE_MAJOR:-0}" -ge 4 ]; then
    CMAKE_POLICY_ARGS=(-DCMAKE_POLICY_VERSION_MINIMUM=3.5)
fi

# ---------------------------------------------------------------------------
# Dependency 1: libogg (static)
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-libogg" ]; then
    download "$OGG_URL" "libogg-${OGG_VERSION}.tar.xz" "$OGG_SHA"
    extract "libogg-${OGG_VERSION}.tar.xz" "libogg-${OGG_VERSION}"
    log "Building libogg ${OGG_VERSION}"
    (
        cd "$SRC_DIR/libogg-${OGG_VERSION}"
        ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-docs
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libogg"
fi

# ---------------------------------------------------------------------------
# Dependency 2: libvorbis (static, needs libogg)
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-libvorbis" ]; then
    download "$VORBIS_URL" "libvorbis-${VORBIS_VERSION}.tar.xz" "$VORBIS_SHA"
    extract "libvorbis-${VORBIS_VERSION}.tar.xz" "libvorbis-${VORBIS_VERSION}"
    log "Building libvorbis ${VORBIS_VERSION}"
    (
        cd "$SRC_DIR/libvorbis-${VORBIS_VERSION}"
        ./configure --prefix="$PREFIX" --disable-shared --enable-static \
            --disable-docs --disable-examples --disable-oggtest --disable-vorbistest
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libvorbis"
fi

# ---------------------------------------------------------------------------
# Dependency 3: libopus (static)
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-libopus" ]; then
    download "$OPUS_URL" "opus-${OPUS_VERSION}.tar.gz" "$OPUS_SHA"
    extract "opus-${OPUS_VERSION}.tar.gz" "opus-${OPUS_VERSION}"
    log "Building libopus ${OPUS_VERSION}"
    (
        cd "$SRC_DIR/opus-${OPUS_VERSION}"
        ./configure --prefix="$PREFIX" --disable-shared --enable-static \
            --disable-doc --disable-extra-programs
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libopus"
fi

# ---------------------------------------------------------------------------
# Dependency 4: LAME / libmp3lame (static)
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-liblame" ]; then
    download "$LAME_URL" "lame-${LAME_VERSION}.tar.gz" "$LAME_SHA"
    extract "lame-${LAME_VERSION}.tar.gz" "lame-${LAME_VERSION}"
    log "Building LAME ${LAME_VERSION}"
    (
        cd "$SRC_DIR/lame-${LAME_VERSION}"
        ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-frontend
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-liblame"
fi

# ---------------------------------------------------------------------------
# Dependency 5: libtwolame (static, MP2 encoder)
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-libtwolame" ]; then
    download "$TWOLAME_URL" "twolame-${TWOLAME_VERSION}.tar.gz" "$TWOLAME_SHA"
    extract "twolame-${TWOLAME_VERSION}.tar.gz" "twolame-${TWOLAME_VERSION}"
    log "Building libtwolame ${TWOLAME_VERSION}"
    (
        cd "$SRC_DIR/twolame-${TWOLAME_VERSION}"
        ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-sndfile
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libtwolame"
fi

# ---------------------------------------------------------------------------
# Dependency 6: libsoxr (static). cmake 4 needs the policy shim because
# soxr 0.1.3 declares cmake_minimum_required(VERSION 2.8).
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-libsoxr" ]; then
    download "$SOXR_URL" "soxr-${SOXR_VERSION}.tar.gz" "$SOXR_SHA"
    extract "soxr-${SOXR_VERSION}.tar.gz" "soxr-${SOXR_VERSION}"
    log "Building libsoxr ${SOXR_VERSION}"
    rm -rf "$SRC_DIR/soxr-build"
    cmake -S "$SRC_DIR/soxr-${SOXR_VERSION}" -B "$SRC_DIR/soxr-build" \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTS=OFF \
        -DBUILD_EXAMPLES=OFF \
        -DWITH_OPENMP=OFF \
        "${CMAKE_POLICY_ARGS[@]}"
    cmake --build "$SRC_DIR/soxr-build" -j"$JOBS"
    cmake --install "$SRC_DIR/soxr-build"
    touch "$PREFIX/.stamp-libsoxr"
fi

# ---------------------------------------------------------------------------
# Dependency 7: liblc3 (static, REQUIRED for LC3)
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-liblc3" ]; then
    download "$LC3_URL" "liblc3-${LC3_VERSION}.tar.gz" "$LC3_SHA"
    extract "liblc3-${LC3_VERSION}.tar.gz" "liblc3-${LC3_VERSION}"
    log "Building liblc3 ${LC3_VERSION}"
    rm -rf "$SRC_DIR/lc3-build"
    meson setup "$SRC_DIR/lc3-build" "$SRC_DIR/liblc3-${LC3_VERSION}" \
        --prefix="$PREFIX" \
        --libdir=lib \
        --buildtype=release \
        --default-library=static \
        -Dtools=false \
        -Dpython=false
    ninja -C "$SRC_DIR/lc3-build" -j"$JOBS"
    meson install -C "$SRC_DIR/lc3-build"
    touch "$PREFIX/.stamp-liblc3"
fi

# ---------------------------------------------------------------------------
# FFmpeg
#
# Exact configure line (paths are $PREFIX=/tmp/opencode/ffmpeg-build/prefix;
# VERSION.txt is generated from FFMPEG_ARGS below):
#
# ./configure --prefix=/tmp/opencode/ffmpeg-build/prefix --pkg-config-flags=--static --extra-cflags=-I/tmp/opencode/ffmpeg-build/prefix/include --extra-ldflags=-L/tmp/opencode/ffmpeg-build/prefix/lib '--extra-libs=-lm -lpthread' --disable-doc --disable-debug --disable-x86asm --disable-shared --enable-static --disable-ffplay --disable-zlib --disable-bzlib --disable-lzma --enable-liblc3 --enable-libsoxr --enable-libopus --enable-libvorbis --enable-libmp3lame --enable-libtwolame
# ---------------------------------------------------------------------------
FFMPEG_ARGS=(
    --prefix="$PREFIX"
    --pkg-config-flags=--static
    --extra-cflags="-I$PREFIX/include"
    --extra-ldflags="-L$PREFIX/lib"
    --extra-libs="-lm -lpthread"
    --disable-doc
    --disable-debug
    --disable-x86asm
    --disable-shared
    --enable-static
    --disable-ffplay
    --disable-zlib
    --disable-bzlib
    --disable-lzma
    --enable-liblc3
    --enable-libsoxr
    --enable-libopus
    --enable-libvorbis
    --enable-libmp3lame
    --enable-libtwolame
)

if [ ! -f "$SRC_DIR/.stamp-ffmpeg-configured" ]; then
    download "$FFMPEG_URL" "ffmpeg-${FFMPEG_VERSION}.tar.xz" "$FFMPEG_SHA"
    extract "ffmpeg-${FFMPEG_VERSION}.tar.xz" "ffmpeg-${FFMPEG_VERSION}"
    log "Configuring FFmpeg ${FFMPEG_VERSION}"
    (
        cd "$SRC_DIR/ffmpeg-${FFMPEG_VERSION}"
        ./configure "${FFMPEG_ARGS[@]}"
    )
    touch "$SRC_DIR/.stamp-ffmpeg-configured"
fi

log "Building FFmpeg ${FFMPEG_VERSION}"
(
    cd "$SRC_DIR/ffmpeg-${FFMPEG_VERSION}"
    make -j"$JOBS"
    make install
)

# ---------------------------------------------------------------------------
# Verify the freshly built binaries before installing them into the repo.
# ---------------------------------------------------------------------------
log "Verifying encoders"
ENCODER_LIST="$("$PREFIX/bin/ffmpeg" -hide_banner -encoders 2>/dev/null || true)"
for enc in liblc3 libopus libvorbis libmp3lame libtwolame aptx aptx_hd sbc aac; do
    if ! grep -q " $enc " <<<"$ENCODER_LIST"; then
        echo "ERROR: encoder '$enc' is missing from the build" >&2
        exit 1
    fi
    echo "  ok: $enc"
done

log "Verifying license configuration"
LICENSE_TEXT="$("$PREFIX/bin/ffmpeg" -hide_banner -L 2>/dev/null || true)"
LICENSE_FLAT="$(tr '\n' ' ' <<<"$LICENSE_TEXT")"
LICENSE_PROBE="$(sed 's/Lesser General Public License/LGPL/g' <<<"$LICENSE_FLAT")"
if grep -qiE 'GNU General Public License|(^|[^A-Za-z])GPL([^A-Za-z]|$)' <<<"$LICENSE_PROBE"; then
    echo "ERROR: build unexpectedly reports GPL licensing; the release baseline is LGPL" >&2
    exit 1
fi
if ! grep -qiE 'LGPL|Lesser General Public License' <<<"$LICENSE_FLAT"; then
    echo "ERROR: build does not report the expected LGPL license" >&2
    exit 1
fi

log "Smoke-testing LC3 encode/decode"
TMP_TEST="$BUILD_DIR/smoke-test"
rm -rf "$TMP_TEST"
mkdir -p "$TMP_TEST"
"$PREFIX/bin/ffmpeg" -hide_banner -v error -y \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=0.2" \
    -af "aeval=val(0)|val(0):c=stereo" -c:a pcm_s16le "$TMP_TEST/in.wav"
"$PREFIX/bin/ffmpeg" -hide_banner -v error -y \
    -i "$TMP_TEST/in.wav" -c:a liblc3 -b:a 96k -f lc3 "$TMP_TEST/out.lc3"
"$PREFIX/bin/ffmpeg" -hide_banner -v error -y \
    -f lc3 -i "$TMP_TEST/out.lc3" -c:a pcm_s16le "$TMP_TEST/out.wav"
"$PREFIX/bin/ffprobe" -hide_banner -v error \
    -show_entries stream=sample_rate,channels -of default=nw=1 "$TMP_TEST/out.wav"

# ---------------------------------------------------------------------------
# Install only the two executables and VERSION.txt into the repository.
# ---------------------------------------------------------------------------
log "Installing into $OUT_DIR"
mkdir -p "$OUT_DIR/bin"
install -m 0755 "$PREFIX/bin/ffmpeg" "$OUT_DIR/bin/ffmpeg"
install -m 0755 "$PREFIX/bin/ffprobe" "$OUT_DIR/bin/ffprobe"
FFMPEG_BIN_SHA="$(sha256sum "$OUT_DIR/bin/ffmpeg" | awk '{print $1}')"
FFPROBE_BIN_SHA="$(sha256sum "$OUT_DIR/bin/ffprobe" | awk '{print $1}')"

CONFIGURE_DISPLAY="./configure"
for arg in "${FFMPEG_ARGS[@]}"; do
    case "$arg" in
        *" "*) CONFIGURE_DISPLAY+=" '$arg'" ;;
        *)     CONFIGURE_DISPLAY+=" $arg" ;;
    esac
done
BUILD_DATE="$(date -u +%Y-%m-%d)"
GCC_VERSION="$(gcc -dumpfullversion 2>/dev/null || gcc -dumpversion)"
HOST_ARCH="$(uname -m)"
BINUTILS_VERSION="$(ld --version 2>/dev/null | head -n1 || true)"
BASELINE_LINES=""
if [ -n "$BASELINE_NAME" ]; then
    BASELINE_LINES+="Build baseline: ${BASELINE_NAME}"$'\n'
    BASELINE_LINES+="Baseline method: ${BASELINE_KIND:-unspecified}"$'\n'
    BASELINE_LINES+="Baseline toolchain: ${BASELINE_TOOLCHAIN:-gcc ${GCC_VERSION}}"$'\n'
fi

cat > "$OUT_DIR/VERSION.txt" <<EOF
FFmpeg:       ${FFMPEG_VERSION} (stable release)
Source:       ${FFMPEG_URL}
SHA-256:      ${FFMPEG_SHA}
Build date:   ${BUILD_DATE} (UTC)
built by tools/build_ffmpeg.sh
Host:         ${HOST_ARCH}, gcc ${GCC_VERSION}
Build tools:  meson ${MESON_VERSION}, ninja ${NINJA_VERSION}, ${CMAKE_VERSION}
Job flags:    make -j (nproc), --disable-x86asm (no nasm/yasm on build host)
Binary type:  ELF PIE, statically linked codec libs, dynamically linked glibc
${BASELINE_LINES}Binary SHA-256 (ffmpeg):  ${FFMPEG_BIN_SHA}
Binary SHA-256 (ffprobe): ${FFPROBE_BIN_SHA}
Linker:       ${BINUTILS_VERSION}
Prefix used:  ${PREFIX}

Exact ./configure line (run from ffmpeg-${FFMPEG_VERSION}/):
${CONFIGURE_DISPLAY}

Static dependencies (all built from source into ${PREFIX}):
  liblc3      ${LC3_VERSION}   https://github.com/google/liblc3
  libsoxr     ${SOXR_VERSION}   https://github.com/chirlu/soxr
  libogg      ${OGG_VERSION}   https://downloads.xiph.org/releases/ogg/
  libvorbis   ${VORBIS_VERSION}   https://downloads.xiph.org/releases/vorbis/
  libopus     ${OPUS_VERSION}   https://downloads.xiph.org/releases/opus/
  libmp3lame  ${LAME_VERSION}   https://sourceforge.net/projects/lame/
  libtwolame  ${TWOLAME_VERSION}   https://sourceforge.net/projects/twolame/

Static dependency archive SHA-256:
  ffmpeg      ${FFMPEG_SHA}   ${FFMPEG_URL}
  liblc3      ${LC3_SHA}   ${LC3_URL}
  libsoxr     ${SOXR_SHA}   ${SOXR_URL}
  libogg      ${OGG_SHA}   ${OGG_URL}
  libvorbis   ${VORBIS_SHA}   ${VORBIS_URL}
  libopus     ${OPUS_SHA}   ${OPUS_URL}
  libmp3lame  ${LAME_SHA}   ${LAME_URL}
  libtwolame  ${TWOLAME_SHA}   ${TWOLAME_URL}

Enabled codecs include (native + external):
  liblc3, native aptx, aptx_hd, sbc, aac, plus libopus, libvorbis,
  libmp3lame, libtwolame.

LC3 raw format: muxer/demuxer name is "lc3" (Bluetooth LC3 test-suite
bitstream with an 18-byte header, or 20 bytes in high-resolution mode;
each packet is prefixed by a 16-bit little-endian length). Encoder sample
rates: 8000, 16000, 24000, 32000, 48000, 96000. Frame durations: 2.5, 5,
7.5, 10 ms.

Canonical commands (48 kHz stereo):
  ffmpeg -i input.wav -c:a liblc3 -b:a 96k -f lc3 output.lc3
  ffmpeg -f lc3 -i output.lc3 -c:a pcm_s16le output.wav
EOF

log "Done"
echo "  $OUT_DIR/bin/ffmpeg"
echo "  $OUT_DIR/bin/ffprobe"
echo "  $OUT_DIR/VERSION.txt"
