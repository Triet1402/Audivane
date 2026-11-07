import type { CodecId } from "@codec-abx/contracts";

export type NativeCodecKind = "noop" | "ffmpeg" | "ldac-helper";

export interface NativeCodecPlan {
  readonly codecId: CodecId;
  readonly kind: NativeCodecKind;
  readonly encoder: string;
  readonly decoder: string;
  /** Container muxer name passed with `-f`; null for no-op and helper codecs. */
  readonly muxer: string | null;
  /** Explicit input demuxer name; null when the container is auto-detected. */
  readonly demuxer: string | null;
  readonly extension: string;
  readonly extraEncodeArgs: readonly string[];
  /** aptX/aptX HD encoders accept stereo only. A mono session is dual-mono. */
  readonly requiresStereoInput: boolean;
  /** Fixed-rate raw codec: the requested bitrate is nominal, not honoured exactly. */
  readonly fixedRate: boolean;
  /** Read the encoded rate from the bitstream/container rather than our setting. */
  readonly bitstreamRate: boolean;
}

const FFMPEG_PLANS: Readonly<Record<Exclude<CodecId, "noop_passthrough" | "ldac">, NativeCodecPlan>> = Object.freeze({
  opus: Object.freeze({
    codecId: "opus", kind: "ffmpeg", encoder: "libopus", decoder: "opus",
    muxer: "opus", demuxer: "ogg", extension: "opus",
    extraEncodeArgs: Object.freeze(["-vbr", "off", "-frame_duration", "10"]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: true,
  }),
  aac: Object.freeze({
    codecId: "aac", kind: "ffmpeg", encoder: "aac", decoder: "aac",
    muxer: "ipod", demuxer: "mov", extension: "m4a",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: true,
  }),
  ogg_vorbis: Object.freeze({
    codecId: "ogg_vorbis", kind: "ffmpeg", encoder: "libvorbis", decoder: "vorbis",
    muxer: "ogg", demuxer: "ogg", extension: "ogg",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: true,
  }),
  mp3: Object.freeze({
    codecId: "mp3", kind: "ffmpeg", encoder: "libmp3lame", decoder: "mp3float",
    muxer: "mp3", demuxer: "mp3", extension: "mp3",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: true,
  }),
  mp2: Object.freeze({
    codecId: "mp2", kind: "ffmpeg", encoder: "libtwolame", decoder: "mp2float",
    // FFmpeg's MPEG-audio demuxer is named mp3 and accepts both layers.
    muxer: "mp2", demuxer: "mp3", extension: "mp2",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: true,
  }),
  lc3: Object.freeze({
    codecId: "lc3", kind: "ffmpeg", encoder: "liblc3", decoder: "liblc3",
    muxer: "lc3", demuxer: "lc3", extension: "lc3",
    extraEncodeArgs: Object.freeze(["-frame_duration", "10"]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: false,
  }),
  sbc: Object.freeze({
    codecId: "sbc", kind: "ffmpeg", encoder: "sbc", decoder: "sbc",
    muxer: "sbc", demuxer: "sbc", extension: "sbc",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: false, fixedRate: false, bitstreamRate: false,
  }),
  aptx: Object.freeze({
    codecId: "aptx", kind: "ffmpeg", encoder: "aptx", decoder: "aptx",
    muxer: "aptx", demuxer: "aptx", extension: "aptx",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: true, fixedRate: true, bitstreamRate: false,
  }),
  aptx_hd: Object.freeze({
    codecId: "aptx_hd", kind: "ffmpeg", encoder: "aptx_hd", decoder: "aptx_hd",
    muxer: "aptx_hd", demuxer: "aptx_hd", extension: "aptx_hd",
    extraEncodeArgs: Object.freeze([]),
    requiresStereoInput: true, fixedRate: true, bitstreamRate: false,
  }),
});

const NOOP_PLAN: NativeCodecPlan = Object.freeze({
  codecId: "noop_passthrough", kind: "noop", encoder: "pcm_f64le", decoder: "pcm_f64le",
  muxer: null, demuxer: null, extension: "", extraEncodeArgs: Object.freeze([]),
  requiresStereoInput: false, fixedRate: false, bitstreamRate: false,
});

const LDAC_PLAN: NativeCodecPlan = Object.freeze({
  codecId: "ldac", kind: "ldac-helper", encoder: "ldac_helper encode",
  decoder: "ldac_helper decode (hegdi/libldacdec)",
  muxer: null, demuxer: null, extension: "ldac", extraEncodeArgs: Object.freeze([]),
  requiresStereoInput: false, fixedRate: false, bitstreamRate: false,
});

export function nativeCodecPlan(codecId: CodecId): NativeCodecPlan {
  if (codecId === "noop_passthrough") return NOOP_PLAN;
  if (codecId === "ldac") return LDAC_PLAN;
  return FFMPEG_PLANS[codecId];
}

/**
 * Internal encoder rate. Every change from the session rate is recorded in the
 * stage provenance; it is never inferred from the final decoded delivery.
 */
export function nativeCodecInternalRate(codecId: CodecId, sessionRate: number): number {
  switch (codecId) {
    case "noop_passthrough":
    case "aac":
      return sessionRate;
    case "opus":
    case "lc3":
    case "ldac":
    case "aptx":
    case "aptx_hd":
      return 48_000;
    case "ogg_vorbis":
    case "mp3":
    case "mp2":
    case "sbc":
      // The local libvorbis build refuses a 96 kHz encode. MPEG audio and SBC
      // are likewise limited to the 48 kHz family. Decode restores the session
      // rate and every such change is disclosed in stage provenance.
      return sessionRate > 48_000 ? 48_000 : sessionRate;
  }
}

/** Channels handed to the encoder. Only the fixed aptX family differs. */
export function nativeCodecEncodedChannels(codecId: CodecId, sessionChannels: 1 | 2): 1 | 2 {
  return nativeCodecPlan(codecId).requiresStereoInput ? 2 : sessionChannels;
}

export const NATIVE_LDAC_DECODER_DISCLOSURE =
  "LDAC decode used the third-party hegdi/libldacdec implementation built into ldac_helper; " +
  "no vendor validation or bit-exact equivalence with a retail LDAC sink is established.";
