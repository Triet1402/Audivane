/**
 * Strict canonical PCM16 WAV decoding for playback.
 *
 * This accepts only the shared policy envelope: a 44-byte RIFF/WAVE header,
 * one 16-byte PCM `fmt ` chunk, one `data` chunk, mono/stereo, 44.1/48/96 kHz,
 * 0.4 s up to the shared delivery ceiling plus explicit codec padding, and at
 * most the shared maximum canonical WAV bytes.
 * AudioBuffers are then created from the actual
 * PCM16 samples; decodeAudioData is never used, so frame counts cannot be
 * silently changed by an implementation-chosen resample. Structure comes from
 * the shared measurements parser; the clip resource/duration bounds and public
 * `load-failed` contract stay here.
 */
import {
  AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_MAX_WAV_BYTES,
} from "@codec-abx/contracts";
import {
  CANONICAL_PCM16_HEADER_BYTES,
  CanonicalPcm16WavStructureError,
  parseCanonicalPcm16WavStructure,
  type CanonicalPcm16WavProblem,
} from "@codec-abx/measurements";

import { PlaybackError, playbackError } from "./errors.js";

export { CANONICAL_PCM16_HEADER_BYTES };
export const MAX_CLIP_BYTES = AUDIO_MAX_WAV_BYTES;
export const MIN_CLIP_SECONDS = 0.4;
export const MAX_CLIP_SECONDS = AUDIO_MAX_DELIVERY_SECONDS;

export interface DecodedClip {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly durationSeconds: number;
  /** Private float copies of the delivered PCM16, never shared with callers. */
  readonly channelData: readonly Float32Array<ArrayBuffer>[];
}

function reject(problem: CanonicalPcm16WavProblem): never {
  playbackError("load-failed", loadMessage(problem));
}

function loadMessage(problem: CanonicalPcm16WavProblem): string {
  switch (problem.code) {
    case "not-bytes":
      return "audio bytes must be a Uint8Array";
    case "too-short":
      return "audio is shorter than the canonical WAV header";
    case "not-riff-wave":
      return "audio is not RIFF/WAVE";
    case "layout":
      return "audio is not the canonical single fmt/data layout";
    case "riff-size":
      return "WAV RIFF size does not exactly match the supplied bytes";
    case "fmt-size":
      return "WAV fmt chunk must be 16 bytes";
    case "not-pcm":
      return "WAV must be integer PCM";
    case "channels":
      return "WAV must be mono or stereo";
    case "sample-rate":
      return `WAV sample rate ${String(problem.sampleRate)} is not supported`;
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

export function decodeCanonicalPcm16(bytes: Uint8Array): DecodedClip {
  if (!(bytes instanceof Uint8Array)) reject({ code: "not-bytes" });
  if (bytes.byteLength > MAX_CLIP_BYTES) {
    playbackError("load-failed", `audio exceeds the ${MAX_CLIP_BYTES} byte bound`);
  }

  let facts;
  try {
    facts = parseCanonicalPcm16WavStructure(bytes);
  } catch (error) {
    if (error instanceof CanonicalPcm16WavStructureError) reject(error.problem);
    throw error;
  }
  const { sampleRate, channels, frames, durationSeconds } = facts;
  if (durationSeconds + 1e-9 < MIN_CLIP_SECONDS) {
    playbackError(
      "load-failed",
      `WAV is ${durationSeconds.toFixed(6)} s, shorter than ${MIN_CLIP_SECONDS} s`,
    );
  }
  if (durationSeconds - 1e-9 > MAX_CLIP_SECONDS) {
    playbackError(
      "load-failed",
      `WAV is ${durationSeconds.toFixed(6)} s, longer than ${MAX_CLIP_SECONDS} s`,
    );
  }

  let channelData: Float32Array<ArrayBuffer>[];
  try {
    channelData = decodePcm16ToFloat32(bytes, channels, facts.dataSize);
  } catch (error) {
    if (error instanceof PlaybackError) throw error;
    playbackError("load-failed", "WAV PCM16 samples could not be decoded");
  }
  return Object.freeze({
    sampleRate,
    channels,
    frames,
    durationSeconds,
    channelData,
  });
}

/**
 * Convert canonical PCM16 directly into playback Float32 copies.
 *
 * `int16 / 32768` is exact in binary floating point, so round-to-Float32 gives
 * the same bits as decoding to Float64 and then copying into a Float32Array.
 * Avoiding the full Float64 intermediate keeps long-track Web Audio loading
 * from briefly holding both representations per side.
 */
function decodePcm16ToFloat32(
  bytes: Uint8Array,
  channels: 1 | 2,
  dataSize: number,
): Float32Array<ArrayBuffer>[] {
  const blockAlign = channels * 2;
  if (dataSize <= 0 || dataSize % blockAlign !== 0) {
    playbackError("load-failed", "WAV PCM16 data is not a whole number of frames");
  }
  const frames = dataSize / blockAlign;
  const planar: Float32Array<ArrayBuffer>[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    planar.push(new Float32Array(frames));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = CANONICAL_PCM16_HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = view.getInt16(offset, true);
      planar[channel]![frame] = sample / 32768;
      offset += 2;
    }
  }
  return planar;
}
