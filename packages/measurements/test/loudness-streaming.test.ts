import assert from "node:assert/strict";
import test from "node:test";
import { integratedLoudnessValue } from "../src/loudness.js";
import { integratedLoudnessValue as integratedLoudnessValueLegacy } from "./legacy-loudness.js";

test("streaming loudness accumulation is bit-identical to the legacy reference", () => {
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    for (const seconds of [0.45, 1.3, 12]) {
      for (const channelCount of [1, 2] as const) {
        const frames = Math.round(seconds * sampleRate);
        const channels: Float64Array[] = [];
        for (let channel = 0; channel < channelCount; channel += 1) {
          let state = (0x9e37_79b9 ^ (channel * 0x85eb_ca6b) ^ sampleRate) >>> 0;
          const samples = new Float64Array(frames);
          for (let frame = 0; frame < frames; frame += 1) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            samples[frame] = (state / 0x1_0000_0000 - 0.5) *
              (0.2 + 0.1 * Math.sin((2 * Math.PI * frame) / sampleRate));
          }
          channels.push(samples);
        }
        const streaming = integratedLoudnessValue(channels, sampleRate, frames);
        const legacy = integratedLoudnessValueLegacy(channels, sampleRate, frames);
        assert.equal(
          streaming,
          legacy,
          `${String(sampleRate)} Hz ${String(seconds)} s ${String(channelCount)} ch`,
        );
      }
    }
  }
});
