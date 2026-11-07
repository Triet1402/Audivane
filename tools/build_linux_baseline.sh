#!/usr/bin/env bash
#
# Build the supported Linux x64 native codec baseline for Audivane.
#
# Supported release baseline: Ubuntu 24.04 LTS x64 (glibc 2.39).
#
# This script builds FFmpeg/ffprobe (with liblc3) and ldac_helper from the
# pinned sources *inside* an Ubuntu 24.04.3 base rootfs. The rootfs is executed
# with proot, so no root privilege, host package installation, AppArmor change
# or other global host policy change is required. The host must be Linux x64
# with glibc >= 2.38 (for the Ubuntu proot package).
#
# Output (default build/linux-baseline):
#   artifacts/third_party/ffmpeg/bin/{ffmpeg,ffprobe}
#   artifacts/third_party/ffmpeg/VERSION.txt
#   artifacts/third_party/ldac/bin/ldac_helper
#   artifacts/third_party/ldac/VERSION.txt
#   provenance.json             (audivane-native-provenance-v1)
#   BASELINE.txt                (rootfs/proot hashes, commands, package versions)
#   package-versions.txt        (dpkg versions inside the baseline rootfs)
#   readiness.json              (npm run check:native, when available)
#
# Usage:
#   tools/build_linux_baseline.sh
#   tools/build_linux_baseline.sh --output /tmp/audivane-baseline
#   tools/build_linux_baseline.sh --rebuild --jobs 16
#   tools/build_linux_baseline.sh --reset-rootfs
#
# Environment overrides:
#   AUDIVANE_BASELINE_CACHE  rootfs/proot cache (default /tmp/opencode/audivane-linux-baseline)
#   PROOT_BIN                use an existing proot executable
#   JOBS                     parallel build jobs (default nproc)
#   BASE_VERSION             Ubuntu base release (default 24.04.3)
#
# The artifact is never copied over third_party/ automatically. Point the
# packager at it explicitly:
#   npm run check:native -- --native-bundle "$PWD/build/linux-baseline/artifacts"
#   npm run package:desktop -- --native-bundle "$PWD/build/linux-baseline/artifacts"
#
set -euo pipefail
export LC_ALL=C
export TZ=UTC

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${AUDIVANE_BASELINE_CACHE:-/tmp/opencode/audivane-linux-baseline}"
BASE_VERSION="${BASE_VERSION:-24.04.3}"
BASE_ARCH="amd64"
BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-${BASE_VERSION}-base-${BASE_ARCH}.tar.gz"
BASE_SHA="6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9"
BASELINE_NAME="Ubuntu ${BASE_VERSION} LTS (x86_64, glibc 2.39)"
BASELINE_GLIBC="2.39"
PROOT_VERSION="5.4.0-3"
PROOT_URL="https://archive.ubuntu.com/ubuntu/pool/universe/p/proot/proot_${PROOT_VERSION}_amd64.deb"
PROOT_SHA="8520a33632dc721ec9404eb8bb0079834dcced02f6e861510238bf636cc629e7"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
OUTPUT="$ROOT/build/linux-baseline"
REBUILD=0
RESET_ROOTFS=0
SKIP_READINESS=0
SKIP_AUDIT=0

while [ $# -gt 0 ]; do
    case "$1" in
        --output) OUTPUT="${2:?--output needs a directory}"; shift 2 ;;
        --output=*) OUTPUT="${1#*=}"; shift ;;
        --jobs) JOBS="${2:?--jobs needs a number}"; shift 2 ;;
        --jobs=*) JOBS="${1#*=}"; shift ;;
        --rebuild) REBUILD=1; shift ;;
        --reset-rootfs) RESET_ROOTFS=1; shift ;;
        --skip-readiness) SKIP_READINESS=1; shift ;;
        --skip-audit) SKIP_AUDIT=1; shift ;;
        -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
        *) echo "error: unknown argument: $1" >&2; exit 2 ;;
    esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this baseline builder requires Linux"
[ "$(uname -m)" = "x86_64" ] || die "this baseline builder supports x86_64 only"
command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
command -v dpkg-deb >/dev/null || die "dpkg-deb is required to unpack proot"
command -v sha256sum >/dev/null || die "sha256sum is required"
command -v node >/dev/null || die "node is required for the provenance audit"

mkdir -p "$CACHE_DIR" "$OUTPUT"
# One baseline build per cache/rootfs: two concurrent proot builds would share
# the same rootfs build tree and corrupt each other's object files.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$CACHE_DIR/.baseline-build.lock"
    flock -n 9 || die "another Linux baseline build is using $CACHE_DIR"
fi
ROOTFS="$CACHE_DIR/rootfs-${BASE_VERSION}"
BASE_TARBALL="$CACHE_DIR/ubuntu-base-${BASE_VERSION}-base-${BASE_ARCH}.tar.gz"
PROOT_DIR="$CACHE_DIR/proot-${PROOT_VERSION}"
PROOT="$PROOT_DIR/usr/bin/proot"
OUT_ARTIFACTS="$OUTPUT/artifacts"
BUILD_PARENT="$(dirname "$OUT_ARTIFACTS")"
mkdir -p "$OUT_ARTIFACTS" "$BUILD_PARENT"

# ---------------------------------------------------------------------------
# Pinned Ubuntu base rootfs.
# ---------------------------------------------------------------------------
if [ ! -f "$BASE_TARBALL" ]; then
    log "Downloading Ubuntu $BASE_VERSION base rootfs"
    curl -fL --retry 3 --connect-timeout 30 -o "$BASE_TARBALL.part" "$BASE_URL"
    mv "$BASE_TARBALL.part" "$BASE_TARBALL"
fi
log "Verifying Ubuntu base rootfs"
printf '%s  %s\n' "$BASE_SHA" "$BASE_TARBALL" | sha256sum -c -

if [ "$RESET_ROOTFS" = 1 ] || [ ! -f "$ROOTFS/etc/os-release" ]; then
    log "Extracting Ubuntu $BASE_VERSION rootfs"
    rm -rf "$ROOTFS"
    mkdir -p "$ROOTFS"
    tar -xzf "$BASE_TARBALL" -C "$ROOTFS"
fi
BASE_RELEASE="$(sed -n 's/^VERSION_ID="\(.*\)"/\1/p' "$ROOTFS/etc/os-release")"
[ "$BASE_RELEASE" = "24.04" ] || die "rootfs is Ubuntu ${BASE_RELEASE}, expected 24.04"
BASE_PRETTY="$(sed -n 's/^PRETTY_NAME="\(.*\)"/\1/p' "$ROOTFS/etc/os-release")"

# ---------------------------------------------------------------------------
# proot from the Ubuntu archive. It runs on the host and chroots into the
# baseline rootfs; the baseline's own glibc/package manager do the build.
# ---------------------------------------------------------------------------
if [ -n "${PROOT_BIN:-}" ]; then
    PROOT="$PROOT_BIN"
elif [ -x "$PROOT" ]; then
    :
elif command -v proot >/dev/null 2>&1; then
    PROOT="$(command -v proot)"
else
    log "Fetching proot $PROOT_VERSION from the Ubuntu archive"
    mkdir -p "$PROOT_DIR"
    curl -fL --retry 3 --connect-timeout 30 -o "$PROOT_DIR/proot.deb.part" "$PROOT_URL"
    mv "$PROOT_DIR/proot.deb.part" "$PROOT_DIR/proot.deb"
    printf '%s  %s\n' "$PROOT_SHA" "$PROOT_DIR/proot.deb" | sha256sum -c -
    dpkg-deb -x "$PROOT_DIR/proot.deb" "$PROOT_DIR"
fi
[ -x "$PROOT" ] || die "proot executable not found: $PROOT"
if ! ldd "$PROOT" >/dev/null 2>&1; then
    die "proot cannot resolve its host libraries; install libtalloc2 or set PROOT_BIN"
fi

PROOT_ENV=(PROOT_NO_SECCOMP=1)

run_in_baseline() {
    env "${PROOT_ENV[@]}" "$PROOT" -0 -r "$ROOTFS" \
        -b /proc -b /dev -b /sys -b /tmp -b /etc/resolv.conf \
        -b "$ROOT" -b "$BUILD_PARENT" -w "$ROOT" \
        "$@"
}

# ---------------------------------------------------------------------------
# Baseline userspace: pinned distro, floating patch-level packages. The exact
# dpkg versions are recorded so an artifact can be traced to its build inputs.
# ---------------------------------------------------------------------------
STAMP="$ROOTFS/.audivane-baseline-${BASE_VERSION}"
if [ ! -f "$STAMP" ]; then
    log "Preparing Ubuntu $BASE_VERSION build userspace (apt)"
    run_in_baseline /bin/bash -c '
        set -euo pipefail
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends \
            build-essential pkg-config meson ninja-build cmake \
            curl ca-certificates xz-utils git patch file
        dpkg-query -W -f="\${binary:Package}=\${Version}\n" > /root/package-versions.txt
        touch /root/.audivane-ready
    '
    touch "$STAMP"
fi
[ -f "$ROOTFS/root/.audivane-ready" ] || die "baseline userspace setup did not complete"

TOOLCHAIN="$(run_in_baseline /bin/bash -c 'printf "%s; %s" "$(gcc --version | head -n1)" "$(ld --version | head -n1)"')"
log "Baseline: $BASE_PRETTY / $TOOLCHAIN"

# ---------------------------------------------------------------------------
# Build both artifacts inside the baseline. Build trees remain inside the
# rootfs, so their absolute paths are stable and do not leak a developer home.
# ---------------------------------------------------------------------------
FFMPEG_BUILD="/var/tmp/audivane-ffmpeg"
LDAC_BUILD="/var/tmp/audivane-ldac"
if [ "$REBUILD" = 1 ]; then
    log "Removing baseline build trees"
    rm -rf "$ROOTFS/var/tmp/audivane-ffmpeg" "$ROOTFS/var/tmp/audivane-ldac"
fi

log "Building FFmpeg in the Ubuntu $BASE_VERSION baseline"
run_in_baseline /usr/bin/env \
    "BASELINE_NAME=$BASELINE_NAME" \
    "BASELINE_KIND=Ubuntu ${BASE_VERSION} base rootfs under proot; host packages untouched" \
    "BASELINE_TOOLCHAIN=$TOOLCHAIN" \
    "BUILD_DIR=$FFMPEG_BUILD" \
    "OUT_DIR=$OUT_ARTIFACTS/third_party/ffmpeg" \
    "JOBS=$JOBS" \
    /bin/bash "$ROOT/tools/build_ffmpeg.sh"

log "Building ldac_helper in the Ubuntu $BASE_VERSION baseline"
run_in_baseline /usr/bin/env \
    "BASELINE_NAME=$BASELINE_NAME" \
    "BASELINE_KIND=Ubuntu ${BASE_VERSION} base rootfs under proot; host packages untouched" \
    "BASELINE_TOOLCHAIN=$TOOLCHAIN" \
    "LDAC_BUILD_DIR=$LDAC_BUILD" \
    "OUT_DIR=$OUT_ARTIFACTS/third_party/ldac" \
    "JOBS=$JOBS" \
    /bin/bash "$ROOT/tools/build_ldac_helper.sh"

cp "$ROOTFS/root/package-versions.txt" "$OUTPUT/package-versions.txt"

# ---------------------------------------------------------------------------
# Independent audit of the produced bytes.
# ---------------------------------------------------------------------------
if [ "$SKIP_AUDIT" != 1 ]; then
    log "Auditing native provenance (glibc <= $BASELINE_GLIBC)"
    node "$ROOT/tools/audit-native-provenance.mjs" \
        --bundle "$OUT_ARTIFACTS" \
        --baseline-glibc "$BASELINE_GLIBC" \
        --json "$OUTPUT/provenance.json" > /dev/null
fi

if [ "$SKIP_READINESS" != 1 ] && [ -d "$ROOT/node_modules/tsx" ]; then
    log "Probing codec readiness through the shared TypeScript contract"
    ( cd "$ROOT" && node --import tsx "$ROOT/packages/engine-native/src/typescript/readiness-cli.ts" \
        --native-bundle "$OUT_ARTIFACTS" --json > "$OUTPUT/readiness.json" )
fi

# ---------------------------------------------------------------------------
# Human- and machine-readable provenance for the build itself.
# ---------------------------------------------------------------------------
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT_DISPLAY="$OUTPUT"
case "$OUTPUT" in
    "$ROOT"/*) OUTPUT_DISPLAY="${OUTPUT#"$ROOT"/}" ;;
esac
{
    cat <<EOF
Audivane Linux x64 native build baseline
========================================
Selected baseline:  $BASELINE_NAME
Rootfs:             $BASE_URL
Rootfs SHA-256:     $BASE_SHA
Rootfs release:     $BASE_PRETTY
proot:              $PROOT_URL
proot SHA-256:      $PROOT_SHA
Build method:       Ubuntu base rootfs executed with proot; no host root,
                    package installation, AppArmor or other policy change
Build date:         $BUILD_DATE
Baseline toolchain: $TOOLCHAIN
Build jobs:         $JOBS

Artifacts (see provenance.json for hashes, ELF/glibc checks and codec tables):
  artifacts/third_party/ffmpeg/bin/ffmpeg
  artifacts/third_party/ffmpeg/bin/ffprobe
  artifacts/third_party/ffmpeg/VERSION.txt
  artifacts/third_party/ldac/bin/ldac_helper
  artifacts/third_party/ldac/VERSION.txt

Build commands:
  tools/build_linux_baseline.sh --output $OUTPUT_DISPLAY
  (internally runs tools/build_ffmpeg.sh and tools/build_ldac_helper.sh
   inside $BASE_PRETTY)
EOF
} > "$OUTPUT/BASELINE.txt"

log "Done"
echo "  artifacts:  $OUT_ARTIFACTS"
echo "  provenance: $OUTPUT/provenance.json"
echo "  baseline:   $OUTPUT/BASELINE.txt"
