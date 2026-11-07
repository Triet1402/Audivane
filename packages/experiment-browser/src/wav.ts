/**
 * Narrow canonical PCM16 WAV envelope for transport binding copies.
 *
 * This mirrors the shared policy writer shape: a 44-byte RIFF/WAVE header, one
 * 16-byte PCM `fmt ` chunk and one `data` chunk at byte 44. It is intentionally
 * not a general WAV importer. The worker service independently re-parses and
 * hashes the transferred bytes; these checks only prevent obviously impossible
 * payloads from crossing the boundary.
 */
import {
  AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_MAX_RETAINED_BYTES,
  AUDIO_MAX_WAV_BYTES,
} from "@codec-abx/contracts";

import { clientError } from "./errors.js";

export const MAX_WAV_BYTES = AUDIO_MAX_WAV_BYTES;
export const MAX_RETAINED_BYTES = AUDIO_MAX_RETAINED_BYTES;
export const MIN_DURATION_SECONDS = 0.4;
export const MAX_DURATION_SECONDS = AUDIO_MAX_DELIVERY_SECONDS;
const SUPPORTED_SAMPLE_RATES = new Set([44_100, 48_000, 96_000]);
const HEADER_BYTES = 44;
const DURATION_EPSILON = 1e-12;

export interface CanonicalWavFacts {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly durationSeconds: number;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function invalid(label: string, detail: string): never {
  throw clientError("artifact-bytes-mismatch", `${label}: ${detail}`);
}

/** Copy an exact ArrayBuffer before any parsing or transfer. Never detaches it. */
export function copyByteBuffer(value: unknown, label: string): Uint8Array {
  if (!(value instanceof ArrayBuffer)) {
    invalid(label, "reader did not return an ArrayBuffer");
  }
  if (value.byteLength > MAX_WAV_BYTES) {
    invalid(label, `exceeds the ${MAX_WAV_BYTES} byte bound`);
  }
  return new Uint8Array(value.slice(0));
}

export function parseCanonicalWav(bytes: Uint8Array, label: string): CanonicalWavFacts {
  if (!(bytes instanceof Uint8Array)) invalid(label, "bytes must be a Uint8Array");
  if (bytes.byteLength > MAX_WAV_BYTES) {
    invalid(label, `exceeds the ${MAX_WAV_BYTES} byte bound`);
  }
  if (bytes.byteLength < HEADER_BYTES) invalid(label, "is shorter than the canonical header");
  if (ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") {
    invalid(label, "is not RIFF/WAVE");
  }
  if (ascii(bytes, 12) !== "fmt " || ascii(bytes, 36) !== "data") {
    invalid(label, "is not the canonical single fmt/data layout");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
    invalid(label, "RIFF size does not match the supplied bytes");
  }
  if (view.getUint32(16, true) !== 16) invalid(label, "fmt chunk is not 16 bytes");
  if (view.getUint16(20, true) !== 1) invalid(label, "is not integer PCM");
  const channels = view.getUint16(22, true);
  if (channels !== 1 && channels !== 2) invalid(label, "is not mono or stereo");
  const sampleRate = view.getUint32(24, true);
  if (!SUPPORTED_SAMPLE_RATES.has(sampleRate)) {
    invalid(label, `sample rate ${String(sampleRate)} is not 44100/48000/96000`);
  }
  const blockAlign = channels * 2;
  if (view.getUint16(32, true) !== blockAlign ||
      view.getUint16(34, true) !== 16 ||
      view.getUint32(28, true) !== sampleRate * blockAlign) {
    invalid(label, "PCM16 format fields are inconsistent");
  }
  const dataSize = view.getUint32(40, true);
  if (dataSize <= 0) invalid(label, "data chunk is empty");
  if (dataSize % blockAlign !== 0) invalid(label, "data is not a whole number of frames");
  if (HEADER_BYTES + dataSize !== bytes.byteLength) {
    invalid(label, "canonical header length disagrees with the data chunk");
  }
  const frames = dataSize / blockAlign;
  const durationSeconds = frames / sampleRate;
  if (durationSeconds + DURATION_EPSILON < MIN_DURATION_SECONDS) {
    invalid(label, `is shorter than ${MIN_DURATION_SECONDS} s`);
  }
  if (durationSeconds > MAX_DURATION_SECONDS + DURATION_EPSILON) {
    invalid(label, `exceeds the ${MAX_DURATION_SECONDS} s bound`);
  }
  return {
    sampleRate,
    channels: channels === 1 ? 1 : 2,
    frames,
    durationSeconds,
  };
}

export function readCanonicalWav(value: unknown, label: string): {
  readonly bytes: Uint8Array;
  readonly facts: CanonicalWavFacts;
} {
  const bytes = copyByteBuffer(value, label);
  return { bytes, facts: parseCanonicalWav(bytes, label) };
}
