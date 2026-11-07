import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  decodePcm16,
  estimateLag,
  integratedLoudness,
  measureNullDepth,
  measurePair,
  samplePeakDbfs,
} from "../src/index.js";
import type { PcmAudio } from "../src/index.js";

interface WavFacts {
  readonly path: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly dataOffset: number;
  readonly dataSize: number;
}

interface Case {
  readonly id: string;
  readonly a: PcmAudio;
  readonly b: PcmAudio;
  readonly options: { readonly maxLagSamples: number; readonly probeSamples: number };
}

const SUPPORTED_RATES = [44100, 48000, 96000] as const;
let fixtureDir = "";
const cases = new Map<string, Case>();
const facts = new Map<string, { a: WavFacts; b: WavFacts }>();

function quantize(samples: Float64Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    pcm[index] = Math.max(
      -32768,
      Math.min(32767, Math.round((samples[index] ?? 0) * 32768)),
    );
  }
  return pcm;
}

function writePcm16Wav(
  name: string,
  sampleRate: number,
  channels: readonly Float64Array[],
): WavFacts {
  const frames = channels[0]?.length ?? 0;
  const channelCount = channels.length === 1 ? 1 : 2;
  const dataSize = frames * channelCount * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channelCount, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channelCount * 2, 28);
  bytes.writeUInt16LE(channelCount * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  const quantized = channels.map(quantize);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      bytes.writeInt16LE(
        quantized[channel]?.[frame] ?? 0,
        44 + (frame * channelCount + channel) * 2,
      );
    }
  }
  fs.writeFileSync(path.join(fixtureDir, name), bytes);
  return {
    path: name,
    sampleRate,
    channels: channelCount,
    frames,
    dataOffset: 44,
    dataSize,
  };
}

function decode(facts: WavFacts): PcmAudio {
  const bytes = new Uint8Array(fs.readFileSync(path.join(fixtureDir, facts.path)));
  return decodePcm16(bytes, facts);
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

function addCase(
  id: string,
  a: readonly Float64Array[],
  b: readonly Float64Array[],
  sampleRate: number,
  maxLagSamples: number,
  probeSamples: number,
): void {
  const aFacts = writePcm16Wav(`${id}-a.wav`, sampleRate, a);
  const bFacts = writePcm16Wav(`${id}-b.wav`, sampleRate, b);
  facts.set(id, { a: aFacts, b: bFacts });
  cases.set(id, {
    id,
    a: decode(aFacts),
    b: decode(bFacts),
    options: { maxLagSamples, probeSamples },
  });
}

before(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codec-abx-measurements-"));

  const mono = [signal(30000, 44100, 1)];
  addCase("mono_zero_delay_44100", mono, mono, 44100, 300, 240000);

  const base = stereo(48000, 48000, 7);
  addCase("stereo_delay_137_48000", base, delayed(base, 137), 48000, 1000, 240000);
  addCase("stereo_negative_83_48000", delayed(base, 83), base, 48000, 1000, 240000);

  const antiMono = signal(48000, 48000, 23);
  const anti = [antiMono, antiMono.map((value) => -value)];
  addCase("stereo_antiphase_137_48000", anti, delayed(anti, 137), 48000, 500, 240000);

  const inactive = [new Float64Array(48000), signal(48000, 48000, 31)];
  addCase("inactive_channel_71_48000", inactive, delayed(inactive, 71), 48000, 300, 240000);

  const unequal = stereo(50000, 96000, 41);
  addCase(
    "unequal_lengths_96000",
    unequal,
    delayed(unequal, 137).map((channel) => channel.slice(0, 40000)),
    96000,
    500,
    240000,
  );

  const intro = new Float64Array(2048 + 8000);
  intro.set(signal(8000, 48000, 53), 2048);
  addCase("silent_intro_small_probe_48000", [intro], delayed([intro], 31), 48000, 100, 512);

  const silence = [new Float64Array(48000)];
  addCase("silence_alignment_48000", silence, silence, 48000, 100, 240000);

  const dc = [new Float64Array(48000).fill(0.25)];
  addCase("dc_alignment_48000", dc, dc, 48000, 100, 240000);

  const exact = stereo(48000, 48000, 67);
  addCase("exact_null_48000", exact, exact, 48000, 500, 240000);

  const level = [signal(48000, 48000, 71)];
  const gain = 10 ** (0.1 / 20);
  addCase(
    "level_offset_0.1db_48000",
    level,
    [level[0]!.map((value) => value * gain)],
    48000,
    500,
    240000,
  );

  const below = new Float64Array(44100);
  for (let frame = 0; frame < below.length; frame += 1) {
    below[frame] = 1e-4 * Math.sin((2 * Math.PI * 440 * frame) / 44100);
  }
  addCase("below_gate_44100", [below], [below], 44100, 300, 240000);

  const short = [signal(1000, 48000, 83)];
  addCase("too_short_48000", short, short, 48000, 100, 240000);

  const boundary = [signal(17640, 44100, 89)];
  addCase("boundary_400ms_44100", boundary, boundary, 44100, 300, 240000);

  const odd = [signal(95000, 96000, 97)];
  addCase("odd_duration_96000", odd, odd, 96000, 500, 240000);

  const gated = new Float64Array(96000);
  for (let frame = 0; frame < 48000; frame += 1) {
    const value = Math.sin((2 * Math.PI * 440 * frame) / 48000);
    gated[frame] = 0.5 * value;
    gated[48000 + frame] = 0.005 * value;
  }
  addCase("gating_sensitive_48000", [gated], [gated], 48000, 500, 240000);

  const long = [signal(240000, 48000, 103)];
  addCase("long_probe_48000", long, delayed(long, 5000), 48000, 96000, 240000);
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function close(actual: number, expected: number, tolerance: number, label: string): void {
  const error = Math.abs(actual - expected);
  assert.ok(
    error <= tolerance,
    `${label}: actual ${actual} expected ${expected} error ${error} > ${tolerance}`,
  );
}

function requireCase(id: string): Case {
  const entry = cases.get(id);
  assert.ok(entry, `missing fixture ${id}`);
  return entry;
}

test("analytical fixture catalogue covers required hard cases and rates", () => {
  assert.equal(cases.size, 17);
  for (const id of [
    "stereo_antiphase_137_48000",
    "inactive_channel_71_48000",
    "stereo_negative_83_48000",
    "unequal_lengths_96000",
    "silence_alignment_48000",
    "dc_alignment_48000",
    "silent_intro_small_probe_48000",
    "exact_null_48000",
    "level_offset_0.1db_48000",
    "below_gate_44100",
    "too_short_48000",
    "boundary_400ms_44100",
    "odd_duration_96000",
    "gating_sensitive_48000",
    "long_probe_48000",
  ]) {
    requireCase(id);
  }
  const rates = new Set([...cases.values()].map((entry) => entry.a.sampleRate));
  for (const rate of SUPPORTED_RATES) assert.ok(rates.has(rate), `missing rate ${rate}`);
  const longCase = requireCase("long_probe_48000");
  assert.ok((longCase.a.channels[0]?.length ?? 0) >= 200_000);
  assert.equal(longCase.options.probeSamples, 240_000);
  assert.equal(longCase.options.maxLagSamples, 96_000);
  const serialized = facts.get("mono_zero_delay_44100");
  assert.ok(serialized);
  assert.equal(serialized.a.dataOffset, 44);
  assert.equal(serialized.a.dataSize, serialized.a.frames * 2);
});

test("serially decoded fixtures recover the constructed delays and rates", () => {
  const expectations: ReadonlyArray<readonly [string, number, "estimated" | "no-evidence"]> = [
    ["mono_zero_delay_44100", 0, "estimated"],
    ["stereo_delay_137_48000", 137, "estimated"],
    ["stereo_negative_83_48000", -83, "estimated"],
    ["stereo_antiphase_137_48000", 137, "estimated"],
    ["inactive_channel_71_48000", 71, "estimated"],
    ["unequal_lengths_96000", 137, "estimated"],
    ["silent_intro_small_probe_48000", 31, "estimated"],
    ["silence_alignment_48000", 0, "no-evidence"],
    ["dc_alignment_48000", 0, "no-evidence"],
    ["exact_null_48000", 0, "estimated"],
    ["level_offset_0.1db_48000", 0, "estimated"],
    ["below_gate_44100", 0, "estimated"],
    ["too_short_48000", 0, "estimated"],
    ["boundary_400ms_44100", 0, "estimated"],
    ["odd_duration_96000", 0, "estimated"],
    ["gating_sensitive_48000", 0, "estimated"],
    ["long_probe_48000", 5000, "estimated"],
  ];
  for (const [id, lag, status] of expectations) {
    const entry = requireCase(id);
    const result = measurePair(entry.a, entry.b, entry.options);
    assert.equal(result.policy, "delivered-pcm-measurements-v1");
    assert.equal(result.alignment.lagSamples, lag, `${id} lag`);
    assert.equal(result.alignment.status, status, `${id} status`);
    assert.equal(result.alignment.maxLagSamples, entry.options.maxLagSamples);
    assert.equal(result.alignment.probeSamples, entry.options.probeSamples);
    assert.ok(Number.isFinite(result.alignment.confidence));
    assert.ok(result.alignment.confidence >= 0 && result.alignment.confidence <= 1);
    for (const side of ["a", "b"] as const) {
      assert.equal(result[side].sampleRate, entry.a.sampleRate);
      assert.equal(result[side].channels, entry.a.channels.length);
      assert.equal(result[side].frames, entry[side].channels[0]?.length);
      assert.ok(result[side].integratedLufs.status !== "finite" ||
        Number.isFinite(result[side].integratedLufs.value));
    }
    assert.equal(result.nullDepth.basis, "unshifted-common-prefix");
    assert.equal(
      result.nullDepth.comparedFrames,
      Math.min(result.a.frames, result.b.frames),
    );
    assert.ok(result.notes.length > 0);
  }
});

test("fixtures exercise exact null, silence, DC and below-gate states", () => {
  const exact = requireCase("exact_null_48000");
  const exactResult = measurePair(exact.a, exact.b, exact.options);
  assert.equal(exactResult.nullDepth.depthDb.status, "negative-infinity");
  assert.equal(exactResult.loudnessDeltaDb.status, "finite");
  if (exactResult.loudnessDeltaDb.status === "finite") {
    close(exactResult.loudnessDeltaDb.value, 0, 1e-9, "exact null loudness delta");
  }

  const silenceCase = requireCase("silence_alignment_48000");
  const silence = measurePair(silenceCase.a, silenceCase.b, silenceCase.options);
  assert.equal(silence.alignment.status, "no-evidence");
  assert.equal(silence.nullDepth.depthDb.status, "undefined");
  assert.equal(silence.a.integratedLufs.status, "negative-infinity");
  assert.equal(silence.a.samplePeakDbfs.status, "negative-infinity");

  const dc = requireCase("dc_alignment_48000");
  const dcResult = measurePair(dc.a, dc.b, dc.options);
  assert.equal(dcResult.alignment.status, "no-evidence");
  assert.equal(dcResult.nullDepth.depthDb.status, "negative-infinity");

  const below = requireCase("below_gate_44100");
  const belowResult = measurePair(below.a, below.b, below.options);
  assert.notEqual(belowResult.a.integratedLufs.status, "finite");
  const short = requireCase("too_short_48000");
  assert.equal(measurePair(short.a, short.b, short.options).a.integratedLufs.status, "unavailable");
});

test("measurePair accepts equal non-identical audio within the reference tolerances", () => {
  const entry = requireCase("stereo_delay_137_48000");
  const result = measurePair(entry.a, entry.b, { maxLagSamples: 1000, probeSamples: 240000 });
  assert.equal(result.alignment.lagSamples, 137);
  assert.equal(result.alignment.status, "estimated");
  assert.ok(result.alignment.confidence > 0.99);
});

function makeAudio(sampleRate: number, channels: readonly Float64Array[]): PcmAudio {
  return { sampleRate, channels };
}

function noiseSignal(frames: number, seed: number, amplitude = 0.2): Float64Array {
  const samples = new Float64Array(frames);
  let state = seed >>> 0;
  for (let index = 0; index < frames; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const random = state / 0x100000000;
    samples[index] =
      amplitude * (2 * random - 1) +
      amplitude * 0.4 * Math.sin((2 * Math.PI * 440 * index) / 48000);
  }
  return samples;
}

function delayedMono(samples: Float64Array, lag: number): Float64Array {
  const output = new Float64Array(samples.length);
  for (let index = lag; index < samples.length; index += 1) {
    output[index] = samples[index - lag] ?? 0;
  }
  return output;
}

test("estimateLag recovers zero, positive and negative sample delays", () => {
  const a = noiseSignal(48000, 11);
  const b = delayedMono(a, 137);
  const positive = estimateLag(makeAudio(48000, [a]), makeAudio(48000, [b]), {
    maxLagSamples: 1000,
  });
  assert.equal(positive.lagSamples, 137);
  assert.equal(positive.status, "estimated");
  assert.ok(positive.confidence > 0.9);

  const negative = estimateLag(makeAudio(48000, [b]), makeAudio(48000, [a]), {
    maxLagSamples: 1000,
  });
  assert.equal(negative.lagSamples, -137);

  const zero = estimateLag(makeAudio(48000, [a]), makeAudio(48000, [a]), {
    maxLagSamples: 1000,
  });
  assert.equal(zero.lagSamples, 0);
  assert.ok(Math.abs(zero.confidence - 1) <= 1e-9);
});

test("anti-phase stereo keeps alignment evidence", () => {
  const mono = noiseSignal(48000, 17);
  const inverse = new Float64Array(mono.length);
  for (let index = 0; index < mono.length; index += 1) inverse[index] = -(mono[index] ?? 0);
  const a = makeAudio(48000, [mono, inverse]);
  const delayedLeft = delayedMono(mono, 137);
  const delayedRight = new Float64Array(inverse.length);
  for (let index = 0; index < inverse.length; index += 1) {
    delayedRight[index] = -(delayedLeft[index] ?? 0);
  }
  const b = makeAudio(48000, [delayedLeft, delayedRight]);
  const result = estimateLag(a, b, { maxLagSamples: 500 });
  assert.equal(result.lagSamples, 137);
  assert.ok(result.confidence > 0.99);
});

test("no-evidence inputs never invent a lag", () => {
  const silent = new Float64Array(48000);
  const dc = new Float64Array(48000).fill(0.25);
  for (const value of [silent, dc]) {
    const result = estimateLag(
      makeAudio(48000, [value]),
      makeAudio(48000, [value.slice()]),
      { maxLagSamples: 100 },
    );
    assert.equal(result.lagSamples, 0);
    assert.equal(result.confidence, 0);
    assert.equal(result.status, "no-evidence");
  }
  const singleFrame = estimateLag(
    makeAudio(48000, [new Float64Array([0.1])]),
    makeAudio(48000, [new Float64Array([0.1])]),
  );
  assert.equal(singleFrame.lagSamples, 0);
  assert.equal(singleFrame.confidence, 0);
  assert.equal(singleFrame.status, "no-evidence");
});

test("measurePair never mutates caller PCM arrays", () => {
  const left = noiseSignal(24000, 23);
  const right = noiseSignal(24000, 29);
  const a = makeAudio(48000, [left, right]);
  const b = makeAudio(48000, [delayedMono(left, 17), delayedMono(right, 17)]);
  const snapshot = [left, right, b.channels[0], b.channels[1]].map((channel) => {
    assert.ok(channel);
    return Array.from(channel);
  });
  measurePair(a, b, { maxLagSamples: 100 });
  const current = [left, right, b.channels[0], b.channels[1]];
  for (let index = 0; index < snapshot.length; index += 1) {
    assert.deepEqual(Array.from(current[index] ?? new Float64Array()), snapshot[index]);
  }
});

test("null depth follows the analytic level-mismatch curve", () => {
  const a = noiseSignal(24000, 31);
  for (const offsetDb of [0.5, 0.1, 0.01]) {
    const gain = 10 ** (offsetDb / 20);
    const b = new Float64Array(a.length);
    for (let index = 0; index < a.length; index += 1) b[index] = (a[index] ?? 0) * gain;
    const expected = 20 * Math.log10(Math.abs(gain - 1));
    const result = measureNullDepth(makeAudio(48000, [a]), makeAudio(48000, [b]));
    assert.equal(result.basis, "unshifted-common-prefix");
    assert.equal(result.comparedFrames, a.length);
    assert.equal(result.depthDb.status, "finite");
    if (result.depthDb.status === "finite") {
      close(result.depthDb.value, expected, 1e-9, `null depth at ${offsetDb} dB`);
    }
  }
});

test("null depth exposes exact null and silent-reference states", () => {
  const a = noiseSignal(48000, 37);
  const exact = measureNullDepth(makeAudio(48000, [a]), makeAudio(48000, [a.slice()]));
  assert.equal(exact.depthDb.status, "negative-infinity");
  assert.equal(exact.depthDb.value, null);

  const silent = new Float64Array(a.length);
  const undefinedResult = measureNullDepth(
    makeAudio(48000, [silent]),
    makeAudio(48000, [a]),
  );
  assert.equal(undefinedResult.depthDb.status, "undefined");
  assert.equal(undefinedResult.comparedFrames, a.length);
});

test("sample peak is sample-based and silent input is negative infinity", () => {
  const ones = new Float64Array(48000).fill(1);
  const zero = samplePeakDbfs(makeAudio(48000, [ones]));
  assert.equal(zero.status, "finite");
  if (zero.status === "finite") close(zero.value, 0, 1e-12, "unit peak");

  const silent = samplePeakDbfs(makeAudio(48000, [new Float64Array(48000)]));
  assert.equal(silent.status, "negative-infinity");
  assert.equal(silent.value, null);
  assert.equal(typeof silent.reason, "string");
});

test("integrated loudness reports short clips as unavailable", () => {
  const short = new Float64Array(1000).fill(0.1);
  const result = integratedLoudness(makeAudio(48000, [short]));
  assert.equal(result.status, "unavailable");
  assert.equal(result.value, null);
  assert.equal(typeof result.reason, "string");
});

test("decodePcm16 converts interleaved little-endian PCM16 to planar float", () => {
  const frames = 3;
  const bytes = new Uint8Array(44 + frames * 2 * 2);
  const view = new DataView(bytes.buffer);
  const values = [0, 16384, -32768, 32767, -1, 1];
  for (let index = 0; index < values.length; index += 1) {
    view.setInt16(44 + index * 2, values[index] ?? 0, true);
  }
  const decoded = decodePcm16(bytes, {
    sampleRate: 48000,
    channels: 2,
    dataOffset: 44,
    dataSize: frames * 4,
  });
  assert.equal(decoded.channels.length, 2);
  assert.deepEqual(Array.from(decoded.channels[0] ?? []), [0, -1, -1 / 32768]);
  assert.deepEqual(Array.from(decoded.channels[1] ?? []), [0.5, 32767 / 32768, 1 / 32768]);
});

test("decodePcm16 rejects malformed layouts before reading samples", () => {
  const bytes = new Uint8Array(16);
  const base = { sampleRate: 48000, channels: 2 as const, dataOffset: 0, dataSize: 8 };
  assert.throws(() => decodePcm16(bytes, { ...base, dataOffset: -1 }));
  assert.throws(() => decodePcm16(bytes, { ...base, dataOffset: 9 }));
  assert.throws(() => decodePcm16(bytes, { ...base, dataSize: 0 }));
  assert.throws(() => decodePcm16(bytes, { ...base, dataSize: 6 }));
  assert.throws(() => decodePcm16(bytes, { ...base, sampleRate: 32000 }));
  assert.throws(() => decodePcm16(bytes, { ...base, channels: 3 as unknown as 2 }));
});

test("measurePair rejects invalid PCM and unsupported work at the boundary", () => {
  const ok = new Float64Array(48000).fill(0.1);
  const audio = (rate: number, channels: readonly Float64Array[]): PcmAudio =>
    makeAudio(rate, channels);

  assert.throws(() => measurePair(audio(48000, []), audio(48000, [ok])));
  assert.throws(() =>
    measurePair(audio(48000, [new Float64Array(0)]), audio(48000, [ok])),
  );
  assert.throws(() =>
    measurePair(audio(48000, [ok, new Float64Array(100)]), audio(48000, [ok])),
  );
  const nan = ok.slice();
  nan[10] = Number.NaN;
  assert.throws(() => measurePair(audio(48000, [nan]), audio(48000, [ok])));
  assert.throws(() => measurePair(audio(44100, [ok]), audio(48000, [ok])));
  assert.throws(() => measurePair(audio(48000, [ok]), audio(48000, [ok, ok])));
  assert.throws(() => measurePair(audio(32000, [ok]), audio(32000, [ok])));
  assert.throws(() =>
    measurePair(audio(48000, [ok]), audio(48000, [ok]), { maxLagSamples: -1 }),
  );
  assert.throws(() =>
    measurePair(audio(48000, [ok]), audio(48000, [ok]), { maxLagSamples: 1.5 }),
  );
  assert.throws(() =>
    measurePair(audio(48000, [ok]), audio(48000, [ok]), { probeSamples: 1 }),
  );
});
