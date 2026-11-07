import type { AudioDescription } from "@codec-abx/contracts";
import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_WAV_BYTES,
  AUDIO_MAX_SOURCE_PADDING_SECONDS,
  AUDIO_MAX_DELIVERY_PADDING_SECONDS,
} from "@codec-abx/contracts";

/**
 * Browser-local aliases of the shared local-audio envelope. The values live in
 * `@codec-abx/contracts`; this adapter must not invent a narrower or wider
 * policy on its own.
 */
export const BROWSER_MAX_INPUT_BYTES = AUDIO_MAX_INPUT_BYTES;
export const BROWSER_MAX_DURATION_SECONDS = AUDIO_MAX_DURATION_SECONDS;
export const BROWSER_MAX_WAV_BYTES = AUDIO_MAX_WAV_BYTES;
export const BROWSER_SOURCE_SAMPLE_RATES = [44100, 48000, 96000] as const;

/**
 * Narrow end-of-stream codec padding allowance at canonical import. A source
 * whose decoded material is longer than this is refused, never cropped.
 */
export const BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS = AUDIO_MAX_SOURCE_PADDING_SECONDS;

/**
 * Extra allowance for codec round-trip padding accumulated by one browser
 * chain (up to four stages). It is a refusal ceiling, not a crop window.
 */
export const BROWSER_CHAIN_PADDING_TOLERANCE_SECONDS = AUDIO_MAX_DELIVERY_PADDING_SECONDS;

/**
 * Build a canonical 44-byte-header PCM16 WAV. The supplemental LC3/LDAC codecs
 * decode inside WASM, so their staged PCM is re-wrapped in a plain RIFF/WAVE
 * file and restored to the session rate/layout by the same explicit
 * `-ar/-ac pcm_s16le` decoder invocation every other stage uses.
 * The output must satisfy parseLinearWav exactly as written here.
 */
export function buildPcm16Wav(
  pcm: Int16Array,
  sampleRate: number,
  channels: 1 | 2,
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`WAV writer: invalid sample rate ${String(sampleRate)}`);
  }
  if (pcm.byteLength % (channels * 2) !== 0) {
    throw new Error("WAV writer: PCM buffer is not a whole number of sample frames");
  }
  const dataBytes = pcm.byteLength;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const setAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  setAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  setAscii(8, "WAVE");
  setAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  setAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return bytes;
}

/** Facts read from the exact PCM16 WAV bytes that are delivered to the caller. */
export interface WavFacts {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly bitsPerSample: 16;
  readonly dataOffset: number;
  readonly dataSize: number;
  readonly durationSeconds: number;
}

export interface SourceWavFacts extends Omit<WavFacts, "bitsPerSample"> {
  readonly bitsPerSample: number;
  readonly format: number;
  readonly validBits: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

/**
 * Parse a RIFF/WAVE file directly. This deliberately does not use Web Audio:
 * decodeAudioData may silently resample or downmix, which would hide the very
 * sample-rate and channel facts this import must report.
 */
function parseLinearWav(bytes: Uint8Array, sourcePrecision: boolean): SourceWavFacts {
  if (bytes.byteLength < 44) throw new Error("WAV file is shorter than a canonical 44-byte header");
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Source is not a RIFF/WAVE file");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredRiffSize = view.getUint32(4, true);
  if (declaredRiffSize + 8 > bytes.byteLength) {
    throw new Error("RIFF size exceeds the available bytes (truncated WAV)");
  }
  if (declaredRiffSize + 8 !== bytes.byteLength) {
    throw new Error("RIFF size does not match the file; trailing bytes outside RIFF are unsupported");
  }

  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let byteRate: number | null = null;
  let blockAlign: number | null = null;
  let bitsPerSample: number | null = null;
  let validBits: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;
  let dataChunks = 0;
  let formatChunks = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) {
      throw new Error(`WAV chunk ${JSON.stringify(id)} exceeds the available bytes`);
    }
    if (id === "fmt ") {
      formatChunks += 1;
      if (formatChunks !== 1) throw new Error("WAV must contain exactly one fmt chunk");
      if (size < 16) throw new Error("WAV fmt chunk is truncated");
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      byteRate = view.getUint32(body + 8, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
      validBits = bitsPerSample;
      if (format === 0xfffe) {
        // Check the complete KSDATAFORMAT_SUBTYPE_PCM GUID, not only its tag.
        const subtype = bytes[body + 24];
        const pcmGuid = [subtype, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
        if (size < 40 || view.getUint16(body + 16, true) !== 22 ||
            (subtype !== 1 && (!sourcePrecision || subtype !== 3)) ||
            pcmGuid.some((byte, index) => bytes[body + 24 + index] !== byte)) {
          throw new Error("Extensible WAV has an invalid PCM subformat");
        }
        validBits = view.getUint16(body + 18, true);
        if (!sourcePrecision && validBits !== 16) {
          throw new Error("Extensible WAV must have 16 valid bits per sample");
        }
        const mask = view.getUint32(body + 20, true);
        if (mask !== 0 && mask !== (channels === 1 ? 4 : 3)) {
          throw new Error("Extensible WAV channel mask must be standard mono/stereo or unspecified");
        }
        format = subtype ?? null;
      }
    } else if (id === "data") {
      dataChunks += 1;
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }

  if (offset !== bytes.byteLength) {
    throw new Error("WAV has trailing bytes outside RIFF chunks");
  }
  if (format !== 1 && (!sourcePrecision || format !== 3)) throw new Error("WAV is not supported linear PCM");
  if (channels !== 1 && channels !== 2) {
    throw new Error(`WAV has unsupported channel count ${String(channels)}; mono/stereo only`);
  }
  if (!sourcePrecision && bitsPerSample !== 16) {
    throw new Error(`WAV is ${String(bitsPerSample)}-bit; 16-bit PCM only`);
  }
  if (sampleRate === null || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("WAV has no usable sample rate");
  }
  if (bitsPerSample === null || ![8, 16, 24, 32, 64].includes(bitsPerSample) ||
      validBits === null || validBits <= 0 || validBits > bitsPerSample ||
      (format === 3 && (bitsPerSample !== 32 && bitsPerSample !== 64))) {
    throw new Error("WAV has unsupported PCM precision or valid bits");
  }
  const bytesPerFrame = channels * (bitsPerSample / 8);
  if (blockAlign !== bytesPerFrame || byteRate !== sampleRate * bytesPerFrame) {
    throw new Error("WAV format fields are inconsistent with PCM16 mono/stereo");
  }
  if (dataChunks !== 1 || dataOffset === null || dataSize === null) {
    throw new Error("WAV must contain exactly one data chunk");
  }
  if (dataSize <= 0) throw new Error("WAV data chunk is empty");
  if (dataSize % blockAlign !== 0) throw new Error("WAV data is not a whole number of frames");

  const frames = dataSize / blockAlign;
  return {
    sampleRate,
    channels,
    frames,
    bitsPerSample,
    format,
    validBits,
    dataOffset,
    dataSize,
    durationSeconds: frames / sampleRate,
  };
}

export interface Pcm16Samples {
  readonly facts: SourceWavFacts;
  /** Interleaved PCM16 samples, exactly the source data bytes. */
  readonly samples: Int16Array;
}

/**
 * Parse a PCM16 WAV and copy its data chunk into an Int16Array. The
 * supplemental LC3/LDAC codecs consume interleaved s16le PCM, and this is the
 * only place canonical WAV bytes become samples for them.
 */
export function parsePcm16Samples(bytes: Uint8Array): Pcm16Samples {
  const source = parseSourceWav(bytes);
  if (source.format !== 1 || source.bitsPerSample !== 16) {
    throw new Error(
      `Supplemental codec input must be canonical PCM16, found format ` +
        `${String(source.format)}/${String(source.bitsPerSample)} bits`);
  }
  const data = bytes.subarray(source.dataOffset, source.dataOffset + source.dataSize);
  if (data.byteLength % 2 !== 0) throw new Error("PCM16 data is not 2-byte aligned");
  const samples = new Int16Array(data.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + source.dataOffset, source.dataSize);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return { facts: source, samples };
}

/** Strict delivered PCM16 parser; source precision never widens this boundary. */
export function parsePcm16Wav(bytes: Uint8Array): WavFacts {
  const { format: _format, validBits: _validBits, ...facts } = parseLinearWav(bytes, false);
  return { ...facts, bitsPerSample: 16 };
}

/** Verify complete linear WAV structure before allowing FFmpeg to normalize it. */
export function parseSourceWav(bytes: Uint8Array): SourceWavFacts {
  return parseLinearWav(bytes, true);
}

/**
 * Validate a strict canonical PCM16 WAV snapshot. This remains the fast path
 * for sources that are already canonical PCM16; compressed, 24-bit/float and
 * otherwise non-canonical containers are decoded once by FFmpeg instead.
 */
export function validateSourceWav(bytes: Uint8Array): WavFacts {
  if (bytes.byteLength > BROWSER_MAX_WAV_BYTES) {
    throw new Error(
      `Source exceeds the ${String(BROWSER_MAX_WAV_BYTES)} byte canonical WAV limit`,
    );
  }
  const facts = parsePcm16Wav(bytes);
  if (!BROWSER_SOURCE_SAMPLE_RATES.some((rate) => rate === facts.sampleRate)) {
    throw new Error(
      `Source rate ${String(facts.sampleRate)} Hz is unsupported in native mode; use ` +
        "44100, 48000 or 96000 Hz, or select the explicit force-48k policy",
    );
  }
  if (facts.durationSeconds >
      BROWSER_MAX_DURATION_SECONDS + BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS) {
    throw new Error(
      `Source is ${facts.durationSeconds.toFixed(3)} s; the limit is ` +
        `${String(BROWSER_MAX_DURATION_SECONDS)} s plus at most ` +
        `${String(BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS)} s codec padding. ` +
        "The source is refused rather than silently cropped.",
    );
  }
  return facts;
}

export function wavDescription(bytes: Uint8Array, sha256: string): AudioDescription {
  const facts = parsePcm16Wav(bytes);
  return Object.freeze({
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    frames: facts.frames,
    wavSha256: sha256,
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
