import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { LevelMeasurement } from "@codec-abx/contracts";
import {
  decodePcm16,
  measureNullDepth,
  type PcmAudio,
} from "@codec-abx/measurements";

import {
  buildCanaryPair,
  evaluateCanaryDepth,
  preparePair,
} from "../src/index.js";
import { PCM16_FLOOR_BIAS, quantizePcm16Sample } from "../src/pcm16.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FLOOR_BIAS = PCM16_FLOOR_BIAS;
const QUANTUM = 1 / 32768;

function pcm(sampleRate: number, channels: readonly Float64Array[]): PcmAudio {
  return { sampleRate, channels };
}

function decodeDelivered(bytes: Uint8Array, sampleRate: number, channels: 1 | 2): PcmAudio {
  return decodePcm16(bytes, {
    sampleRate,
    channels,
    dataOffset: 44,
    dataSize: bytes.byteLength - 44,
  });
}

function correlation(a: Float64Array, b: Float64Array): number {
  assert.equal(a.length, b.length);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return ab / Math.sqrt(aa * bb);
}

function nonperiodicBase(rate: number, frames: number): Float64Array {
  const output = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / rate;
    output[frame] =
      0.17 * Math.sin(2 * Math.PI * (311 * t + 43 * t * t)) +
      0.08 * Math.sin(2 * Math.PI * (947 * t + 0.31)) +
      0.04 * Math.sin(2 * Math.PI * (1553 * t + 1.17));
  }
  return output;
}

function shifted(source: Float64Array, delay: number): Float64Array {
  const output = new Float64Array(source.length);
  for (let index = delay; index < source.length; index += 1) {
    output[index] = source[index - delay]!;
  }
  return output;
}

function ffmpegBinary(): string | null {
  const vendored = path.join(REPOSITORY_ROOT, "third_party", "ffmpeg", "bin", "ffmpeg");
  if (existsSync(vendored)) return vendored;
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  return probe.status === 0 ? "ffmpeg" : null;
}

/**
 * Independently implemented FFmpeg EBU R128 scanner reading only the exact
 * serialized WAV fixture. This is a separate meter implementation, not a
 * second call to the shared TypeScript loudness routine. It is corroborating
 * evidence for the declared -16 LUFS product target, not ITU/EBU certification.
 */
function ffmpegIntegratedLufs(ffmpeg: string, wav: Uint8Array): number {
  const dir = mkdtempSync(path.join(os.tmpdir(), "independent-policy-"));
  const file = path.join(dir, "fixture.wav");
  try {
    writeFileSync(file, wav);
    const result = spawnSync(
      ffmpeg,
      [
        "-nostdin", "-hide_banner", "-nostats",
        "-i", file,
        "-filter_complex", "ebur128=peak=true",
        "-f", "null", "-",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const matches = [...result.stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/g)];
    const last = matches[matches.length - 1]?.[1];
    assert.ok(last !== undefined, "FFmpeg ebur128 did not print an integrated loudness");
    const value = Number(last);
    assert.ok(Number.isFinite(value));
    return value;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function finiteLevel(level: LevelMeasurement): number {
  assert.equal(level.status, "finite");
  if (level.status !== "finite") throw new Error("level is not finite");
  return level.value;
}

test("known positive and negative delays crop the later side and preserve nonperiodic content", () => {
  const rate = 48_000;
  const frames = 28_800;
  const delay = 137;
  const base = nonperiodicBase(rate, frames);
  const delayed = shifted(base, delay);

  for (const direction of ["positive", "negative"] as const) {
    const a = direction === "positive" ? base.slice() : delayed.slice();
    const b = direction === "positive" ? delayed.slice() : base.slice();
    const aBefore = a.slice();
    const bBefore = b.slice();
    const result = preparePair(pcm(rate, [a]), pcm(rate, [b]));

    assert.equal(result.report.alignment.status, "estimated");
    assert.equal(
      result.report.alignment.lagSamples,
      direction === "positive" ? delay : -delay,
      "positive means B is delayed, negative means A is delayed",
    );
    assert.equal(
      result.report.alignment.startFrameA,
      direction === "negative" ? delay : 0,
    );
    assert.equal(
      result.report.alignment.startFrameB,
      direction === "positive" ? delay : 0,
    );
    assert.equal(result.report.alignment.outputFrames, frames - delay);
    assert.deepEqual(a, aBefore, "preparePair must not mutate input A");
    assert.deepEqual(b, bBefore, "preparePair must not mutate input B");

    // After the declared head trim both sides contain the same unshifted base.
    assert.deepEqual(result.aWav, result.bWav);
    const deliveredA = decodeDelivered(result.aWav, rate, 1).channels[0]!;
    const deliveredB = decodeDelivered(result.bWav, rate, 1).channels[0]!;
    assert.equal(deliveredA.length, frames - delay);
    assert.deepEqual(deliveredA, deliveredB);

    // Independent content check: derive the applied common gain by a
    // least-squares fit against the analytical base, then require every output
    // sample to be that gain times the base, within one PCM16 LSB.
    let cross = 0;
    let energy = 0;
    for (let index = 0; index < deliveredA.length; index += 1) {
      cross += deliveredA[index]! * base[index]!;
      energy += base[index]! * base[index]!;
    }
    const factor = cross / energy;
    assert.ok(Number.isFinite(factor) && factor > 0);
    for (let index = 0; index < deliveredA.length; index += 1) {
      assert.ok(
        Math.abs(deliveredA[index]! - base[index]! * factor) <= QUANTUM * 1.01 + 1e-12,
        `delivered sample ${String(index)} does not match the known crop/content`,
      );
    }
    const nullDepth = measureNullDepth(
      decodeDelivered(result.aWav, rate, 1),
      decodeDelivered(result.bWav, rate, 1),
    );
    assert.equal(nullDepth.depthDb.status, "negative-infinity");
  }
});

test("anti-phase cancels within one quantum and channels are not downmixed or swapped", () => {
  const rate = 48_000;
  const frames = 24_000;
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / rate;
    left[frame] = 0.15 * Math.sin(2 * Math.PI * 440 * t);
    right[frame] = 0.08 * Math.sin(2 * Math.PI * 660 * t + 0.2);
  }
  // A stereo source whose right channel is the exact negative of its left must
  // remain anti-phase and stereo through serialization (no downmix/rectify).
  const antiSource = pcm(rate, [left, left.map((sample) => -sample)]);
  const anti = preparePair(antiSource, antiSource);
  const antiA = decodeDelivered(anti.aWav, rate, 2).channels;
  const antiB = decodeDelivered(anti.bWav, rate, 2).channels;
  assert.equal(anti.report.alignment.lagSamples, 0);
  assert.equal(antiA[0]?.length, frames);
  assert.deepEqual(anti.aWav, anti.bWav);
  for (let frame = 0; frame < frames; frame += 1) {
    const sum = (antiA[0]![frame] ?? 0) + (antiA[1]![frame] ?? 0);
    assert.ok(Math.abs(sum) <= QUANTUM + 1e-12,
      `anti-phase channels did not cancel at frame ${String(frame)}`);
    assert.equal(antiA[1]![frame], antiB[1]![frame]);
  }

  // Identical stereo pair: each output channel must follow only its own input.
  const isolated = preparePair(pcm(rate, [left, right]), pcm(rate, [left, right]));
  const isolatedA = decodeDelivered(isolated.aWav, rate, 2).channels;
  assert.equal(isolatedA[0]?.length, frames);
  assert.ok(Math.abs(correlation(isolatedA[0]!, left)) > 0.9999);
  assert.ok(Math.abs(correlation(isolatedA[1]!, right)) > 0.9999);
  assert.ok(Math.abs(correlation(isolatedA[0]!, right)) < 0.2,
    "left output must not contain the right input");
  assert.ok(Math.abs(correlation(isolatedA[1]!, left)) < 0.2,
    "right output must not contain the left input");
});

test("known gain ratios target -16 LUFS and one common trim preserves the ratio", (t) => {
  const rate = 48_000;
  const frames = 28_800;
  const sine = (amplitude: number): Float64Array => {
    const samples = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      samples[frame] = amplitude * Math.sin(2 * Math.PI * 1000 * frame / rate);
    }
    return samples;
  };
  const ffmpeg = ffmpegBinary();
  const requireIndependent = process.env.CODEC_ABX_REQUIRE_INDEPENDENT_LOUDNESS === "1";
  if (!ffmpeg) {
    if (requireIndependent) {
      assert.fail("production verification requires FFmpeg for the independent ebur128 check");
    }
    t.diagnostic("FFmpeg is unavailable; the independent ebur128 check is skipped");
  }

  const unity = preparePair(pcm(rate, [sine(0.1)]), pcm(rate, [sine(0.01)]));
  assert.ok(Math.abs(unity.report.loudness.gainBDb - unity.report.loudness.gainADb - 20) < 1e-6,
    "a 10x amplitude ratio must map to a 20 dB independent-gain difference");
  assert.equal(unity.report.loudness.commonTrimDb, 0);
  assert.ok(Math.abs(finiteLevel(unity.delivered.a.integratedLufs) - -16) < 1e-3);
  assert.ok(Math.abs(finiteLevel(unity.delivered.b.integratedLufs) - -16) < 1e-3);

  const impulse = (amplitude: number): Float64Array => {
    const samples = new Float64Array(frames);
    samples[1000] = amplitude;
    return samples;
  };
  const trimmed = preparePair(pcm(rate, [impulse(0.5)]), pcm(rate, [impulse(0.05)]));
  assert.ok(trimmed.report.loudness.commonTrimDb > 0,
    "the fixture must require common attenuation");
  assert.ok(Math.abs(trimmed.report.loudness.gainBDb - trimmed.report.loudness.gainADb - 20) < 1e-6);
  assert.ok(Math.abs(
    finiteLevel(trimmed.delivered.a.integratedLufs) -
    finiteLevel(trimmed.delivered.b.integratedLufs),
  ) < 1e-9, "one common trim must preserve the relative gain");
  assert.ok(Math.abs(
    finiteLevel(trimmed.delivered.a.integratedLufs) -
    (-16 - trimmed.report.loudness.commonTrimDb),
  ) < 1e-9);
  // Peaks never exceed the published one-quantum headroom.
  for (const side of ["a", "b"] as const) {
    const samples = decodeDelivered(side === "a" ? trimmed.aWav : trimmed.bWav, rate, 1)
      .channels[0]!;
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    assert.ok(peak <= 32767 / 32768 + 1e-15);
  }

  if (ffmpeg) {
    const measuredA = ffmpegIntegratedLufs(ffmpeg, unity.aWav);
    const measuredB = ffmpegIntegratedLufs(ffmpeg, unity.bWav);
    assert.ok(Math.abs(measuredA - -16) < 0.2,
      `independent ebur128 A was ${String(measuredA)} LUFS, not near the declared target`);
    assert.ok(Math.abs(measuredB - -16) < 0.2,
      `independent ebur128 B was ${String(measuredB)} LUFS, not near the declared target`);

    const trimmedA = ffmpegIntegratedLufs(ffmpeg, trimmed.aWav);
    const trimmedB = ffmpegIntegratedLufs(ffmpeg, trimmed.bWav);
    assert.ok(Math.abs(trimmedA - trimmedB) < 0.2,
      "independent ebur128 must agree that common trim preserved the side ratio");
    assert.ok(Math.abs(trimmedA - finiteLevel(trimmed.delivered.a.integratedLufs)) < 0.3,
      "independent ebur128 and the declared meter should agree for this exact fixture");
  }
});

test("null statuses distinguish exact digital null, silent reference and anti-phase residual", () => {
  const rate = 48_000;
  const frames = 4_800;
  const one = new Float64Array(frames);
  const opposite = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) {
    one[index] = 0.125 * Math.sin(2 * Math.PI * 500 * index / rate);
    opposite[index] = -one[index]!;
  }
  const silence = new Float64Array(frames);

  const exact = measureNullDepth(pcm(rate, [one]), pcm(rate, [one.slice()]));
  assert.equal(exact.depthDb.status, "negative-infinity");
  assert.equal(exact.comparedFrames, frames);

  const silentReference = measureNullDepth(pcm(rate, [silence]), pcm(rate, [one]));
  assert.equal(silentReference.depthDb.status, "undefined");
  if (silentReference.depthDb.status !== "undefined") {
    assert.fail("a silent reference must have an undefined null depth");
  }
  assert.match(silentReference.depthDb.reason, /silent reference/);

  const silentResidual = measureNullDepth(pcm(rate, [one]), pcm(rate, [silence]));
  assert.equal(silentResidual.depthDb.status, "finite");
  assert.ok(Math.abs(finiteLevel(silentResidual.depthDb)) < 1e-12);

  const anti = measureNullDepth(pcm(rate, [one]), pcm(rate, [opposite]));
  assert.equal(anti.depthDb.status, "finite");
  // Null depth is a difference residual: A - (-A) = 2A, i.e. exactly +6.02 dB.
  // Anti-phase cancellation is a SUM property, exercised separately above.
  assert.ok(Math.abs(finiteLevel(anti.depthDb) - 20 * Math.log10(2)) < 1e-9);
});

test("PCM16 signed/boundary quantization follows the documented floor-plus-bias product choice", () => {
  assert.equal(FLOOR_BIAS, 2 ** -17);
  const cases: readonly (readonly [number, number])[] = [
    [0, 0],
    [1 / 32768, 1],
    [-1 / 32768, -1],
    [0.9 / 32768, 0],
    [-0.9 / 32768, -1],
    [1.5 / 32768, 1],
    [-1.5 / 32768, -2],
    [32767 / 32768, 32767],
    [-32768 / 32768, -32768],
    [1, 32767],
    [-1, -32768],
    [1.2, 32767],
    [-1.2, -32768],
  ];
  for (const [input, expected] of cases) {
    assert.equal(quantizePcm16Sample(input), expected, `quantize(${String(input)})`);
  }
  assert.throws(() => quantizePcm16Sample(Number.NaN), /non-finite/);
  assert.throws(() => quantizePcm16Sample(Number.POSITIVE_INFINITY), /non-finite/);
});

test("canary usability rejects driven material that is not a gross material difference", () => {
  const rate = 44_100;
  const frames = 44_100;
  const square = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // A low-frequency full-scale square is mostly preserved by a 3 kHz
    // low-pass and then driven/clipped back to the same plateau level, so the
    // measured difference is far below the deliberately-easy -30 dB floor.
    const value = Math.sin(2 * Math.PI * 5 * frame / rate) >= 0 ? 0.45 : -0.45;
    square[frame] = Math.round(value * 32768) / 32768;
  }
  const material = buildCanaryPair(pcm(rate, [square]));
  assert.equal(material.report.usable, false);
  assert.equal(material.report.status, "not-usable");
  assert.equal(material.report.depthDb.status, "finite");
  assert.ok(finiteLevel(material.report.depthDb) <= -30);
  assert.match(material.report.reason, /too subtle|at or below/);
});

test("canary degradation matches a direct small DFT and a one-off frequency grid", () => {
  const rate = 44_100;
  const frames = 128;
  const input = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const low = 0.22 * Math.sin(2 * Math.PI * 4 * frame / frames);
    const high = 0.13 * Math.sin(2 * Math.PI * 20 * frame / frames + 0.4);
    // Put the fixture exactly on the signed PCM16 grid before canary validation.
    input[frame] = Math.round((low + high) * 32768) / 32768;
  }
  const before = input.slice();
  const material = buildCanaryPair(pcm(rate, [input]));
  assert.deepEqual(input, before, "canary construction must not mutate its input");
  assert.equal(material.report.frames, frames);
  assert.equal(material.report.policy, "delivered-canary-v1");

  const pristine = decodeDelivered(material.pristineWav, rate, 1).channels[0]!;
  const degraded = decodeDelivered(material.degradedWav, rate, 1).channels[0]!;
  assert.equal(pristine.length, frames);
  assert.equal(degraded.length, frames);
  for (let frame = 0; frame < frames; frame += 1) {
    assert.equal(Math.round(pristine[frame]! * 32768), Math.round(input[frame]! * 32768));
  }

  // Independent naive DFT, not the shared FFT plan. Use the documented
  // NumPy rfftfreq arithmetic and the same strictly-above-3000-Hz bin rule.
  const frequencyStep = 1 / (frames * (1 / rate));
  const spectrumRe = new Float64Array(frames);
  const spectrumIm = new Float64Array(frames);
  for (let bin = 0; bin < frames; bin += 1) {
    let re = 0;
    let im = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const angle = (2 * Math.PI * bin * frame) / frames;
      re += input[frame]! * Math.cos(angle);
      im -= input[frame]! * Math.sin(angle);
    }
    const folded = Math.min(bin, frames - bin);
    if (folded * frequencyStep > 3000) {
      re = 0;
      im = 0;
    }
    spectrumRe[bin] = re;
    spectrumIm[bin] = im;
  }
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (let bin = 0; bin < frames; bin += 1) {
      const angle = (2 * Math.PI * bin * frame) / frames;
      value += spectrumRe[bin]! * Math.cos(angle) - spectrumIm[bin]! * Math.sin(angle);
    }
    value /= frames;
    const driven = Math.max(-0.45, Math.min(0.45, value * 10));
    const expected = quantizePcm16Sample(driven);
    const actual = Math.round(degraded[frame]! * 32768);
    assert.ok(Math.abs(actual - expected) <= 1,
      `canary frame ${String(frame)}: ${String(actual)} vs direct-DFT ${String(expected)}`);
  }

  const decision = evaluateCanaryDepth(material.report.depthDb);
  assert.equal(material.report.status, decision.status);
  assert.equal(material.report.usable, decision.usable);
});
