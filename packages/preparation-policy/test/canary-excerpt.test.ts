import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_CANARY_EXCERPT_SECONDS } from "@codec-abx/contracts";
import { decodePcm16, type PcmAudio } from "@codec-abx/measurements";

import {
  buildCanaryExcerptPair,
  buildCanaryPair,
  canaryExcerptFrames,
  canaryExcerptPcm,
} from "../src/index.js";

const RATE = 48_000;

function pcm(seconds: number, channels: 1 | 2 = 1): PcmAudio {
  const frames = Math.round(seconds * RATE);
  return {
    sampleRate: RATE,
    channels: Array.from({ length: channels }, (_, channel) => {
      const samples = new Float64Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        // Exact signed PCM16 grid values; deterministic and non-periodic.
        const value = Math.round(
          12_000 * Math.sin((2 * Math.PI * (317 + channel * 211) * frame) / RATE + frame / 997),
        );
        samples[frame] = value / 32768;
      }
      return samples;
    }),
  };
}

function payload(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(44, 44 + (bytes.length - 44));
}

test("short material keeps the frozen full-extent canary byte for byte", () => {
  const input = pcm(0.6);
  const expected = buildCanaryPair(input);
  const actual = buildCanaryExcerptPair(input);
  assert.deepEqual(actual.pristineWav, expected.pristineWav);
  assert.deepEqual(actual.degradedWav, expected.degradedWav);
  assert.deepEqual(actual.report, expected.report);
  assert.equal(actual.report.frames, input.channels[0]!.length);
});

test("long material calibrates on exactly the FIRST ten seconds", () => {
  const input = pcm(12);
  const result = buildCanaryExcerptPair(input);
  const excerptFrames = AUDIO_CANARY_EXCERPT_SECONDS * RATE;
  assert.equal(canaryExcerptFrames(RATE, input.channels[0]!.length), excerptFrames);
  assert.equal(result.report.frames, excerptFrames);
  assert.ok(
    result.report.notes.some((note) =>
      note.includes(`FIRST ${String(excerptFrames)} frames`)),
  );

  const decoded = decodePcm16(result.pristineWav, {
    sampleRate: result.report.sampleRate,
    channels: result.report.channels,
    dataOffset: 44,
    dataSize: result.pristineWav.byteLength - 44,
  });
  assert.equal(decoded.channels[0]!.length, excerptFrames);
  for (let frame = 0; frame < excerptFrames; frame += 1) {
    // `+ 0` normalises the signed zero that PCM16 zero may carry.
    assert.equal(decoded.channels[0]![frame]! + 0, input.channels[0]![frame]! + 0);
  }
  // The prefix is not an arbitrary full-length or suffix excerpt.
  assert.notEqual(result.pristineWav.byteLength, 44 + input.channels[0]!.length * 2);
  const suffix = payload(buildCanaryPair(canaryExcerptPcm({
    sampleRate: RATE,
    channels: input.channels.map((channel) => channel.subarray(input.channels[0]!.length - excerptFrames)),
  })).pristineWav);
  assert.notDeepEqual(payload(result.pristineWav), suffix);
});

test("boundary excerpt selection preserves integer frame counts", () => {
  assert.equal(canaryExcerptFrames(RATE, AUDIO_CANARY_EXCERPT_SECONDS * RATE), AUDIO_CANARY_EXCERPT_SECONDS * RATE);
  assert.equal(canaryExcerptFrames(RATE, AUDIO_CANARY_EXCERPT_SECONDS * RATE + 1), AUDIO_CANARY_EXCERPT_SECONDS * RATE);
  assert.equal(canaryExcerptFrames(RATE, 1), 1);
  assert.throws(() => canaryExcerptFrames(RATE, 0), /positive safe integer/);
  assert.throws(() => canaryExcerptFrames(0, 10), /not positive/);
});

test("long stereo material selects both channels of the same prefix", () => {
  const input = pcm(11, 2);
  const result = buildCanaryExcerptPair(input);
  assert.equal(result.report.channels, 2);
  const excerpt = canaryExcerptPcm(input);
  assert.equal(excerpt.channels[0]!.length, AUDIO_CANARY_EXCERPT_SECONDS * RATE);
  assert.equal(excerpt.channels[1]!.length, AUDIO_CANARY_EXCERPT_SECONDS * RATE);
  assert.equal(excerpt.channels[0]![0], input.channels[0]![0]);
  assert.equal(excerpt.channels[1]![0], input.channels[1]![0]);
});
