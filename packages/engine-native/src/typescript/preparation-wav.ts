import { createHash } from "node:crypto";

import type { AudioDescription } from "@codec-abx/contracts";
import {
  CanonicalPcm16WavStructureError,
  parseCanonicalPcm16WavStructure,
  type CanonicalPcm16WavFacts,
  type CanonicalPcm16WavProblem,
} from "@codec-abx/measurements";

export type { CanonicalPcm16WavFacts } from "@codec-abx/measurements";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(problem: CanonicalPcm16WavProblem): never {
  throw new Error(deliveredMessage(problem));
}

function deliveredMessage(problem: CanonicalPcm16WavProblem): string {
  switch (problem.code) {
    case "not-bytes":
      return "Delivered WAV bytes must be a Uint8Array";
    case "too-short":
      return "Delivered audio is shorter than a canonical 44-byte WAV header";
    case "not-riff-wave":
      return "Delivered audio is not a RIFF/WAVE file";
    case "layout":
      return problem.layout === "fmt"
        ? "Delivered WAV is not in the canonical fmt-first layout"
        : "Delivered WAV is not in the canonical single-data-chunk layout";
    case "riff-size":
      return "Delivered WAV RIFF size does not match its exact bytes";
    case "fmt-size":
      return "Delivered WAV fmt chunk is not the canonical 16-byte PCM header";
    case "not-pcm":
      return "Delivered WAV is not integer PCM";
    case "channels":
      return `Delivered WAV has unsupported channel count ${String(problem.channels)}`;
    case "sample-rate":
      return `Delivered WAV rate ${String(problem.sampleRate)} Hz is outside the shared 44.1/48/96 kHz domain`;
    case "format-fields":
      return problem.field === "byte-rate"
        ? "Delivered WAV byte rate disagrees with its PCM16 layout"
        : problem.field === "block-align"
          ? "Delivered WAV block alignment disagrees with its PCM16 layout"
          : "Delivered WAV is not 16-bit PCM";
    case "empty-data":
    case "partial-frame":
      return "Delivered WAV data is empty or not a whole number of PCM16 frames";
    case "data-size":
      return "Delivered WAV data size does not match its exact bytes";
  }
}

/**
 * Strictly parse the exact canonical little-endian PCM16 WAVs produced by the
 * shared preparation policy. This is a delivery boundary, not a general WAV
 * reader: alternate chunk layouts, trailing bytes and non-canonical headers
 * fail closed rather than being normalised into the same report. Caller bounds
 * (duration/retention) remain in the preparation verification path.
 */
export function parseCanonicalPcm16Wav(bytes: Uint8Array): CanonicalPcm16WavFacts {
  if (!(bytes instanceof Uint8Array)) fail({ code: "not-bytes" });
  try {
    return parseCanonicalPcm16WavStructure(bytes);
  } catch (error) {
    if (error instanceof CanonicalPcm16WavStructureError) fail(error.problem);
    throw error;
  }
}

export function describeCanonicalWav(
  bytes: Uint8Array,
  facts: CanonicalPcm16WavFacts,
): AudioDescription {
  return Object.freeze({
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    frames: facts.frames,
    wavSha256: sha256Hex(bytes),
  });
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** One exact-copy ownership boundary for every caller-facing audio read. */
export function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
