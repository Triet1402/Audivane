import type { Pcm16Layout, PcmAudio } from "./types.js";
import { assertSupportedSampleRate } from "./validate.js";

/**
 * Decode already-validated little-endian interleaved WAV PCM16 into planar
 * Float64. Samples are signed integers divided by 32768, matching the native
 * soundfile convention. This is not a WAV header parser: the strict browser
 * adapter supplies the layout after its own chunk validation.
 */
export function decodePcm16(bytes: Uint8Array, layout: Pcm16Layout): PcmAudio {
  if (!(bytes instanceof Uint8Array)) throw new Error("PCM16 bytes must be a Uint8Array");
  assertSupportedSampleRate(layout.sampleRate, "PCM16");
  const channels = layout.channels;
  if (channels !== 1 && channels !== 2) throw new Error("PCM16 layout supports mono or stereo only");

  const { dataOffset, dataSize } = layout;
  if (!Number.isSafeInteger(dataOffset) || dataOffset < 0) {
    throw new Error("PCM16 dataOffset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(dataSize) || dataSize <= 0) {
    throw new Error("PCM16 dataSize must be a positive integer");
  }
  if (dataOffset + dataSize > bytes.length) {
    throw new Error("PCM16 data range exceeds the supplied bytes");
  }
  const blockAlign = channels * 2;
  if (dataSize % blockAlign !== 0) {
    throw new Error("PCM16 data is not a whole number of frames");
  }
  const frames = dataSize / blockAlign;
  if (frames <= 0) throw new Error("PCM16 data contains no frames");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const planar: Float64Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    planar.push(new Float64Array(frames));
  }
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = view.getInt16(dataOffset + (frame * channels + channel) * 2, true);
      const target = planar[channel];
      if (!target) throw new Error("PCM16 channel disappeared");
      target[frame] = sample / 32768;
    }
  }

  return { sampleRate: layout.sampleRate, channels: planar };
}
