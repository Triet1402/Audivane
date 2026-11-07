/*
 * ldac_wasm.c -- supplemental LDAC codec glue for the browser engine.
 *
 * In-memory port of tools/ldac_helper.c (the native desktop tier's helper is
 * compiled separately). Identical integer behavior: container v1 framing (the
 * 48-byte LE header and CRC live engine-side in TS,
 * packages/engine-browser/src/ldac-container.ts), MQ/SQ/HQ encoder modes from
 * pinned AOSP libldac 2.00.02, 128-sample LSU blocks, and the per-frame
 * decoder contract from pinned hegdi/libldacdec 7f3bd6cc. Inputs are
 * validated exactly like the helper's CLI (bad rate/channels/bitrate, bad
 * frame headers) so failures are clean and never hang.
 *
 * Exported ABI (see supplemental-codecs.ts for the TS contract):
 *   int32_t ldac_wasm_encoder_new(rate, channels, bitrate_kbps, meta*2);
 *       meta[0] = encoder LSU samples per frame (128);
 *       meta[1] = actual bitrate libldac reports (kbps).
 *   int32_t ldac_wasm_encode_block(handle, int16 pcm_block[]);
 *       one full/padded LSU block (LSU*channels s16 samples).
 *   int32_t ldac_wasm_frame_len(handle);
 *       the next transport frame produced by the last block (0 when none).
 *   int32_t ldac_wasm_frame_copy(handle, uint8 out[]);
 *       copies and consumes that frame.
 *   int32_t ldac_wasm_encoder_flush(handle);
 *       -> calls ldacBT_encode(NULL) once; the frames it produced (0..n) are
 *          served one at a time by ldac_wasm_frame_len/frame_copy exactly
 *          like a block's stream.
 *   void    ldac_wasm_encoder_free(handle);
 *   int32_t ldac_wasm_decoder_new(rate, channels);
 *   int32_t ldac_wasm_decode_block(handle, uint8 frame[], nbytes, int16 out[]);
 *       writes one block of decoded s16 samples; returns the number of sample
 *       frames decoded (or -1 on a rejected/corrupt frame).
 *   void    ldac_wasm_decoder_free(handle);
 */

#include "ldacBT.h"
#include "ldacdec.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define ENC_FRAME_BYTES_MAX 1027u   /* 3-byte header + 1024-byte payload cap */
#define ENC_FRAME_SAMPLES 128u      /* libldac LDACBT_ENC_LSU */
#define ENC_MTU 679                 /* standard 2-DH5 LDAC MTU */

#ifndef LDACDEC_MAX_FRAME_SAMPLES
#define LDACDEC_MAX_FRAME_SAMPLES 256
#endif
#ifndef MAX_FRAME_SAMPLES
#define MAX_FRAME_SAMPLES LDACDEC_MAX_FRAME_SAMPLES
#endif

typedef struct {
    int rate, channels, bitrate;
    int lsu;                     /* encoder block samples */
    unsigned char *packet;       /* ldacBT_encode output stream */
    /* ldacBT_encode may packetize several transport frames per call; every
     * frame must be served in order, so streams accumulate here until the
     * consumer drains them with ldac_wasm_frame_len/frame_copy. */
    unsigned char *pending;
    size_t pending_len;
    size_t pending_off;
    HANDLE_LDAC_BT handle;
} ldacw_encoder;

#define LDACW_PENDING_CAP 8192u

/* Append one call's stream bytes, keeping the consumer's offsets valid. */
static int ldacw_append_stream(ldacw_encoder *e, unsigned char *stream, int stream_sz) {
    if (stream_sz <= 0) return 0;
    /* Compact consumed bytes first so `pending` stays small. */
    if (e->pending_off > 0 && e->pending_off < e->pending_len) {
        memmove(e->pending, e->pending + e->pending_off, e->pending_len - e->pending_off);
        e->pending_len -= e->pending_off;
        e->pending_off = 0;
    } else if (e->pending_off == e->pending_len) {
        e->pending_len = 0;
        e->pending_off = 0;
    }
    if (e->pending_len + (size_t)stream_sz > LDACW_PENDING_CAP) {
        return -1;   /* the TS consumer never leaves frames undrained */
    }
    memcpy(e->pending + e->pending_len, stream, (size_t)stream_sz);
    e->pending_len += (size_t)stream_sz;
    return 0;
}

typedef struct {
    int rate, channels;
    ldacdec_t dec;
} ldacw_decoder;

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

/* Parse the 3-byte LDAC transport frame header; returns payload length. */
static int ldac_payload_len(const unsigned char *frame, size_t avail) {
    int len;
    if (avail < 3 || frame[0] != 0xAA) return -1;
    len = ((((int)frame[1] & 0x07) << 6) | ((int)frame[2] >> 2)) + 1;
    if (len < 1 || len > (int)ENC_FRAME_BYTES_MAX - 3) return -1;
    return len;
}

int32_t ldac_wasm_encoder_new(int32_t rate, int32_t channels, int32_t bitrate, int32_t *meta) {
    if (rate != 44100 && rate != 48000) return 0;
    if (channels != 1 && channels != 2) return 0;
    const int eqmid = bitrate_to_eqmid(bitrate);
    if (eqmid < 0) return 0;

    ldacw_encoder *e = (ldacw_encoder *)calloc(1, sizeof(ldacw_encoder));
    if (!e) return 0;
    e->rate = rate;
    e->channels = channels;
    e->bitrate = bitrate;
    e->lsu = (int)ENC_FRAME_SAMPLES;
    e->packet = (unsigned char *)malloc(4096);
    e->pending = (unsigned char *)calloc(1, LDACW_PENDING_CAP);
    if (!e->packet || !e->pending) {
        free(e->packet); free(e->pending); free(e);
        return 0;
    }
    /* Every failure past the initial allocations releases the same two
     * buffers (packet, pending) and, once acquired, the libldac handle. */
    e->handle = ldacBT_get_handle();
    if (!e->handle) {
        free(e->packet);
        free(e->pending);
        free(e);
        return 0;
    }
    if (ldacBT_init_handle_encode(e->handle, ENC_MTU, eqmid, channel_mode(channels),
                                  LDACBT_SMPL_FMT_S16, rate) < 0) {
        ldacBT_free_handle(e->handle);
        free(e->packet);
        free(e->pending);
        free(e);
        return 0;
    }
    if (meta != NULL) {
        meta[0] = e->lsu;
        meta[1] = ldacBT_get_bitrate(e->handle);
    }
    return (int32_t)(intptr_t)e;
}

int32_t ldac_wasm_encode_block(int32_t handle, int16_t *pcm) {
    if (!handle || !pcm) return -1;
    ldacw_encoder *e = (ldacw_encoder *)(intptr_t)handle;
    int used = 0, stream_sz = 0, frame_num = 0;
    if (ldacBT_encode(e->handle, pcm, &used, e->packet, &stream_sz, &frame_num) < 0) {
        return -1;
    }
    if (used != (int)(e->lsu * e->channels * (int)sizeof(int16_t))) {
        /* The encoder must consume exactly one padded LSU block. */
        return -1;
    }
    if (stream_sz < 0 || stream_sz > 4096) return -1;
    return ldacw_append_stream(e, e->packet, stream_sz);
}

int32_t ldac_wasm_encoder_flush(int32_t handle) {
    if (!handle) return -1;
    ldacw_encoder *e = (ldacw_encoder *)(intptr_t)handle;
    int used = 0, stream_sz = 0, frame_num = 0;
    if (ldacBT_encode(e->handle, NULL, &used, e->packet, &stream_sz, &frame_num) < 0) {
        return -1;
    }
    if (stream_sz < 0 || stream_sz > 4096) return -1;
    return ldacw_append_stream(e, e->packet, stream_sz);
}

int32_t ldac_wasm_frame_len(int32_t handle) {
    if (!handle) return 0;
    ldacw_encoder *e = (ldacw_encoder *)(intptr_t)handle;
    if (e->pending_off >= e->pending_len) return 0;
    const int payload = ldac_payload_len(
        e->pending + e->pending_off, e->pending_len - e->pending_off);
    if (payload <= 0) return 0;   /* a pending corrupt header must not frameroll */
    const int len = payload + 3;
    if (e->pending_off + (size_t)len > e->pending_len) {
        /* A truncated encoder stream is refused, not reframed. */
        e->pending_off = e->pending_len;
        return 0;
    }
    return len;
}

int32_t ldac_wasm_frame_copy(int32_t handle, uint8_t *out) {
    if (!handle || !out) return -1;
    ldacw_encoder *e = (ldacw_encoder *)(intptr_t)handle;
    const int len = ldac_wasm_frame_len(handle);
    if (len <= 0) return 0;
    memcpy(out, e->pending + e->pending_off, (size_t)len);
    e->pending_off += (size_t)len;
    if (e->pending_off == e->pending_len) {
        e->pending_len = 0;
        e->pending_off = 0;
    }
    return len;
}

void ldac_wasm_encoder_free(int32_t handle) {
    if (!handle) return;
    ldacw_encoder *e = (ldacw_encoder *)(intptr_t)handle;
    if (e->handle) ldacBT_free_handle(e->handle);
    free(e->packet);
    free(e->pending);
    free(e);
}

int32_t ldac_wasm_decoder_new(int32_t rate, int32_t channels) {
    if (rate != 44100 && rate != 48000) return 0;
    if (channels != 1 && channels != 2) return 0;
    ldacw_decoder *d = (ldacw_decoder *)calloc(1, sizeof(ldacw_decoder));
    if (!d) return 0;
    d->rate = rate;
    d->channels = channels;
    if (ldacdecInit(&d->dec) < 0) {
        free(d);
        return 0;
    }
    return (int32_t)(intptr_t)d;
}

int32_t ldac_wasm_decode_block(int32_t handle, uint8_t *frame, int32_t frame_bytes, int16_t *out) {
    if (!handle || !frame || frame_bytes < 4 ||
        frame_bytes > (int32_t)ENC_FRAME_BYTES_MAX || !out) {
        return -1;
    }
    ldacw_decoder *d = (ldacw_decoder *)(intptr_t)handle;
    const int payload = ldac_payload_len(frame, (size_t)frame_bytes);
    if (payload <= 0 || payload + 3 != frame_bytes) return -1;
    /* Per-frame consistency, as the helper does before decoding: */
    const int sfid = ((int)frame[1] >> 5) & 0x07;
    const int cci = ((int)frame[1] >> 3) & 0x03;
    if (sfid != (d->rate == 44100 ? 0 : 1)) return -1;
    if (cci != (d->channels == 1 ? 0 : 2)) return -1;

    /* libldacdec writes interleaved s16 samples for the whole frame. */
    int16_t *scratch = (int16_t *)calloc(
        (size_t)(MAX_FRAME_SAMPLES * d->channels + 2), sizeof(int16_t));
    if (!scratch) return -1;
    int used = 0;
    const int rc = ldacDecode(&d->dec, frame, scratch, &used);
    if (rc < 0) {
        free(scratch);
        return -1;
    }
    const int frame_samples = d->dec.frame.frameSamples;
    if (ldacdecGetSampleRate(&d->dec) != d->rate ||
        ldacdecGetChannelCount(&d->dec) != d->channels ||
        frame_samples <= 0 || frame_samples > MAX_FRAME_SAMPLES) {
        free(scratch);
        return -1;
    }
    memcpy(out, scratch,
           (size_t)frame_samples * (size_t)d->channels * sizeof(int16_t));
    free(scratch);
    return frame_samples;
}

void ldac_wasm_decoder_free(int32_t handle) {
    if (!handle) return;
    ldacw_decoder *d = (ldacw_decoder *)(intptr_t)handle;
    free(d);
}
