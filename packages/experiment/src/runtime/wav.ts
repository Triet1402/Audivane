/**
 * Deliberately narrow canonical PCM16 WAV reader for runtime verification.
 *
 * The only accepted input is the exact header shape emitted by the frozen
 * shared `aligned-gain-matched-v1` / `delivered-canary-v1` writers: a 44-byte
 * RIFF/WAVE header, one 16-byte PCM `fmt ` chunk, and one `data` chunk at byte
 * 44. Structure comes from the shared measurements parser; this runtime owns
 * its shared duration-derived per-buffer/retained bounds and 0.4 s minimum. This is
 * not a general WAV parser and must not be widened to accept raw, extensible,
 * 24-bit, RF64 or trailing-chunk files.
 */
import {
  AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_MAX_RETAINED_BYTES,
  AUDIO_MAX_WAV_BYTES,
} from "@codec-abx/contracts";
import {
  CANONICAL_PCM16_HEADER_BYTES,
  CanonicalPcm16WavStructureError,
  parseCanonicalPcm16WavStructure,
  type CanonicalPcm16WavFacts,
} from "@codec-abx/measurements";

export { CANONICAL_PCM16_HEADER_BYTES };
/** Per-buffer bound shared by binding and serving; verification never reads more. */
export const MAX_ARTIFACT_BYTES = AUDIO_MAX_WAV_BYTES;
/** Two bounded deliveries plus calibration material. */
export const MAX_RETAINED_BYTES = AUDIO_MAX_RETAINED_BYTES;
export const MIN_DELIVERED_SECONDS = 0.4;
export const MAX_DELIVERED_SECONDS = AUDIO_MAX_DELIVERY_SECONDS;

export type CanonicalWavFacts = CanonicalPcm16WavFacts;

export class WavFormatError extends Error {
  readonly code = "invalid-canonical-wav";

  constructor(message: string) {
    super(message);
    this.name = "WavFormatError";
  }
}

function fail(message: string): never {
  throw new WavFormatError(message);
}

/** Parse and validate the exact canonical PCM16 envelope used by the policy. */
export function parseCanonicalPcm16Wav(bytes: Uint8Array): CanonicalWavFacts {
  if (!(bytes instanceof Uint8Array)) fail("WAV bytes must be a Uint8Array");
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    fail(`WAV exceeds the ${MAX_ARTIFACT_BYTES} byte runtime bound`);
  }

  let facts: CanonicalPcm16WavFacts;
  try {
    facts = parseCanonicalPcm16WavStructure(bytes);
  } catch (error) {
    if (error instanceof CanonicalPcm16WavStructureError) fail(error.message);
    throw error;
  }
  if (facts.durationSeconds + 1e-12 < MIN_DELIVERED_SECONDS) {
    fail(`WAV is ${facts.durationSeconds.toFixed(6)} s, shorter than the 0.4 s minimum`);
  }
  return facts;
}

export function copyByteBuffer(value: unknown, label: string): Uint8Array {
  if (!(value instanceof ArrayBuffer)) {
    fail(`${label} reader did not return an ArrayBuffer`);
  }
  if (value.byteLength > MAX_ARTIFACT_BYTES) {
    fail(`${label} exceeds the ${MAX_ARTIFACT_BYTES} byte runtime bound`);
  }
  return new Uint8Array(value.slice(0));
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("WebCrypto is not available");
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export function wavPcmPayload(bytes: Uint8Array, facts: CanonicalWavFacts): Uint8Array {
  return bytes.slice(facts.dataOffset, facts.dataOffset + facts.dataSize);
}

export function requireSha256Hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${label} must be a 64-character SHA-256 hex string`);
  }
  return value.toLowerCase();
}
