import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_WAV_BYTES,
} from "@codec-abx/contracts";
import { decodePcm16 } from "@codec-abx/measurements";

import { PlaybackError } from "../src/errors.js";
import {
  CANONICAL_PCM16_HEADER_BYTES,
  MAX_CLIP_BYTES,
  MAX_CLIP_SECONDS,
  decodeCanonicalPcm16,
} from "../src/wav.js";
import { makeWav } from "./fixtures.js";

test("accepts canonical mono/stereo PCM16 at each shared rate", () => {
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    for (const channels of [1, 2] as const) {
      const clip = decodeCanonicalPcm16(makeWav({ sampleRate, channels, seconds: 0.4 }));
      assert.equal(clip.sampleRate, sampleRate);
      assert.equal(clip.channels, channels);
      assert.equal(clip.frames, Math.round(sampleRate * 0.4));
      assert.equal(clip.channelData.length, channels);
      assert.ok(Math.abs(clip.durationSeconds - 0.4) < 1e-12);
    }
  }
});

test("decodes signed PCM16 without changing channel counts", () => {
  const clip = decodeCanonicalPcm16(
    makeWav({ channels: 2, antiPhase: true, seconds: 0.4 }),
  );
  assert.equal(clip.channelData.length, 2);
  const left = clip.channelData[0]!;
  const right = clip.channelData[1]!;
  assert.equal(left.length, right.length);
  for (let index = 0; index < left.length; index += 1) {
    const leftSample = left[index]!;
    const rightSample = right[index]!;
    assert.ok(Math.abs(leftSample + rightSample) < 1e-9);
  }
});

test("maps malformed audio and unsupported rates to playback load failures", () => {
  // Structure details belong to the shared parser suite. Here the boundary
  // contract is that parser failures become a PlaybackError.
  const cases: Array<[string, Uint8Array]> = [
    ["too short", new Uint8Array(10)],
    ["not RIFF", mutate(makeWav({ seconds: 0.4 }), 0, [0x4e])],
    ["float PCM", mutate(makeWav({ seconds: 0.4 }), 20, [3, 0])],
    ["22050 Hz", mutate(makeWav({ seconds: 0.4 }), 24, [0x22, 0x56, 0, 0])],
  ];
  for (const [name, bytes] of cases) {
    assert.throws(
      () => decodeCanonicalPcm16(bytes),
      (error: unknown) => error instanceof PlaybackError && error.code === "load-failed",
      name,
    );
  }
});

test("enforces the 0.4 s minimum and shared delivery plus explicit padding ceiling", () => {
  assert.equal(MAX_CLIP_SECONDS, AUDIO_MAX_DURATION_SECONDS + 0.5);
  assert.equal(MAX_CLIP_BYTES, AUDIO_MAX_WAV_BYTES);
  assert.throws(
    () => decodeCanonicalPcm16(makeWav({ seconds: 0.399 })),
    /shorter than 0.4 s/,
  );
  // Long material beyond the old ten-second bound is accepted unchanged.
  const long = decodeCanonicalPcm16(makeWav({ seconds: 11 }));
  assert.equal(long.durationSeconds, 11);
  // The ceiling is derived from the shared delivery policy, so this remains a
  // boundary check rather than a duplicated hard-coded duration.
  const overCeiling = silentWav(MAX_CLIP_SECONDS + 0.01);
  assert.throws(
    () => decodeCanonicalPcm16(overCeiling),
    new RegExp(`longer than ${MAX_CLIP_SECONDS} s`),
  );
});

test("playback preserves codec padding beyond the former ten-minute bound within the shared ceiling", () => {
  const clip = decodeCanonicalPcm16(silentWav(600.03));
  assert.equal(clip.frames, Math.round(600.03 * 44_100));
  assert.ok(clip.durationSeconds > 600);
  assert.ok(clip.durationSeconds < MAX_CLIP_SECONDS);
});

/** Zero-filled canonical mono WAV that does not pay a per-sample loop. */
function silentWav(seconds: number, sampleRate = 44_100): Uint8Array {
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

test("rejects an oversized buffer before parsing it", () => {
  // A proxy keeps the bound check analytical: it reports one byte over the
  // shared maximum without allocating the multi-hundred-MiB buffer.
  const small = new Uint8Array(CANONICAL_PCM16_HEADER_BYTES);
  const oversized = new Proxy(small, {
    get(target, property, receiver) {
      if (property === "byteLength") return MAX_CLIP_BYTES + 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.ok(oversized instanceof Uint8Array);
  assert.throws(() => decodeCanonicalPcm16(oversized), /byte bound/);
});

function mutate(bytes: Uint8Array, offset: number, values: readonly number[]): Uint8Array {
  const copy = bytes.slice();
  values.forEach((value, index) => {
    copy[offset + index] = value;
  });
  return copy;
}

test("direct PCM16 to Float32 conversion preserves the Float64 decode bits", () => {
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    for (const channels of [1, 2] as const) {
      const seconds = 0.45;
      const frames = Math.round(sampleRate * seconds);
      const bytes = makeWav({ sampleRate, channels, seconds, antiPhase: true });
      const clip = decodeCanonicalPcm16(bytes);
      const decoded = decodePcm16(bytes, {
        sampleRate,
        channels,
        dataOffset: 44,
        dataSize: frames * channels * 2,
      });
      for (let channel = 0; channel < channels; channel += 1) {
        const float32 = new Float32Array(decoded.channels[channel]!);
        assert.deepEqual(
          new Uint32Array(clip.channelData[channel]!.buffer),
          new Uint32Array(float32.buffer),
          `${String(sampleRate)} Hz ${String(channels)} ch`,
        );
      }
    }
  }
});
