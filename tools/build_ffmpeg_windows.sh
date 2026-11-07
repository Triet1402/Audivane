#!/usr/bin/env bash
#
# Pinned, from-source Windows x64 FFmpeg build with LC3 (liblc3) support.
# Run inside an MSYS2 MINGW64 (or UCRT64/CLANG64) shell on Windows x64.
#
# Result (also reproducible from the pins below and recorded in VERSION.txt):
#   third_party/ffmpeg/bin/ffmpeg.exe
#   third_party/ffmpeg/bin/ffprobe.exe
#   third_party/ffmpeg/VERSION.txt
#
# The Linux equivalent is tools/build_ffmpeg.sh. Source pins are the same;
# target-specific flags differ. Sources and the static prefix stay under
# $BUILD_DIR (default: <repo>/build/ffmpeg-windows, which is gitignored).
#
# Prerequisites (MSYS2 MINGW64 shell, no administrator rights):
#   pacman -S --needed base-devel \
#     mingw-w64-x86_64-toolchain mingw-w64-x86_64-cmake \
#     mingw-w64-x86_64-meson mingw-w64-x86_64-ninja \
#     mingw-w64-x86_64-pkgconf git curl tar xz
# Node.js is required only for the post-build PE/DLL audit.
#
# This recipe has NOT been executed on a Windows host in this repository yet.
# The first Windows run must keep its own VERSION.txt/build log and pass
# tools/verification/windows-native-audit.mjs before the bundle is used.
#
# Cross-compiling from Linux is also supported for a concrete artifact and
# structural PE/DLL validation:
#   PATH=/path/to/mingw-w64/bin:$PATH tools/build_ffmpeg_windows.sh --cross
# Cross builds require x86_64-w64-mingw32-{gcc,ar,ranlib,strip,nm,windres}
# and the normal host build tools. The PE binaries are NOT executed on Linux;
# codec support is then only compile-configuration evidence and is labelled so
# in VERSION.txt. Use --cross-prefix to choose another prefix.
#
# Usage:
#   tools/build_ffmpeg_windows.sh
#   BUILD_DIR=/c/build/ffmpeg-win JOBS=16 tools/build_ffmpeg_windows.sh
#   tools/build_ffmpeg_windows.sh --cross
#
# To force a completely clean rebuild, remove $BUILD_DIR first.
#
set -euo pipefail
export LC_ALL=C
export TZ=UTC

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$REPO_ROOT/build/ffmpeg-windows}"
SRC_DIR="$BUILD_DIR/src"
PREFIX="$BUILD_DIR/prefix"
OUT_DIR="${OUT_DIR:-}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
CROSS=0
CROSS_PREFIX="${CROSS_PREFIX:-x86_64-w64-mingw32-}"
HOST_CC="${HOST_CC:-gcc}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
    case "$arg" in
        --clean) rm -rf "$BUILD_DIR" ;;
        --cross) CROSS=1 ;;
        --cross-prefix=*) CROSS_PREFIX="${arg#--cross-prefix=}"; CROSS=1 ;;
        --help|-h)
            awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
            exit 0
            ;;
        *) die "unknown argument: $arg" ;;
    esac
done

# ---------------------------------------------------------------------------
# Host/toolchain guard: produce a real 64-bit Windows executable, never an
# MSYS or 32-bit binary that would silently pass a loose build. Cross builds
# run on Linux with an extracted/distro mingw-w64 toolchain and never execute
# the resulting PE files on this host.
# ---------------------------------------------------------------------------
if [ "$CROSS" = 1 ]; then
    [[ "$(uname -s)" == "Linux" ]] || die "--cross is implemented for a Linux cross-build host"
    [[ "$(uname -m)" == "x86_64" ]] || die "Windows x64 cross build requires an x86_64 host"
    CC="${CC:-${CROSS_PREFIX}gcc}"
    AR="${AR:-${CROSS_PREFIX}ar}"
    RANLIB="${RANLIB:-${CROSS_PREFIX}ranlib}"
    STRIP="${STRIP:-${CROSS_PREFIX}strip}"
    NM="${NM:-${CROSS_PREFIX}nm}"
    WINDRES="${WINDRES:-${CROSS_PREFIX}windres}"
    DLLTOOL="${DLLTOOL:-${CROSS_PREFIX}dlltool}"
    for tool in "$CC" "$AR" "$RANLIB" "$STRIP" "$NM" "$WINDRES" "$DLLTOOL" "$HOST_CC"; do
        command -v "$tool" >/dev/null 2>&1 || die "cross toolchain command '$tool' was not found"
    done
    export CC AR RANLIB STRIP NM WINDRES DLLTOOL
    export lt_cv_deplibs_check_method=pass_all
    HOST_BUILD="$("$HOST_CC" -dumpmachine)"
    CONFIGURE_HOST_ARGS=(--host=x86_64-w64-mingw32 --build="$HOST_BUILD")
    FFMPEG_CROSS_ARGS=(
        --enable-cross-compile
        --cross-prefix="$CROSS_PREFIX"
        --target-os=mingw32
        --arch=x86_64
        --host-cc="$HOST_CC"
        --pkg-config=pkg-config
    )
    CROSS_TOOLCHAIN_FILE="$BUILD_DIR/mingw-w64-toolchain.cmake"
    MESON_CROSS_FILE="$BUILD_DIR/mingw-w64-cross.ini"
    CC_ABS="$(command -v "$CC")"
    AR_ABS="$(command -v "$AR")"
    RANLIB_ABS="$(command -v "$RANLIB")"
    STRIP_ABS="$(command -v "$STRIP")"
    WINDRES_ABS="$(command -v "$WINDRES")"
    LD_TOOL="${CROSS_PREFIX}ld"
    BUILD_KIND="Linux x86_64 cross build using ${CC}"
else
    CC="${CC:-gcc}"
    case "${MSYSTEM:-}" in
        MINGW64|UCRT64|CLANG64) ;;
        *) die "run this script inside an MSYS2 MINGW64, UCRT64 or CLANG64 shell (MSYSTEM=${MSYSTEM:-unset}), or use --cross on Linux" ;;
    esac
    HOST_BUILD=""
    CONFIGURE_HOST_ARGS=()
    FFMPEG_CROSS_ARGS=(--target-os=mingw32 --arch=x86_64)
    LD_TOOL="ld"
    BUILD_KIND="native Windows x64 MSYS2 ${MSYSTEM}"
fi
[[ "$(uname -m)" == "x86_64" ]] || die "Windows x64 build requires an x86_64 host"
command -v "$CC" >/dev/null 2>&1 || die "C compiler '$CC' was not found"
TARGET_TRIPLE="$("$CC" -dumpmachine 2>/dev/null || true)"
case "$TARGET_TRIPLE" in
    x86_64-w64-mingw32*) ;;
    *) die "compiler '$CC' targets '$TARGET_TRIPLE', expected x86_64-w64-mingw32" ;;
esac

for tool in make pkg-config curl tar sha256sum install node meson ninja cmake "$HOST_CC"; do
    command -v "$tool" >/dev/null 2>&1 || die "required build tool '$tool' was not found (see the header)"
done

if [ "$CROSS" = 1 ]; then
    CMAKE_CROSS_ARGS=(-DCMAKE_TOOLCHAIN_FILE="$CROSS_TOOLCHAIN_FILE")
    MESON_CROSS_ARGS=(--cross-file "$MESON_CROSS_FILE")
    # A Linux cross build must never overwrite the developer's tracked Linux
    # VERSION file. Explicit OUT_DIR remains authoritative.
    OUT_DIR="${OUT_DIR:-$BUILD_DIR/out/ffmpeg}"
else
    CMAKE_CROSS_ARGS=()
    MESON_CROSS_ARGS=()
    OUT_DIR="${OUT_DIR:-$REPO_ROOT/third_party/ffmpeg}"
fi

export PATH="$PREFIX/bin:$PATH"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# ---------------------------------------------------------------------------
# Pinned versions and archive hashes shared with tools/build_ffmpeg.sh.
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

if [ "$CROSS" = 1 ]; then
    cat > "$CROSS_TOOLCHAIN_FILE" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER "${CC_ABS}")
set(CMAKE_AR "${AR_ABS}")
set(CMAKE_RANLIB "${RANLIB_ABS}")
set(CMAKE_STRIP "${STRIP_ABS}")
set(CMAKE_RC_COMPILER "${WINDRES_ABS}")
set(CMAKE_FIND_ROOT_PATH "${PREFIX}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
EOF
    cat > "$MESON_CROSS_FILE" <<EOF
[binaries]
c = '${CC_ABS}'
ar = '${AR_ABS}'
strip = '${STRIP_ABS}'
windres = '${WINDRES_ABS}'

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'

[properties]
needs_exe_wrapper = true
EOF
fi

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
# Static dependencies. All are built from the pinned archives into $PREFIX.
# ---------------------------------------------------------------------------
if [ ! -f "$PREFIX/.stamp-libogg" ]; then
    download "$OGG_URL" "libogg-${OGG_VERSION}.tar.xz" "$OGG_SHA"
    extract "libogg-${OGG_VERSION}.tar.xz" "libogg-${OGG_VERSION}"
    log "Building libogg ${OGG_VERSION}"
    (
        cd "$SRC_DIR/libogg-${OGG_VERSION}"
        ./configure "${CONFIGURE_HOST_ARGS[@]}" --prefix="$PREFIX" --disable-shared --enable-static --disable-docs
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libogg"
fi

if [ ! -f "$PREFIX/.stamp-libvorbis" ]; then
    download "$VORBIS_URL" "libvorbis-${VORBIS_VERSION}.tar.xz" "$VORBIS_SHA"
    extract "libvorbis-${VORBIS_VERSION}.tar.xz" "libvorbis-${VORBIS_VERSION}"
    log "Building libvorbis ${VORBIS_VERSION}"
    (
        cd "$SRC_DIR/libvorbis-${VORBIS_VERSION}"
        ./configure "${CONFIGURE_HOST_ARGS[@]}" --prefix="$PREFIX" --disable-shared --enable-static \
            --disable-docs --disable-examples --disable-oggtest --disable-vorbistest
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libvorbis"
fi

if [ ! -f "$PREFIX/.stamp-libopus" ]; then
    download "$OPUS_URL" "opus-${OPUS_VERSION}.tar.gz" "$OPUS_SHA"
    extract "opus-${OPUS_VERSION}.tar.gz" "opus-${OPUS_VERSION}"
    log "Building libopus ${OPUS_VERSION}"
    (
        cd "$SRC_DIR/opus-${OPUS_VERSION}"
        ./configure "${CONFIGURE_HOST_ARGS[@]}" --prefix="$PREFIX" --disable-shared --enable-static \
            --disable-doc --disable-extra-programs
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libopus"
fi

if [ ! -f "$PREFIX/.stamp-liblame" ]; then
    download "$LAME_URL" "lame-${LAME_VERSION}.tar.gz" "$LAME_SHA"
    extract "lame-${LAME_VERSION}.tar.gz" "lame-${LAME_VERSION}"
    log "Building LAME ${LAME_VERSION}"
    (
        cd "$SRC_DIR/lame-${LAME_VERSION}"
        ./configure "${CONFIGURE_HOST_ARGS[@]}" --prefix="$PREFIX" --disable-shared --enable-static --disable-frontend
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-liblame"
fi

if [ ! -f "$PREFIX/.stamp-libtwolame" ]; then
    download "$TWOLAME_URL" "twolame-${TWOLAME_VERSION}.tar.gz" "$TWOLAME_SHA"
    extract "twolame-${TWOLAME_VERSION}.tar.gz" "twolame-${TWOLAME_VERSION}"
    log "Building libtwolame ${TWOLAME_VERSION}"
    (
        cd "$SRC_DIR/twolame-${TWOLAME_VERSION}"
        ./configure "${CONFIGURE_HOST_ARGS[@]}" --prefix="$PREFIX" --disable-shared --enable-static --disable-sndfile
        make -j"$JOBS"
        make install
    )
    touch "$PREFIX/.stamp-libtwolame"
fi

if [ ! -f "$PREFIX/.stamp-libsoxr" ]; then
    download "$SOXR_URL" "soxr-${SOXR_VERSION}.tar.gz" "$SOXR_SHA"
    extract "soxr-${SOXR_VERSION}.tar.gz" "soxr-${SOXR_VERSION}"
    log "Building libsoxr ${SOXR_VERSION}"
    rm -rf "$SRC_DIR/soxr-build"
    cmake -S "$SRC_DIR/soxr-${SOXR_VERSION}" -B "$SRC_DIR/soxr-build" \
        "${CMAKE_CROSS_ARGS[@]}" \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTS=OFF \
        -DBUILD_EXAMPLES=OFF \
        -DWITH_OPENMP=OFF \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    cmake --build "$SRC_DIR/soxr-build" --parallel "$JOBS"
    cmake --install "$SRC_DIR/soxr-build"
    touch "$PREFIX/.stamp-libsoxr"
fi

if [ ! -f "$PREFIX/.stamp-liblc3" ]; then
    download "$LC3_URL" "liblc3-${LC3_VERSION}.tar.gz" "$LC3_SHA"
    extract "liblc3-${LC3_VERSION}.tar.gz" "liblc3-${LC3_VERSION}"
    log "Building liblc3 ${LC3_VERSION}"
    # liblc3 defaults b_lto=true. Some cross binutils/ar combinations do not
    # index LTO objects for the linker; a static non-LTO archive is portable
    # and still comes from the same pinned source.
    rm -rf "$SRC_DIR/lc3-build"
    meson setup "$SRC_DIR/lc3-build" "$SRC_DIR/liblc3-${LC3_VERSION}" \
        "${MESON_CROSS_ARGS[@]}" \
        --prefix="$PREFIX" \
        --libdir=lib \
        --buildtype=release \
        --default-library=static \
        -Db_lto=false \
        -Dtools=false \
        -Dpython=false
    ninja -C "$SRC_DIR/lc3-build" -j"$JOBS"
    meson install -C "$SRC_DIR/lc3-build"
    touch "$PREFIX/.stamp-liblc3"
fi

# ---------------------------------------------------------------------------
# FFmpeg. --disable-autodetect keeps host libraries out of the dependency set;
# -static links the MinGW runtime so no libgcc/libwinpthread DLL is required.
# ---------------------------------------------------------------------------
FFMPEG_ARGS=(
    --prefix="$PREFIX"
    --pkg-config-flags=--static
    --extra-cflags="-I$PREFIX/include -DLIBTWOLAME_STATIC"
    --extra-ldflags="-static -L$PREFIX/lib"
    --extra-libs="-lm -lpthread"
    "${FFMPEG_CROSS_ARGS[@]}"
    --disable-autodetect
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

if [ ! -f "$SRC_DIR/.stamp-ffmpeg-configured-windows" ]; then
    download "$FFMPEG_URL" "ffmpeg-${FFMPEG_VERSION}.tar.xz" "$FFMPEG_SHA"
    extract "ffmpeg-${FFMPEG_VERSION}.tar.xz" "ffmpeg-${FFMPEG_VERSION}"
    log "Configuring FFmpeg ${FFMPEG_VERSION} for Windows x64"
    (
        cd "$SRC_DIR/ffmpeg-${FFMPEG_VERSION}"
        ./configure "${FFMPEG_ARGS[@]}"
    )
    touch "$SRC_DIR/.stamp-ffmpeg-configured-windows"
fi

log "Building FFmpeg ${FFMPEG_VERSION}"
(
    cd "$SRC_DIR/ffmpeg-${FFMPEG_VERSION}"
    make -j"$JOBS"
    make install
)

# A shared build would move codec DLLs beside the executables and require a
# different release payload. Fail instead of shipping an accidental hybrid.
shopt -s nullglob
extra_dlls=("$PREFIX/bin/"*.dll)
shopt -u nullglob
if [ "${#extra_dlls[@]}" -ne 0 ]; then
    die "unexpected shared DLLs in the FFmpeg prefix: ${extra_dlls[*]}"
fi

if [ "$CROSS" = 1 ]; then
    log "Cross build: skipping runtime encoder/license probes and LC3 round trip"
    log "Verifying compile-time codec configuration"
    CONFIG_H="$SRC_DIR/ffmpeg-${FFMPEG_VERSION}/config.h"
    COMPONENTS_H="$SRC_DIR/ffmpeg-${FFMPEG_VERSION}/config_components.h"
    [ -f "$CONFIG_H" ] || die "FFmpeg config.h is missing after configure"
    [ -f "$COMPONENTS_H" ] || die "FFmpeg config_components.h is missing after configure"
    for macro in \
        CONFIG_LIBLC3_ENCODER CONFIG_LIBLC3_DECODER CONFIG_LC3_MUXER CONFIG_LC3_DEMUXER \
        CONFIG_LIBOPUS_ENCODER CONFIG_OPUS_DECODER CONFIG_OPUS_MUXER CONFIG_OGG_DEMUXER \
        CONFIG_LIBVORBIS_ENCODER CONFIG_VORBIS_DECODER CONFIG_OGG_MUXER \
        CONFIG_LIBMP3LAME_ENCODER CONFIG_MP3_DECODER CONFIG_MP3_MUXER \
        CONFIG_LIBTWOLAME_ENCODER CONFIG_MP2_MUXER \
        CONFIG_APTX_ENCODER CONFIG_APTX_DECODER CONFIG_APTX_HD_ENCODER CONFIG_APTX_HD_DECODER \
        CONFIG_SBC_ENCODER CONFIG_SBC_DECODER CONFIG_AAC_ENCODER CONFIG_AAC_DECODER \
        CONFIG_FLAC_DEMUXER CONFIG_FLAC_MUXER CONFIG_MOV_DEMUXER CONFIG_WAV_DEMUXER CONFIG_WAV_MUXER; do
        grep -q "^#define ${macro} 1$" "$COMPONENTS_H" || die "FFmpeg build configuration lacks $macro"
        echo "  ok (compile config): $macro"
    done
    grep -q '^#define CONFIG_GPL 0$' "$CONFIG_H" || die "FFmpeg build enables GPL components"
    grep -q '^#define CONFIG_NONFREE 0$' "$CONFIG_H" || die "FFmpeg build enables nonfree components"
    grep -q '^#define CONFIG_VERSION3 0$' "$CONFIG_H" || die "FFmpeg build enables version3 licensing"
    echo "  ok (compile config): GPL=0 nonfree=0 version3=0"
    echo "  NOTE: codec availability is compile-configuration evidence only;"
    echo "        these PE binaries were not executed on this cross-build host."
else
    log "Verifying encoders"
    ENCODER_LIST="$("$PREFIX/bin/ffmpeg.exe" -hide_banner -encoders 2>/dev/null || true)"
    for enc in liblc3 libopus libvorbis libmp3lame libtwolame aptx aptx_hd sbc aac; do
        if ! grep -q " $enc " <<<"$ENCODER_LIST"; then
            die "encoder '$enc' is missing from the build"
        fi
        echo "  ok: $enc"
    done

    log "Verifying license configuration"
    LICENSE_TEXT="$("$PREFIX/bin/ffmpeg.exe" -hide_banner -L 2>/dev/null || true)"
    LICENSE_PROBE="$(sed 's/Lesser General Public License/LGPL/g' <<<"$LICENSE_TEXT")"
    if grep -qiE 'GNU General Public License|(^|[^A-Za-z])GPL([^A-Za-z]|$)' <<<"$LICENSE_PROBE"; then
        die "build unexpectedly reports GPL licensing; the release baseline is LGPL"
    fi
    if ! grep -qiE 'LGPL|Lesser General Public License' <<<"$LICENSE_TEXT"; then
        die "build does not report the expected LGPL license"
    fi

    log "Smoke-testing LC3 encode/decode"
    TMP_TEST="$BUILD_DIR/smoke-test"
    rm -rf "$TMP_TEST"
    mkdir -p "$TMP_TEST"
    "$PREFIX/bin/ffmpeg.exe" -hide_banner -v error -y \
        -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=0.2" \
        -af "aeval=val(0)|val(0):c=stereo" -c:a pcm_s16le "$TMP_TEST/in.wav"
    "$PREFIX/bin/ffmpeg.exe" -hide_banner -v error -y \
        -i "$TMP_TEST/in.wav" -c:a liblc3 -b:a 96k -f lc3 "$TMP_TEST/out.lc3"
    "$PREFIX/bin/ffmpeg.exe" -hide_banner -v error -y \
        -f lc3 -i "$TMP_TEST/out.lc3" -c:a pcm_s16le "$TMP_TEST/out.wav"
    "$PREFIX/bin/ffprobe.exe" -hide_banner -v error \
        -show_entries stream=sample_rate,channels -of default=nw=1 "$TMP_TEST/out.wav"
fi

CONFIGURE_DISPLAY="./configure"
for arg in "${FFMPEG_ARGS[@]}"; do
    case "$arg" in
        *" "*) CONFIGURE_DISPLAY+=" '$arg'" ;;
        *)     CONFIGURE_DISPLAY+=" $arg" ;;
    esac
done
# Keep host-specific build prefixes out of the bundled provenance text.
CONFIGURE_DISPLAY="${CONFIGURE_DISPLAY//$PREFIX/<static-prefix>}"
BUILD_DATE="$(date -u +%Y-%m-%d)"
GCC_VERSION="$("$CC" --version 2>/dev/null | head -n1)"
MESON_VERSION="$(meson --version 2>/dev/null || echo unknown)"
NINJA_VERSION="$(ninja --version 2>/dev/null || echo unknown)"
CMAKE_VERSION="$(cmake --version 2>/dev/null | head -n1 || echo unknown)"
LINKER_VERSION="$("$LD_TOOL" --version 2>/dev/null | head -n1 || echo unknown)"
FFMPEG_BIN_SHA="$(sha256sum "$PREFIX/bin/ffmpeg.exe" | awk '{print $1}')"
FFPROBE_BIN_SHA="$(sha256sum "$PREFIX/bin/ffprobe.exe" | awk '{print $1}')"
if [ "$CROSS" = 1 ]; then
    EXECUTION_EVIDENCE="none (cross-compiled PE was not executed on this build host; codec evidence is compile configuration only)"
else
    EXECUTION_EVIDENCE="runtime encoder/license probe and LC3 encode/decode round trip on this Windows host"
fi

cat > "$BUILD_DIR/VERSION.txt" <<EOF
FFmpeg:       ${FFMPEG_VERSION} (stable release)
Target:       Windows x64 (PE32+), ${BUILD_KIND}
Source:       ${FFMPEG_URL}
SHA-256:      ${FFMPEG_SHA}
Build date:   ${BUILD_DATE} (UTC)
built by tools/build_ffmpeg_windows.sh
Compiler:     ${GCC_VERSION}
Build tools:  meson ${MESON_VERSION}, ninja ${NINJA_VERSION}, ${CMAKE_VERSION}
Binary type:  PE32+ executable, statically linked codec libs and MinGW runtime
Linker:       ${LINKER_VERSION}
Binary SHA-256 (ffmpeg):  ${FFMPEG_BIN_SHA}
Binary SHA-256 (ffprobe): ${FFPROBE_BIN_SHA}
Execution evidence: ${EXECUTION_EVIDENCE}
DLL policy:   imports must be Windows system DLLs or DLLs supplied beside the exe;
              tools/verification/windows-native-audit.mjs enforces this

Exact ./configure line (run from ffmpeg-${FFMPEG_VERSION}/):
${CONFIGURE_DISPLAY}

Static dependencies (all built from source into <static-prefix>):
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
EOF

# Audit a clean mini-bundle before installing anything into the repository.
AUDIT_DIR="$BUILD_DIR/audit-bundle"
rm -rf "$AUDIT_DIR"
mkdir -p "$AUDIT_DIR/third_party/ffmpeg/bin"
cp "$PREFIX/bin/ffmpeg.exe" "$PREFIX/bin/ffprobe.exe" "$AUDIT_DIR/third_party/ffmpeg/bin/"
cp "$BUILD_DIR/VERSION.txt" "$AUDIT_DIR/third_party/ffmpeg/VERSION.txt"
log "Auditing PE headers, provenance and DLL imports"
node "$REPO_ROOT/tools/verification/windows-native-audit.mjs" --bundle "$AUDIT_DIR"

log "Installing into $OUT_DIR"
mkdir -p "$OUT_DIR/bin"
install -m 0755 "$PREFIX/bin/ffmpeg.exe" "$OUT_DIR/bin/ffmpeg.exe"
install -m 0755 "$PREFIX/bin/ffprobe.exe" "$OUT_DIR/bin/ffprobe.exe"
install -m 0644 "$BUILD_DIR/VERSION.txt" "$OUT_DIR/VERSION.txt"

log "Done"
echo "  $OUT_DIR/bin/ffmpeg.exe"
echo "  $OUT_DIR/bin/ffprobe.exe"
echo "  $OUT_DIR/VERSION.txt"
