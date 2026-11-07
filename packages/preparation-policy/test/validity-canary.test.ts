import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  CanaryMaterialReport,
  LevelMeasurement,
  PreparationRequest,
} from "@codec-abx/contracts";
import { decodePcm16, type PcmAudio } from "@codec-abx/measurements";
import { createFftPlan, MAX_FFT_PLAN_LENGTH } from "@codec-abx/measurements/fft";

import {
  CANARY_CLIP_LEVEL,
  CANARY_CUTOFF_HZ,
  CANARY_DRIVE,
  CANARY_MIN_RESIDUAL_DB,
  NULL_GATE_THRESHOLD_DB,
  PreparationPolicyError,
  buildCanaryPair,
  evaluateCanaryDepth,
  evaluateNullGate,
} from "../src/index.js";

const finite = (value: number): LevelMeasurement => ({
  status: "finite", value, reason: null,
});
const negativeInfinity = (reason = "exact null"): LevelMeasurement => ({
  status: "negative-infinity", value: null, reason,
});
const undefinedLevel = (reason = "silent reference"): LevelMeasurement => ({
  status: "undefined", value: null, reason,
});
const unavailable = (reason = "not measured"): LevelMeasurement => ({
  status: "unavailable", value: null, reason,
});

function snapshot(audio: PcmAudio): number[][] {
  // PCM16 decoding preserves the IEEE sign of zero; compare the delivered
  // integer grid instead of treating +0 and -0 as different audio.
  return audio.channels.map((channel) =>
    Array.from(channel, (value) => (value === 0 ? 0 : value)));
}

// ---------------------------------------------------------------------------
// Arbitrary-length FFT kernel
// ---------------------------------------------------------------------------

function naiveDft(re: Float64Array, im: Float64Array, inverse: boolean): {
  re: Float64Array;
  im: Float64Array;
} {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k += 1) {
    let sumRe = 0;
    let sumIm = 0;
    for (let index = 0; index < n; index += 1) {
      const angle = (sign * 2 * Math.PI * k * index) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const xr = re[index] ?? 0;
      const xi = im[index] ?? 0;
      sumRe += xr * c - xi * s;
      sumIm += xr * s + xi * c;
    }
    outRe[k] = inverse ? sumRe / n : sumRe;
    outIm[k] = inverse ? sumIm / n : sumIm;
  }
  return { re: outRe, im: outIm };
}

test("FFT plan lengths reject before oversized allocation or bitwise overflow", () => {
  for (const n of [0, -1, 1.5, MAX_FFT_PLAN_LENGTH + 1, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createFftPlan(n), /FFT length must be an integer/);
  }
});

test("arbitrary-N FFT matches a direct DFT for odd, even and power-of-two lengths", () => {
  let maximumError = 0;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64, 65, 100, 127]) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let index = 0; index < n; index += 1) {
      re[index] = Math.sin(index * 0.37) + 0.2 * Math.cos(index * 0.11);
      im[index] = 0.3 * Math.sin(index * 0.23) - 0.1;
    }
    const expected = naiveDft(re, im, false);
    const plan = createFftPlan(n);
    const actualRe = new Float64Array(re);
    const actualIm = new Float64Array(im);
    plan.transform(actualRe, actualIm, false);
    for (let index = 0; index < n; index += 1) {
      const error = Math.max(
        Math.abs((actualRe[index] ?? 0) - (expected.re[index] ?? 0)),
        Math.abs((actualIm[index] ?? 0) - (expected.im[index] ?? 0)),
      );
      maximumError = Math.max(maximumError, error);
      assert.ok(error <= 1e-8, `n=${n} bin ${index} error ${error}`);
    }
    plan.transform(actualRe, actualIm, true);
    for (let index = 0; index < n; index += 1) {
      assert.ok(Math.abs((actualRe[index] ?? 0) - (re[index] ?? 0)) <= 1e-10,
        `n=${n} roundtrip re ${index}`);
      assert.ok(Math.abs((actualIm[index] ?? 0) - (im[index] ?? 0)) <= 1e-10,
        `n=${n} roundtrip im ${index}`);
    }
  }
  assert.ok(maximumError <= 1e-8);
});

// ---------------------------------------------------------------------------
// Null gate and canary depth decisions
// ---------------------------------------------------------------------------

const identicalRequest: PreparationRequest = {
  version: 1,
  preparationPolicy: "aligned-gain-matched-v1",
  sampleRateMode: "native",
  a: { codecId: "opus", bitrateKbps: 128 },
  b: { codecId: "opus", bitrateKbps: 128 },
};
const differentBitrate: PreparationRequest = {
  ...identicalRequest,
  b: { codecId: "opus", bitrateKbps: 96 },
};
const differentCodec: PreparationRequest = {
  ...identicalRequest,
  b: { codecId: "aac", bitrateKbps: 128 },
};
const noopRequest: PreparationRequest = {
  ...identicalRequest,
  a: { codecId: "noop_passthrough", bitrateKbps: 0 },
  b: { codecId: "noop_passthrough", bitrateKbps: 0 },
};

test("null gate decisions follow the strict -60 dB floor and applicability rules", async (t) => {
  const cases: ReadonlyArray<readonly [
    string,
    PreparationRequest,
    LevelMeasurement,
    "passed" | "failed" | "not-applicable",
  ]> = [
    ["identical_finite_at_floor", identicalRequest, finite(-60), "passed"],
    ["identical_finite_above_floor", identicalRequest, finite(-60 + 1e-12), "failed"],
    ["identical_finite_below_floor", identicalRequest, finite(-60 - 1e-12), "passed"],
    ["identical_exact_null", identicalRequest, negativeInfinity(), "passed"],
    ["identical_undefined", identicalRequest, undefinedLevel(), "failed"],
    ["identical_unavailable", identicalRequest, unavailable(), "failed"],
    ["different_bitrate_shallow", differentBitrate, finite(-0.5), "not-applicable"],
    ["different_codec_shallow", differentCodec, finite(-0.5), "not-applicable"],
    ["same_noop_exact", noopRequest, negativeInfinity("exact digital null"), "passed"],
    ["identical_64_finite", identicalRequest, finite(-64), "passed"],
  ];
  for (const [id, request, level, status] of cases) {
    await t.test(id, () => {
      const before = JSON.stringify(request);
      const result = evaluateNullGate(request, level);
      assert.equal(result.policy, "identical-pipeline-null-v1");
      assert.equal(result.expectedIdentical, status !== "not-applicable");
      assert.equal(result.thresholdDb, -60);
      assert.equal(result.status, status);
      assert.ok(result.reason.length > 0);
      assert.deepEqual(result.depthDb, level);
      assert.equal(JSON.stringify(request), before, "request must not be mutated");
    });
  }
});

test("null gate threshold and malformed-level boundaries are strict", () => {
  assert.equal(evaluateNullGate(identicalRequest, finite(-60)).status, "passed");
  assert.equal(evaluateNullGate(identicalRequest, finite(-60 - 1e-12)).status, "passed");
  assert.equal(evaluateNullGate(identicalRequest, finite(-60 + 1e-12)).status, "failed");
  assert.equal(evaluateNullGate(identicalRequest, finite(-0)).status, "failed");
  assert.equal(evaluateNullGate(identicalRequest, negativeInfinity()).status, "passed");
});

test("canary depth decisions are strict at -30 dB and reject non-finite levels", async (t) => {
  const cases: ReadonlyArray<readonly [string, LevelMeasurement, boolean]> = [
    ["deeper_than_floor", finite(-31), false],
    ["floor_representation", finite(-30), false],
    ["just_below_floor", finite(-30.001), false],
    ["just_above_floor", finite(-29.999), true],
    ["clearly_above", finite(-2), true],
    ["exact_null", negativeInfinity(), false],
    ["silence", undefinedLevel(), false],
    ["unavailable", unavailable(), false],
  ];
  for (const [id, level, usable] of cases) {
    await t.test(id, () => {
      const result = evaluateCanaryDepth(level);
      assert.equal(result.status, usable ? "usable" : "not-usable");
      assert.equal(result.usable, usable);
      assert.equal(result.minimumResidualDb, -30);
      assert.ok(result.reason.length > 0);
      assert.deepEqual(result.depthDb, level);
    });
  }
});

test("canary depth is strict at -30 dB and rejects non-finite levels", () => {
  assert.equal(evaluateCanaryDepth(finite(-30)).usable, false);
  assert.equal(evaluateCanaryDepth(finite(-30 - 1e-12)).usable, false);
  assert.equal(evaluateCanaryDepth(finite(-30 + 1e-12)).usable, true);
  assert.equal(evaluateCanaryDepth(finite(0)).usable, true);
  for (const value of [negativeInfinity(), undefinedLevel(), unavailable()]) {
    assert.equal(evaluateCanaryDepth(value).usable, false);
  }
});

// ---------------------------------------------------------------------------
// Canary material
// ---------------------------------------------------------------------------

function quantize(samples: Float64Array): Float64Array {
  const output = new Float64Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const integer = Math.max(
      -32768,
      Math.min(32767, Math.round((samples[index] ?? 0) * 32768)),
    );
    output[index] = integer / 32768;
  }
  return output;
}

function wave(
  frames: number,
  options: {
    readonly rate?: number;
    readonly frequencies?: readonly number[];
    readonly amplitude?: number;
    readonly dc?: number;
    readonly noise?: number;
    readonly seed?: number;
  } = {},
): Float64Array {
  const rate = options.rate ?? 48000;
  const frequencies = options.frequencies ?? [440, 1370, 3137];
  const amplitude = options.amplitude ?? 0.2;
  const dc = options.dc ?? 0;
  const noise = options.noise ?? 0;
  let state = (options.seed ?? 1) >>> 0;
  const samples = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let value = dc;
    for (const frequency of frequencies) {
      value += amplitude * Math.sin((2 * Math.PI * frequency * frame) / rate);
    }
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    value += noise * (state / 0x1_0000_0000 - 0.5);
    samples[frame] = value;
  }
  return quantize(samples);
}

interface CanaryCase {
  readonly id: string;
  readonly input: PcmAudio;
  readonly status: "usable" | "not-usable";
  readonly check: (report: CanaryMaterialReport) => void;
}

function canaryCases(): CanaryCase[] {
  return [
    {
      id: "stereo_odd_44100",
      input: {
        sampleRate: 44100,
        channels: [wave(4411, { rate: 44100, seed: 2 }), wave(4411, { rate: 44100, seed: 3 })],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "mono_even_48000",
      input: { sampleRate: 48000, channels: [wave(4800)] },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "stereo_power2_96000",
      input: {
        sampleRate: 96000,
        channels: [wave(8192, { rate: 96000, seed: 4 }), wave(8192, { rate: 96000, seed: 5 })],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "stereo_antiphase_48000",
      input: (() => {
        const mono = wave(3001, { seed: 6 });
        return { sampleRate: 48000, channels: [mono, mono.map((value) => -value)] };
      })(),
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "inactive_channel_48000",
      input: {
        sampleRate: 48000,
        channels: [new Float64Array(3001), wave(3001, { seed: 7 })],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "silence_mono_44100",
      input: { sampleRate: 44100, channels: [new Float64Array(2048)] },
      status: "not-usable",
      check: (report) => assert.equal(report.depthDb.status, "undefined"),
    },
    {
      id: "dc_positive_mono_48000",
      input: { sampleRate: 48000, channels: [new Float64Array(4800).fill(0.25)] },
      status: "usable",
      check: (report) => {
        const depth = isFiniteDepth(report.depthDb);
        assert.ok(depth <= 0 && depth > CANARY_MIN_RESIDUAL_DB);
      },
    },
    {
      id: "clip_both_bounds_stereo_48000",
      input: {
        sampleRate: 48000,
        channels: [
          new Float64Array(4800).fill(0.75),
          new Float64Array(4800).fill(-0.75),
        ],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) < 0),
    },
    {
      id: "quiet_tone_mono_44100",
      input: {
        sampleRate: 44100,
        channels: [wave(2205, { rate: 44100, frequencies: [1000], amplitude: 0.01 })],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "impulse_mono_48000",
      input: (() => {
        const samples = new Float64Array(3001);
        samples[0] = 0.8;
        return { sampleRate: 48000, channels: [quantize(samples)] };
      })(),
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "above_cutoff_tone_mono_48000",
      input: {
        sampleRate: 48000,
        channels: [wave(16000, { frequencies: [4000], amplitude: 0.4 })],
      },
      status: "usable",
      check: (report) => assert.ok(Math.abs(isFiniteDepth(report.depthDb)) < 1),
    },
    {
      id: "rounded_cutoff_44100",
      input: {
        sampleRate: 44100,
        channels: [wave(22197, { rate: 44100, frequencies: [3000], amplitude: 0.4, seed: 8 })],
      },
      status: "usable",
      check: (report) => assert.ok(Math.abs(isFiniteDepth(report.depthDb)) < 1),
    },
    {
      id: "rounded_cutoff_48000",
      input: {
        sampleRate: 48000,
        channels: [wave(24112, { frequencies: [3000], amplitude: 0.4, seed: 9 })],
      },
      status: "usable",
      check: (report) => assert.ok(Math.abs(isFiniteDepth(report.depthDb)) < 1),
    },
    {
      id: "rounded_cutoff_96000",
      input: {
        sampleRate: 96000,
        channels: [wave(48224, { rate: 96000, frequencies: [3000], amplitude: 0.4, seed: 10 })],
      },
      status: "usable",
      check: (report) => assert.ok(Math.abs(isFiniteDepth(report.depthDb)) < 1),
    },
    {
      id: "long_nonpower2_stereo_48000",
      input: {
        sampleRate: 48000,
        channels: [wave(240001, { seed: 11, noise: 0.05 }), wave(240001, { seed: 12, noise: 0.05 })],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
    {
      id: "long_odd_96000_mono",
      input: {
        sampleRate: 96000,
        channels: [wave(300001, { rate: 96000, seed: 13, noise: 0.05 })],
      },
      status: "usable",
      check: (report) => assert.ok(isFiniteDepth(report.depthDb) > 0),
    },
  ];
}

function isFiniteDepth(level: LevelMeasurement): number {
  assert.equal(level.status, "finite");
  assert.ok(level.status === "finite");
  return level.value;
}

function decodeCanary(bytes: Uint8Array, sampleRate: number, channels: 1 | 2): PcmAudio {
  return decodePcm16(bytes, {
    sampleRate,
    channels,
    dataOffset: 44,
    dataSize: bytes.byteLength - 44,
  });
}

test("canary material is deterministic, byte-preserving and analytically usable", async (t) => {
  for (const entry of canaryCases()) {
    await t.test(entry.id, () => {
      const before = snapshot(entry.input);
      const started = Date.now();
      const result = buildCanaryPair(entry.input);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 30_000, `${entry.id} canary took ${elapsed}ms`);
      assert.deepEqual(snapshot(entry.input), before, `${entry.id} mutated caller PCM`);

      const frames = entry.input.channels[0]?.length ?? 0;
      const channels = entry.input.channels.length === 1 ? 1 : 2;
      assert.equal(result.report.policy, "delivered-canary-v1");
      assert.equal(result.report.status, entry.status);
      assert.equal(result.report.usable, entry.status === "usable");
      assert.equal(result.report.minimumResidualDb, -30);
      assert.equal(result.report.cutoffHz, 3000);
      assert.equal(result.report.frequencyGrid, "numpy-rfftfreq-v1");
      assert.equal(result.report.drive, 10);
      assert.equal(result.report.clipLevel, 0.45);
      assert.equal(result.report.sampleRate, entry.input.sampleRate);
      assert.equal(result.report.channels, channels);
      assert.equal(result.report.frames, frames);
      assert.ok(result.report.notes.length >= 3);
      entry.check(result.report);

      assert.equal(result.pristineWav.byteLength, 44 + frames * channels * 2);
      assert.equal(result.degradedWav.byteLength, 44 + frames * channels * 2);
      const pristine = decodeCanary(result.pristineWav, entry.input.sampleRate, channels);
      assert.deepEqual(snapshot(pristine), snapshot(entry.input),
        `${entry.id}: pristine PCM16 payload must be byte-preserving`);

      const degraded = decodeCanary(result.degradedWav, entry.input.sampleRate, channels);
      assert.equal(degraded.channels[0]?.length, frames);
      for (const channel of degraded.channels) {
        for (const sample of channel) assert.ok(Number.isFinite(sample));
      }

      const repeat = buildCanaryPair(entry.input);
      assert.deepEqual(repeat.pristineWav, result.pristineWav);
      assert.deepEqual(repeat.degradedWav, result.degradedWav);
      assert.deepEqual(repeat.report, result.report);
    });
  }
});

// ---------------------------------------------------------------------------
// Validation, mutation and reporting
// ---------------------------------------------------------------------------

function makeAudio(sampleRate: number, channels: Float64Array[]): PcmAudio {
  return { sampleRate, channels };
}

test("canary input validation refuses malformed or non-delivered PCM", () => {
  const valid = new Float64Array(64);
  for (let index = 0; index < valid.length; index += 1) {
    valid[index] = (index % 17) / 32768;
  }
  const invalid: Array<{ label: string; audio: PcmAudio }> = [
    {
      label: "non PCM16 grid",
      audio: makeAudio(48000, [new Float64Array(64).fill(0.1234567)]),
    },
    {
      label: "positive full-scale outside signed grid",
      audio: makeAudio(48000, [new Float64Array(64).fill(1)]),
    },
    {
      label: "negative full-scale below signed grid",
      audio: makeAudio(48000, [new Float64Array(64).fill(-32769 / 32768)]),
    },
    {
      label: "non-finite sample",
      audio: makeAudio(48000, [new Float64Array(64).fill(Number.NaN)]),
    },
    {
      label: "unsupported rate",
      audio: makeAudio(32000, [valid]),
    },
    {
      label: "too many channels",
      audio: makeAudio(48000, [valid, valid.slice(), valid.slice()]),
    },
    {
      label: "zero frames",
      audio: makeAudio(48000, [new Float64Array(0)]),
    },
    {
      label: "longer than ten seconds",
      audio: makeAudio(48000, [new Float64Array(480000 + 1)]),
    },
    {
      label: "unequal channel lengths",
      audio: makeAudio(48000, [valid, valid.slice(1)]),
    },
    {
      label: "non Float64Array channel",
      audio: makeAudio(48000, [[0, 1, 2] as unknown as Float64Array]),
    },
  ];
  for (const entry of invalid) {
    assert.throws(
      () => buildCanaryPair(entry.audio),
      (error: unknown) =>
        error instanceof PreparationPolicyError && error.code === "invalid-pcm",
      entry.label,
    );
  }

  const ten = new Float64Array(480000);
  ten[0] = -1;
  ten[1] = 32767 / 32768;
  const result = buildCanaryPair(makeAudio(48000, [ten]));
  assert.equal(result.report.frames, 480000);
  assert.equal(result.report.status, "usable");
});

test("malformed requests and levels are rejected, not treated as a pass", () => {
  const validRequest: PreparationRequest = {
    version: 1,
    sampleRateMode: "native",
    a: { codecId: "opus", bitrateKbps: 128 },
    b: { codecId: "opus", bitrateKbps: 128 },
  };
  const validLevel: LevelMeasurement = finite(-80);

  const badRequests: unknown[] = [
    { ...validRequest, version: 2 },
    { ...validRequest, a: { codecId: "opus", bitrateKbps: 100 } },
    { ...validRequest, b: { codecId: "unknown_mp3", bitrateKbps: 128 } },
    { ...validRequest, canaryEnabled: "yes" },
    { ...validRequest, sampleRateMode: "resample" },
  ];
  for (const request of badRequests) {
    assert.throws(
      () => evaluateNullGate(request as PreparationRequest, validLevel),
      (error: unknown) =>
        error instanceof PreparationPolicyError && error.code === "invalid-request",
    );
  }

  const badLevels: unknown[] = [
    null,
    {},
    { status: "finite", value: Number.NaN, reason: null },
    { status: "finite", value: Number.POSITIVE_INFINITY, reason: null },
    { status: "finite", value: null, reason: null },
    { status: "negative-infinity", value: 0, reason: "exact null" },
    { status: "undefined", value: null, reason: "" },
    { status: "weird", value: null, reason: "unknown" },
  ];
  for (const level of badLevels) {
    assert.throws(
      () => evaluateNullGate(validRequest, level as LevelMeasurement),
      (error: unknown) =>
        error instanceof PreparationPolicyError && error.code === "invalid-level",
    );
    assert.throws(
      () => evaluateCanaryDepth(level as LevelMeasurement),
      (error: unknown) =>
        error instanceof PreparationPolicyError && error.code === "invalid-level",
    );
    assert.throws(
      () => evaluateNullGate({ ...validRequest,
        b: { codecId: "noop_passthrough", bitrateKbps: 0 } }, level as LevelMeasurement),
      (error: unknown) =>
        error instanceof PreparationPolicyError && error.code === "invalid-level",
      "different configurations do not turn malformed levels into valid inputs",
    );
  }
});

test("canary report is JSON-safe and describes actual served bytes", () => {
  const samples = new Float64Array(1000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(12000 * Math.sin(index / 7)) / 32768;
  }
  const result = buildCanaryPair(makeAudio(48000, [samples]));
  const json = JSON.parse(JSON.stringify(result.report)) as CanaryMaterialReport;
  assert.deepEqual(json, result.report);
  assert.equal(json.policy, "delivered-canary-v1");
  assert.equal(json.cutoffHz, CANARY_CUTOFF_HZ);
  assert.equal(json.drive, CANARY_DRIVE);
  assert.equal(json.clipLevel, CANARY_CLIP_LEVEL);
  assert.equal(json.minimumResidualDb, CANARY_MIN_RESIDUAL_DB);
  assert.equal(NULL_GATE_THRESHOLD_DB, -60);
});

test("sparse ordered chains cannot skip null applicability validation", () => {
  const stage = {codecId: "opus" as const, bitrateKbps: 128};
  const depth: LevelMeasurement = finite(-80);
  for (const sparse of [Array(2), [, stage], [stage, ,]]) {
    for (const side of ["a", "b"]) {
      const request = {version: 2, sampleRateMode: "native", a: [stage], b: [stage], [side]: sparse};
      assert.throws(() => evaluateNullGate(request as PreparationRequest, depth),
        (error: unknown) => error instanceof PreparationPolicyError && error.code === "invalid-request");
    }
  }
});
