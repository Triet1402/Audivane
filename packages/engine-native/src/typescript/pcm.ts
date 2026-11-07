import {
  AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE,
  AUDIO_MAX_RETAINED_FLOAT64_BYTES,
} from "@codec-abx/contracts";
import type { PcmAudio } from "@codec-abx/measurements";

/**
 * Codec-stage samples are planar Float64, explicitly not PCM16 and not clipped
 * by this module. Codec encoders may themselves quantize or clamp; those input
 * excursions are counted and disclosed by the executor.
 *
 * The per-side bound includes the ten-second refusal-sentinel decode window,
 * so a capped/truncated read cannot be mistaken for a complete 1800 s source.
 * The post-decode duration check remains the acceptance authority. The retained
 * pair bound covers two 1800.5 s 96 kHz stereo Float64 sides.
 */
export const NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE =
  AUDIO_MAX_DECODED_FLOAT64_BYTES_PER_SIDE;
export const NATIVE_CODEC_MAX_RETAINED_PCM_BYTES =
  AUDIO_MAX_RETAINED_FLOAT64_BYTES;

export interface NativePcmScan {
  readonly peak: number;
  readonly samplesOutsideUnitRange: number;
}

export function validatePcmLayout(
  pcm: PcmAudio,
  sampleRate: number,
  channels: 1 | 2,
  label: string,
): number {
  if (!pcm || typeof pcm !== "object") throw new Error(`${label} PCM is not an object`);
  if (pcm.sampleRate !== sampleRate) {
    throw new Error(`${label} PCM rate ${String(pcm.sampleRate)} disagrees with ${String(sampleRate)}`);
  }
  if (!Array.isArray(pcm.channels) || pcm.channels.length !== channels) {
    throw new Error(`${label} PCM channel count disagrees with ${String(channels)}`);
  }
  const frames = pcm.channels[0]?.length ?? 0;
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    throw new Error(`${label} PCM contains no frames`);
  }
  for (const channel of pcm.channels) {
    if (!(channel instanceof Float64Array) || channel.length !== frames) {
      throw new Error(`${label} PCM channels must be equal-length Float64Array instances`);
    }
  }
  const bytes = frames * channels * 8;
  if (bytes > NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE) {
    throw new Error(
      `${label} PCM is ${String(bytes)} bytes, above the ` +
        `${String(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE)} byte per-side decoded bound`,
    );
  }
  return frames;
}

export function scanPcm(pcm: PcmAudio, label: string): NativePcmScan {
  let peak = 0;
  let samplesOutsideUnitRange = 0;
  for (let channel = 0; channel < pcm.channels.length; channel += 1) {
    const samples = pcm.channels[channel];
    if (!(samples instanceof Float64Array)) {
      throw new Error(`${label} PCM channel ${String(channel)} is not Float64Array`);
    }
    for (let frame = 0; frame < samples.length; frame += 1) {
      const value = samples[frame]!;
      if (!Number.isFinite(value)) {
        throw new Error(`${label} PCM contains a non-finite sample at frame ${String(frame)}`);
      }
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      if (magnitude > 1) samplesOutsideUnitRange += 1;
    }
  }
  return Object.freeze({ peak, samplesOutsideUnitRange });
}

/** Serialize interleaved little-endian Float64 for FFmpeg's raw f64le input. */
export function serializeFloat64Pcm(pcm: PcmAudio, label: string): Buffer {
  const channels = pcm.channels.length;
  if (channels !== 1 && channels !== 2) throw new Error(`${label} PCM must be mono or stereo`);
  const frames = validatePcmLayout(
    pcm,
    pcm.sampleRate,
    channels === 1 ? 1 : 2,
    label,
  );
  const bytes = Buffer.allocUnsafe(frames * channels * 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = pcm.channels[channel]![frame]!;
      if (!Number.isFinite(value)) {
        throw new Error(`${label} PCM contains a non-finite sample at frame ${String(frame)}`);
      }
      view.setFloat64(offset, value, true);
      offset += 8;
    }
  }
  return bytes;
}

/** Parse raw interleaved f64le bytes without lossy conversion or clipping. */
export function parseFloat64Pcm(
  bytes: Uint8Array,
  sampleRate: number,
  channels: 1 | 2,
  label: string,
): PcmAudio {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${label} PCM bytes must be a Uint8Array`);
  if (bytes.byteLength > NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE) {
    throw new Error(
      `${label} decoded PCM is ${String(bytes.byteLength)} bytes, above the ` +
        `${String(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE)} byte per-side bound`,
    );
  }
  const blockAlign = channels * 8;
  if (bytes.byteLength === 0 || bytes.byteLength % blockAlign !== 0) {
    throw new Error(`${label} decoded PCM is empty or not a whole number of frames`);
  }
  const frames = bytes.byteLength / blockAlign;
  const planar: Float64Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    planar.push(new Float64Array(frames));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = view.getFloat64(offset, true);
      if (!Number.isFinite(value)) {
        throw new Error(`${label} decoded PCM contains a non-finite sample at frame ${String(frame)}`);
      }
      planar[channel]![frame] = value;
      offset += 8;
    }
  }
  return { sampleRate, channels: planar };
}

/**
 * Read bounded raw PCM directly into its final planar arrays. A high-rate
 * thirty-minute decode exceeds fs.readFile's 2 GiB single-file limit; keeping
 * one interleaved copy as well would also double the peak decode allocation.
 * readRange must return the requested range in full or reject.
 */
export async function readFloat64PcmChunks(
  byteLength: number,
  readRange: (offset: number, length: number) => Promise<Uint8Array>,
  sampleRate: number,
  channels: 1 | 2,
  label: string,
  checkCancelled: () => void = () => {},
): Promise<PcmAudio> {
  const blockAlign = channels * 8;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % blockAlign !== 0) {
    throw new Error(`${label} decoded PCM is empty or not a whole number of frames`);
  }
  if (byteLength > NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE) {
    throw new Error(`${label} decoded PCM exceeds the per-side bound`);
  }
  checkCancelled();
  const frames = byteLength / blockAlign;
  const planar = Array.from({ length: channels }, () => new Float64Array(frames));
  const chunkBytes = 1024 * 1024;
  for (let offset = 0; offset < byteLength; offset += chunkBytes) {
    checkCancelled();
    const length = Math.min(chunkBytes, byteLength - offset);
    const bytes = await readRange(offset, length);
    checkCancelled();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new Error(`${label} decoded PCM changed or ended during reading`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const firstFrame = offset / blockAlign;
    for (let localOffset = 0; localOffset < length; localOffset += blockAlign) {
      const frame = firstFrame + localOffset / blockAlign;
      for (let channel = 0; channel < channels; channel += 1) {
        const value = view.getFloat64(localOffset + channel * 8, true);
        if (!Number.isFinite(value)) {
          throw new Error(`${label} decoded PCM contains a non-finite sample at frame ${frame}`);
        }
        planar[channel]![frame] = value;
      }
    }
  }
  return { sampleRate, channels: planar };
}

export function pcmDurationSeconds(pcm: PcmAudio): number {
  const frames = pcm.channels[0]?.length ?? 0;
  if (pcm.sampleRate <= 0 || frames <= 0) return 0;
  return frames / pcm.sampleRate;
}
