import { SUPPORTED_SAMPLE_RATES } from "./types.js";

/**
 * Shared structure of the canonical PCM16 WAV envelope emitted by the frozen
 * `aligned-gain-matched-v1` / `delivered-canary-v1` writers: a 44-byte
 * RIFF/WAVE header, one 16-byte PCM `fmt ` chunk, and one `data` chunk at byte
 * 44. This is not a general WAV parser. Callers own their resource bounds,
 * duration policy and public error contracts around these structural facts.
 */
export const CANONICAL_PCM16_HEADER_BYTES = 44 as const;

export interface CanonicalPcm16WavFacts {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly dataOffset: 44;
  readonly dataSize: number;
  readonly durationSeconds: number;
}

/** The exact structural disagreement found before caller policy is applied. */
export type CanonicalPcm16WavProblem =
  | { readonly code: "not-bytes" }
  | { readonly code: "too-short" }
  | { readonly code: "not-riff-wave" }
  | { readonly code: "layout"; readonly layout: "fmt" | "data" }
  | { readonly code: "riff-size" }
  | { readonly code: "fmt-size" }
  | { readonly code: "not-pcm" }
  | { readonly code: "channels"; readonly channels: number }
  | { readonly code: "sample-rate"; readonly sampleRate: number }
  | {
      readonly code: "format-fields";
      readonly field: "byte-rate" | "block-align" | "bits";
    }
  | { readonly code: "empty-data" }
  | { readonly code: "partial-frame" }
  | { readonly code: "data-size" };

export class CanonicalPcm16WavStructureError extends Error {
  readonly problem: CanonicalPcm16WavProblem;

  constructor(problem: CanonicalPcm16WavProblem) {
    super(describeCanonicalPcm16WavProblem(problem));
    this.name = "CanonicalPcm16WavStructureError";
    this.problem = problem;
  }
}

function describeCanonicalPcm16WavProblem(problem: CanonicalPcm16WavProblem): string {
  switch (problem.code) {
    case "not-bytes":
      return "WAV bytes must be a Uint8Array";
    case "too-short":
      return "WAV is shorter than the canonical 44-byte header";
    case "not-riff-wave":
      return "WAV is not RIFF/WAVE";
    case "layout":
      return "WAV is not the canonical single fmt/data layout";
    case "riff-size":
      return "WAV RIFF size does not exactly match the supplied bytes";
    case "fmt-size":
      return "WAV fmt chunk must be 16 bytes";
    case "not-pcm":
      return "WAV must be integer PCM";
    case "channels":
      return "WAV must be mono or stereo";
    case "sample-rate":
      return `WAV sample rate ${String(problem.sampleRate)} is outside the supported measurement domain`;
    case "format-fields":
      return "WAV PCM16 format fields are inconsistent";
    case "empty-data":
      return "WAV data chunk is empty";
    case "partial-frame":
      return "WAV data is not a whole number of frames";
    case "data-size":
      return "WAV canonical header length disagrees with the data chunk";
  }
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function problem(found: CanonicalPcm16WavProblem): never {
  throw new CanonicalPcm16WavStructureError(found);
}

/**
 * Read and validate only the canonical structural envelope. Resource limits and
 * duration policy deliberately belong to each caller, and malformed layouts are
 * refused rather than normalised.
 */
export function parseCanonicalPcm16WavStructure(
  bytes: unknown,
): CanonicalPcm16WavFacts {
  if (!(bytes instanceof Uint8Array)) problem({ code: "not-bytes" });
  if (bytes.byteLength < CANONICAL_PCM16_HEADER_BYTES) problem({ code: "too-short" });
  if (ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") {
    problem({ code: "not-riff-wave" });
  }
  if (ascii(bytes, 12) !== "fmt ") problem({ code: "layout", layout: "fmt" });
  if (ascii(bytes, 36) !== "data") problem({ code: "layout", layout: "data" });

  // Honour byteOffset/byteLength of caller-owned views instead of reading the
  // surrounding backing buffer.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true);
  if (riffSize + 8 !== bytes.byteLength) problem({ code: "riff-size" });
  if (view.getUint32(16, true) !== 16) problem({ code: "fmt-size" });
  if (view.getUint16(20, true) !== 1) problem({ code: "not-pcm" });
  const channels = view.getUint16(22, true);
  if (channels !== 1 && channels !== 2) problem({ code: "channels", channels });
  const sampleRate = view.getUint32(24, true);
  if (!SUPPORTED_SAMPLE_RATES.some((rate) => rate === sampleRate)) {
    problem({ code: "sample-rate", sampleRate });
  }
  const blockAlign = channels * 2;
  if (view.getUint32(28, true) !== sampleRate * blockAlign) {
    problem({ code: "format-fields", field: "byte-rate" });
  }
  if (view.getUint16(32, true) !== blockAlign) {
    problem({ code: "format-fields", field: "block-align" });
  }
  if (view.getUint16(34, true) !== 16) {
    problem({ code: "format-fields", field: "bits" });
  }
  const dataSize = view.getUint32(40, true);
  if (dataSize <= 0) problem({ code: "empty-data" });
  if (dataSize % blockAlign !== 0) problem({ code: "partial-frame" });
  if (CANONICAL_PCM16_HEADER_BYTES + dataSize !== bytes.byteLength) {
    problem({ code: "data-size" });
  }

  const frames = dataSize / blockAlign;
  return Object.freeze({
    sampleRate,
    channels: channels === 1 ? 1 : 2,
    frames,
    dataOffset: CANONICAL_PCM16_HEADER_BYTES,
    dataSize,
    durationSeconds: frames / sampleRate,
  });
}
