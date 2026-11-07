/**
 * Byte-exact LC3 raw container (FFmpeg `lc3` muxer format), for the browser's
 * supplemental liblc3 codec.
 *
 * The pinned @ffmpeg/core 0.12.10 has no LC3 codec or muxer, so the supplemental
 * codec encodes frames with a WASM build of pinned liblc3 1.1.3 and assembles
 * the Bluetooth SIG test-suite bitstream that FFmpeg's `lc3` raw muxer writes.
 * Keeping the container identical to the native side means a native
 * ffmpeg/liblc3 command can decode browser-encoded bytes and vice versa.
 *
 * Byte layout (all fields little-endian except the leading tag, per
 * libavformat/lc3.c in FFmpeg 9.0.2):
 *
 *   wb16 0x1ccc        tag (big-endian)
 *   wl16 (9+hr)*2      header size in bytes (18 without high-resolution mode)
 *   wl16 srate_hz / 100
 *   wl16 bit_rate / 100
 *   wl16 channels
 *   wl16 frame_us / 10 (100 for 10 ms)
 *   wl16 ep_mode       (always 0 here)
 *   wl32 nb_samples    authoritative unpadded sample count per channel
 *   wl16 hr_mode       only when hr_mode != 0 (header size 20)
 * then per frame: wl16 size, size payload bytes.
 *
 * The supplemental encoder writes ceil(samples / frame_samples) frames plus one
 * flush frame whose payload completes the encoder's internal lookahead, exactly
 * like the native ffmpeg liblc3 pipeline; decode returns exactly `nb_samples`.
 */

export interface Lc3ContainerHeader {
  readonly sampleRateHz: number;
  readonly bitrateBps: number;
  readonly channels: 1 | 2;
  readonly frameDurationUs: number;
  readonly epMode: boolean;
  /** Authoritative unpadded length in sample frames per channel. */
  readonly totalSamples: number;
  readonly hrMode: boolean;
}

const LC3_TAG = 0x1ccc;
const HEADER_UNITS_NON_HR = 9;
const SUPPORTED_SAMPLE_RATES_HZ = [8_000, 16_000, 24_000, 32_000, 48_000, 96_000] as const;
const SUPPORTED_FRAME_DURATIONS_US = [2_500, 5_000, 7_500, 10_000] as const;
export const LC3_FRAME_SAMPLES_PER_MS = [2.5, 4, 6, 8] as const;

export function lc3HeaderSize(hrMode: boolean): number {
  return (HEADER_UNITS_NON_HR + (hrMode ? 1 : 0)) * 2;
}

function assertSupported(sampleRateHz: number, frameDurationUs: number): void {
  if (!SUPPORTED_SAMPLE_RATES_HZ.includes(sampleRateHz as 8_000)) {
    throw new Error(`LC3 container: unsupported sample rate ${String(sampleRateHz)} Hz`);
  }
  if (!SUPPORTED_FRAME_DURATIONS_US.includes(frameDurationUs as 2_500)) {
    throw new Error(`LC3 container: unsupported frame duration ${String(frameDurationUs)} µs`);
  }
  if (frameDurationUs === 7_500 && sampleRateHz > 48_000) {
    throw new Error("LC3 container: 7.5 ms frames are not valid above 48 kHz");
  }
}

/** Rounded sample count in one frame, FFmpeg's av_rescale(frame_us, srate Hz, 1e6). */
export function lc3FrameSamples(sampleRateHz: number, frameDurationUs: number): number {
  assertSupported(sampleRateHz, frameDurationUs);
  return Math.round((frameDurationUs * sampleRateHz) / 1_000_000);
}

export function writeLc3Header(header: Lc3ContainerHeader): Uint8Array {
  assertSupported(header.sampleRateHz, header.frameDurationUs);
  if (!Number.isInteger(header.bitrateBps) || header.bitrateBps < 16_000 || header.bitrateBps > 320_000) {
    throw new Error(`LC3 container: implausible bitrate ${String(header.bitrateBps)} bps`);
  }
  const bytes = new Uint8Array(lc3HeaderSize(header.hrMode));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LC3_TAG, false);
  view.setUint16(2, bytes.byteLength, true);
  view.setUint16(4, header.sampleRateHz / 100, true);
  view.setUint16(6, header.bitrateBps / 100, true);
  view.setUint16(8, header.channels, true);
  view.setUint16(10, header.frameDurationUs / 10, true);
  view.setUint16(12, header.epMode ? 1 : 0, true);
  if (!Number.isInteger(header.totalSamples) || header.totalSamples < 0) {
    throw new Error(`LC3 container: invalid total sample count ${String(header.totalSamples)}`);
  }
  view.setUint32(14, header.totalSamples >>> 0, true);
  if (header.hrMode) view.setUint16(18, 1, true);
  return bytes;
}

export function parseLc3Header(bytes: Uint8Array): Lc3ContainerHeader {
  if (bytes.byteLength < lc3HeaderSize(false)) {
    throw new Error("LC3 container: shorter than the smallest header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint16(0, false);
  const headerSize = view.getUint16(2, true);
  if (tag !== LC3_TAG) throw new Error("LC3 container: bad tag");
  if (headerSize < lc3HeaderSize(false) || headerSize > bytes.byteLength) {
    throw new Error(`LC3 container: unsupported header size ${String(headerSize)}`);
  }
  // FFmpeg accepts hdr_size >= 18 and treats one extra 16-bit parameter as the
  // high-resolution marker; a smaller size is non-HR. Match that exactly.
  const hrMode = headerSize >= lc3HeaderSize(true) && view.getUint16(18, true) !== 0;
  const sampleRateHz = view.getUint16(4, true) * 100;
  const bitrateBps = view.getUint16(6, true) * 100;
  const channelsRaw = view.getUint16(8, true);
  const frameDurationUs = view.getUint16(10, true) * 10;
  const epMode = view.getUint16(12, true) !== 0;
  const totalSamples = view.getUint32(14, true);
  assertSupported(sampleRateHz, frameDurationUs);
  if (channelsRaw !== 1 && channelsRaw !== 2) {
    throw new Error(`LC3 container: unsupported channel count ${String(channelsRaw)}`);
  }
  if (hrMode && sampleRateHz < 48_000) {
    throw new Error("LC3 container: high-resolution mode below 48 kHz is inconsistent");
  }
  if (epMode) {
    throw new Error("LC3 container: error-protection mode is not supported");
  }
  return Object.freeze({
    sampleRateHz,
    bitrateBps,
    channels: channelsRaw,
    frameDurationUs,
    epMode,
    totalSamples,
    hrMode,
  });
}

/**
 * Frame-level container writer. Frame payloads arrive from the supplemental
 * liblc3 encoder one call at a time (so progress and cancellation stay
 * responsive) and every record is identical to FFmpeg's lc3_write_packet.
 */
export class Lc3ContainerWriter {
  private readonly chunks: Uint8Array[] = [];
  private frameCount = 0;
  private readonly header: Uint8Array;

  constructor(header: Lc3ContainerHeader) {
    this.header = writeLc3Header(header);
    this.chunks.push(this.header);
  }

  get frames(): number {
    return this.frameCount;
  }

  pushFrame(payload: Uint8Array): void {
    if (payload.byteLength === 0 || payload.byteLength > 1_024) {
      throw new Error(`LC3 container: invalid frame payload length ${String(payload.byteLength)}`);
    }
    const record = new Uint8Array(2 + payload.byteLength);
    new DataView(record.buffer).setUint16(0, payload.byteLength, true);
    record.set(payload, 2);
    this.chunks.push(record);
    this.frameCount += 1;
  }

  finish(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/**
 * Read every length-prefixed frame after `headerSize` bytes. Byte lengths are
 * checked against the buffer before any payload is returned.
 */
export function parseLc3Frames(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Uint8Array[] = [];
  let offset = lc3HeaderSize(view.getUint16(2, true) > lc3HeaderSize(false));
  while (offset + 2 <= bytes.byteLength) {
    const size = view.getUint16(offset, true);
    if (size === 0 || offset + 2 + size > bytes.byteLength) {
      throw new Error(`LC3 container: invalid frame record at offset ${String(offset)}`);
    }
    frames.push(bytes.subarray(offset + 2, offset + 2 + size));
    offset += 2 + size;
  }
  if (offset !== bytes.byteLength) {
    throw new Error("LC3 container: trailing bytes after the final frame record");
  }
  return frames;
}
