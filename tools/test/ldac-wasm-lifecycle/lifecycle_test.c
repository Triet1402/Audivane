/*
 * Bounded fault-injection lifecycle harness for tools/ldac_wasm.c.
 *
 * Scope (finding P2 at tools/ldac_wasm.c lines 133-140, baseline 9cf30ab):
 *   - every ldac_wasm_encoder_new construction failure path must release the
 *     packet buffer, the 8192-byte pending buffer and the session struct,
 *     plus the libldac handle once it was acquired;
 *   - decoder construction/decode failure paths must stay clean;
 *   - success paths keep their normal behavior (handle/init counts, frame
 *     serving, destructor), so the cleanup refactor cannot change them.
 *
 * How: the REAL tools/ldac_wasm.c is compiled against the ABI stand-in
 * headers in this directory (which name-mirror the pinned
 * libldac/ldacdec headers; see the header comments) and linked with stub
 * implementations of the codec symbols. Allocation accounting and failure
 * injection happen at the malloc/calloc/free boundary via GNU/LLVM linker
 * wrapping, so the glue's own allocations and releases are observed without
 * modifying it. There are no external dependencies and no real WASM or
 * pinned-codec build; the parent integration owns artifact rebuild and
 * byte-parity acceptance.
 *
 * Address-space note: the glue stores sessions as int32_t handles (the real
 * WASM contract, where the heap's linear memory keeps every pointer inside
 * int32 range). A native host can hand out addresses above 2^31, so the
 * wrappers back all post-start allocations with an anonymous mapping pinned
 * at a low fixed address, emulating the WASM linear-memory constraint while
 * still observing every allocation and release.
 *
 * Build and run (from the repository root):
 *   cc -std=c11 -Wall -Wextra -Wno-unused-parameter \
 *       -Itools/test/ldac-wasm-lifecycle \
 *       tools/test/ldac-wasm-lifecycle/lifecycle_test.c tools/ldac_wasm.c \
 *       -Wl,--wrap=malloc,--wrap=calloc,--wrap=free \
 *       -o /tmp/opencode/ldac-wasm-lifecycle/lifecycle_test
 *   /tmp/opencode/ldac-wasm-lifecycle/lifecycle_test
 *
 * Exit status 0 with only "ok:" lines, nonzero otherwise.
 */

#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <sys/mman.h>

#include "ldacBT.h"
#include "ldacdec.h"

/* The glue's Captured ABI (tools/ldac_wasm.c, exported WASM functions). */
int32_t ldac_wasm_encoder_new(int32_t rate, int32_t channels, int32_t bitrate, int32_t *meta);
int32_t ldac_wasm_encode_block(int32_t handle, int16_t *pcm);
int32_t ldac_wasm_encoder_flush(int32_t handle);
int32_t ldac_wasm_frame_len(int32_t handle);
int32_t ldac_wasm_frame_copy(int32_t handle, uint8_t *out);
void    ldac_wasm_encoder_free(int32_t handle);
int32_t ldac_wasm_decoder_new(int32_t rate, int32_t channels);
int32_t ldac_wasm_decode_block(int32_t handle, uint8_t *frame, int32_t frame_bytes, int16_t *out);
void    ldac_wasm_decoder_free(int32_t handle);

/* --- allocation accounting and fault injection --------------------------- */

/* Low fixed address (128 MiB), keeps every glue pointer inside int32 range
 * exactly like the WASM linear-memory heap the contract targets. */
#define POOL_ADDR ((void *)0x08000000u)
#define POOL_LEN  (8u << 20)

static unsigned char *g_pool;
static size_t g_pool_at;

extern void *__real_malloc(size_t size);
extern void *__real_calloc(size_t nmemb, size_t size);
extern void __real_free(void *ptr);

static int pool_init(void) {
    g_pool = (unsigned char *)mmap(POOL_ADDR, POOL_LEN, PROT_READ | PROT_WRITE,
                                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
                                   -1, 0);
    return g_pool == MAP_FAILED ? -1 : 0;
}

static void *pool_alloc(size_t n) {
    size_t at = (g_pool_at + 15u) & ~15u;   /* 16-byte alignment */
    if (n > POOL_LEN - at) {
        fprintf(stderr, "harness arena exhausted (need %zu bytes)\n", n);
        exit(2);
    }
    g_pool_at = at + n;
    return g_pool + at;
}

#define REG_MAX 1024
static void  *g_reg_p[REG_MAX];
static size_t g_reg_n[REG_MAX];
static int    g_reg_used[REG_MAX];
static long   g_out_count;   /* live allocations */
static long   g_out_bytes;   /* live allocation bytes */

static int g_malloc_skip, g_malloc_fail_pending;   /* succeed N mallocs, then fail one */
static int g_calloc_skip, g_calloc_fail_pending;

static void registry_clear(void) {
    memset(g_reg_p, 0, sizeof g_reg_p);
    memset(g_reg_n, 0, sizeof g_reg_n);
    memset(g_reg_used, 0, sizeof g_reg_used);
    g_out_count = 0;
    g_out_bytes = 0;
    g_malloc_skip = 0; g_malloc_fail_pending = 0;
    g_calloc_skip = 0; g_calloc_fail_pending = 0;
}

static void registry_note(void *p, size_t n) {
    int i;
    for (i = 0; i < REG_MAX; i++) {
        if (!g_reg_used[i]) {
            g_reg_p[i] = p;
            g_reg_n[i] = n;
            g_reg_used[i] = 1;
            g_out_count++;
            g_out_bytes += (long)n;
            return;
        }
    }
    fprintf(stderr, "harness registry exhausted\n");
    exit(2);
}

static void registry_drop(void *p) {
    int i;
    for (i = 0; i < REG_MAX; i++) {
        if (g_reg_used[i] && g_reg_p[i] == p) {
            g_reg_used[i] = 0;
            g_out_count--;
            g_out_bytes -= (long)g_reg_n[i];
            return;
        }
    }
    /* Untracked pointer (made before this harness started): pass through. */
}

void *__wrap_malloc(size_t size) {
    void *p;
    if (g_malloc_skip > 0) {
        g_malloc_skip--;
    } else if (g_malloc_fail_pending) {
        g_malloc_fail_pending = 0;
        return NULL;
    }
    p = pool_alloc(size);
    registry_note(p, size);
    return p;
}

void *__wrap_calloc(size_t nmemb, size_t size) {
    void *p;
    size_t n = nmemb * size;
    if (g_calloc_skip > 0) {
        g_calloc_skip--;
    } else if (g_calloc_fail_pending) {
        g_calloc_fail_pending = 0;
        return NULL;
    }
    p = pool_alloc(n);
    memset(p, 0, n);
    registry_note(p, n);
    return p;
}

void __wrap_free(void *ptr) {
    if (!ptr) return;
    if (g_pool && (unsigned char *)ptr >= g_pool &&
        (unsigned char *)ptr < g_pool + POOL_LEN) {
        registry_drop(ptr);
        return;
    }
    __real_free(ptr);
}

static long g_snap_count, g_snap_bytes;
static void snapshot_allocs(void) { g_snap_count = g_out_count; g_snap_bytes = g_out_bytes; }
static int  allocs_balanced(void) { return g_snap_count == g_out_count && g_snap_bytes == g_out_bytes; }

/* --- checking ------------------------------------------------------------ */

static int g_failures;
static void check(int ok, const char *what) {
    if (ok) {
        printf("ok: %s\n", what);
    } else {
        fprintf(stderr, "FAIL: %s\n", what);
        g_failures++;
    }
}

/* --- stub libldac (encoder) ---------------------------------------------- */

struct _st_ldacbt_handle { unsigned slot; };
static struct _st_ldacbt_handle g_stub_handle;

static int g_get_handle_calls, g_free_handle_calls, g_init_calls, g_encode_calls;
static int g_get_handle_fail, g_init_fail;
static int g_init_mtu, g_init_eqmid, g_init_channels, g_init_fmt, g_init_rate;
static int g_get_bitrate_returns = 990;
static int g_pcm_used = 512;    /* stereo 128-sample s16 block */

static unsigned char g_stream[8];
static int g_stream_sz;

static void stub_reset(void) {
    g_get_handle_calls = 0; g_free_handle_calls = 0; g_init_calls = 0; g_encode_calls = 0;
    g_get_handle_fail = 0; g_init_fail = 0;
    g_init_mtu = 0; g_init_eqmid = 0; g_init_channels = 0; g_init_fmt = 0; g_init_rate = 0;
    /* One minimal LDAC transport frame: sync 0xAA, zero SFID/payload-low bits,
     * payload length 3 ((g_stream[2] >> 2) + 1), 3 payload bytes. */
    g_stream[0] = 0xAA; g_stream[1] = 0x00; g_stream[2] = 0x08;
    g_stream[3] = 'p'; g_stream[4] = 'q'; g_stream[5] = 'r';
    g_stream_sz = 6;
}

HANDLE_LDAC_BT ldacBT_get_handle(void) {
    g_get_handle_calls++;
    if (g_get_handle_fail) { g_get_handle_fail = 0; return NULL; }
    return &g_stub_handle;
}

void ldacBT_free_handle(HANDLE_LDAC_BT hLdacBt) { g_free_handle_calls++; (void)hLdacBt; }
void ldacBT_close_handle(HANDLE_LDAC_BT hLdacBt) { (void)hLdacBt; }
int ldacBT_get_version(void) { return 200001; }
int ldacBT_get_sampling_freq(HANDLE_LDAC_BT hLdacBt) { (void)hLdacBt; return g_init_rate; }
int ldacBT_get_bitrate(HANDLE_LDAC_BT hLdacBt) { (void)hLdacBt; return g_get_bitrate_returns; }
int ldacBT_get_error_code(HANDLE_LDAC_BT hLdacBt) { (void)hLdacBt; return 0; }

int ldacBT_init_handle_encode(HANDLE_LDAC_BT hLdacBt, int mtu, int eqmid, int cm,
                              LDACBT_SMPL_FMT_T fmt, int sf) {
    (void)hLdacBt;
    g_init_calls++;
    g_init_mtu = mtu; g_init_eqmid = eqmid; g_init_channels = cm;
    g_init_fmt = (int)fmt; g_init_rate = sf;
    if (g_init_fail) { g_init_fail = 0; return -1; }
    return 0;
}

int ldacBT_encode(HANDLE_LDAC_BT hLdacBt, void *p_pcm, int *pcm_used,
                  unsigned char *stream_bytes, int *stream_sz, int *frame_num) {
    (void)hLdacBt;
    g_encode_calls++;
    *pcm_used = (p_pcm != NULL) ? g_pcm_used : 0;
    *stream_sz = 0;
    *frame_num = 0;
    if (g_stream_sz > 0) {
        if (g_stream_sz > 4096) return -1;
        memcpy(stream_bytes, g_stream, (size_t)g_stream_sz);
        *stream_sz = g_stream_sz;
        *frame_num = 1;
    }
    return 0;
}

/* --- stub libldacdec (decoder) ------------------------------------------- */

static int g_ldacdec_init_fail;
static int g_dec_rate = 48000, g_dec_channels = 2, g_dec_frame_samples = 128;
static int g_ldacdec_decode_calls;

static void stub_decoder_reset(void) {
    g_ldacdec_init_fail = 0;
    g_dec_rate = 48000; g_dec_channels = 2; g_dec_frame_samples = 128;
    g_ldacdec_decode_calls = 0;
}

int ldacdecInit(ldacdec_t *this) {
    if (g_ldacdec_init_fail) { g_ldacdec_init_fail = 0; return -1; }
    this->frame.frameSamples = g_dec_frame_samples;
    return 0;
}

int ldacDecode(ldacdec_t *this, uint8_t *stream, int16_t *pcm, int *bytesUsed) {
    (void)stream;
    g_ldacdec_decode_calls++;
    this->frame.frameSamples = g_dec_frame_samples;
    *bytesUsed = g_stream_sz;
    memset(pcm, 0, (size_t)this->frame.frameSamples * (size_t)g_dec_channels * sizeof(int16_t));
    return 0;
}

int ldacdecGetSampleRate(ldacdec_t *this) { (void)this; return g_dec_rate; }
int ldacdecGetChannelCount(ldacdec_t *this) { (void)this; return g_dec_channels; }

/* --- tests --------------------------------------------------------------- */

enum { STEREO_PCM = 128 * 2 };    /* samples per padded stereo LSU block */

static void test_encoder_success_and_free(void) {
    int32_t meta[2] = { 0, 0 };
    int16_t pcm[STEREO_PCM];
    uint8_t frame[8];
    int32_t h;
    int rc;

    stub_reset();
    stub_decoder_reset();
    registry_clear();
    h = ldac_wasm_encoder_new(48000, 2, 990, meta);
    check(h != 0, "encoder_new returns a session for a valid configuration");
    check(g_get_handle_calls == 1, "exactly one libldac handle is acquired");
    check(g_init_calls == 1, "exactly one libldac init is performed");
    check(g_init_rate == 48000 && g_init_channels == LDACBT_CHANNEL_MODE_STEREO,
          "init receives the requested rate and stereo channel mode");
    check(g_init_eqmid == LDACBT_EQMID_HQ, "990 kbps maps to the HQ eqmid");
    check(g_init_fmt == LDACBT_SMPL_FMT_S16, "init receives the S16 sample format");
    check(g_init_mtu == 679, "init receives the standard 2-DH5 MTU");
    check(meta[0] == 128, "meta reports the 128-sample LSU");
    check(meta[1] == 990, "meta reports the libldac-reported bitrate");

    memset(pcm, 0, sizeof pcm);
    rc = ldac_wasm_encode_block(h, pcm);
    check(rc == 0, "one padded stereo block encodes cleanly");
    check(g_encode_calls == 1 && g_pcm_used == 512,
          "the encoder consumed one full padded LSU block");

    check(ldac_wasm_frame_len(h) == 6, "the transport frame is served whole");
    memset(frame, 0, sizeof frame);
    check(ldac_wasm_frame_copy(h, frame) == 6,
          "frame_copy copies the stub frame");
    check(memcmp(frame, g_stream, 6) == 0, "copied frame bytes are exact");

    g_stream_sz = 0;   /* flush yields no frames in the stub */
    check(ldac_wasm_encoder_flush(h) == 0, "flush with no tail frame succeeds");

    ldac_wasm_encoder_free(h);
    check(g_free_handle_calls == 1, "exactly one libldac handle is released");
    check(g_out_count == 0 && g_out_bytes == 0,
          "the destructor releases every session allocation, buffers included");
}

static void test_encoder_handle_failure(void) {
    int32_t meta[2] = { 0, 0 };
    stub_reset();
    stub_decoder_reset();
    registry_clear();
    g_get_handle_fail = 1;
    snapshot_allocs();
    check(ldac_wasm_encoder_new(48000, 2, 990, meta) == 0,
          "encoder_new fails when the libldac handle cannot be acquired");
    check(g_init_calls == 0, "no init is attempted without a handle");
    check(g_free_handle_calls == 0, "no handle exists to release");
    check(allocs_balanced(),
          "handle-acquisition failure releases packet AND pending buffers");  /* P2 fix */
    check(g_out_count == 0 && g_out_bytes == 0, "nothing leaks at all");
}

static void test_encoder_init_failure(void) {
    int32_t meta[2] = { 0, 0 };
    stub_reset();
    stub_decoder_reset();
    registry_clear();
    g_init_fail = 1;
    snapshot_allocs();
    check(ldac_wasm_encoder_new(48000, 2, 990, meta) == 0,
          "encoder_new fails when the libldac init is rejected");
    check(g_free_handle_calls == 1, "the acquired handle is released on init failure");
    check(allocs_balanced(),
          "init failure releases packet AND pending buffers");  /* P2 fix */
    check(g_out_count == 0 && g_out_bytes == 0, "nothing leaks at all");
}

static void test_encoder_alloc_failures(void) {
    int32_t meta[2] = { 0, 0 };
    int case_i;
    const char *names[] = {
        "all sessions released after a struct allocation failure",
        "all sessions released after a packet allocation failure",
        "all sessions released after a pending allocation failure"
    };

    for (case_i = 0; case_i < 3; case_i++) {
        stub_reset();
        stub_decoder_reset();
        registry_clear();
        snapshot_allocs();
        switch (case_i) {
            case 0: g_calloc_fail_pending = 1; break;                    /* struct */
            case 1: g_malloc_fail_pending = 1; break;                    /* packet */
            case 2: g_calloc_skip = 1; g_calloc_fail_pending = 1; break;  /* pending */
        }
        check(ldac_wasm_encoder_new(48000, 2, 990, meta) == 0,
              "encoder_new refuses when a constructor allocation fails");
        check(allocs_balanced() && g_out_count == 0,
              names[case_i]);
        check(g_get_handle_calls == 0,
              "no handle is acquired when a buffer allocation fails first");
    }
}

static void test_decoder_lifecycle(void) {
    int32_t dh;
    uint8_t good[6] = { 0xAA, 0x30, 0x08, 'a', 'b', 'c' };  /* sfid 1, cci 2, payload 3 */
    uint8_t bad_sync[6]   = { 0xAB, 0x30, 0x08, 'a', 'b', 'c' };
    uint8_t bad_cci[6]    = { 0xAA, 0x20, 0x08, 'a', 'b', 'c' };
    uint8_t short_frame[5] = { 0xAA, 0x30, 0x08, 'a', 'b' };
    int16_t out[256 * 2];

    stub_reset();
    stub_decoder_reset();
    registry_clear();

    dh = ldac_wasm_decoder_new(48000, 2);
    check(dh != 0, "decoder_new returns a session for a valid configuration");

    memset(out, 0xAA, sizeof out);
    check(ldac_wasm_decode_block(dh, good, 6, out) == 128,
          "decode_block decodes the stub's 128-sample frame");
    check(ldac_wasm_decode_block(dh, bad_sync, 6, out) == -1,
          "a corrupt sync byte is refused");
    check(ldac_wasm_decode_block(dh, bad_cci, 6, out) == -1,
          "a stereo/cc mismatch is refused");
    check(ldac_wasm_decode_block(dh, short_frame, 5, out) == -1,
          "a frame shorter than its header-length claim is refused");

    snapshot_allocs();
    g_calloc_fail_pending = 1;   /* the decode scratch allocation fails next */
    check(ldac_wasm_decode_block(dh, good, 6, out) == -1,
          "a decoder scratch-allocation failure is refused");
    check(allocs_balanced(),
          "no decoder allocation leaks on scratch failure");

    ldac_wasm_decoder_free(dh);
    check(g_out_count == 0 && g_out_bytes == 0,
          "the decoder destructor releases the open session struct completely");

    stub_reset();
    stub_decoder_reset();
    registry_clear();
    g_ldacdec_init_fail = 1;
    snapshot_allocs();
    check(ldac_wasm_decoder_new(48000, 2) == 0,
          "decoder_new fails when the decoder init fails");
    check(allocs_balanced() && g_out_count == 0 && g_out_bytes == 0,
          "decoder construction failure releases the session struct");
}

int main(void) {
    if (pool_init() != 0) {
        fprintf(stderr, "cannot pin the harness arena at a low address\n");
        return 2;
    }
    if ((intptr_t)(g_pool + POOL_LEN - 1) > INT32_MAX) {
        fprintf(stderr, "harness arena exceeds int32 range\n");
        return 2;
    }
    setvbuf(stdout, NULL, _IONBF, 0);
    test_encoder_success_and_free();
    test_encoder_handle_failure();
    test_encoder_init_failure();
    test_encoder_alloc_failures();
    test_decoder_lifecycle();
    if (g_failures == 0) {
        printf("all ldac_wasm lifecycle checks passed\n");
        return 0;
    }
    fprintf(stderr, "%d lifecycle check(s) failed\n", g_failures);
    return 1;
}
