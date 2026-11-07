import assert from "node:assert/strict";
import { test } from "node:test";

import type { LevelMeasurement } from "@codec-abx/contracts";
import { decodePcm16, measurePair, type PcmAudio } from "@codec-abx/measurements";

import {
  PreparationPolicyError,
  preparePair,
  PREPARATION_PEAK_CEILING,
  PREPARATION_PROBE_SAMPLES,
} from "../src/index.js";
import { cropForLag } from "../src/prepare.js";
import { encodePcm16Wav, quantizePcm16Sample } from "../src/pcm16.js";

interface Fixture {
  readonly id: string;
  readonly a: PcmAudio;
  readonly b: PcmAudio;
  readonly expectedLag: number | null;
  readonly expectedStatus: "estimated" | "no-evidence";
  readonly expectedError?: string;
  readonly expectedOutputFrames?: number;
}

function quantized(channels: readonly Float64Array[]): Float64Array[] {
  return channels.map((channel) => {
    const decoded = new Float64Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      const integer = Math.max(
        -32768,
        Math.min(32767, Math.round((channel[index] ?? 0) * 32768)),
      );
      decoded[index] = integer / 32768;
    }
    return decoded;
  });
}

function audio(sampleRate: number, channels: readonly Float64Array[]): PcmAudio {
  return { sampleRate, channels: quantized(channels) };
}

function signal(frames: number, rate: number, seed: number, amplitude = 0.35): Float64Array {
  const samples = new Float64Array(frames);
  let state = seed >>> 0;
  for (let frame = 0; frame < frames; frame += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const random = state / 0x1_0000_0000 - 0.5;
    const time = frame / rate;
    samples[frame] = amplitude * (
      0.6 * Math.sin(2 * Math.PI * 440 * time + 0.1) +
      0.3 * Math.sin(2 * Math.PI * 3137 * time) +
      0.2 * Math.sin(2 * Math.PI * 97 * time)
    ) + amplitude * 0.08 * random;
  }
  const transient = Math.max(1, Math.floor(frames / 5));
  const width = Math.min(100, frames - transient);
  for (let index = 0; index < width; index += 1) {
    samples[transient + index] = (samples[transient + index] ?? 0) + amplitude * 1.5;
  }
  return samples;
}

function stereo(frames: number, rate: number, seed: number): Float64Array[] {
  return [signal(frames, rate, seed), signal(frames, rate, seed + 101)];
}

function delayed(channels: readonly Float64Array[], lag: number): Float64Array[] {
  return channels.map((channel) => {
    const output = new Float64Array(channel.length);
    if (lag >= 0) output.set(channel.subarray(0, channel.length - lag), lag);
    else output.set(channel.subarray(-lag), 0);
    return output;
  });
}

function fixture(
  id: string,
  rate: number,
  a: readonly Float64Array[],
  b: readonly Float64Array[],
  options: Pick<Fixture, "expectedLag" | "expectedStatus" | "expectedError" | "expectedOutputFrames">,
): Fixture {
  return { id, a: audio(rate, a), b: audio(rate, b), ...options };
}

function fixtures(): Fixture[] {
  const list: Fixture[] = [];
  const mono = [signal(30000, 44100, 1)];
  list.push(fixture("mono_zero_44100", 44100, mono, mono, {
    expectedLag: 0, expectedStatus: "estimated", expectedOutputFrames: 30000,
  }));

  const base = stereo(48000, 48000, 7);
  list.push(fixture("stereo_positive_137_48000", 48000, base, delayed(base, 137), {
    expectedLag: 137, expectedStatus: "estimated", expectedOutputFrames: 47863,
  }));
  list.push(fixture("stereo_negative_83_48000", 48000, delayed(base, 83), base, {
    expectedLag: -83, expectedStatus: "estimated", expectedOutputFrames: 47917,
  }));

  const antiMono = signal(48000, 48000, 23);
  const anti = [antiMono, antiMono.map((value) => -value)];
  list.push(fixture("stereo_antiphase_211_48000", 48000, anti, delayed(anti, 211), {
    expectedLag: 211, expectedStatus: "estimated", expectedOutputFrames: 47789,
  }));

  const inactive = [new Float64Array(48000), signal(48000, 48000, 31)];
  list.push(fixture("inactive_channel_71_48000", 48000, inactive, delayed(inactive, 71), {
    expectedLag: 71, expectedStatus: "estimated", expectedOutputFrames: 47929,
  }));

  const unequal = stereo(60000, 96000, 41);
  list.push(fixture(
    "unequal_lengths_137_96000",
    96000,
    unequal,
    delayed(unequal, 137).map((channel) => channel.slice(0, 50000)),
    { expectedLag: 137, expectedStatus: "estimated", expectedOutputFrames: 49863 },
  ));

  const intro = new Float64Array(4800 + 24000);
  intro.set(signal(24000, 48000, 53), 4800);
  list.push(fixture("silent_intro_31_48000", 48000, [intro], delayed([intro], 31), {
    expectedLag: 31, expectedStatus: "estimated", expectedOutputFrames: 28769,
  }));

  const level = [signal(48000, 48000, 71)];
  const gain = 10 ** (0.1 / 20);
  list.push(fixture(
    "level_offset_0.1db_48000",
    48000,
    level,
    [level[0]!.map((value) => value * gain)],
    { expectedLag: 0, expectedStatus: "estimated", expectedOutputFrames: 48000 },
  ));

  const exact = stereo(48000, 48000, 67);
  list.push(fixture("exact_nonzero_48000", 48000, exact, exact, {
    expectedLag: 0, expectedStatus: "estimated", expectedOutputFrames: 48000,
  }));

  const transient = signal(48000, 48000, 109, 0.02);
  transient[16000] = 0.9;
  transient[16001] = -0.85;
  list.push(fixture(
    "transient_common_trim_57_48000",
    48000,
    [transient],
    delayed([transient], 57).map((channel) => channel.map((value) => value * 0.5)),
    { expectedLag: 57, expectedStatus: "estimated", expectedOutputFrames: 47943 },
  ));

  const dc = [new Float64Array(48000).fill(0.25)];
  list.push(fixture("dc_no_evidence_48000", 48000, dc, dc, {
    expectedLag: 0, expectedStatus: "no-evidence", expectedOutputFrames: 48000,
  }));

  const boundary = [signal(17640, 44100, 89)];
  list.push(fixture("boundary_400ms_44100", 44100, boundary, boundary, {
    expectedLag: 0, expectedStatus: "estimated", expectedOutputFrames: 17640,
  }));

  const long = stereo(240000, 48000, 103);
  list.push(fixture("long_fft_4000_48000", 48000, long, delayed(long, 4000), {
    expectedLag: 4000, expectedStatus: "estimated", expectedOutputFrames: 236000,
  }));

  const shortA = [signal(20000, 48000, 113)];
  list.push(fixture("short_crop_48000", 48000, shortA, delayed(shortA, 1000), {
    expectedLag: 1000, expectedStatus: "estimated", expectedError: "short-crop",
  }));

  const shortInput = [signal(1000, 48000, 127)];
  list.push(fixture("short_input_48000", 48000, shortInput, shortInput, {
    expectedLag: 0, expectedStatus: "estimated", expectedError: "short-crop",
  }));

  const silence = [new Float64Array(48000)];
  list.push(fixture("silence_48000", 48000, silence, silence, {
    expectedLag: 0, expectedStatus: "no-evidence", expectedError: "loudness-unavailable",
  }));

  const below = new Float64Array(44100);
  for (let frame = 0; frame < below.length; frame += 1) {
    below[frame] = 1e-4 * Math.sin((2 * Math.PI * 440 * frame) / 44100);
  }
  list.push(fixture("below_gate_44100", 44100, [below], [below], {
    expectedLag: 0, expectedStatus: "estimated", expectedError: "loudness-unavailable",
  }));
  return list;
}

const cases = fixtures();
const caseById = new Map(cases.map((entry) => [entry.id, entry]));

function close(actual: number, expected: number, tolerance: number, label: string): number {
  const error = Math.abs(actual - expected);
  assert.ok(
    error <= tolerance,
    `${label}: actual ${actual} expected ${expected} error ${error} > ${tolerance}`,
  );
  return error;
}

function requireCase(id: string): Fixture {
  const entry = caseById.get(id);
  assert.ok(entry, `missing fixture ${id}`);
  return entry;
}

test("analytical fixtures cover the policy acceptance matrix", () => {
  assert.equal(cases.length, 17);
  for (const id of [
    "mono_zero_44100",
    "stereo_positive_137_48000",
    "stereo_negative_83_48000",
    "stereo_antiphase_211_48000",
    "inactive_channel_71_48000",
    "unequal_lengths_137_96000",
    "silent_intro_31_48000",
    "level_offset_0.1db_48000",
    "exact_nonzero_48000",
    "transient_common_trim_57_48000",
    "dc_no_evidence_48000",
    "boundary_400ms_44100",
    "long_fft_4000_48000",
    "short_crop_48000",
    "short_input_48000",
    "silence_48000",
    "below_gate_44100",
  ]) {
    requireCase(id);
  }
  const rates = new Set(cases.map((entry) => entry.a.sampleRate));
  for (const rate of [44100, 48000, 96000]) assert.ok(rates.has(rate), `missing rate ${rate}`);
  const longCase = requireCase("long_fft_4000_48000");
  assert.ok((longCase.a.channels[0]?.length ?? 0) >= 200_000);
  assert.equal(longCase.expectedLag, 4000);
});

test("prepared PCM and reports follow the constructed fixture evidence", async (t) => {
  for (const entry of cases) {
    await t.test(entry.id, () => {
      const snapshot = [
        ...entry.a.channels.map((channel) => Array.from(channel)),
        ...entry.b.channels.map((channel) => Array.from(channel)),
      ];
      if (entry.expectedError) {
        assert.throws(
          () => preparePair(entry.a, entry.b),
          (error: unknown) => {
            assert.ok(error instanceof PreparationPolicyError, "typed policy error");
            assert.equal(error.code, entry.expectedError);
            assert.ok(error.message.length > 0);
            return true;
          },
        );
        return;
      }

      const result = preparePair(entry.a, entry.b);
      assert.equal(result.report.policy, "aligned-gain-matched-v1");
      assert.equal(result.report.targetLufs, -16);
      assert.equal(result.report.minimumDurationSeconds, 0.4);
      assert.equal(result.report.maxLagSeconds, 0.1);
      assert.equal(result.report.peakCeiling, PREPARATION_PEAK_CEILING);
      assert.deepEqual(result.report.serialization, {
        format: "pcm16-le",
        rounding: "floor",
        floorBiasCodeSteps: 2 ** -17,
        dither: false,
      });

      const applied = result.report.alignment;
      assert.equal(applied.lagSamples, entry.expectedLag);
      assert.equal(applied.status, entry.expectedStatus);
      assert.equal(applied.maxLagSamples, Math.floor(0.1 * entry.a.sampleRate));
      assert.equal(applied.probeSamples, PREPARATION_PROBE_SAMPLES);
      assert.equal(applied.inputFramesA, entry.a.channels[0]?.length);
      assert.equal(applied.inputFramesB, entry.b.channels[0]?.length);
      assert.equal(applied.outputFrames, entry.expectedOutputFrames);
      assert.equal(applied.startFrameA, (entry.expectedLag ?? 0) < 0 ? -(entry.expectedLag ?? 0) : 0);
      assert.equal(applied.startFrameB, (entry.expectedLag ?? 0) > 0 ? (entry.expectedLag ?? 0) : 0);
      assert.ok(Number.isFinite(applied.confidence));

      for (const side of ["preA", "preB"] as const) {
        const level = result.report.loudness[side];
        assert.equal(level.status, "finite", `${side} pre-gain level finite`);
        if (level.status === "finite") assert.ok(Number.isFinite(level.value));
      }
      assert.ok(Number.isFinite(result.report.loudness.gainADb));
      assert.ok(Number.isFinite(result.report.loudness.gainBDb));
      assert.ok(result.report.loudness.commonTrimDb >= 0);

      assert.equal(result.aWav.byteLength, 44 + result.report.alignment.outputFrames *
        (entry.a.channels.length) * 2, "A canonical width");
      assert.equal(result.bWav.byteLength, 44 + result.report.alignment.outputFrames *
        (entry.b.channels.length) * 2, "B canonical width");
      const decodedA = decodePcm16(result.aWav, {
        sampleRate: entry.a.sampleRate,
        channels: entry.a.channels.length === 1 ? 1 : 2,
        dataOffset: 44,
        dataSize: result.aWav.byteLength - 44,
      });
      const decodedB = decodePcm16(result.bWav, {
        sampleRate: entry.b.sampleRate,
        channels: entry.b.channels.length === 1 ? 1 : 2,
        dataOffset: 44,
        dataSize: result.bWav.byteLength - 44,
      });

      for (const side of ["a", "b"] as const) {
        const actual = result.delivered[side];
        assert.equal(actual.sampleRate, entry.a.sampleRate, `${side} rate`);
        assert.equal(actual.channels, entry.a.channels.length, `${side} channels`);
        assert.equal(actual.frames, applied.outputFrames, `${side} delivered frames`);
      }
      assert.equal(result.delivered.policy, "delivered-pcm-measurements-v1");
      assert.equal(result.delivered.alignment.lagSamples, 0);
      assert.equal(result.delivered.nullDepth.comparedFrames, applied.outputFrames);

      const notes = result.report.notes.join("\n");
      assert.match(notes, /Applied alignment trimmed/);
      assert.doesNotMatch(notes, /no samples were shifted/i);
      if (applied.status === "no-evidence") assert.match(notes, /no lag evidence/i);
      assert.match(result.delivered.notes.join("\n"), /residual/i);

      // The decoded delivery is authoritative and independently re-measured.
      const remeasured = measurePair(decodedA, decodedB, {
        maxLagSamples: applied.maxLagSamples,
        probeSamples: applied.probeSamples,
      });
      assert.deepEqual(result.delivered.a, remeasured.a);
      assert.deepEqual(result.delivered.b, remeasured.b);
      assert.deepEqual(result.delivered.alignment, remeasured.alignment);
      assert.deepEqual(result.delivered.nullDepth, remeasured.nullDepth);

      const current = [
        ...entry.a.channels.map((channel) => Array.from(channel)),
        ...entry.b.channels.map((channel) => Array.from(channel)),
      ];
      assert.deepEqual(current, snapshot, `${entry.id} mutated caller PCM`);
    });
  }
});

test("common trim leaves exactly one positive PCM16 quantum", () => {
  const entry = requireCase("transient_common_trim_57_48000");
  const result = preparePair(entry.a, entry.b);
  assert.ok(result.report.loudness.commonTrimDb > 0, "fixture must exercise the ceiling");
  for (const side of ["a", "b"] as const) {
    const decoded = decodePcm16(result[`${side}Wav`], {
      sampleRate: entry.a.sampleRate,
      channels: 1,
      dataOffset: 44,
      dataSize: result[`${side}Wav`].byteLength - 44,
    });
    let peak = 0;
    for (const channel of decoded.channels) {
      for (let index = 0; index < channel.length; index += 1) {
        peak = Math.max(peak, Math.abs(Math.round((channel[index] ?? 0) * 32768)));
      }
    }
    assert.ok(peak <= 32767, `${side} serialized peak ${peak} exceeds the ceiling`);
    assert.ok(peak >= 32766, `${side} serialized peak ${peak} does not reach the ceiling`);
  }
  assert.ok(result.delivered.a.integratedLufs.status === "finite");
  if (result.delivered.a.integratedLufs.status === "finite") {
    close(
      result.delivered.a.integratedLufs.value,
      -16 - result.report.loudness.commonTrimDb,
      1e-3,
      "delivered level reflects the common trim",
    );
  }
});

test("level offset is absorbed by independent gains", () => {
  const entry = requireCase("level_offset_0.1db_48000");
  const result = preparePair(entry.a, entry.b);
  const preA = result.report.loudness.preA;
  const preB = result.report.loudness.preB;
  assert.equal(preA.status, "finite");
  assert.equal(preB.status, "finite");
  if (preA.status === "finite" && preB.status === "finite") {
    close(preB.value - preA.value, 0.1, 1e-5, "pre-gain B is 0.1 dB hotter");
  }
  close(
    result.report.loudness.gainBDb - result.report.loudness.gainADb,
    -0.1,
    1e-5,
    "independent gain difference",
  );
  assert.equal(result.delivered.nullDepth.depthDb.status, "finite");
  assert.equal(result.report.loudness.commonTrimDb, 0);
});

test("floor quantization matches soundfile including negative fractions", () => {
  const fractions = [-1.5, -1, -0.9, -0.5, 0, 0.1, 0.5, 0.9, 1, 1.5];
  const expected = [-2, -1, -1, -1, 0, 0, 0, 0, 1, 1];
  fractions.forEach((fraction, index) => {
    assert.equal(quantizePcm16Sample(fraction / 32768), expected[index],
      `fraction ${fraction}/32768`);
  });
  assert.equal(quantizePcm16Sample(-2.6 / 32768), -3);
  assert.equal(quantizePcm16Sample(-1.4 / 32768), -2);
  assert.equal(quantizePcm16Sample(-0.1 / 32768), -1);
  assert.equal(quantizePcm16Sample(2.6 / 32768), 2);
  assert.equal(quantizePcm16Sample(-100.0000001 / 32768), -100);
  assert.equal(quantizePcm16Sample(-100.000005 / 32768), -100);
  assert.equal(quantizePcm16Sample(-100.00001 / 32768), -101);
  assert.equal(quantizePcm16Sample(100.1 / 32768), 100);
});

test("PCM16 quantization clamps at signed bounds and never wraps", () => {
  assert.equal(quantizePcm16Sample(1), 32767);
  assert.equal(quantizePcm16Sample(40000 / 32768), 32767);
  assert.equal(quantizePcm16Sample(-1), -32768);
  assert.equal(quantizePcm16Sample(-40000 / 32768), -32768);
  assert.equal(PREPARATION_PEAK_CEILING, 32767 / 32768);
  assert.equal(quantizePcm16Sample(PREPARATION_PEAK_CEILING), 32767);
  assert.throws(
    () => quantizePcm16Sample(Number.NaN),
    (error: unknown) => error instanceof PreparationPolicyError &&
      error.code === "nonfinite-processing",
  );
});

test("empty and short crops are refused explicitly", () => {
  const ten = new Float64Array(10).fill(0.1);
  assert.throws(
    () => cropForLag([ten], [ten.slice()], 10),
    (error: unknown) => error instanceof PreparationPolicyError && error.code === "empty-crop",
  );
  const chained = new Float64Array(100).fill(0.1);
  assert.throws(
    () => cropForLag([chained], [chained.slice()], -100),
    (error: unknown) => error instanceof PreparationPolicyError && error.code === "empty-crop",
  );
  assert.deepEqual(cropForLag([ten], [ten.slice()], -3).frames, 7);
});

function makeAudio(sampleRate: number, channels: readonly Float64Array[]): PcmAudio {
  return { sampleRate, channels };
}

test("invalid PCM and incompatible layouts are refused before DSP", () => {
  const good = new Float64Array(20_000).fill(0.1);
  const invalid: Array<{ label: string; a: PcmAudio; b: PcmAudio; code: string }> = [
    {
      label: "unsupported rate",
      a: makeAudio(32000, [good]),
      b: makeAudio(32000, [good]),
      code: "invalid-pcm",
    },
    {
      label: "non-finite sample",
      a: makeAudio(48000, [new Float64Array(20_000).fill(Number.NaN)]),
      b: makeAudio(48000, [good]),
      code: "invalid-pcm",
    },
    {
      label: "mismatched channel layout",
      a: makeAudio(48000, [good]),
      b: makeAudio(48000, [good, good.slice()]),
      code: "incompatible-pair",
    },
    {
      label: "mismatched sample rates",
      a: makeAudio(48000, [good]),
      b: makeAudio(44100, [good]),
      code: "incompatible-pair",
    },
  ];
  for (const entry of invalid) {
    assert.throws(
      () => preparePair(entry.a, entry.b),
      (error: unknown) => error instanceof PreparationPolicyError && error.code === entry.code,
      entry.label,
    );
  }
});

test("crop shapes have the expected sign convention", () => {
  const positive = preparePair(
    requireCase("stereo_positive_137_48000").a,
    requireCase("stereo_positive_137_48000").b,
  ).report.alignment;
  assert.equal(positive.lagSamples, 137);
  assert.equal(positive.startFrameA, 0);
  assert.equal(positive.startFrameB, 137);
  assert.equal(positive.outputFrames, positive.inputFramesA - 137);
  assert.equal(positive.outputFrames, positive.inputFramesB - 137);

  const negative = preparePair(
    requireCase("stereo_negative_83_48000").a,
    requireCase("stereo_negative_83_48000").b,
  ).report.alignment;
  assert.equal(negative.lagSamples, -83);
  assert.equal(negative.startFrameA, 83);
  assert.equal(negative.startFrameB, 0);
  assert.equal(negative.outputFrames, negative.inputFramesA - 83);
  assert.equal(negative.outputFrames, negative.inputFramesB - 83);
});

test("delivered measurement statuses are analytically distinguished", () => {
  const exact = preparePair(
    requireCase("exact_nonzero_48000").a,
    requireCase("exact_nonzero_48000").b,
  );
  assert.equal(exact.delivered.nullDepth.depthDb.status, "negative-infinity");
  assert.equal(exact.delivered.loudnessDeltaDb.status, "finite");
  if (exact.delivered.loudnessDeltaDb.status === "finite") {
    assert.ok(exact.delivered.loudnessDeltaDb.value <= 1e-9);
  }

  const dc = preparePair(
    requireCase("dc_no_evidence_48000").a,
    requireCase("dc_no_evidence_48000").b,
  );
  assert.equal(dc.report.alignment.status, "no-evidence");
  assert.match(dc.report.notes.join("\n"), /no lag evidence/i);
  assert.equal(dc.delivered.nullDepth.depthDb.status, "negative-infinity");
});

test("all accepted pre-gain levels are finite LevelMeasurement values", () => {
  const levels: LevelMeasurement[] = [];
  for (const entry of cases) {
    if (entry.expectedError) continue;
    const result = preparePair(entry.a, entry.b);
    levels.push(result.report.loudness.preA, result.report.loudness.preB);
  }
  for (const level of levels) {
    assert.equal(level.status, "finite");
    if (level.status === "finite") {
      assert.ok(Number.isFinite(level.value));
      assert.equal(level.reason, null);
    }
  }
});

test("direct gained serialization is byte-identical to the two-step reference", () => {
  const sampleRate = 48_000;
  const frames = Math.round(0.75 * sampleRate);
  const make = (seed: number, factor: number) => {
    let state = seed >>> 0;
    return new Float64Array(frames).map(() => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state / 0x1_0000_0000 - 0.5) * factor;
    });
  };
  const a = { sampleRate, channels: [make(0x1234_5678, 0.7), make(0x8765_4321, 0.5)] };
  const b = { sampleRate, channels: [make(0x0bad_f00d, 0.4), make(0xfeed_beef, 0.6)] };
  const result = preparePair(a, b);
  const report = result.report;
  const cropped = cropForLag(a.channels, b.channels, report.alignment.lagSamples);
  const scale = (channels: readonly Float64Array[], factor: number) =>
    channels.map((source) => {
      const output = new Float64Array(source.length);
      for (let index = 0; index < source.length; index += 1) {
        output[index] = (source[index] ?? 0) * factor;
      }
      return output;
    });
  const gainA = 10 ** (report.loudness.gainADb / 20);
  const gainB = 10 ** (report.loudness.gainBDb / 20);
  const gainedA = scale(cropped.a, gainA);
  const gainedB = scale(cropped.b, gainB);
  let peak = 0;
  for (const channel of [...gainedA, ...gainedB]) {
    for (const value of channel) peak = Math.max(peak, Math.abs(value));
  }
  const commonTrimDb = peak > PREPARATION_PEAK_CEILING
    ? 20 * Math.log10(peak / PREPARATION_PEAK_CEILING)
    : 0;
  assert.equal(commonTrimDb, report.loudness.commonTrimDb);
  const commonTrim = 10 ** (-commonTrimDb / 20);
  const expectedA = encodePcm16Wav(scale(gainedA, commonTrim), sampleRate).bytes;
  const expectedB = encodePcm16Wav(scale(gainedB, commonTrim), sampleRate).bytes;
  assert.deepEqual(result.aWav, expectedA);
  assert.deepEqual(result.bWav, expectedB);
});
