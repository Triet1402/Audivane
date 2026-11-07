/*
 * ldac_helper -- minimal LDAC encode/decode helper for Codec_ABX_test.
 *
 * The application shells out to this program because FFmpeg has no LDAC
 * support.  The encoder is AOSP libldac (ldacBT).  AOSP ships only the
 * encoder, so the decoder is the MIT-licensed reverse-engineered
 * ldacdec library (hegdi/libldacdec, based on the ATRAC9 decoder).
 * Both are compiled as static libraries and linked into this binary.
 *
 * CLI
 *   ldac_helper encode --rate 48000 --channels 2 --bitrate 660 \
 *                      --in input.pcm --out output.ldac
 *   ldac_helper decode --rate 48000 --channels 2 --bitrate 660 \
 *                      --in input.ldac --out output.pcm
 *   ldac_helper --version
 *
 * PCM is raw signed 16-bit little-endian interleaved, at the given
 * rate/channels.  Supported values are documented in usage().
 *
 * .ldac container, version 1 (all integers little-endian)
 *
 *   offset  size  field
 *   0       4     magic "LDAC"
 *   4       2     container version (1)
 *   6       2     header size in bytes (48)
 *   8       4     sample rate in Hz (44100 or 48000)
 *   12      4     channels (1 or 2)
 *   16      4     requested bitrate in kbps (330, 660 or 990)
 *   20      4     frame count (number of frame records below)
 *   24      8     true sample count, in sample frames per channel
 *   32      4     actual bitrate reported by libldac (kbps; 303/606/909
 *                 at 44.1 kHz and 165/330/495 for mono at 48 kHz)
 *   36      4     flags (bit 0 set: payload CRC-32 present)
 *   40      4     CRC-32 (IEEE) of all bytes after this header
 *   44      4     reserved (0)
 *   48      ...   frame records
 *
 *   frame record: uint16 length, then `length` bytes of one LDAC
 *   transport frame.  A transport frame is the standard 3-byte LDAC
 *   frame header (0xAA sync, sample-rate index, channel config, 9-bit
 *   payload length, 2-bit status) followed by that payload.  Frames are
 *   stored individually so decoding needs no side channel.
 *
 * The encoder pads the final partial 128-sample frame with silence.
 * `sample count` is the unpadded input length, so decode trims back to
 * exactly the original number of samples.
 *
 * LDAC's MDCT overlap means the decoder emits one 128-sample frame of
 * warm-up before the first real output.  Decode discards that leading
 * frame (128 sample frames per channel) and then trims to sample count.
 */

#define _FILE_OFFSET_BITS 64

#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <wchar.h>
#include <windows.h>
#include <shellapi.h>
#else
#include <sys/wait.h>
#endif

#include "ldacBT.h"
#include "ldacdec.h"

#ifndef LDAC_HELPER_VERSION
#define LDAC_HELPER_VERSION "1.0.0"
#endif
#ifndef LDAC_HELPER_LIBLDAC_COMMIT
#define LDAC_HELPER_LIBLDAC_COMMIT "unknown"
#endif
#ifndef LDAC_HELPER_LIBLDACDEC_COMMIT
#define LDAC_HELPER_LIBLDACDEC_COMMIT "unknown"
#endif

#define CONTAINER_MAGIC "LDAC"
#define CONTAINER_VERSION 1u
#define CONTAINER_HEADER_SIZE 48u
#define CONTAINER_FLAG_CRC32 1u
#define CONTAINER_MAX_FRAME_BYTES 1027u
#define ENC_FRAME_SAMPLES 128u   /* libldac LDACBT_ENC_LSU */
#define ENC_MTU 679              /* standard 2-DH5 LDAC MTU */
#define DEC_WARMUP_SAMPLES 128   /* one MDCT-overlap frame */

enum {
    EXIT_USAGE = 2,
    EXIT_IO = 3,
    EXIT_CONTAINER = 4,
    EXIT_CODEC = 5
};

typedef struct {
    int rate;
    int channels;
    int bitrate;
} config_t;

static void usage(FILE *f) {
    fprintf(f,
        "ldac_helper %s\n"
        "Usage:\n"
        "  ldac_helper encode --rate R --channels C --bitrate B --in IN --out OUT\n"
        "  ldac_helper decode --rate R --channels C --bitrate B --in IN --out OUT\n"
        "  ldac_helper --version\n"
        "\n"
        "Raw PCM is signed 16-bit little-endian, interleaved.\n"
        "Supported: rate 44100 or 48000; channels 1 or 2;\n"
        "           bitrate 330, 660 or 990 kbps.\n",
        LDAC_HELPER_VERSION);
}

static int fail(int code, const char *fmt, ...) {
    va_list ap;
    fputs("ldac_helper: error: ", stderr);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    return code;
}

static int parse_int_arg(const char *s, int *out) {
    char *end = NULL;
    long v;
    if (s == NULL || *s == '\0') return -1;
    errno = 0;
    v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || v < INT32_MIN || v > INT32_MAX) return -1;
    *out = (int)v;
    return 0;
}

static int validate_config(const config_t *c) {
    if (c->rate != 44100 && c->rate != 48000) {
        char msg[64];
        snprintf(msg, sizeof(msg), "unsupported sample rate %d Hz", c->rate);
        return fail(EXIT_USAGE,
                    "%s (supported: 44100, 48000)", msg);
    }
    if (c->channels != 1 && c->channels != 2) {
        char msg[64];
        snprintf(msg, sizeof(msg), "unsupported channel count %d", c->channels);
        return fail(EXIT_USAGE, "%s (supported: 1, 2)", msg);
    }
    if (c->bitrate != 330 && c->bitrate != 660 && c->bitrate != 990) {
        char msg[64];
        snprintf(msg, sizeof(msg), "unsupported bitrate %d kbps", c->bitrate);
        return fail(EXIT_USAGE, "%s (supported: 330, 660, 990)", msg);
    }
    return 0;
}

static int bitrate_to_eqmid(int kbps) {
    switch (kbps) {
        case 330: return LDACBT_EQMID_MQ;
        case 660: return LDACBT_EQMID_SQ;
        case 990: return LDACBT_EQMID_HQ;
        default:  return -1;
    }
}

static int channel_mode(int channels) {
    return channels == 1 ? LDACBT_CHANNEL_MODE_MONO : LDACBT_CHANNEL_MODE_STEREO;
}

static void put_u16le(unsigned char *p, uint16_t v) {
    p[0] = (unsigned char)(v & 0xffu);
    p[1] = (unsigned char)((v >> 8) & 0xffu);
}

static void put_u32le(unsigned char *p, uint32_t v) {
    p[0] = (unsigned char)(v & 0xffu);
    p[1] = (unsigned char)((v >> 8) & 0xffu);
    p[2] = (unsigned char)((v >> 16) & 0xffu);
    p[3] = (unsigned char)((v >> 24) & 0xffu);
}

static void put_u64le(unsigned char *p, uint64_t v) {
    put_u32le(p, (uint32_t)(v & 0xffffffffu));
    put_u32le(p + 4, (uint32_t)(v >> 32));
}

static uint16_t get_u16le(const unsigned char *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t get_u32le(const unsigned char *p) {
    return ((uint32_t)p[0]) | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t get_u64le(const unsigned char *p) {
    return (uint64_t)get_u32le(p) | ((uint64_t)get_u32le(p + 4) << 32);
}

#ifdef _WIN32
#define OPEN_READ L"rb"
#define OPEN_WRITE L"wb"
#define OPEN_READWRITE L"wb+"

/* UTF-8 is the helper's internal path representation on every platform. The
 * Windows CLI is rebuilt from GetCommandLineW so non-ASCII arguments survive;
 * all Windows file/process calls then use the wide API. */
static wchar_t *utf8_to_wide(const char *value) {
    int length;
    wchar_t *wide;
    if (value == NULL) return NULL;
    length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
    if (length <= 0) return NULL;
    wide = (wchar_t *)malloc((size_t)length * sizeof(wchar_t));
    if (wide == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, wide, length) <= 0) {
        free(wide);
        return NULL;
    }
    return wide;
}

static char *wide_to_utf8(const wchar_t *value) {
    int length;
    char *utf8;
    if (value == NULL) return NULL;
    length = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    if (length <= 0) return NULL;
    utf8 = (char *)malloc((size_t)length);
    if (utf8 == NULL) return NULL;
    if (WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8, length, NULL, NULL) <= 0) {
        free(utf8);
        return NULL;
    }
    return utf8;
}

static FILE *open_file_utf8(const char *path, const wchar_t *mode) {
    wchar_t *wide = utf8_to_wide(path);
    FILE *file;
    if (wide == NULL) {
        errno = EINVAL;
        return NULL;
    }
    file = _wfopen(wide, mode);
    free(wide);
    return file;
}

static int remove_file_utf8(const char *path) {
    wchar_t *wide = utf8_to_wide(path);
    int result;
    if (wide == NULL) return -1;
    result = DeleteFileW(wide) ? 0 : -1;
    free(wide);
    return result;
}

/* Compare open-handle file IDs, so case aliases and hard links are caught. */
static int same_file_as(FILE *in, const char *in_path, const char *out_path) {
    BY_HANDLE_FILE_INFORMATION left_info, right_info;
    HANDLE input_handle = (HANDLE)_get_osfhandle(_fileno(in));
    HANDLE output_handle;
    wchar_t *wide_out;
    int same = 0;
    (void)in_path;
    if (input_handle == INVALID_HANDLE_VALUE ||
        !GetFileInformationByHandle(input_handle, &left_info)) {
        return 0;
    }
    wide_out = utf8_to_wide(out_path);
    if (wide_out == NULL) return 0;
    output_handle = CreateFileW(wide_out, 0,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(wide_out);
    if (output_handle == INVALID_HANDLE_VALUE) return 0;
    if (GetFileInformationByHandle(output_handle, &right_info)) {
        same = left_info.dwVolumeSerialNumber == right_info.dwVolumeSerialNumber &&
               left_info.nFileIndexHigh == right_info.nFileIndexHigh &&
               left_info.nFileIndexLow == right_info.nFileIndexLow;
    }
    CloseHandle(output_handle);
    return same;
}

/* Create a unique sibling file with the wide API (GetTempFileNameW also
 * creates it), then return its UTF-8 path. */
static char *make_temp_path(const char *out_path) {
    wchar_t *wide_out = utf8_to_wide(out_path);
    wchar_t directory[MAX_PATH];
    wchar_t temp_path[MAX_PATH];
    wchar_t *separator;
    size_t length;
    char *utf8;
    if (wide_out == NULL) {
        errno = EINVAL;
        return NULL;
    }
    length = wcslen(wide_out);
    if (length == 0 || length >= (size_t)MAX_PATH) {
        free(wide_out);
        errno = ENAMETOOLONG;
        return NULL;
    }
    wmemcpy(directory, wide_out, length + 1);
    separator = wcsrchr(directory, L'\\');
    {
        wchar_t *forward = wcsrchr(directory, L'/');
        if (forward != NULL && (separator == NULL || forward > separator)) separator = forward;
    }
    if (separator == NULL) {
        wmemcpy(directory, L".", 2);
    } else {
        separator[1] = L'\0';
        if (directory[0] == L'\0') wmemcpy(directory, L".", 2);
    }
    free(wide_out);
    if (!GetTempFileNameW(directory, L"aud", 0, temp_path)) {
        errno = EIO;
        return NULL;
    }
    utf8 = wide_to_utf8(temp_path);
    if (utf8 == NULL) {
        DeleteFileW(temp_path);
        errno = ENOMEM;
        return NULL;
    }
    return utf8;
}

/* Atomic install; Windows rename() refuses to replace an existing file. */
static int replace_file(const char *from, const char *to) {
    wchar_t *wide_from = utf8_to_wide(from);
    wchar_t *wide_to = utf8_to_wide(to);
    int result = -1;
    if (wide_from != NULL && wide_to != NULL &&
        MoveFileExW(wide_from, wide_to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        result = 0;
    }
    free(wide_from);
    free(wide_to);
    if (result != 0) errno = EIO;
    return result;
}
#else
#define OPEN_READ "rb"
#define OPEN_WRITE "wb"
#define OPEN_READWRITE "wb+"

static FILE *open_file_utf8(const char *path, const char *mode) {
    return fopen(path, mode);
}

static int remove_file_utf8(const char *path) {
    return unlink(path);
}

/* True if `out_path` names the same existing file as the open input.  Missing
 * paths are not the same file; stat() follows symlinks, so aliases and hard
 * links are caught. */
static int same_file_as(FILE *in, const char *in_path, const char *out_path) {
    struct stat input_stat, other;
    (void)in_path;
    if (fstat(fileno(in), &input_stat) != 0) return 0;
    if (stat(out_path, &other) != 0) return 0;
    return input_stat.st_dev == other.st_dev && input_stat.st_ino == other.st_ino;
}

static char *make_temp_path(const char *out_path) {
    size_t len = strlen(out_path) + sizeof(".tmp.XXXXXX");
    char *tmp = (char *)malloc(len);
    int fd;
    if (tmp == NULL) {
        errno = ENOMEM;
        return NULL;
    }
    if (snprintf(tmp, len, "%s.tmp.XXXXXX", out_path) >= (int)len) {
        free(tmp);
        errno = ENAMETOOLONG;
        return NULL;
    }
    fd = mkstemp(tmp);
    if (fd < 0) {
        int saved = errno;
        free(tmp);
        errno = saved;
        return NULL;
    }
    /* mkstemp creates 0600; match a normal fopen-created output. */
    {
        mode_t mask = umask(0);
        umask(mask);
        (void)fchmod(fd, (mode_t)(0666 & ~mask));
    }
    if (close(fd) != 0) {
        int saved = errno;
        unlink(tmp);
        free(tmp);
        errno = saved;
        return NULL;
    }
    return tmp;
}

static int replace_file(const char *from, const char *to) {
    return rename(from, to);
}
#endif

/* CRC-32 (IEEE 802.3, same polynomial as zlib). */
static uint32_t crc32_update(uint32_t crc, const unsigned char *p, size_t n) {
    size_t i;
    for (i = 0; i < n; i++) {
        int bit;
        crc ^= p[i];
        for (bit = 0; bit < 8; bit++) {
            uint32_t mask = (uint32_t)-(int32_t)(crc & 1u);
            crc = (crc >> 1) ^ (0xEDB88320u & mask);
        }
    }
    return crc;
}

/* Parse the 3-byte LDAC transport-frame header.  Returns payload length or -1. */
static int ldac_payload_len(const unsigned char *frame, size_t avail) {
    int len;
    if (avail < 3 || frame[0] != 0xAA) return -1;
    len = ((((int)frame[1] & 0x07) << 6) | ((int)frame[2] >> 2)) + 1;
    if (len < 1 || len > (int)CONTAINER_MAX_FRAME_BYTES - 3) return -1;
    return len;
}

static int ldac_sample_rate_id(int rate) {
    switch (rate) {
        case 44100: return 0;
        case 48000: return 1;
        case 88200: return 2;
        case 96000: return 3;
        default:    return -1;
    }
}

static int ldac_channel_config_id(int channels) {
    /* Encoder is initialized with MONO or STEREO, never DUAL_CHANNEL. */
    return channels == 1 ? 0 : 2;
}

static int write_container_header(FILE *f, const config_t *c, uint32_t frame_count,
                                  uint64_t sample_count, int actual_bitrate,
                                  uint32_t crc) {
    unsigned char h[CONTAINER_HEADER_SIZE];
    memset(h, 0, sizeof(h));
    memcpy(h, CONTAINER_MAGIC, 4);
    put_u16le(h + 4, CONTAINER_VERSION);
    put_u16le(h + 6, CONTAINER_HEADER_SIZE);
    put_u32le(h + 8, (uint32_t)c->rate);
    put_u32le(h + 12, (uint32_t)c->channels);
    put_u32le(h + 16, (uint32_t)c->bitrate);
    put_u32le(h + 20, frame_count);
    put_u64le(h + 24, sample_count);
    put_u32le(h + 32, (uint32_t)actual_bitrate);
    put_u32le(h + 36, CONTAINER_FLAG_CRC32);
    put_u32le(h + 40, crc);
    put_u32le(h + 44, 0);
    if (fseek(f, 0, SEEK_SET) != 0) return -1;
    if (fwrite(h, 1, sizeof(h), f) != sizeof(h)) return -1;
    return 0;
}

static int parse_container_header(const unsigned char *h, const config_t *cli,
                                  uint32_t *frame_count, uint64_t *sample_count,
                                  int *actual_bitrate, uint32_t *crc) {
    uint16_t version, header_size;
    uint32_t rate, channels, bitrate, flags;
    if (memcmp(h, CONTAINER_MAGIC, 4) != 0) {
        return fail(EXIT_CONTAINER, "not an ldac_helper container (bad magic)%s", "");
    }
    version = get_u16le(h + 4);
    header_size = get_u16le(h + 6);
    if (version != CONTAINER_VERSION) {
        char msg[64];
        snprintf(msg, sizeof(msg), "unsupported container version %u", (unsigned)version);
        return fail(EXIT_CONTAINER, "%s", msg);
    }
    if (header_size != CONTAINER_HEADER_SIZE) {
        char msg[64];
        snprintf(msg, sizeof(msg), "bad container header size %u", (unsigned)header_size);
        return fail(EXIT_CONTAINER, "%s", msg);
    }
    rate = get_u32le(h + 8);
    channels = get_u32le(h + 12);
    bitrate = get_u32le(h + 16);
    *frame_count = get_u32le(h + 20);
    *sample_count = get_u64le(h + 24);
    *actual_bitrate = (int)get_u32le(h + 32);
    flags = get_u32le(h + 36);
    *crc = get_u32le(h + 40);
    if (flags != CONTAINER_FLAG_CRC32) {
        return fail(EXIT_CONTAINER, "unsupported container flags 0x%08x", flags);
    }
    if (get_u32le(h + 44) != 0) {
        return fail(EXIT_CONTAINER, "nonzero reserved container field%s", "");
    }
    if ((int)rate != cli->rate || (int)channels != cli->channels || (int)bitrate != cli->bitrate) {
        char msg[192];
        snprintf(msg, sizeof(msg),
                 "container config is %u Hz / %u ch / %u kbps, "
                 "command line says %d Hz / %d ch / %d kbps",
                 rate, channels, bitrate, cli->rate, cli->channels, cli->bitrate);
        return fail(EXIT_CONTAINER, "%s", msg);
    }
    return 0;
}

static int cmd_encode(const config_t *c, const char *in_path, const char *out_path) {
    FILE *in = NULL, *out = NULL;
    struct stat st;
    char *tmp_path = NULL;
    HANDLE_LDAC_BT handle = NULL;
    unsigned char *pcm = NULL, *packet = NULL;
    uint64_t sample_count = 0;
    uint32_t frame_count = 0;
    uint32_t crc = 0xFFFFFFFFu;
    int actual_bitrate = 0;
    int rc = EXIT_IO;
    size_t bytes_per_frame = (size_t)c->channels * 2u * ENC_FRAME_SAMPLES;
    int eqmid = bitrate_to_eqmid(c->bitrate);

    if (eqmid < 0) return validate_config(c); /* should not happen */

    in = open_file_utf8(in_path, OPEN_READ);
    if (in == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot open input '%s': %s\n",
                in_path, strerror(errno));
        return EXIT_IO;
    }
    if (fstat(fileno(in), &st) != 0 || !S_ISREG(st.st_mode)) {
        fprintf(stderr, "ldac_helper: error: input '%s' is not a regular file\n", in_path);
        goto done;
    }
    if (same_file_as(in, in_path, out_path)) {
        fprintf(stderr, "ldac_helper: error: input and output resolve to the same file '%s'\n",
                out_path);
        rc = EXIT_USAGE;
        goto done;
    }
    if (st.st_size < 0) {
        fprintf(stderr, "ldac_helper: error: input is too large\n");
        goto done;
    }
    if ((uint64_t)st.st_size % ((uint64_t)c->channels * 2u) != 0) {
        fprintf(stderr,
                "ldac_helper: error: input size %lld is not a whole number of "
                "%d-channel 16-bit sample frames\n",
                (long long)st.st_size, c->channels);
        goto done;
    }
    sample_count = (uint64_t)st.st_size / ((uint64_t)c->channels * 2u);

    tmp_path = make_temp_path(out_path);
    if (tmp_path == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot create output next to '%s': %s\n",
                out_path, strerror(errno));
        goto done;
    }
    out = open_file_utf8(tmp_path, OPEN_READWRITE);
    if (out == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot open temporary output for '%s': %s\n",
                out_path, strerror(errno));
        goto done;
    }
    /* Placeholder; rewritten after encoding with real counts. */
    if (write_container_header(out, c, 0, 0, 0, 0) != 0) {
        fprintf(stderr, "ldac_helper: error: cannot write container header\n");
        goto done;
    }

    handle = ldacBT_get_handle();
    if (handle == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot allocate LDAC encoder\n");
        rc = EXIT_CODEC;
        goto done;
    }
    if (ldacBT_init_handle_encode(handle, ENC_MTU, eqmid, channel_mode(c->channels),
                                  LDACBT_SMPL_FMT_S16, c->rate) < 0) {
        fprintf(stderr, "ldac_helper: error: LDAC encoder init failed (err=%d) "
                        "for %d Hz / %d ch / %d kbps\n",
                ldacBT_get_error_code(handle), c->rate, c->channels, c->bitrate);
        rc = EXIT_CODEC;
        goto done;
    }
    actual_bitrate = ldacBT_get_bitrate(handle);

    pcm = (unsigned char *)calloc(1, bytes_per_frame);
    packet = (unsigned char *)malloc(4096);
    if (pcm == NULL || packet == NULL) {
        fprintf(stderr, "ldac_helper: error: out of memory\n");
        goto done;
    }

    for (;;) {
        size_t n = fread(pcm, 1, bytes_per_frame, in);
        int used = 0, stream_sz = 0, frame_num = 0;
        size_t off;

        if (n == 0) {
            if (ferror(in)) {
                fprintf(stderr, "ldac_helper: error: read failed: %s\n", strerror(errno));
                goto done;
            }
            break;
        }
        if (n < bytes_per_frame) {
            /* Final partial frame: libldac requires a full 128-sample block. */
            memset(pcm + n, 0, bytes_per_frame - n);
        }
        if (ldacBT_encode(handle, pcm, &used, packet, &stream_sz, &frame_num) < 0) {
            fprintf(stderr, "ldac_helper: error: LDAC encode failed (err=%d)\n",
                    ldacBT_get_error_code(handle));
            rc = EXIT_CODEC;
            goto done;
        }
        if (used != (int)bytes_per_frame) {
            fprintf(stderr, "ldac_helper: error: encoder consumed %d of %zu bytes\n",
                    used, bytes_per_frame);
            rc = EXIT_CODEC;
            goto done;
        }
        for (off = 0; off < (size_t)stream_sz; ) {
            int payload = ldac_payload_len(packet + off, (size_t)stream_sz - off);
            uint16_t len;
            if (payload < 0 || off + 3u + (size_t)payload > (size_t)stream_sz) {
                fprintf(stderr, "ldac_helper: error: encoder produced a malformed frame\n");
                rc = EXIT_CODEC;
                goto done;
            }
            len = (uint16_t)(3 + payload);
            {
                unsigned char lb[2];
                put_u16le(lb, len);
                if (fwrite(lb, 1, 2, out) != 2 ||
                    fwrite(packet + off, 1, len, out) != len) {
                    fprintf(stderr, "ldac_helper: error: write failed: %s\n", strerror(errno));
                    goto done;
                }
                crc = crc32_update(crc, lb, 2);
                crc = crc32_update(crc, packet + off, len);
            }
            off += len;
            frame_count++;
        }
    }

    /* Flush the encoder's internal overlap tail. */
    for (;;) {
        int used = 0, stream_sz = 0, frame_num = 0;
        size_t off;
        if (ldacBT_encode(handle, NULL, &used, packet, &stream_sz, &frame_num) < 0) {
            fprintf(stderr, "ldac_helper: error: LDAC flush failed (err=%d)\n",
                    ldacBT_get_error_code(handle));
            rc = EXIT_CODEC;
            goto done;
        }
        for (off = 0; off < (size_t)stream_sz; ) {
            int payload = ldac_payload_len(packet + off, (size_t)stream_sz - off);
            uint16_t len;
            if (payload < 0 || off + 3u + (size_t)payload > (size_t)stream_sz) {
                fprintf(stderr, "ldac_helper: error: encoder produced a malformed flush frame\n");
                rc = EXIT_CODEC;
                goto done;
            }
            len = (uint16_t)(3 + payload);
            {
                unsigned char lb[2];
                put_u16le(lb, len);
                if (fwrite(lb, 1, 2, out) != 2 ||
                    fwrite(packet + off, 1, len, out) != len) {
                    fprintf(stderr, "ldac_helper: error: write failed: %s\n", strerror(errno));
                    goto done;
                }
                crc = crc32_update(crc, lb, 2);
                crc = crc32_update(crc, packet + off, len);
            }
            off += len;
            frame_count++;
        }
        if (stream_sz == 0) break;
    }

    if (write_container_header(out, c, frame_count, sample_count, actual_bitrate,
                               crc ^ 0xFFFFFFFFu) != 0) {
        fprintf(stderr, "ldac_helper: error: cannot finalize container header\n");
        goto done;
    }
    rc = 0;

done:
    if (handle != NULL) ldacBT_free_handle(handle);
    if (in != NULL) fclose(in);
    if (out != NULL) {
        if (fclose(out) != 0 && rc == 0) {
            fprintf(stderr, "ldac_helper: error: close failed: %s\n", strerror(errno));
            rc = EXIT_IO;
        }
    }
    free(pcm);
    free(packet);
    if (rc == 0 && tmp_path != NULL) {
        if (replace_file(tmp_path, out_path) != 0) {
            fprintf(stderr, "ldac_helper: error: cannot install output '%s': %s\n",
                    out_path, strerror(errno));
            rc = EXIT_IO;
        }
    }
    if (tmp_path != NULL) {
        if (rc != 0) remove_file_utf8(tmp_path);
        free(tmp_path);
    }
    return rc;
}

/* Runs in the decoder child.  All libldacdec work happens here so a bad
 * bitstream can only kill this process, never the helper's caller. */
static int decode_into_file(const config_t *c, FILE *in, const char *tmp_path,
                            uint32_t frame_count, uint64_t sample_count,
                            uint32_t expected_crc) {
    FILE *out = NULL;
    ldacdec_t dec;
    unsigned char *frame = NULL;
    int16_t *pcm = NULL;
    uint32_t i;
    uint64_t written = 0;
    uint32_t crc = 0xFFFFFFFFu;
    int skip = DEC_WARMUP_SAMPLES;
    int rc = EXIT_IO;

    if (ldacdecInit(&dec) < 0) {
        fprintf(stderr, "ldac_helper: error: cannot initialize LDAC decoder\n");
        return EXIT_CODEC;
    }
    out = open_file_utf8(tmp_path, OPEN_WRITE);
    if (out == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot open temporary output: %s\n",
                strerror(errno));
        return EXIT_IO;
    }

    /* Extra zero padding protects the decoder from over-read on bad frames.
     * It is not sufficient for all malformed payloads; containment (fork)
     * catches the ones that still go out of bounds. */
    frame = (unsigned char *)calloc(1, CONTAINER_MAX_FRAME_BYTES + 2048u);
    pcm = (int16_t *)calloc(1, (MAX_FRAME_SAMPLES * 2u + 2u) * sizeof(int16_t));
    if (frame == NULL || pcm == NULL) {
        fprintf(stderr, "ldac_helper: error: out of memory\n");
        goto done;
    }

    for (i = 0; i < frame_count; i++) {
        unsigned char lb[2];
        uint16_t len;
        int payload, sfid, cci, used = 0;
        size_t nwrite;

        if (fread(lb, 1, 2, in) != 2) {
            fprintf(stderr, "ldac_helper: error: container is truncated at frame %u of %u\n",
                    i, frame_count);
            rc = EXIT_CONTAINER;
            goto done;
        }
        len = get_u16le(lb);
        if (len < 4 || len > CONTAINER_MAX_FRAME_BYTES) {
            fprintf(stderr, "ldac_helper: error: invalid frame length %u at frame %u\n",
                    (unsigned)len, i);
            rc = EXIT_CONTAINER;
            goto done;
        }
        memset(frame, 0, CONTAINER_MAX_FRAME_BYTES + 2048u);
        if (fread(frame, 1, len, in) != len) {
            fprintf(stderr, "ldac_helper: error: container is truncated inside frame %u\n", i);
            rc = EXIT_CONTAINER;
            goto done;
        }
        crc = crc32_update(crc, lb, 2);
        crc = crc32_update(crc, frame, len);
        payload = ldac_payload_len(frame, len);
        if (payload < 0 || (size_t)(3 + payload) != len) {
            fprintf(stderr, "ldac_helper: error: corrupt LDAC frame header at frame %u\n", i);
            rc = EXIT_CONTAINER;
            goto done;
        }
        sfid = ((int)frame[1] >> 5) & 0x07;
        cci = ((int)frame[1] >> 3) & 0x03;
        if (sfid != ldac_sample_rate_id(c->rate)) {
            fprintf(stderr, "ldac_helper: error: frame %u has sample rate id %d, "
                            "container says %d Hz\n", i, sfid, c->rate);
            rc = EXIT_CONTAINER;
            goto done;
        }
        if (cci != ldac_channel_config_id(c->channels)) {
            fprintf(stderr, "ldac_helper: error: frame %u has channel config id %d, "
                            "container says %d channel(s)\n", i, cci, c->channels);
            rc = EXIT_CONTAINER;
            goto done;
        }
        memset(pcm, 0, (MAX_FRAME_SAMPLES * 2u + 2u) * sizeof(int16_t));
        if (ldacDecode(&dec, frame, pcm, &used) < 0) {
            fprintf(stderr, "ldac_helper: error: LDAC decode failed at frame %u\n", i);
            rc = EXIT_CONTAINER;
            goto done;
        }
        if (ldacdecGetSampleRate(&dec) != c->rate ||
            ldacdecGetChannelCount(&dec) != c->channels ||
            dec.frame.frameSamples <= 0 ||
            dec.frame.frameSamples > MAX_FRAME_SAMPLES) {
            fprintf(stderr, "ldac_helper: error: inconsistent decoded frame %u\n", i);
            rc = EXIT_CONTAINER;
            goto done;
        }

        {
            int frames = dec.frame.frameSamples;
            int start = 0;
            if (skip > 0) {
                start = skip < frames ? skip : frames;
                skip -= start;
            }
            frames -= start;
            if ((uint64_t)frames > sample_count - written) {
                frames = (int)(sample_count - written);
            }
            nwrite = (size_t)frames * (size_t)c->channels;
            if (nwrite > 0 &&
                fwrite(pcm + (size_t)start * (size_t)c->channels,
                       sizeof(int16_t), nwrite, out) != nwrite) {
                fprintf(stderr, "ldac_helper: error: write failed: %s\n", strerror(errno));
                goto done;
            }
            written += (uint64_t)frames;
        }
    }

    if ((crc ^ 0xFFFFFFFFu) != expected_crc) {
        fprintf(stderr, "ldac_helper: error: container checksum mismatch%s\n", "");
        rc = EXIT_CONTAINER;
        goto done;
    }
    if (written != sample_count) {
        fprintf(stderr,
                "ldac_helper: error: decoded %llu samples but header declares %llu\n",
                (unsigned long long)written, (unsigned long long)sample_count);
        rc = EXIT_CONTAINER;
        goto done;
    }
    {
        int ch;
        if ((ch = fgetc(in)) != EOF) {
            fprintf(stderr, "ldac_helper: error: trailing data after %u frames\n", frame_count);
            rc = EXIT_CONTAINER;
            goto done;
        }
    }
    rc = 0;

done:
    if (out != NULL) {
        if (fclose(out) != 0 && rc == 0) {
            fprintf(stderr, "ldac_helper: error: close failed: %s\n", strerror(errno));
            rc = EXIT_IO;
        }
    }
    free(frame);
    free(pcm);
    return rc;
}

static volatile sig_atomic_t decode_cancelled = 0;

#ifdef _WIN32
static BOOL WINAPI cancel_decode_win(DWORD event) {
    if (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT) {
        decode_cancelled = 1;
        return TRUE;
    }
    return FALSE;
}
#else
static void cancel_decode(int signum) {
    decode_cancelled = signum;
}
#endif

#ifdef _WIN32
/* Child mode: reopen the container and decode into the sibling temp path.
 * The parent owns cancellation and installs the finished file. */
static int cmd_decode_child(const char *in_path, const char *tmp_path) {
    FILE *in = NULL;
    unsigned char header[CONTAINER_HEADER_SIZE];
    config_t child_config;
    uint32_t frame_count = 0;
    uint64_t sample_count = 0;
    uint32_t expected_crc = 0;
    int actual_bitrate = 0;
    int rc = EXIT_IO;

    memset(&child_config, 0, sizeof(child_config));
    in = open_file_utf8(in_path, OPEN_READ);
    if (in == NULL) {
        fprintf(stderr, "ldac_helper: error: decoder child cannot open input: %s\n",
                strerror(errno));
        return EXIT_IO;
    }
    if (fread(header, 1, sizeof(header), in) != sizeof(header) ||
        parse_container_header(header, &child_config, &frame_count, &sample_count,
                               &actual_bitrate, &expected_crc) != 0) {
        fprintf(stderr, "ldac_helper: error: decoder child cannot parse container\n");
        fclose(in);
        return EXIT_CONTAINER;
    }
    rc = decode_into_file(&child_config, in, tmp_path, frame_count, sample_count,
                          expected_crc);
    fclose(in);
    return rc;
}
#endif

#ifdef _WIN32
/* Append one argv element using the CommandLineToArgvW quoting rules. Every
 * argument is quoted so spaces and non-ASCII paths survive intact. */
static int append_quoted_arg(wchar_t *command_line, size_t capacity, size_t *used,
                             const wchar_t *argument) {
    size_t backslashes = 0;
    const wchar_t *cursor = argument;
    if (*used > 0) {
        if (*used + 1 >= capacity) return -1;
        command_line[(*used)++] = L' ';
    }
    if (*used + 2 >= capacity) return -1;
    command_line[(*used)++] = L'"';
    while (*cursor != L'\0') {
        if (*cursor == L'\\') {
            backslashes++;
        } else if (*cursor == L'"') {
            if (*used + backslashes * 2 + 2 >= capacity) return -1;
            while (backslashes-- > 0) command_line[(*used)++] = L'\\';
            command_line[(*used)++] = L'\\';
            command_line[(*used)++] = L'"';
            backslashes = 0;
        } else {
            if (*used + backslashes + 2 >= capacity) return -1;
            while (backslashes-- > 0) command_line[(*used)++] = L'\\';
            command_line[(*used)++] = *cursor;
            backslashes = 0;
        }
        cursor++;
    }
    if (*used + backslashes * 2 + 2 >= capacity) return -1;
    while (backslashes-- > 0) {
        command_line[(*used)++] = L'\\';
        command_line[(*used)++] = L'\\';
    }
    command_line[(*used)++] = L'"';
    command_line[*used] = L'\0';
    return 0;
}

/* Start the decoder suspended, enforce kill-on-close job containment, then
 * resume it. Any containment failure is fatal: there is no unconfined
 * fallback. */
static int start_decode_child(const char *in_path, const char *tmp_path,
                              HANDLE *process_out, HANDLE *job_out) {
    wchar_t exe_path[MAX_PATH];
    wchar_t *wide_in = NULL;
    wchar_t *wide_tmp = NULL;
    wchar_t command_line[32768];
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    size_t used = 0;
    DWORD exe_length;
    HANDLE job = NULL;
    int result = -1;

    exe_length = GetModuleFileNameW(NULL, exe_path, (DWORD)(sizeof(exe_path) / sizeof(exe_path[0])));
    if (exe_length == 0 || exe_length >= (DWORD)(sizeof(exe_path) / sizeof(exe_path[0]))) {
        fprintf(stderr, "ldac_helper: error: cannot resolve helper executable path\n");
        return -1;
    }
    wide_in = utf8_to_wide(in_path);
    wide_tmp = utf8_to_wide(tmp_path);
    if (wide_in == NULL || wide_tmp == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot convert decoder paths to UTF-16\n");
        goto done;
    }
    if (append_quoted_arg(command_line, 32768, &used, exe_path) != 0 ||
        append_quoted_arg(command_line, 32768, &used, L"--decode-child") != 0 ||
        append_quoted_arg(command_line, 32768, &used, wide_in) != 0 ||
        append_quoted_arg(command_line, 32768, &used, wide_tmp) != 0) {
        fprintf(stderr, "ldac_helper: error: decoder command line is too long\n");
        goto done;
    }
    memset(&startup, 0, sizeof(startup));
    startup.cb = sizeof(startup);
    memset(&process, 0, sizeof(process));
    if (!CreateProcessW(exe_path, command_line, NULL, NULL, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
                        &startup, &process)) {
        fprintf(stderr, "ldac_helper: error: cannot start decoder process (0x%08lx)\n",
                (unsigned long)GetLastError());
        goto done;
    }
    job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot create decoder job\n");
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, INFINITE);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        goto done;
    }
    memset(&limits, 0, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(job, process.hProcess)) {
        fprintf(stderr, "ldac_helper: error: cannot confine decoder process\n");
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, INFINITE);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        job = NULL;
        goto done;
    }
    if (ResumeThread(process.hThread) == (DWORD)-1) {
        fprintf(stderr, "ldac_helper: error: cannot resume decoder process\n");
        TerminateJobObject(job, 1);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        job = NULL;
        goto done;
    }
    CloseHandle(process.hThread);
    *process_out = process.hProcess;
    *job_out = job;
    result = 0;

done:
    free(wide_in);
    free(wide_tmp);
    return result;
}
#endif

static int cmd_decode(const config_t *c, const char *in_path, const char *out_path) {
    FILE *in = NULL;
    struct stat st;
    char *tmp_path = NULL;
    unsigned char header[CONTAINER_HEADER_SIZE];
    uint32_t frame_count = 0;
    uint64_t sample_count = 0;
    uint32_t expected_crc = 0;
    int actual_bitrate = 0;
    int rc = EXIT_IO;
#ifdef _WIN32
    HANDLE child_process = NULL;
    HANDLE job = NULL;
    DWORD child_status = 0;
    int handler_installed = 0;
#else
    pid_t pid;
    int status = 0;
    sigset_t cancel_signals, original_mask;
    struct sigaction action = {0}, original_term, original_int;
    int mask_saved = 0, term_installed = 0, int_installed = 0;
#endif

    in = open_file_utf8(in_path, OPEN_READ);
    if (in == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot open input '%s': %s\n",
                in_path, strerror(errno));
        return EXIT_IO;
    }
    if (fstat(fileno(in), &st) != 0 || !S_ISREG(st.st_mode)) {
        fprintf(stderr, "ldac_helper: error: input '%s' is not a regular file\n", in_path);
        goto done;
    }
    if (fread(header, 1, sizeof(header), in) != sizeof(header)) {
        fprintf(stderr, "ldac_helper: error: input is shorter than the container header\n");
        rc = EXIT_CONTAINER;
        goto done;
    }
    if (parse_container_header(header, c, &frame_count, &sample_count,
                               &actual_bitrate, &expected_crc) != 0) {
        rc = EXIT_CONTAINER;
        goto done;
    }
    if (same_file_as(in, in_path, out_path)) {
        fprintf(stderr, "ldac_helper: error: input and output resolve to the same file '%s'\n",
                out_path);
        rc = EXIT_USAGE;
        goto done;
    }

    /* Write to a sibling temp file so a failed decode never changes or
     * deletes a pre-existing destination. */
    tmp_path = make_temp_path(out_path);
    if (tmp_path == NULL) {
        fprintf(stderr, "ldac_helper: error: cannot create output next to '%s': %s\n",
                out_path, strerror(errno));
        goto done;
    }

#ifdef _WIN32
    /* Windows containment: run the decoder in this same executable as a child
     * process, keep it in a kill-on-close Job Object, and let only the parent
     * publish output. A hard parent death closes the job handle and kills the
     * decoder even though Windows has no POSIX signal/fork semantics. */
    {
        decode_cancelled = 0;
        if (!SetConsoleCtrlHandler(cancel_decode_win, TRUE)) {
            fprintf(stderr, "ldac_helper: error: cannot install cancellation handler\n");
            goto done;
        }
        handler_installed = 1;
        fflush(NULL);
        if (start_decode_child(in_path, tmp_path, &child_process, &job) != 0) {
            rc = EXIT_IO;
            goto done;
        }
        for (;;) {
            DWORD wait = WaitForSingleObject(child_process, 10);
            if (wait == WAIT_OBJECT_0) break;
            if (wait == WAIT_FAILED) {
                fprintf(stderr, "ldac_helper: error: wait for decoder failed: %lu\n",
                        (unsigned long)GetLastError());
                rc = EXIT_IO;
                goto done;
            }
            if (decode_cancelled) {
                (void)TerminateJobObject(job, 1);
            }
        }
        if (!GetExitCodeProcess(child_process, &child_status)) {
            fprintf(stderr, "ldac_helper: error: cannot read decoder exit status\n");
            rc = EXIT_IO;
            goto done;
        }
        if (decode_cancelled) {
            fprintf(stderr, "ldac_helper: error: decode cancelled\n");
            rc = EXIT_IO;
            goto done;
        }
        if (child_status == 0) {
            rc = 0;
        } else if (child_status < 256) {
            rc = (int)child_status;
        } else {
            fprintf(stderr,
                    "ldac_helper: error: decoder crashed on malformed payload "
                    "(status 0x%08lx); refusing output\n",
                    (unsigned long)child_status);
            rc = EXIT_CODEC;
        }
    }
#else
    /* Block cancellation across fork, then let only the parent handle it.
     * A killed parent would otherwise orphan the isolated decoder. The
     * handler only sets a flag; the wait loop kills even a stuck/stopped
     * child and reaps it before returning to the application. */
    sigemptyset(&cancel_signals);
    sigaddset(&cancel_signals, SIGTERM);
    sigaddset(&cancel_signals, SIGINT);
    if (sigprocmask(SIG_BLOCK, &cancel_signals, &original_mask) != 0) {
        fprintf(stderr, "ldac_helper: error: cannot block cancellation: %s\n", strerror(errno));
        goto done;
    }
    mask_saved = 1;
    decode_cancelled = 0;
    action.sa_handler = cancel_decode;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, &original_term) != 0) goto signal_error;
    term_installed = 1;
    if (sigaction(SIGINT, &action, &original_int) != 0) goto signal_error;
    int_installed = 1;

    fflush(NULL);
    pid = fork();
    if (pid < 0) {
        fprintf(stderr, "ldac_helper: error: cannot start decoder process: %s\n",
                strerror(errno));
        goto done;
    }
    if (pid == 0) {
        int child_rc;
        sigaction(SIGTERM, &original_term, NULL);
        sigaction(SIGINT, &original_int, NULL);
        sigprocmask(SIG_SETMASK, &original_mask, NULL);
        child_rc = decode_into_file(c, in, tmp_path, frame_count, sample_count,
                                    expected_crc);
        fflush(NULL);
        _exit(child_rc);
    }
    sigprocmask(SIG_SETMASK, &original_mask, NULL);

    for (;;) {
        const struct timespec interval = {0, 10000000};
        pid_t got;
        if (decode_cancelled) kill(pid, SIGKILL);
        got = waitpid(pid, &status, WNOHANG);
        if (got == pid) break;
        if (got == 0) {
            /* A short bounded wait avoids the signal-before-waitpid race.
             * No decoder cooperation is required for cancellation. */
            nanosleep(&interval, NULL);
            continue;
        }
        if (got < 0 && errno == EINTR) continue;
        fprintf(stderr, "ldac_helper: error: wait for decoder failed: %s\n",
                strerror(errno));
        rc = EXIT_IO;
        goto done;
    }

    if (decode_cancelled) {
        fprintf(stderr, "ldac_helper: error: decode cancelled (signal %d)\n", decode_cancelled);
        rc = EXIT_IO;
        goto done;
    }

    if (WIFSIGNALED(status)) {
        fprintf(stderr,
                "ldac_helper: error: decoder crashed on malformed payload "
                "(signal %d); refusing output\n",
                WTERMSIG(status));
        rc = EXIT_CODEC;
    } else if (WIFEXITED(status)) {
        rc = WEXITSTATUS(status);
    } else {
        fprintf(stderr, "ldac_helper: error: decoder terminated abnormally%s\n", "");
        rc = EXIT_CODEC;
    }
#endif

    if (rc == 0) {
        if (replace_file(tmp_path, out_path) != 0) {
            fprintf(stderr, "ldac_helper: error: cannot install output '%s': %s\n",
                    out_path, strerror(errno));
            rc = EXIT_IO;
        }
    }
    goto done;

#ifndef _WIN32
signal_error:
    fprintf(stderr, "ldac_helper: error: cannot handle cancellation: %s\n", strerror(errno));
#endif

done:
    if (in != NULL) fclose(in);
    if (tmp_path != NULL) {
        if (rc != 0) remove_file_utf8(tmp_path);
        free(tmp_path);
    }
#ifdef _WIN32
    if (child_process != NULL) CloseHandle(child_process);
    if (job != NULL) CloseHandle(job);
    if (handler_installed) SetConsoleCtrlHandler(cancel_decode_win, FALSE);
#else
    if (term_installed) sigaction(SIGTERM, &original_term, NULL);
    if (int_installed) sigaction(SIGINT, &original_int, NULL);
    if (mask_saved) sigprocmask(SIG_SETMASK, &original_mask, NULL);
#endif
    return rc;
}

#ifdef _WIN32
/* Rebuild argv from the UTF-16 command line so non-ASCII paths are not lost to
 * the ANSI CRT entry point. Converted strings live until process exit. */
static char **utf8_argv_from_command_line(int *argc_out) {
    int wide_count = 0;
    LPWSTR *wide = CommandLineToArgvW(GetCommandLineW(), &wide_count);
    char **arguments;
    int index;
    if (wide == NULL || wide_count < 1) return NULL;
    arguments = (char **)calloc((size_t)wide_count + 1, sizeof(char *));
    if (arguments == NULL) {
        LocalFree(wide);
        return NULL;
    }
    for (index = 0; index < wide_count; index++) {
        arguments[index] = wide_to_utf8(wide[index]);
        if (arguments[index] == NULL) {
            int previous;
            for (previous = 0; previous < index; previous++) free(arguments[previous]);
            free(arguments);
            LocalFree(wide);
            return NULL;
        }
    }
    arguments[wide_count] = NULL;
    *argc_out = wide_count;
    LocalFree(wide);
    return arguments;
}
#endif

int main(int argc, char **argv) {
    config_t cfg;
    const char *in_path = NULL, *out_path = NULL;
    int have_rate = 0, have_channels = 0, have_bitrate = 0;
    int i, rc;

#ifdef _WIN32
    {
        int utf8_argc = 0;
        char **utf8_argv = utf8_argv_from_command_line(&utf8_argc);
        if (utf8_argv != NULL) {
            argc = utf8_argc;
            argv = utf8_argv;
        }
    }
    /* Internal containment process; never part of the public CLI surface. */
    if (argc == 4 && strcmp(argv[1], "--decode-child") == 0) {
        return cmd_decode_child(argv[2], argv[3]);
    }
#endif

    if (argc == 2 && (strcmp(argv[1], "--version") == 0 || strcmp(argv[1], "-V") == 0)) {
        printf("ldac_helper %s\n", LDAC_HELPER_VERSION);
        printf("libldac (AOSP) commit %s\n", LDAC_HELPER_LIBLDAC_COMMIT);
        printf("libldac version %d.%02d.%02d\n",
               (ldacBT_get_version() >> 16) & 0xff,
               (ldacBT_get_version() >> 8) & 0xff,
               ldacBT_get_version() & 0xff);
        printf("libldacdec (hegdi) commit %s\n", LDAC_HELPER_LIBLDACDEC_COMMIT);
        printf("container version %u\n", CONTAINER_VERSION);
        return 0;
    }
    if (argc == 2 && (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0)) {
        usage(stdout);
        return 0;
    }
    if (argc < 2) {
        usage(stderr);
        return EXIT_USAGE;
    }
    if (strcmp(argv[1], "encode") != 0 && strcmp(argv[1], "decode") != 0) {
        usage(stderr);
        return fail(EXIT_USAGE, "unknown command '%s'", argv[1]);
    }

    memset(&cfg, 0, sizeof(cfg));
    for (i = 2; i < argc; i++) {
        const char *arg = argv[i];
        const char *val = NULL;
        if (strcmp(arg, "--rate") == 0 || strcmp(arg, "--channels") == 0 ||
            strcmp(arg, "--bitrate") == 0 || strcmp(arg, "--in") == 0 ||
            strcmp(arg, "--out") == 0) {
            if (i + 1 >= argc) return fail(EXIT_USAGE, "missing value for '%s'", arg);
            val = argv[++i];
        } else {
            return fail(EXIT_USAGE, "unknown option '%s'", arg);
        }
        if (strcmp(arg, "--rate") == 0) {
            if (parse_int_arg(val, &cfg.rate) != 0) return fail(EXIT_USAGE, "invalid --rate '%s'", val);
            have_rate = 1;
        } else if (strcmp(arg, "--channels") == 0) {
            if (parse_int_arg(val, &cfg.channels) != 0) return fail(EXIT_USAGE, "invalid --channels '%s'", val);
            have_channels = 1;
        } else if (strcmp(arg, "--bitrate") == 0) {
            if (parse_int_arg(val, &cfg.bitrate) != 0) return fail(EXIT_USAGE, "invalid --bitrate '%s'", val);
            have_bitrate = 1;
        } else if (strcmp(arg, "--in") == 0) {
            in_path = val;
        } else {
            out_path = val;
        }
    }
    if (!have_rate || !have_channels || !have_bitrate || in_path == NULL || out_path == NULL) {
        usage(stderr);
        return fail(EXIT_USAGE, "missing required option near '%s'", "");
    }
    rc = validate_config(&cfg);
    if (rc != 0) return rc;

    if (strcmp(argv[1], "encode") == 0) return cmd_encode(&cfg, in_path, out_path);
    return cmd_decode(&cfg, in_path, out_path);
}
