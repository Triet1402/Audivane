/*
 * Minimal ABI stand-in for the pinned AOSP libldac 2.00.02 encoder header.
 *
 * The real build (tools/build_codec_wasm.sh) compiles libldac from
 * libldac/inc/ldacBT.h; tools/ldac_wasm.c never depends on that header's
 * internals, only on the handful of symbols below. This stand-in exists
 * solely for tools/test/ldac-wasm-lifecycle, which links stub
 * implementations so constructor failure paths can be injected without the
 * real encoder. Constants mirror the pinned header values for comprehension;
 * the built artifact remains provably pinned by that build script.
 */
#ifndef LDAC_WASM_LIFECYCLE_STUB_LDACBT_H
#define LDAC_WASM_LIFECYCLE_STUB_LDACBT_H

/* Encode Quality Mode Index (mirrors pinned enum; HQ=0, SQ=1, MQ=2). */
enum {
    LDACBT_EQMID_HQ = 0,
    LDACBT_EQMID_SQ,
    LDACBT_EQMID_MQ,
    LDACBT_EQMID_ABR = 0x7F,
};

/* Sample format (mirrors pinned enum). Only S16 is referenced. */
typedef enum _ENUM_LDACBT_SMPL_FMT {
    LDACBT_SMPL_FMT_S16 = 0x2,
} LDACBT_SMPL_FMT_T;

/* Channel-mode capability bits (mirrors pinned macros). */
#define LDACBT_CHANNEL_MODE_STEREO         0x01
#define LDACBT_CHANNEL_MODE_DUAL_CHANNEL   0x02
#define LDACBT_CHANNEL_MODE_MONO           0x04

/* Handle type: opaque to the glue, materialized by the stub implementations. */
typedef struct _st_ldacbt_handle *HANDLE_LDAC_BT;

HANDLE_LDAC_BT ldacBT_get_handle(void);
void           ldacBT_free_handle(HANDLE_LDAC_BT hLdacBt);
void           ldacBT_close_handle(HANDLE_LDAC_BT hLdacBt);
int            ldacBT_get_version(void);
int            ldacBT_get_sampling_freq(HANDLE_LDAC_BT hLdacBt);
int            ldacBT_get_bitrate(HANDLE_LDAC_BT hLdacBt);
int            ldacBT_init_handle_encode(HANDLE_LDAC_BT hLdacBt, int mtu, int eqmid, int cm,
                                         LDACBT_SMPL_FMT_T fmt, int sf);
int            ldacBT_encode(HANDLE_LDAC_BT hLdacBt, void *p_pcm, int *pcm_used,
                             unsigned char *stream_bytes, int *stream_sz, int *frame_num);
int            ldacBT_get_error_code(HANDLE_LDAC_BT hLdacBt);

#endif /* LDAC_WASM_LIFECYCLE_STUB_LDACBT_H */
