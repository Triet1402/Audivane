/*
 * Minimal ABI stand-in for the pinned hegdi/libldacdec 7f3bd6cc header.
 *
 * The real build (tools/build_codec_wasm.sh) compiles libldacdec's ldacdec.h.
 * tools/ldac_wasm.c only touches the struct path d->dec.frame.frameSamples
 * and the four functions below; this stand-in provides an ABI-sufficient
 * shape so the fault-injection harness can compile the real glue without
 * the pinned decoder tree. Real identity of the built artifact stays owned
 * by tools/build_codec_wasm.sh pinning.
 */
#ifndef LDAC_WASM_LIFECYCLE_STUB_LDACDEC_H
#define LDAC_WASM_LIFECYCLE_STUB_LDACDEC_H

#include <stdint.h>

#define MAX_QUANT_UNITS     (34)
#define MAX_FRAME_SAMPLES   (256)

typedef struct { int opaque; } Mdct;

typedef struct Frame frame_t;
typedef struct Channel channel_t;

struct Frame {
    int sampleRateId;
    int channelConfigId;
    int frameLength;
    int frameStatus;
    int frameSamplesPower;
    int frameSamples;
};

struct Channel {
    frame_t *frame;
    Mdct mdct;
};

typedef struct {
    frame_t frame;
} ldacdec_t;

int ldacdecInit(ldacdec_t *this);
int ldacDecode(ldacdec_t *this, uint8_t *stream, int16_t *pcm, int *bytesUsed);
int ldacdecGetSampleRate(ldacdec_t *this);
int ldacdecGetChannelCount(ldacdec_t *this);

#endif /* LDAC_WASM_LIFECYCLE_STUB_LDACDEC_H */
