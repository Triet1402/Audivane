import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_WAV_BYTES,
  AUDIO_DECODE_SENTINEL_SECONDS,
} from "@codec-abx/contracts";

import {
  BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS,
  BROWSER_SOURCE_SAMPLE_RATES,
  parsePcm16Wav,
  parseSourceWav,
  sha256Hex,
  type WavFacts,
} from "./wav.js";

/**
 * Browser source import.
 *
 * File extensions and MIME types are deliberately not inputs to classification:
 * the first bytes of the selected file must match a small audio-container
 * allowlist. Playlists, URLs and arbitrary containers are therefore refused
 * before any FFmpeg command runs. A container signature is still not trusted
 * as media metadata; FFmpeg's real input probe and, above all, the decoded
 * canonical PCM16 snapshot establish the accepted sample facts.
 */

export type AudioImportFormatId = "wav" | "flac" | "mp3" | "m4a" | "ogg" | "aac";

export interface AudioImportFormat {
  readonly id: AudioImportFormatId;
  readonly label: string;
  /** Explicit FFmpeg input demuxer; never inferred from a file name. */
  readonly demuxer: string;
  /**
   * `false`/`true` when the container itself is always lossy/lossless,
   * otherwise `null` because it can carry either (for example WAV, Ogg or M4A).
   */
  readonly containerLossy: boolean | null;
}

const WAV_FORMAT: AudioImportFormat = Object.freeze({
  id: "wav", label: "WAV (RIFF/WAVE)", demuxer: "wav", containerLossy: null,
});
const FLAC_FORMAT: AudioImportFormat = Object.freeze({
  id: "flac", label: "FLAC", demuxer: "flac", containerLossy: false,
});
const MP3_FORMAT: AudioImportFormat = Object.freeze({
  id: "mp3", label: "MP3 (MPEG audio)", demuxer: "mp3", containerLossy: true,
});
const M4A_FORMAT: AudioImportFormat = Object.freeze({
  id: "m4a", label: "MP4/M4A", demuxer: "mov", containerLossy: null,
});
const OGG_FORMAT: AudioImportFormat = Object.freeze({
  id: "ogg", label: "Ogg (Opus/Vorbis)", demuxer: "ogg", containerLossy: null,
});
const AAC_FORMAT: AudioImportFormat = Object.freeze({
  id: "aac", label: "AAC (ADTS)", demuxer: "aac", containerLossy: true,
});

export const BROWSER_AUDIO_IMPORT_FORMATS: readonly AudioImportFormat[] = Object.freeze([
  WAV_FORMAT, FLAC_FORMAT, MP3_FORMAT, M4A_FORMAT, OGG_FORMAT, AAC_FORMAT,
]);

/** Extra decoded seconds beyond the source limit used only to detect overrun. */
export const SOURCE_DECODE_SENTINEL_SECONDS = AUDIO_DECODE_SENTINEL_SECONDS;
/** Extra decoded bytes beyond the canonical WAV ceiling used only to detect a capped decode. */
export const DECODE_OUTPUT_CAP_MARGIN_BYTES = 4 * 1024 * 1024;
/**
 * FFmpeg's `-fs` ceiling for the canonical source decode. It sits above the
 * acceptance ceiling so a legitimate maximum-layout decode is not truncated at
 * the same boundary it must pass, while a decode that actually reaches the cap
 * is still refused rather than accepted as a short success.
 */
export const SOURCE_DECODE_OUTPUT_CAP_BYTES =
  AUDIO_MAX_WAV_BYTES + DECODE_OUTPUT_CAP_MARGIN_BYTES;
/** Detect a decode that stopped at the safety cap, allowing one frame of slack. */
export const DECODE_OUTPUT_CAP_HIT_TOLERANCE_BYTES = 1024 * 1024;

export interface DeclaredAudioFacts {
  readonly container: string | null;
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly durationSeconds: number | null;
}

export interface SourceImportCapture {
  readonly code: number;
  readonly output: string;
}

export interface SourceImportHooks {
  exec(args: readonly string[]): Promise<SourceImportCapture>;
  writeFile(name: string, bytes: Uint8Array): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
  deleteFile(name: string): Promise<void>;
  /** Register a worker-created name for the engine's owned-file cleanup. */
  trackFile?(name: string): void;
  /** Throw the caller's cancellation/disposal error; called between stages. */
  checkCancelled(): Promise<void>;
}

export interface AudioSourceSnapshot {
  /**
   * Original encoded bytes. `worker.writeFile` transfers this buffer, so no
   * second JS copy is retained; only the length and SHA-256 survive.
   */
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  /** SHA-256 of the original encoded bytes, never the decoded snapshot. */
  readonly sha256: string;
  readonly format: AudioImportFormat;
  readonly sampleRateMode: "native" | "force_48k";
  /** Strict PCM16 facts when the source itself is already canonical. */
  readonly fastPcm16: WavFacts | null;
}

export interface SnapshotOptions {
  readonly sampleRateMode: "native" | "force_48k";
}

export interface DecodeSourceOptions {
  readonly inputName: string;
  readonly canonicalName: string;
}

export interface ImportedAudioSource {
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly format: AudioImportFormat;
  readonly declared: DeclaredAudioFacts | null;
  readonly canonicalName: string;
  readonly canonical: WavFacts;
  /** True when FFmpeg produced the canonical snapshot. */
  readonly decodedByFfmpeg: boolean;
  readonly disclosures: readonly string[];
}

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(byteAt(bytes, offset + index));
  }
  return text;
}

function unsupportedError(): Error {
  return new Error(
    "Unsupported audio source signature. Accepted inputs are WAV (RIFF/WAVE), FLAC, " +
      "MP3, MP4/M4A (AAC/ALAC audio), Ogg (Opus/Vorbis) and raw ADTS AAC. File " +
      "extensions, MIME types, playlists and network references are not used.",
  );
}

/** Classify an MPEG/ADTS sync word if one starts at `offset`. */
function mpegKindAt(bytes: Uint8Array, offset: number): "mp3" | "aac" | null {
  if (byteAt(bytes, offset) !== 0xff) return null;
  const second = byteAt(bytes, offset + 1);
  if ((second & 0xf6) === 0xf0) {
    // ADTS has a 12-bit sync, layer bits 00 and a valid sampling index.
    const samplingIndex = (byteAt(bytes, offset + 2) >> 2) & 0x0f;
    return samplingIndex === 0x0f ? null : "aac";
  }
  // MPEG audio has an 11-bit sync, a non-reserved version and layer.
  if ((second & 0xe0) !== 0xe0) return null;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrateIndex = (byteAt(bytes, offset + 2) >> 4) & 0x0f;
  const rateIndex = (byteAt(bytes, offset + 2) >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrateIndex === 0x0f || rateIndex === 3) return null;
  return "mp3";
}

/** Offset after an ID3v2 tag, or 0 when the file has no leading tag. */
function afterId3Tag(bytes: Uint8Array): number {
  if (asciiAt(bytes, 0, 3) !== "ID3" || bytes.byteLength < 10) return 0;
  const size = ((byteAt(bytes, 6) & 0x7f) << 21) |
    ((byteAt(bytes, 7) & 0x7f) << 14) |
    ((byteAt(bytes, 8) & 0x7f) << 7) |
    (byteAt(bytes, 9) & 0x7f);
  const footer = (byteAt(bytes, 5) & 0x10) === 0 ? 0 : 10;
  const offset = 10 + size + footer;
  return offset > 0 && offset < bytes.byteLength ? offset : bytes.byteLength;
}

function findMpegKind(bytes: Uint8Array, start: number): "mp3" | "aac" | null {
  const end = Math.min(bytes.byteLength - 3, start + 1024 * 1024);
  for (let offset = start; offset <= end; offset += 1) {
    const kind = mpegKindAt(bytes, offset);
    if (kind !== null) return kind;
  }
  return null;
}

/** Classify accepted audio containers from their actual leading bytes. */
export function classifyAudioSource(bytes: Uint8Array): AudioImportFormat {
  if (bytes.byteLength < 4) throw unsupportedError();
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WAVE") {
    return WAV_FORMAT;
  }
  if (asciiAt(bytes, 0, 4) === "fLaC") return FLAC_FORMAT;
  if (asciiAt(bytes, 0, 4) === "OggS") return OGG_FORMAT;
  if (asciiAt(bytes, 4, 4) === "ftyp") return M4A_FORMAT;
  if (asciiAt(bytes, 0, 3) === "ID3") {
    const offset = afterId3Tag(bytes);
    if (asciiAt(bytes, offset, 4) === "fLaC") return FLAC_FORMAT;
    const kind = findMpegKind(bytes, offset);
    if (kind === "aac") return AAC_FORMAT;
    if (kind === "mp3") return MP3_FORMAT;
    throw unsupportedError();
  }
  const kind = mpegKindAt(bytes, 0);
  if (kind === "aac") return AAC_FORMAT;
  if (kind === "mp3") return MP3_FORMAT;
  throw unsupportedError();
}

function layoutChannels(layout: string): number | null {
  const text = layout.trim().toLowerCase();
  const counted = /(\d+)\s*channels?/.exec(text);
  if (counted?.[1] !== undefined) return Number(counted[1]);
  const layouts: Readonly<Record<string, number>> = {
    mono: 1,
    stereo: 2,
    "2.0": 2,
    "2.1": 3,
    "3.0": 3,
    "3.0(back)": 3,
    "4.0": 4,
    quad: 4,
    "4.1": 5,
    "5.0": 5,
    "5.0(side)": 5,
    "5.1": 6,
    "5.1(side)": 6,
    "6.0": 6,
    "6.1": 7,
    "7.0": 7,
    "7.1": 8,
    "7.1(wide)": 8,
    downmix: 2,
  };
  return layouts[text] ?? null;
}

/** Parse the real FFmpeg input log. Callers must still verify by decoding. */
export function parseAudioProbeLog(output: string): DeclaredAudioFacts {
  const input = /Input #\d+,\s*([^,\n]+)/i.exec(output);
  const duration = /Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(output);
  const audio = /Stream #0:\d+[^\n]*?:\s*Audio:\s*([^,\n]+),\s*(\d+)\s*Hz,\s*([^,\n]+)/i
    .exec(output);
  return {
    container: input?.[1]?.trim() ?? null,
    codec: audio?.[1]?.trim() ?? null,
    sampleRate: audio?.[2] === undefined ? null : Number(audio[2]),
    channels: audio?.[3] === undefined ? null : layoutChannels(audio[3]),
    durationSeconds: duration === null
      ? null
      : Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
  };
}

export function formatByteCount(bytes: number): string {
  return `${String(bytes)} bytes (${(bytes / (1024 * 1024)).toFixed(1)} MiB)`;
}

/** Reject oversized encoded input before allocating any decoder state. */
export function assertSourceByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error("Source is empty");
  }
  if (byteLength > AUDIO_MAX_INPUT_BYTES) {
    throw new Error(
      `Source is ${formatByteCount(byteLength)}; the encoded/container limit is ` +
        `${formatByteCount(AUDIO_MAX_INPUT_BYTES)}`,
    );
  }
}

export function assertCanonicalByteLength(byteLength: number): void {
  if (byteLength > AUDIO_MAX_WAV_BYTES) {
    throw new Error(
      `Decoded source is ${formatByteCount(byteLength)}; the canonical PCM16 WAV limit is ` +
        `${formatByteCount(AUDIO_MAX_WAV_BYTES)}. No truncated excerpt is delivered.`,
    );
  }
}

/** A decode that reaches the `-fs` cap is refused rather than treated as short. */
export function assertDecodeOutputNotCapped(byteLength: number): void {
  if (byteLength >= SOURCE_DECODE_OUTPUT_CAP_BYTES - DECODE_OUTPUT_CAP_HIT_TOLERANCE_BYTES) {
    throw new Error(
      `Decoded source reached the ${formatByteCount(SOURCE_DECODE_OUTPUT_CAP_BYTES)} FFmpeg output ` +
        "safety cap. The source exceeds the supported layout/duration envelope or has " +
        "unexpected channels or rate; no truncated excerpt is delivered.",
    );
  }
}

/**
 * Declared probe facts are hints and disclosure material, never acceptance or
 * refusal authority. In particular, raw ADTS AAC commonly advertises a longer
 * duration than the decoded frames (a real 1800 s stream can be declared as
 * slightly longer). The bounded decode and its canonical frame count decide.
 */
export function declaredFactNotes(
  declared: DeclaredAudioFacts,
  mode: "native" | "force_48k",
): string[] {
  const notes: string[] = [];
  if (declared.channels !== null && declared.channels > 2) {
    notes.push(
      `The input probe declared ${String(declared.channels)} audio channels. The bounded ` +
        "decode and its canonical frame count are authoritative; multichannel material is " +
        "refused there and never downmixed.",
    );
  }
  if (declared.durationSeconds !== null &&
      declared.durationSeconds >
        AUDIO_MAX_DURATION_SECONDS + BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS) {
    notes.push(
      `The input probe declared ${declared.durationSeconds.toFixed(3)} s, above the ` +
        `${String(AUDIO_MAX_DURATION_SECONDS)} s limit. Declared duration is not trusted; ` +
        `the bounded ${String(AUDIO_MAX_DURATION_SECONDS + SOURCE_DECODE_SENTINEL_SECONDS)} s ` +
        "decode verifies the actual frames and refuses overlong material rather than cropping it.",
    );
  }
  if (mode === "native" && declared.sampleRate !== null &&
      !BROWSER_SOURCE_SAMPLE_RATES.some((rate) => rate === declared.sampleRate)) {
    notes.push(
      `The input probe declared ${String(declared.sampleRate)} Hz, outside native-mode ` +
        `${BROWSER_SOURCE_SAMPLE_RATES.join("/")} Hz. The decoded canonical rate is ` +
        "authoritative and unsupported native rates are refused there.",
    );
  }
  return notes;
}

export function assertCanonicalDuration(facts: Pick<WavFacts, "durationSeconds">): void {
  if (facts.durationSeconds >
      AUDIO_MAX_DURATION_SECONDS + BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS) {
    throw new Error(
      `Decoded source is ${facts.durationSeconds.toFixed(3)} s; the limit is ` +
        `${String(AUDIO_MAX_DURATION_SECONDS)} s plus at most ` +
        `${String(BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS)} s codec padding. The source ` +
        `is refused rather than silently cropped to its first ` +
        `${String(AUDIO_MAX_DURATION_SECONDS)} s.`,
    );
  }
}

export function assertCanonicalFacts(
  facts: WavFacts,
  mode: "native" | "force_48k",
): void {
  assertCanonicalDuration(facts);
  if (mode === "force_48k") {
    if (facts.sampleRate !== 48000) {
      throw new Error(
        `Explicit force-48k canonical decode produced ${String(facts.sampleRate)} Hz; ` +
          "refusing rather than delivering an unintended rate",
      );
    }
    return;
  }
  if (!BROWSER_SOURCE_SAMPLE_RATES.some((rate) => rate === facts.sampleRate)) {
    throw new Error(
      `Decoded source rate ${String(facts.sampleRate)} Hz is unsupported in native mode; ` +
        `use ${BROWSER_SOURCE_SAMPLE_RATES.join("/")} Hz or select the explicit ` +
        "force-48k policy",
    );
  }
}

export function buildSourceProbeArgs(format: AudioImportFormat, inputName: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-protocol_whitelist", "file",
    "-f", format.demuxer, "-i", inputName,
  ];
}

export function buildSourceDecodeArgs(
  format: AudioImportFormat,
  mode: "native" | "force_48k",
  inputName: string,
  canonicalName: string,
): string[] {
  return [
    "-hide_banner", "-nostdin", "-xerror", "-protocol_whitelist", "file",
    "-f", format.demuxer, "-i", inputName,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
    "-c:a", "pcm_s16le",
    ...(mode === "force_48k" ? ["-ar", "48000"] : []),
    "-t", String(AUDIO_MAX_DURATION_SECONDS + SOURCE_DECODE_SENTINEL_SECONDS),
    "-fs", String(SOURCE_DECODE_OUTPUT_CAP_BYTES),
    "-f", "wav", canonicalName,
  ];
}

export async function snapshotAudioSource(
  bytes: Uint8Array,
  options: SnapshotOptions,
): Promise<AudioSourceSnapshot> {
  assertSourceByteLength(bytes.byteLength);
  const format = classifyAudioSource(bytes);
  let fastPcm16: WavFacts | null = null;
  if (format.id === "wav") {
    // FFmpeg tolerates truncated RIFF input. Validate the complete source
    // structure before allowing higher-precision normalization through it.
    const layout = parseSourceWav(bytes);
    assertCanonicalDuration(layout);
    let strict: WavFacts | null = null;
    try {
      strict = parsePcm16Wav(bytes);
    } catch {
      // 24-bit/float/extensible-layout or otherwise non-canonical WAVs are
      // decoded explicitly below; the parser stays strict and fast.
      strict = null;
    }
    if (strict !== null) {
      assertCanonicalDuration(strict);
      if (options.sampleRateMode === "native" || strict.sampleRate === 48000) {
        assertCanonicalFacts(strict, options.sampleRateMode);
        fastPcm16 = strict;
      }
    }
  }
  const sha256 = await sha256Hex(bytes);
  return {
    bytes,
    byteLength: bytes.byteLength,
    sha256,
    format,
    sampleRateMode: options.sampleRateMode,
    fastPcm16,
  };
}

function codecBaseName(codec: string): string {
  return codec.trim().toLowerCase().split(/[\s(]/)[0] ?? "";
}

const LOSSLESS_CODECS = new Set([
  "flac", "alac", "wavpack", "ape", "truehd", "mlp", "tak", "tta",
]);
const LOSSY_CODECS = new Set([
  "mp3", "mp2", "aac", "opus", "vorbis", "ac3", "eac3", "atrac3", "atrac3p",
  "atrac9", "wmav1", "wmav2", "speex", "amr_nb", "amr_wb", "mp1",
]);

/** Truthful lossy status; `null` means the codec did not establish it. */
export function sourceLossyStatus(
  format: AudioImportFormat,
  codec: string | null,
): boolean | null {
  if (format.containerLossy !== null) return format.containerLossy;
  if (codec === null) return null;
  const base = codecBaseName(codec);
  if (base === "") return null;
  if (base.startsWith("pcm_")) return false;
  if (LOSSLESS_CODECS.has(base)) return false;
  if (LOSSY_CODECS.has(base)) return true;
  return null;
}

function canonicalFactsLine(facts: WavFacts): string {
  return `${String(facts.sampleRate)} Hz, ${String(facts.channels)} channel(s), ` +
    `${String(facts.frames)} frames, ${facts.durationSeconds.toFixed(6)} s`;
}

function declaredFactsLine(declared: DeclaredAudioFacts): string {
  return `${declared.container ?? "unknown container"}, codec ${declared.codec ?? "unknown"}, ` +
    `${declared.sampleRate === null ? "unknown rate" : `${String(declared.sampleRate)} Hz`}, ` +
    `${declared.channels === null ? "unknown channels" : String(declared.channels)} channel(s), ` +
    `${declared.durationSeconds === null
      ? "unknown duration"
      : `${declared.durationSeconds.toFixed(3)} s`}`;
}

function importDisclosures(
  snapshot: AudioSourceSnapshot,
  declared: DeclaredAudioFacts | null,
  canonical: WavFacts,
  decodedByFfmpeg: boolean,
): string[] {
  const lines: string[] = [
    `Source format was established from leading bytes as ${snapshot.format.label} ` +
      `(explicit FFmpeg demuxer ${snapshot.format.demuxer}); file extension and MIME type ` +
      "were not used.",
    `Source SHA-256 covers the original ${formatByteCount(snapshot.byteLength)}; the canonical ` +
      `snapshot is ${canonicalFactsLine(canonical)}.`,
  ];
  if (decodedByFfmpeg) {
    lines.push(
      `The local FFmpeg WASM worker decoded the source exactly once to canonical PCM16 WAV ` +
        `(${canonicalFactsLine(canonical)}). Both Side A and Side B chains start from this ` +
        "same snapshot, and the encoded source was removed from worker memory once the " +
        "snapshot was validated. Only the first audio stream (0:a:0) was decoded; video, " +
        "subtitle, data and additional audio streams were not. No channel downmix and no " +
        "time crop were applied.",
    );
    if (declared !== null) {
      const mismatches: string[] = [];
      if (declared.sampleRate !== null && declared.sampleRate !== canonical.sampleRate) {
        mismatches.push("sample rate");
      }
      if (declared.channels !== null && declared.channels !== canonical.channels) {
        mismatches.push("channel count");
      }
      if (declared.durationSeconds !== null &&
          Math.abs(declared.durationSeconds - canonical.durationSeconds) >
            BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS) {
        mismatches.push("duration");
      }
      lines.push(
        `FFmpeg's input probe declared ${declaredFactsLine(declared)}. Decoded canonical ` +
          "facts are authoritative" +
          (mismatches.length === 0
            ? "; the declared facts agreed with the decoded snapshot."
            : `; the probe differed on ${mismatches.join(", ")}, so the decoded facts were used.`),
      );
      lines.push(...declaredFactNotes(declared, snapshot.sampleRateMode));
    }
    if (snapshot.sampleRateMode === "force_48k") {
      lines.push(
        "The explicit force-48k policy resampled once during canonical decode to 48000 Hz. " +
          "This is an intentional request, not a hidden browser resample.",
      );
    } else {
      lines.push(
        "Native rate policy preserved the decoded source rate at canonical import; no " +
          "sample-rate conversion was requested before the codec chains.",
      );
    }
  } else {
    lines.push(
      `The source is already strict canonical PCM16 WAV at ${canonicalFactsLine(canonical)}. ` +
        "It was adopted directly as the shared canonical snapshot without a second decode; " +
        "both Side A and Side B chains start from these bytes.",
    );
  }

  const lossy = sourceLossyStatus(snapshot.format, declared?.codec ?? "pcm_s16le");
  if (lossy === true) {
    lines.push(
      `The source codec ${declared?.codec ?? "unknown"} is lossy; decoding does not restore ` +
        "discarded information, and this snapshot is not an original-quality reference.",
    );
  } else if (lossy === false) {
    lines.push(
      decodedByFfmpeg
        ? `The source codec ${declared?.codec ?? "PCM16"} is lossless, but the canonical snapshot ` +
          "is PCM16: any source precision above 16 bits (including 32-bit integer or float WAV) " +
          "is quantized. No lossless restoration beyond that snapshot is claimed."
        : "The source is lossless PCM16 and was adopted unchanged; import did not quantize its samples.",
    );
  } else {
    lines.push(
      "The source codec's lossless status was not established from the input probe. The " +
        "canonical snapshot is PCM16, so sample precision is quantized to 16 bits and no " +
        "lossless restoration is claimed.",
    );
  }

  if (canonical.durationSeconds > AUDIO_MAX_DURATION_SECONDS) {
    lines.push(
      `Decoded duration ${canonical.durationSeconds.toFixed(6)} s exceeds ` +
        `${String(AUDIO_MAX_DURATION_SECONDS)} s by ` +
        `${(canonical.durationSeconds - AUDIO_MAX_DURATION_SECONDS).toFixed(6)} s, inside the ` +
        `disclosed ${String(BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS)} s end-of-stream codec ` +
        "padding allowance. No samples were cropped.",
    );
  }
  return lines;
}

/**
 * Normalize a source to the single canonical PCM16 snapshot used by both
 * chains. The original encoded MEMFS file is deleted as soon as the decoded
 * snapshot has been read and validated.
 */
export async function decodeAudioSource(
  hooks: SourceImportHooks,
  snapshot: AudioSourceSnapshot,
  options: DecodeSourceOptions,
): Promise<ImportedAudioSource> {
  await hooks.checkCancelled();
  if (snapshot.fastPcm16 !== null) {
    // Already canonical PCM16: write the original bytes once as the shared
    // snapshot. Nothing is decoded twice and no second source copy is created.
    await hooks.writeFile(options.canonicalName, snapshot.bytes);
    await hooks.checkCancelled();
    return {
      sourceSha256: snapshot.sha256,
      sourceByteLength: snapshot.byteLength,
      format: snapshot.format,
      declared: null,
      canonicalName: options.canonicalName,
      canonical: snapshot.fastPcm16,
      decodedByFfmpeg: false,
      disclosures: Object.freeze(
        importDisclosures(snapshot, null, snapshot.fastPcm16, false),
      ),
    };
  }

  await hooks.writeFile(options.inputName, snapshot.bytes);
  try {
    await hooks.checkCancelled();
    const probe = await hooks.exec(buildSourceProbeArgs(snapshot.format, options.inputName));
    await hooks.checkCancelled();
    const declared = parseAudioProbeLog(probe.output);
    if (declared.codec === null) {
      throw new Error(
        "FFmpeg did not identify a decodable audio stream in the source; no substitution " +
          "or fallback is attempted",
      );
    }
    await hooks.checkCancelled();

    hooks.trackFile?.(options.canonicalName);
    const decode = await hooks.exec(buildSourceDecodeArgs(
      snapshot.format, snapshot.sampleRateMode, options.inputName, options.canonicalName,
    ));
    if (decode.code !== 0) {
      const detail = decode.output.split(/\r?\n/).slice(-8).join("\n");
      throw new Error(
        `FFmpeg source decode failed with exit code ${String(decode.code)}: ${detail}`,
      );
    }
    await hooks.checkCancelled();
    // Satisfy the MEMFS lifetime rule before the canonical bytes are copied
    // into JS or any codec stage starts.
    await hooks.deleteFile(options.inputName);
    await hooks.checkCancelled();

    const canonicalBytes = await hooks.readFile(options.canonicalName);
    await hooks.checkCancelled();
    assertDecodeOutputNotCapped(canonicalBytes.byteLength);
    assertCanonicalByteLength(canonicalBytes.byteLength);
    let canonical: WavFacts;
    try {
      canonical = parsePcm16Wav(canonicalBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Decoded source is not a valid canonical PCM16 WAV (${message}); no partial or ` +
          "truncated decode is accepted",
      );
    }
    assertCanonicalFacts(canonical, snapshot.sampleRateMode);
    await hooks.checkCancelled();
    return {
      sourceSha256: snapshot.sha256,
      sourceByteLength: snapshot.byteLength,
      format: snapshot.format,
      declared,
      canonicalName: options.canonicalName,
      canonical,
      decodedByFfmpeg: true,
      disclosures: Object.freeze(importDisclosures(snapshot, declared, canonical, true)),
    };
  } catch (error: unknown) {
    // Do not leave a partial decoded file in MEMFS. If this cleanup cannot run
    // (for example after cancellation), the engine's owned-file cleanup retries
    // and resets the worker if necessary.
    try {
      await hooks.deleteFile(options.canonicalName);
    } catch {
      // Ignore cleanup failure; it must not mask the original error.
    }
    throw error;
  }
}
