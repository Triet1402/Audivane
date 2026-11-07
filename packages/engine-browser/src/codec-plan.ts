import type { CodecId } from "@codec-abx/contracts";

/** An implemented round trip, conditional on this exact core's advertised names. */
export interface CodecPlan {
  readonly encoder: string;
  readonly decoder: string;
  readonly format: string;
  readonly extension: string;
  /**
   * The pinned aptX/aptX HD encoders only accept stereo input. A mono session
   * is carried as dual-mono inside the codec and restored to mono after decode;
   * this is disclosed in stage notes and artifact disclosures.
   */
  readonly requiresStereoInput?: boolean;
  /** Fixed-rate codec: the requested bitrate is nominal and not honoured exactly. */
  readonly fixedRate?: boolean;
}

/**
 * LC3/LDAC do not run through the pinned FFmpeg core at all. Their round trips
 * execute in same-origin supplemental WASM builds of the exact pinned codec
 * sources the native tier uses; these plans carry only the honest provenance
 * strings and container facts. Availability is configured by the app bundle
 * (asset URLs); absence refuses before source reads like a missing helper.
 */
export interface SupplementalPlan {
  readonly codecId: "lc3" | "ldac";
  readonly encoder: string;
  readonly decoder: string;
  readonly extension: "lc3" | "ldac";
}

const LC3_SUPPLEMENTAL_PLAN: SupplementalPlan = {
  codecId: "lc3",
  encoder: "liblc3 1.1.3 (same-origin WASM)",
  decoder: "liblc3 1.1.3 (same-origin WASM)",
  extension: "lc3",
};

const LDAC_SUPPLEMENTAL_PLAN: SupplementalPlan = {
  codecId: "ldac",
  encoder: "ldac_wasm encode (AOSP libldac 2.00.02)",
  decoder: "ldac_wasm decode (hegdi/libldacdec)",
  extension: "ldac",
};

export function supplementalPlan(codecId: CodecId): SupplementalPlan | null {
  if (codecId === "lc3") return LC3_SUPPLEMENTAL_PLAN;
  if (codecId === "ldac") return LDAC_SUPPLEMENTAL_PLAN;
  return null;
}

const IMPLEMENTED: Partial<Record<CodecId, CodecPlan>> = {
  noop_passthrough: { encoder: "pcm_s16le", decoder: "pcm_s16le", format: "wav", extension: "wav" },
  opus: { encoder: "libopus", decoder: "opus", format: "ogg", extension: "opus" },
  aac: { encoder: "aac", decoder: "aac", format: "adts", extension: "aac" },
  mp3: { encoder: "libmp3lame", decoder: "mp3float", format: "mp3", extension: "mp3" },
  ogg_vorbis: { encoder: "libvorbis", decoder: "vorbis", format: "ogg", extension: "ogg" },
  // The pinned core has no libtwolame; this is FFmpeg's built-in MP2 encoder.
  mp2: { encoder: "mp2", decoder: "mp2float", format: "mp2", extension: "mp2" },
  sbc: { encoder: "sbc", decoder: "sbc", format: "sbc", extension: "sbc" },
  aptx: {
    encoder: "aptx",
    decoder: "aptx",
    format: "aptx",
    extension: "aptx",
    requiresStereoInput: true,
    fixedRate: true,
  },
  aptx_hd: {
    encoder: "aptx_hd",
    decoder: "aptx_hd",
    format: "aptx_hd",
    extension: "aptxhd",
    requiresStereoInput: true,
    fixedRate: true,
  },
};

export function implementedPlan(codecId: CodecId): CodecPlan | null {
  return IMPLEMENTED[codecId] ?? null;
}

/**
 * mp3float/mp2float and their integer counterparts are explicit FFmpeg
 * decoders; disclose the selected one without inventing an unlisted name.
 */
export function probedPlan(codecId: CodecId, decoders: ReadonlySet<string>): CodecPlan | null {
  const plan = implementedPlan(codecId);
  if (codecId === "mp3" && plan && !decoders.has("mp3float") && decoders.has("mp3")) {
    return { ...plan, decoder: "mp3" };
  }
  if (codecId === "mp2" && plan && !decoders.has("mp2float") && decoders.has("mp2")) {
    return { ...plan, decoder: "mp2" };
  }
  return plan;
}

/**
 * Internal encoder rate. Native and browser supplemental tiers agree:
 * opus/lc3/ldac/aptx/aptx_hd are pinned to 48 kHz internally for every session
 * and each stage restores the session rate afterwards (disclosed).
 * MP2 uses libtwolame; browser MP2 is FFmpeg's built-in mp2 encoder instead.
 */
export function codecInternalRate(codecId: CodecId, sessionRate: number): number {
  if (codecId === "opus") return 48000;
  if (codecId === "ldac") return 48000;
  // The raw aptX/aptX HD container carries no usable rate metadata in this
  // core: decoding a 44.1 kHz encode as-is produced a wrong duration. Pin both
  // codecs to 48 kHz internally for every session and restore the session rate
  // after decode. This is disclosed; the encoded bytes are honestly measured.
  // Raw aptX/aptX HD lack usable rate metadata in this core and LC3 matches
  // the native tier's explicit internal policy; both restore the session rate
  // after decode. Disclosed; encoded bytes are honestly measured.
  if (codecId === "aptx" || codecId === "aptx_hd") return 48000;
  if (codecId === "lc3") return 48000;
  // MPEG audio and SBC do not accept 96 kHz in the pinned core. Restore
  // the session rate and layout after every decode; no hidden rate substitution.
  if (
    (codecId === "aac" || codecId === "mp3" || codecId === "mp2" || codecId === "sbc") &&
    sessionRate > 48000
  ) {
    return 48000;
  }
  return sessionRate;
}

/** Encoder input channel count; only the fixed-layout aptX codecs differ. */
export function codecInputChannels(codecId: CodecId, sessionChannels: 1 | 2): 1 | 2 {
  return implementedPlan(codecId)?.requiresStereoInput === true ? 2 : sessionChannels;
}
