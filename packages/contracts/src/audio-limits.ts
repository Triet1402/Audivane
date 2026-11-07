/**
 * Current local-audio envelope.
 *
 * The current TypeScript engines accept a larger source than the earlier
 * ten-minute/256 MiB spike. These values are derived from the maximum
 * supported layout rather than chosen as round numbers, so downstream WAV,
 * decoded-PCM and retained-evidence limits cannot silently disagree.
 *
 * Capacity basis: 1800.5 s delivery at 96 kHz stereo PCM16 is 691_392_044
 * bytes. A native Float64 side for the 1810 s refusal-sentinel decode is
 * 2_780_160_000 bytes. Both fit safely below the 4 GiB RIFF/ArrayBuffer
 * addressability limits; browser availability is still a separate, disclosed
 * runtime constraint, not a guarantee.
 */
export const AUDIO_MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const AUDIO_MAX_DURATION_SECONDS = 1800;
/** Small, explicit end padding budgets; accepted audio is never cropped to fit. */
export const AUDIO_MAX_SOURCE_PADDING_SECONDS = 0.1;
export const AUDIO_MAX_DELIVERY_PADDING_SECONDS = 0.5;
export const AUDIO_MAX_DELIVERY_SECONDS =
  AUDIO_MAX_DURATION_SECONDS + AUDIO_MAX_DELIVERY_PADDING_SECONDS;
/** Decode beyond every acceptance ceiling so a truncated prefix cannot pass. */
export const AUDIO_DECODE_SENTINEL_SECONDS = 10;
/** Canonical source/decoded container support is mono/stereo up to 96 kHz. */
export const AUDIO_MAX_SAMPLE_RATE = 96_000;
export const AUDIO_MAX_CHANNELS = 2;
export const AUDIO_PCM16_BYTES_PER_SAMPLE = 2;
export const AUDIO_FLOAT64_BYTES_PER_SAMPLE = 8;
/** Delivery-frame ceiling at the maximum supported rate. */
export const AUDIO_MAX_DELIVERY_FRAMES = Math.ceil(
  AUDIO_MAX_DELIVERY_SECONDS * AUDIO_MAX_SAMPLE_RATE,
);
/** One canonical 44-byte-header PCM16 WAV at the maximum delivery layout. */
export const AUDIO_MAX_WAV_BYTES = 44 +
  AUDIO_MAX_DELIVERY_FRAMES * AUDIO_MAX_CHANNELS * AUDIO_PCM16_BYTES_PER_SAMPLE;
/** Canary DSP stays frozen; producers may select this prefix of long Side A. */
export const AUDIO_CANARY_EXCERPT_SECONDS = 10;
/** One canonical PCM16 canary WAV at the maximum layout. */
export const AUDIO_MAX_CANARY_WAV_BYTES = 44 +
  AUDIO_CANARY_EXCERPT_SECONDS * AUDIO_MAX_SAMPLE_RATE * AUDIO_MAX_CHANNELS *
    AUDIO_PCM16_BYTES_PER_SAMPLE;
/**
 * Two full deliveries plus the independently bounded pristine/degraded canary
 * pair. This is a capacity bound, not a claim that every host can allocate it.
 */
export const AUDIO_MAX_RETAINED_BYTES = 2 * AUDIO_MAX_WAV_BYTES +
  2 * AUDIO_MAX_CANARY_WAV_BYTES;
/**
 * One decoded native Float64 side, including the ten-second refusal-sentinel
 * headroom. The post-decode duration check still rejects anything above the
 * source/delivery ceilings, so hitting this byte bound cannot be served as a
 * shortened success.
 */
export const AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE = Math.ceil(
  (AUDIO_MAX_DURATION_SECONDS + AUDIO_DECODE_SENTINEL_SECONDS) * AUDIO_MAX_SAMPLE_RATE,
) * AUDIO_MAX_CHANNELS * AUDIO_FLOAT64_BYTES_PER_SAMPLE;
/** Two final Float64 sides at the delivery ceiling, before PCM16 serialization. */
export const AUDIO_MAX_RETAINED_FLOAT64_BYTES = 2 *
  AUDIO_MAX_DELIVERY_FRAMES * AUDIO_MAX_CHANNELS * AUDIO_FLOAT64_BYTES_PER_SAMPLE;
