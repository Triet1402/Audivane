import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_CANARY_EXCERPT_SECONDS,
  AUDIO_MAX_CANARY_WAV_BYTES,
  AUDIO_MAX_CHANNELS,
  AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE,
  AUDIO_MAX_DELIVERY_FRAMES,
  AUDIO_MAX_DELIVERY_PADDING_SECONDS,
  AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_RETAINED_BYTES,
  AUDIO_MAX_RETAINED_FLOAT64_BYTES,
  AUDIO_MAX_SAMPLE_RATE,
  AUDIO_MAX_SOURCE_PADDING_SECONDS,
  AUDIO_MAX_WAV_BYTES,
  AUDIO_PCM16_BYTES_PER_SAMPLE,
  AUDIO_DECODE_SENTINEL_SECONDS,
} from "../src/audio-limits.js";

const MIB = 1024 * 1024;

test("source acceptance is the requested 512 MiB / 1800 s envelope", () => {
  assert.equal(AUDIO_MAX_INPUT_BYTES, 512 * MIB);
  assert.equal(AUDIO_MAX_DURATION_SECONDS, 1800);
});

test("canonical delivery and retained bounds are derived from max frames/layout", () => {
  assert.equal(AUDIO_MAX_SAMPLE_RATE, 96_000);
  assert.equal(AUDIO_MAX_CHANNELS, 2);
  assert.equal(AUDIO_MAX_SOURCE_PADDING_SECONDS, 0.1);
  assert.equal(AUDIO_MAX_DELIVERY_PADDING_SECONDS, 0.5);
  assert.equal(AUDIO_MAX_DELIVERY_SECONDS, 1800.5);
  assert.equal(AUDIO_MAX_DELIVERY_FRAMES, 1800.5 * 96_000);
  assert.ok(Number.isSafeInteger(AUDIO_MAX_DELIVERY_FRAMES));

  const expectedWav = 44 + AUDIO_MAX_DELIVERY_FRAMES * 2 * 2;
  assert.equal(AUDIO_MAX_WAV_BYTES, expectedWav);
  // A canonical RIFF uint32 size field and ArrayBuffer can address this file.
  assert.ok(AUDIO_MAX_WAV_BYTES - 8 < 0xffff_ffff);
  assert.ok(AUDIO_MAX_WAV_BYTES > 600 * 96_000 * 2 * 2);
  // Decoded/helper PCM has a separate ceiling: a valid compressed source may
  // expand past the encoded-source byte limit without exceeding its duration.
  const thirtyMinuteHelperPcmBytes = 1800 * 96_000 * 2 * 2;
  assert.ok(thirtyMinuteHelperPcmBytes > AUDIO_MAX_INPUT_BYTES);
  assert.ok(thirtyMinuteHelperPcmBytes <= AUDIO_MAX_WAV_BYTES - 44);

  assert.equal(
    AUDIO_MAX_CANARY_WAV_BYTES,
    44 + AUDIO_CANARY_EXCERPT_SECONDS * 96_000 * 2 * 2,
  );
  assert.equal(
    AUDIO_MAX_RETAINED_BYTES,
    2 * AUDIO_MAX_WAV_BYTES + 2 * AUDIO_MAX_CANARY_WAV_BYTES,
  );
  assert.ok(Number.isSafeInteger(AUDIO_MAX_RETAINED_BYTES));
  // The former 1 GiB envelope cannot cover two 1800.5 s 96 kHz stereo sides.
  assert.ok(AUDIO_MAX_RETAINED_BYTES > 1024 * MIB);
  assert.ok(AUDIO_MAX_RETAINED_BYTES > 2 * 691_392_000);
});

test("native decoded bounds cover the sentinel decode but not an unbounded prefix", () => {
  const sourceFrames = Math.ceil(
    (AUDIO_MAX_DURATION_SECONDS + AUDIO_MAX_SOURCE_PADDING_SECONDS) * 96_000,
  );
  const deliveryFrames = AUDIO_MAX_DELIVERY_FRAMES;
  const float64PerSideAtDelivery = deliveryFrames * 2 * 8;
  const float64PerSideAtSentinel = Math.ceil(
    (AUDIO_MAX_DURATION_SECONDS + AUDIO_DECODE_SENTINEL_SECONDS) * 96_000,
  ) * 2 * 8;

  assert.ok(sourceFrames < deliveryFrames);
  assert.equal(AUDIO_PCM16_BYTES_PER_SAMPLE, 2);
  assert.equal(AUDIO_DECODE_SENTINEL_SECONDS, 10);
  assert.equal(float64PerSideAtDelivery, 2_765_568_000);
  assert.equal(AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE, float64PerSideAtSentinel);
  assert.ok(AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE > float64PerSideAtDelivery);
  assert.equal(AUDIO_MAX_RETAINED_FLOAT64_BYTES, 2 * float64PerSideAtDelivery);
  assert.ok(Number.isSafeInteger(AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE));
  assert.ok(Number.isSafeInteger(AUDIO_MAX_RETAINED_FLOAT64_BYTES));
});
