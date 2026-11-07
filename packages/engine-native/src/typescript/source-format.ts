import path from "node:path";

/**
 * Explicit local source allowlist for the native executor.
 *
 * An extension selects both the FFmpeg demuxer and the ffprobe container/codec
 * facts that must agree with it. Arbitrary FFmpeg inputs are not accepted:
 * continue-format playlists, network protocols and unknown containers never
 * reach a probe or decoder in this graph.
 */
export type NativeSourceFormatId =
  | "wav"
  | "flac"
  | "mp3"
  | "aac"
  | "m4a"
  | "ogg"
  | "opus";

export interface NativeSourceFormat {
  readonly id: NativeSourceFormatId;
  readonly label: string;
  /** Explicit `-f <demuxer>` used for both probe and decode. */
  readonly demuxer: string;
  readonly extensions: readonly string[];
  /** Accepted lowercase ffprobe `format_name` tokens. */
  readonly probeFormats: readonly string[];
  /** Exact accepted ffprobe `codec_name` values. */
  readonly codecs: readonly string[];
  /** Accepted ffprobe `codec_name` prefixes (for example `pcm_`). */
  readonly codecPrefixes: readonly string[];
}

const FORMATS: Readonly<Record<string, NativeSourceFormat>> = Object.freeze({
  wav: Object.freeze({
    id: "wav" as const,
    label: "WAV",
    demuxer: "wav",
    extensions: Object.freeze(["wav"]),
    probeFormats: Object.freeze(["wav"]),
    codecs: Object.freeze([]),
    codecPrefixes: Object.freeze(["pcm_"]),
  }),
  flac: Object.freeze({
    id: "flac" as const,
    label: "FLAC",
    demuxer: "flac",
    extensions: Object.freeze(["flac"]),
    probeFormats: Object.freeze(["flac"]),
    codecs: Object.freeze(["flac"]),
    codecPrefixes: Object.freeze([]),
  }),
  mp3: Object.freeze({
    id: "mp3" as const,
    label: "MP3",
    demuxer: "mp3",
    extensions: Object.freeze(["mp3"]),
    probeFormats: Object.freeze(["mp3"]),
    codecs: Object.freeze(["mp3"]),
    codecPrefixes: Object.freeze([]),
  }),
  aac: Object.freeze({
    id: "aac" as const,
    label: "AAC (ADTS)",
    demuxer: "aac",
    extensions: Object.freeze(["aac"]),
    probeFormats: Object.freeze(["aac"]),
    codecs: Object.freeze(["aac"]),
    codecPrefixes: Object.freeze([]),
  }),
  m4a: Object.freeze({
    id: "m4a" as const,
    label: "M4A/MP4",
    // `.m4a` is an ISO-BMFF/QuickTime container: FFmpeg's demuxer is `mov`,
    // never the nonexistent `m4a` demuxer.
    demuxer: "mov",
    extensions: Object.freeze(["m4a", "mp4"]),
    probeFormats: Object.freeze(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]),
    codecs: Object.freeze(["aac", "alac"]),
    codecPrefixes: Object.freeze([]),
  }),
  ogg: Object.freeze({
    id: "ogg" as const,
    label: "Ogg",
    demuxer: "ogg",
    extensions: Object.freeze(["ogg", "oga"]),
    probeFormats: Object.freeze(["ogg"]),
    codecs: Object.freeze(["vorbis", "opus", "flac", "speex"]),
    codecPrefixes: Object.freeze([]),
  }),
  opus: Object.freeze({
    id: "opus" as const,
    label: "Opus",
    // An `.opus` file is Ogg-framed; the demuxer name is `ogg`, not `opus`.
    demuxer: "ogg",
    extensions: Object.freeze(["opus"]),
    probeFormats: Object.freeze(["ogg"]),
    codecs: Object.freeze(["opus"]),
    codecPrefixes: Object.freeze([]),
  }),
});

export const NATIVE_SOURCE_FORMATS: readonly NativeSourceFormat[] =
  Object.freeze(Object.values(FORMATS));

const EXTENSION_INDEX: Readonly<Record<string, NativeSourceFormat>> = Object.freeze(
  Object.fromEntries(
    NATIVE_SOURCE_FORMATS.flatMap((format) =>
      format.extensions.map((extension) => [extension, format] as const)),
  ),
);

export const NATIVE_SOURCE_EXTENSIONS: readonly string[] = Object.freeze(
  Object.keys(EXTENSION_INDEX),
);

/** Resolve by lowercase extension only; no content sniffing or fallback. */
export function resolveNativeSourceFormat(filePath: string): NativeSourceFormat | null {
  const extension = path.extname(filePath).toLowerCase().replace(/^\./, "");
  if (extension.length === 0) return null;
  return EXTENSION_INDEX[extension] ?? null;
}

export function acceptsProbedContainer(
  format: NativeSourceFormat,
  formatName: string,
): boolean {
  const tokens = formatName
    .toLowerCase()
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.some((token) => format.probeFormats.includes(token));
}

export function acceptsProbedCodec(
  format: NativeSourceFormat,
  codecName: string,
): boolean {
  const name = codecName.toLowerCase();
  return format.codecs.includes(name) ||
    format.codecPrefixes.some((prefix) => name.startsWith(prefix));
}
