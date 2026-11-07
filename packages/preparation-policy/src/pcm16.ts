import { PreparationPolicyError } from "./errors.js";

/** Canonical WAV header size for the uncompressed PCM16 files this module writes. */
export const PCM16_WAV_HEADER_BYTES = 44;

/**
 * libsndfile's PCM16 float writer adds 2^-17 of a code step before flooring.
 * This is invisible for exact multiples (the fractions verified by the root
 * brief) but decides which side of an integer boundary a near-boundary float
 * lands on. Measured against the installed soundfile 0.14.0/libsndfile writer
 * over 200k random samples plus boundary probes: 0 mismatches.
 */
export const PCM16_FLOOR_BIAS = 2 ** -17;

export interface EncodedPcm16Wav {
  readonly bytes: Uint8Array;
  readonly dataOffset: number;
  readonly dataSize: number;
}

/**
 * One float sample -> signed PCM16 integer.
 *
 * The policy uses floor semantics matching the installed
 * soundfile/libsndfile PCM16 float writer, including negative fractions and
 * that writer's 2^-17 pre-floor bias:
 * `-1.5/32768 -> -2`, `-0.9/32768 -> -1`, `0.9/32768 -> 0`, `1.5/32768 -> 1`.
 * Out-of-range values are clamped to the representable signed range so a
 * writer can never wrap. Policy output should already be at or below the
 * ceiling; reaching a clamp indicates a programming error, not normal flow.
 */
export function quantizePcm16Sample(value: number): number {
  if (!Number.isFinite(value)) {
    throw new PreparationPolicyError(
      "nonfinite-processing",
      "Cannot quantize a non-finite sample to PCM16",
    );
  }
  const scaled = Math.floor(value * 32768 + PCM16_FLOOR_BIAS);
  if (scaled < -32768) return -32768;
  if (scaled > 32767) return 32767;
  return scaled;
}

function writeFourCc(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < 4; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

interface CanonicalWavBuffer {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly frames: number;
  readonly channelCount: number;
  readonly dataSize: number;
}

function canonicalWavBuffer(
  channels: readonly Float64Array[],
  sampleRate: number,
): CanonicalWavBuffer {
  const channelCount = channels.length;
  if (channelCount !== 1 && channelCount !== 2) {
    throw new PreparationPolicyError(
      "invalid-pcm",
      "PCM16 WAV serialization supports mono or stereo only",
    );
  }
  const frames = channels[0]?.length ?? 0;
  if (frames <= 0) {
    throw new PreparationPolicyError("empty-crop", "Cannot serialize an empty WAV");
  }
  for (let channel = 0; channel < channelCount; channel += 1) {
    if ((channels[channel]?.length ?? -1) !== frames) {
      throw new PreparationPolicyError(
        "invalid-pcm",
        "PCM16 WAV channels must have equal lengths",
      );
    }
  }

  const dataSize = frames * channelCount * 2;
  const buffer = new ArrayBuffer(PCM16_WAV_HEADER_BYTES + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const blockAlign = channelCount * 2;

  writeFourCc(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeFourCc(view, 8, "WAVE");
  writeFourCc(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeFourCc(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return { bytes, view, frames, channelCount, dataSize };
}

/**
 * Serialize planar float channels as a canonical little-endian PCM16 WAV.
 * No dither, no extra chunks, no header-shape compatibility promise. Samples
 * are interleaved frame by frame in channel-major order.
 */
export function encodePcm16Wav(
  channels: readonly Float64Array[],
  sampleRate: number,
): EncodedPcm16Wav {
  const buffer = canonicalWavBuffer(channels, sampleRate);
  let offset = PCM16_WAV_HEADER_BYTES;
  for (let frame = 0; frame < buffer.frames; frame += 1) {
    for (let channel = 0; channel < buffer.channelCount; channel += 1) {
      const samples = channels[channel];
      if (!samples) throw new PreparationPolicyError("invalid-pcm", "Missing PCM channel");
      buffer.view.setInt16(
        offset,
        quantizePcm16Sample(samples[frame] ?? Number.NaN),
        true,
      );
      offset += 2;
    }
  }
  return {
    bytes: buffer.bytes,
    dataOffset: PCM16_WAV_HEADER_BYTES,
    dataSize: buffer.dataSize,
  };
}

/**
 * Serialize with the frozen two-step gain arithmetic without materializing the
 * gained and trimmed Float64 copies. Each sample is still evaluated as
 * `(sample * gainFactor) * commonTrim` before the unchanged quantizer, so the
 * delivered bytes are identical to scaling first and serializing afterwards.
 * This is a long-material memory optimization only; it changes no policy value.
 */
export function encodeGainedPcm16Wav(
  channels: readonly Float64Array[],
  sampleRate: number,
  gainFactor: number,
  commonTrim: number,
): EncodedPcm16Wav {
  if (!Number.isFinite(gainFactor) || gainFactor <= 0) {
    throw new PreparationPolicyError(
      "nonfinite-processing",
      `Gain factor ${String(gainFactor)} is not finite and positive`,
    );
  }
  if (!Number.isFinite(commonTrim) || commonTrim <= 0) {
    throw new PreparationPolicyError(
      "nonfinite-processing",
      `Common trim ${String(commonTrim)} is not finite and positive`,
    );
  }
  const buffer = canonicalWavBuffer(channels, sampleRate);
  let offset = PCM16_WAV_HEADER_BYTES;
  for (let frame = 0; frame < buffer.frames; frame += 1) {
    for (let channel = 0; channel < buffer.channelCount; channel += 1) {
      const samples = channels[channel];
      if (!samples) throw new PreparationPolicyError("invalid-pcm", "Missing PCM channel");
      // Preserve the frozen order: scale by the independent gain, then by the
      // common trim. Do not fold the factors into one multiplication.
      const gained = (samples[frame] ?? Number.NaN) * gainFactor;
      const final = gained * commonTrim;
      if (!Number.isFinite(final)) {
        throw new PreparationPolicyError(
          "nonfinite-processing",
          `Gain processing produced a non-finite sample at channel ${channel}, frame ${frame}`,
        );
      }
      buffer.view.setInt16(offset, quantizePcm16Sample(final), true);
      offset += 2;
    }
  }
  return {
    bytes: buffer.bytes,
    dataOffset: PCM16_WAV_HEADER_BYTES,
    dataSize: buffer.dataSize,
  };
}
