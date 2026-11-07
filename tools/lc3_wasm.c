/*
 * lc3_wasm.c -- supplemental LC3 codec glue for the browser engine.
 *
 * Frame-level wrapper over pinned liblc3 (same source family as the native
 * vendored FFmpeg tier), compiled to WASM by tools/build_codec_wasm.sh and
 * loaded by packages/engine-browser/src/supplemental-codecs.ts. The rate,
 * bitrate and delay math mirrors FFmpeg 9.0.2's libavcodec/liblc3enc.c
 * wrapper exactly:
 *
 *   block_bytes      = lc3_hr_frame_block_bytes(hr, dt, sr, nch, bitrate)
 *   effective_bps    = lc3_hr_resolve_bitrate(hr, dt, sr, block_bytes)
 *   frame_samples    = lc3_hr_frame_samples(hr, dt, sr)
 *   delay_samples    = lc3_hr_delay_samples(hr, dt, sr)
 *   per-channel size = block_bytes/nch + (ch < block_bytes%nch),
 *                      concatenated per channel within one frame
 *
 * PCM enters as interleaved s16le and is converted to float with the same
 * scale FFmpeg's pcm_s16le -> float conversion uses (divide by 32768), because
 * the native wrapper feeds liblc3 in LC3_PCM_FORMAT_FLOAT; decoding returns
 * s16le after the mirrored float -> s16 rounding (multiply by 32768, round
 * half-to-even via lrintf, clamp). Parity is asserted by
 * packages/engine-browser/test/supplemental-codecs.test.ts.
 *
 * Exported ABI (all little-endian, single-threaded reuse):
 *   int32_t lc3_encoder_new(rate, channels, bitrate_bps, frame_us, meta*4);
 *   int32_t lc3_encode_block(handle, int16_t pcm_block[]);
 *       -> exactly frame_samples * channels s16 samples per call
 *   int32_t lc3_frame_len(handle);
 *   int32_t lc3_frame_copy(handle, uint8 out[]);
 *       -> copies block_bytes (payload of the last encoded block)
 *   void    lc3_encoder_free(handle);
 *   int32_t lc3_decoder_new(rate, channels, frame_us, hr_mode);
 *   int32_t lc3_decode_block(handle, uint8 frame[], nbytes, int16 out[]);
 *       -> writes frame_samples * channels s16 samples; returns 0/1(PLC)/-1
 *   void    lc3_decoder_free(handle);
 */

#include <lc3.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    int rate, channels, bitrate_bps, frame_us;
    int block_bytes, frame_samples, delay_samples, effective_bitrate;
    int hr_mode;
    float *pcm_scratch;              /* frame_samples * channels floats */
    uint8_t *out_block;              /* block_bytes contiguous frame payload */
    void *state_mem;                 /* channels * lc3_hr_encoder_size block */
    lc3_encoder_t encoder[2];
} lc3w_encoder;

typedef struct {
    int rate, channels, frame_us;
    int frame_bytes;                 /* read from the incoming frame payload */
    int frame_samples_local;
    int hr_mode;
    float *pcm_scratch;              /* frame_samples * channels floats */
    void *state_mem;                 /* channels * lc3_hr_decoder_size block */
    lc3_decoder_t decoder[2];
} lc3w_decoder;

#define MAX_ENCODER_CHANNELS 2
#define MAX_FRAME_BYTES 1024

static int valid_dt(int frame_us) {
    return frame_us == 2500 || frame_us == 5000 ||
           frame_us == 7500 || frame_us == 10000;
}

static float s16_to_f32(int16_t v) { return (float)v / 32768.0f; }

static int16_t f32_to_s16(float v) {
    if (isnan(v)) return 0;
    if (v >= 1.0f) return 32767;
    if (v <= -1.0f) return -32768;
    long r = lrintf(v * 32768.0f);
    if (r > 32767) r = 32767;
    if (r < -32768) r = -32768;
    return (int16_t)r;
}

int32_t lc3_encoder_new(int32_t rate, int32_t channels, int32_t bitrate_bps,
                        int32_t frame_us, int32_t *meta) {
    if (channels < 1 || channels > MAX_ENCODER_CHANNELS) return 0;
    if (!valid_dt(frame_us)) return 0;
    if (rate != 8000 && rate != 16000 && rate != 24000 &&
        rate != 32000 && rate != 48000 && rate != 96000) return 0;
    if (bitrate_bps < 16000 || bitrate_bps > 320000) return 0;

    int hr_mode = (rate > 48000) && (rate >= 48000);
    if (frame_us == 7500 && hr_mode) return 0;

    int block_bytes = lc3_hr_frame_block_bytes(
        hr_mode, frame_us, rate, channels, bitrate_bps);
    if (block_bytes <= 0 || block_bytes > MAX_FRAME_BYTES) return 0;

    lc3w_encoder *e = (lc3w_encoder *)calloc(1, sizeof(lc3w_encoder));
    if (!e) return 0;
    e->rate = rate;
    e->channels = channels;
    e->bitrate_bps = bitrate_bps;
    e->frame_us = frame_us;
    e->hr_mode = hr_mode;
    e->block_bytes = block_bytes;
    e->frame_samples = lc3_hr_frame_samples(hr_mode, frame_us, rate);
    e->delay_samples = lc3_hr_delay_samples(hr_mode, frame_us, rate);
    e->effective_bitrate = lc3_hr_resolve_bitrate(hr_mode, frame_us, rate, block_bytes);
    if (e->frame_samples <= 0 || e->delay_samples < 0 || e->effective_bitrate <= 0) {
        free(e);
        return 0;
    }

    unsigned size = lc3_hr_encoder_size(hr_mode, frame_us, rate);
    if (size == 0) { free(e); return 0; }
    void *mem = calloc((size_t)channels, size);
    if (!mem) { free(e); return 0; }
    e->state_mem = mem;
    e->pcm_scratch = (float *)calloc((size_t)e->frame_samples * channels, sizeof(float));
    e->out_block = (uint8_t *)calloc(1, (size_t)e->block_bytes + 3);
    if (!e->pcm_scratch || !e->out_block) {
        free(e->out_block); free(e->pcm_scratch); free(mem); free(e); return 0;
    }
    for (int ch = 0; ch < channels; ch += 1) {
        e->encoder[ch] = lc3_hr_setup_encoder(
            hr_mode, frame_us, rate, 0,
            (char *)mem + (size_t)ch * size);
        if (!e->encoder[ch]) {
            free(e->out_block); free(e->pcm_scratch); free(mem); free(e);
            return 0;
        }
    }

    if (meta != NULL) {
        meta[0] = e->block_bytes;
        meta[1] = e->frame_samples;
        meta[2] = e->delay_samples;
        meta[3] = e->effective_bitrate;
    }
    return (int32_t)(intptr_t)e;
}

int32_t lc3_encode_block(int32_t handle, int16_t *pcm) {
    if (!handle || !pcm) return -1;
    lc3w_encoder *e = (lc3w_encoder *)(intptr_t)handle;
    const int interp = e->frame_samples * e->channels;
    for (int i = 0; i < interp; i += 1) e->pcm_scratch[i] = s16_to_f32(pcm[i]);
    uint8_t *dst = e->out_block;
    for (int ch = 0; ch < e->channels; ch += 1) {
        int nbytes = e->block_bytes / e->channels + (ch < e->block_bytes % e->channels);
        /* Stride = channels: the scratch holds the interleaved block; each
         * channel frame lands in the contiguous per-channel glue output. */
        if (lc3_encode(e->encoder[ch], LC3_PCM_FORMAT_FLOAT,
                       e->pcm_scratch + ch, e->channels, nbytes, dst) != 0) {
            return -1;
        }
        dst += nbytes;
    }
    return 0;
}

int32_t lc3_frame_len(int32_t handle) {
    if (!handle) return 0;
    return ((lc3w_encoder *)(intptr_t)handle)->block_bytes;
}

int32_t lc3_frame_copy(int32_t handle, uint8_t *out) {
    if (!handle || !out) return -1;
    lc3w_encoder *e = (lc3w_encoder *)(intptr_t)handle;
    memcpy(out, e->out_block, (size_t)e->block_bytes);
    return e->block_bytes;
}

void lc3_encoder_free(int32_t handle) {
    if (!handle) return;
    lc3w_encoder *e = (lc3w_encoder *)(intptr_t)handle;
    /* The per-channel encoder states live at consecutive offsets inside
     * e->state_mem (one contiguous channels * lc3_hr_encoder_size block); the
     * base pointer must be retained so destruction releases all of it. */
    free(e->state_mem);
    free(e->out_block);
    free(e->pcm_scratch);
    free(e);
}

int32_t lc3_decoder_new(int32_t rate, int32_t channels, int32_t frame_us, int32_t hr_mode) {
    if (channels < 1 || channels > MAX_ENCODER_CHANNELS) return 0;
    if (!valid_dt(frame_us)) return 0;
    if (rate != 8000 && rate != 16000 && rate != 24000 &&
        rate != 32000 && rate != 48000 && rate != 96000) return 0;
    lc3w_decoder *d = (lc3w_decoder *)calloc(1, sizeof(lc3w_decoder));
    if (!d) return 0;
    d->rate = rate;
    d->channels = channels;
    d->frame_us = frame_us;
    d->hr_mode = hr_mode != 0;
    d->frame_samples_local = lc3_hr_frame_samples(hr_mode != 0, frame_us, rate);
    if (d->frame_samples_local <= 0) { free(d); return 0; }
    unsigned size = lc3_hr_decoder_size(hr_mode != 0, frame_us, rate);
    if (size == 0) { free(d); return 0; }
    void *mem = calloc((size_t)channels, size);
    if (!mem) { free(d); return 0; }
    d->state_mem = mem;
    d->pcm_scratch = (float *)calloc((size_t)d->frame_samples_local * channels, sizeof(float));
    if (!d->pcm_scratch) { free(mem); free(d); return 0; }
    for (int ch = 0; ch < channels; ch += 1) {
        d->decoder[ch] = lc3_hr_setup_decoder(
            hr_mode != 0, frame_us, rate, 0,
            (char *)mem + (size_t)ch * size);
        if (!d->decoder[ch]) {
            free(d->pcm_scratch);
            free(mem);
            free(d);
            return 0;
        }
    }
    return (int32_t)(intptr_t)d;
}

int32_t lc3_decode_block(int32_t handle, uint8_t *frame, int32_t nbytes, int16_t *out) {
    if (!handle || !out) return -1;
    if (nbytes <= 0 || nbytes > MAX_FRAME_BYTES) return -1;
    lc3w_decoder *d = (lc3w_decoder *)(intptr_t)handle;
    const int frame_samples = d->frame_samples_local;
    const int interp = frame_samples * d->channels;
    int rc = 0;
    /* Frame blocks concatenate one channel frame after another, mirroring
     * FFmpeg's liblc3 decoder wrapper channel splitting. */
    const uint8_t *src = frame;
    for (int ch = 0; ch < d->channels; ch += 1) {
        int nch_bytes = nbytes / d->channels + (ch < nbytes % d->channels);
        if (lc3_decode(d->decoder[ch], src, nch_bytes,
                       LC3_PCM_FORMAT_FLOAT, d->pcm_scratch + ch, d->channels) != 0) {
            rc = -1;
        }
        src += nch_bytes;
    }
    if (rc != 0) return rc;
    for (int i = 0; i < interp; i += 1) out[i] = f32_to_s16(d->pcm_scratch[i]);
    return 0;
}

void lc3_decoder_free(int32_t handle) {
    if (!handle) return;
    lc3w_decoder *d = (lc3w_decoder *)(intptr_t)handle;
    /* Per-channel decoder states share the retained contiguous block; free
     * its base pointer explicitly (pcm_scratch and the struct are separate). */
    free(d->state_mem);
    free(d->pcm_scratch);
    free(d);
}
