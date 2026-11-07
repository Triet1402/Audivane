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
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { LevelMeasurement } from "@codec-abx/contracts";
import {
  SUPPORTED_SAMPLE_RATES,
  decodePcm16,
  integratedLoudness,
  type PcmAudio,
} from "@codec-abx/measurements";

import {
  PREPARATION_PEAK_CEILING,
  PREPARATION_POLICY_ID,
  PREPARATION_TARGET_LUFS,
  PreparationPolicyError,
  preparePair,
} from "../src/index.js";
import {
  PCM16_FLOOR_BIAS,
  PCM16_WAV_HEADER_BYTES,
  encodePcm16Wav,
  quantizePcm16Sample,
} from "../src/pcm16.js";

/**
 * Independent loudness/quantization evidence for the frozen
 * `aligned-gain-matched-v1` policy.
 *
 * Evidence classes kept separate in this file:
 * - analytical properties of known generated signals (level ratios, channel
 *   energy sums, block/gate arithmetic, signed PCM16 boundaries);
 * - delivery self-checks of the exact served WAV bytes against the report
 *   (the same shared meter is intentionally used here only to check delivery);
 * - a separate external FFmpeg `ebur128` implementation. It corroborates the
 *   product target/properties where both interpretations agree, and its known
 *   partial-block difference is recorded rather than forced into equality.
 */
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REQUIRE_INDEPENDENT = process.env.CODEC_ABX_REQUIRE_INDEPENDENT_LOUDNESS === "1";
const FFMPEG = ffmpegBinary();

function pcm(sampleRate: number, channels: readonly Float64Array[]): PcmAudio {
  return { sampleRate, channels };
}

function cloneAudio(audio: PcmAudio): PcmAudio {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((channel) => channel.slice()),
  };
}

function tone(
  sampleRate: number,
  seconds: number,
  amplitude: number,
  frequency = 1000,
  phase = 0,
): Float64Array {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame] = amplitude * Math.sin(
      2 * Math.PI * frequency * frame / sampleRate + phase,
    );
  }
  return samples;
}

function impulse(sampleRate: number, seconds: number, amplitude: number): Float64Array {
  const samples = new Float64Array(Math.round(seconds * sampleRate));
  samples[Math.floor(sampleRate * 0.1)] = amplitude;
  return samples;
}

function concatChannels(...parts: readonly Float64Array[]): Float64Array {
  const frames = parts.reduce((total, part) => total + part.length, 0);
  const samples = new Float64Array(frames);
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  return samples;
}

function finiteLufs(audio: PcmAudio): number {
  const level = integratedLoudness(audio);
  assert.equal(level.status, "finite", level.status === "finite" ? undefined : level.reason);
  if (level.status !== "finite") throw new Error("integrated loudness is not finite");
  return level.value;
}

function finiteLevel(level: LevelMeasurement): number {
  assert.equal(level.status, "finite", level.status === "finite" ? undefined : level.reason);
  if (level.status !== "finite") throw new Error("level is not finite");
  return level.value;
}

function decodeDelivered(bytes: Uint8Array, sampleRate: number, channels: 1 | 2): PcmAudio {
  return decodePcm16(bytes, {
    sampleRate,
    channels,
    dataOffset: PCM16_WAV_HEADER_BYTES,
    dataSize: bytes.byteLength - PCM16_WAV_HEADER_BYTES,
  });
}

function servedCodes(bytes: Uint8Array): Int16Array {
  const dataSize = bytes.byteLength - PCM16_WAV_HEADER_BYTES;
  assert.equal(dataSize % 2, 0, "PCM16 data must contain whole 16-bit codes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codes = new Int16Array(dataSize / 2);
  for (let index = 0; index < codes.length; index += 1) {
    codes[index] = view.getInt16(PCM16_WAV_HEADER_BYTES + index * 2, true);
  }
  return codes;
}

function assertCanonicalWav(
  bytes: Uint8Array,
  sampleRate: number,
  channels: 1 | 2,
  frames: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readText = (offset: number): string => String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
  assert.equal(readText(0), "RIFF");
  assert.equal(readText(8), "WAVE");
  assert.equal(readText(12), "fmt ");
  assert.equal(readText(36), "data");
  assert.equal(view.getUint16(20, true), 1, "format must be PCM");
  assert.equal(view.getUint16(22, true), channels);
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(28, true), sampleRate * channels * 2, "byte rate");
  assert.equal(view.getUint16(32, true), channels * 2, "block align");
  assert.equal(view.getUint32(40, true), bytes.byteLength - PCM16_WAV_HEADER_BYTES);
  assert.equal(view.getUint32(40, true), frames * channels * 2);
}

/**
 * Verify that the exact served PCM16 codes are the documented quantizer applied
 * to the report's two constant gain factors, in the same multiplication order
 * as the frozen policy. This is a delivery/report self-check, not independent
 * evidence for the loudness meter that produced the gains.
 */
function assertServedMatchesReportedGains(
  result: ReturnType<typeof preparePair>,
  side: "a" | "b",
  input: PcmAudio,
): void {
  const loudness = side === "a" ? result.report.loudness.gainADb : result.report.loudness.gainBDb;
  const gainFactor = 10 ** (loudness / 20);
  const trimFactor = 10 ** (-result.report.loudness.commonTrimDb / 20);
  const codes = servedCodes(side === "a" ? result.aWav : result.bWav);
  const channels = input.channels.length;
  const frames = input.channels[0]?.length ?? 0;
  assert.equal(codes.length, frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const source = input.channels[channel]?.[frame];
      if (source === undefined) throw new Error("input channel disappeared");
      const expected = quantizePcm16Sample((source * gainFactor) * trimFactor);
      const actual = codes[frame * channels + channel];
      assert.equal(actual, expected,
        `${side} served code mismatch at frame ${String(frame)}, channel ${String(channel)}`);
    }
  }
}

function ffmpegBinary(): string | null {
  const vendored = path.join(REPOSITORY_ROOT, "third_party", "ffmpeg", "bin", "ffmpeg");
  if (existsSync(vendored)) return vendored;
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  return probe.status === 0 ? "ffmpeg" : null;
}

/**
 * Separate external implementation: FFmpeg's ebur128 filter reads only the
 * exact serialized WAV fixture. `metadata=1` prints the integrated value with
 * milliloudness-level text precision; `ametadata` avoids relying on the
 * one-decimal human summary. This is corroboration, not ITU/EBU certification.
 */
function ffmpegIntegratedLufs(ffmpeg: string, wav: Uint8Array): number {
  const dir = mkdtempSync(path.join(os.tmpdir(), "independent-loudness-"));
  const file = path.join(dir, "fixture.wav");
  try {
    writeFileSync(file, wav);
    const result = spawnSync(
      ffmpeg,
      [
        "-nostdin", "-hide_banner", "-nostats",
        "-i", file,
        "-filter_complex", "ebur128=peak=true:metadata=1,ametadata=mode=print:file=-",
        "-f", "null", "-",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const stdout = result.stdout ?? "";
    const matches = [...stdout.matchAll(/lavfi\.r128\.I=(-?\d+(?:\.\d+)?)/g)];
    const last = matches[matches.length - 1]?.[1];
    assert.ok(last !== undefined, "FFmpeg ebur128 did not print integrated loudness metadata");
    const value = Number(last);
    assert.ok(Number.isFinite(value));
    return value;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkExternalAvailability(t: TestContext): string | null {
  if (FFMPEG) {
    t.diagnostic(
      "external evidence: FFmpeg ebur128 (separate implementation) is available and used " +
        "for corroboration; it is not a conformance authority",
    );
    return FFMPEG;
  }
  if (REQUIRE_INDEPENDENT) {
    assert.fail(
      "CODEC_ABX_REQUIRE_INDEPENDENT_LOUDNESS=1 requires FFmpeg ebur128, but no " +
        "vendored or PATH FFmpeg was found; the production lane must not omit external evidence",
    );
  }
  t.diagnostic(
    "external evidence omitted: FFmpeg is unavailable, so no independent ebur128 " +
      "comparison ran. Analytical and served-byte checks in this test still ran.",
  );
  return null;
}

/**
 * Analytical relative-gate arithmetic for stationary, equal-length regions.
 * `energies` are block mean-square energies normalized to one fully loud block.
 * This deliberately re-implements only the documented block/gate arithmetic,
 * not the K-weighting filter, and assumes every block clears the -70 LUFS
 * absolute gate (true for these fixtures).
 */
function analyticalGatingOffsetDb(energies: readonly number[]): number {
  assert.ok(energies.length > 0);
  const mean = energies.reduce((total, value) => total + value, 0) / energies.length;
  const relativeThreshold = mean * 0.1;
  const gated = energies.filter((value) => value > relativeThreshold);
  assert.ok(gated.length > 0);
  const gatedMean = gated.reduce((total, value) => total + value, 0) / gated.length;
  return 10 * Math.log10(gatedMean);
}

/**
 * Block energies for a signal that is exactly `loudSeconds` of a stationary
 * tone followed by `quietSeconds` of a scaled copy (same frequency/phase, so
 * the quiet region's steady energy ratio is the amplitude ratio squared).
 * Uses the documented 400 ms block / 100 ms step grid and the same
 * integer-truncation boundary rule as the product meter.
 */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function twoRegionBlockEnergies(
  sampleRate: number,
  loudSeconds: number,
  quietSeconds: number,
  quietEnergyRatio: number,
): number[] {
  const blockSeconds = 0.4;
  const stepSeconds = 0.1;
  const duration = loudSeconds + quietSeconds;
  const numBlocks = Math.trunc(
    roundHalfToEven((duration - blockSeconds) / stepSeconds) + 1,
  );
  const energies: number[] = [];
  for (let block = 0; block < numBlocks; block += 1) {
    const lower = block * stepSeconds * sampleRate;
    const upper = lower + blockSeconds * sampleRate;
    const loudFrames = Math.max(0, Math.min(upper, loudSeconds * sampleRate) - lower);
    const quietFrames = Math.max(0, Math.min(upper, duration * sampleRate) - Math.max(lower, loudSeconds * sampleRate));
    const covered = loudFrames + quietFrames;
    assert.ok(covered > 0, "analytical block must cover fixture samples");
    // The product meter divides by the full 400 ms block even when the final
    // block is truncated; block-index blocks here are full except the last.
    const divisor = blockSeconds * sampleRate;
    energies.push((loudFrames + quietEnergyRatio * quietFrames) / divisor);
  }
  return energies;
}

test("production lane requires the separate FFmpeg ebur128 implementation", (t) => {
  if (!FFMPEG) {
    if (REQUIRE_INDEPENDENT) {
      assert.fail(
        "production independent-loudness evidence requires FFmpeg ebur128; " +
          "install the vendored FFmpeg or provide it on PATH",
      );
    }
    t.diagnostic(
      "FFmpeg is unavailable in this ordinary development run; external ebur128 " +
        "evidence is explicitly omitted rather than reported as a pass",
    );
    return;
  }
  t.diagnostic("FFmpeg ebur128 is available for the separate external comparisons");
});

test("steady tones at 44.1/48/96 kHz mono/stereo target -16 LUFS with exact served PCM16", (t) => {
  const ffmpeg = checkExternalAvailability(t);
  let maxDeliveredTargetErrorDb = 0;
  let maxExternalTargetErrorDb = 0;
  let externalComparisons = 0;
  const scenarios = SUPPORTED_SAMPLE_RATES.length * 3 * 2;
  let compared = 0;

  for (const sampleRate of SUPPORTED_SAMPLE_RATES) {
    for (const frequency of [60, 1000, 8000]) {
      for (const stereo of [false, true]) {
        const source = tone(sampleRate, 1.2, 0.1, frequency);
        const inputA = pcm(sampleRate, stereo ? [source.slice(), source.slice()] : [source.slice()]);
        const inputB = pcm(sampleRate, stereo ? [source.slice(), source.slice()] : [source.slice()]);
        const beforeA = cloneAudio(inputA);
        const beforeB = cloneAudio(inputB);
        const result = preparePair(inputA, inputB);

        assert.equal(result.report.policy, PREPARATION_POLICY_ID);
        assert.equal(result.report.targetLufs, PREPARATION_TARGET_LUFS);
        assert.equal(result.report.alignment.lagSamples, 0);
        assert.equal(result.report.alignment.outputFrames, source.length);
        assert.equal(result.report.loudness.commonTrimDb, 0,
          "this fixture's peak must not require common attenuation");
        assert.deepEqual(inputA.channels, beforeA.channels, "preparePair mutated input A");
        assert.deepEqual(inputB.channels, beforeB.channels, "preparePair mutated input B");

        const channels: 1 | 2 = stereo ? 2 : 1;
        assertCanonicalWav(result.aWav, sampleRate, channels, source.length);
        assertCanonicalWav(result.bWav, sampleRate, channels, source.length);
        assert.deepEqual(result.aWav, result.bWav, "identical inputs must serialize identically");

        // Delivery self-check: the same shared meter remeasures final bytes.
        const deliveredA = finiteLevel(result.delivered.a.integratedLufs);
        const deliveredB = finiteLevel(result.delivered.b.integratedLufs);
        const targetError = Math.max(
          Math.abs(deliveredA - PREPARATION_TARGET_LUFS),
          Math.abs(deliveredB - PREPARATION_TARGET_LUFS),
        );
        maxDeliveredTargetErrorDb = Math.max(maxDeliveredTargetErrorDb, targetError);
        assert.ok(targetError < 0.005,
          `served -16 LUFS target error ${String(targetError)} dB exceeds the one-quantum bound`);

        assertServedMatchesReportedGains(result, "a", inputA);
        assertServedMatchesReportedGains(result, "b", inputB);

        if (ffmpeg) {
          const measured = ffmpegIntegratedLufs(ffmpeg, result.aWav);
          const error = Math.abs(measured - PREPARATION_TARGET_LUFS);
          maxExternalTargetErrorDb = Math.max(maxExternalTargetErrorDb, error);
          externalComparisons += 1;
          // Independently implemented K-weighting/filter design plus the
          // milliloudness text precision of the metadata; 0.1 dB is a bounded
          // corroboration tolerance, not a relaxation of any product target.
          assert.ok(error < 0.1,
            `FFmpeg ebur128 measured ${String(measured)} LUFS for ${String(sampleRate)} Hz ` +
              `${String(frequency)} Hz ${stereo ? "stereo" : "mono"}, outside 0.1 dB corroboration`);
        }
        compared += 1;
      }
    }
  }
  assert.equal(compared, scenarios);
  t.diagnostic(
    `steady tones: ${String(compared)} ${String(PREPARATION_POLICY_ID)} scenarios; ` +
      `max |served shared meter + 16| = ${maxDeliveredTargetErrorDb.toFixed(6)} dB; ` +
      (ffmpeg
        ? `${String(externalComparisons)} external ebur128 comparisons, ` +
          `max |FFmpeg + 16| = ${maxExternalTargetErrorDb.toFixed(3)} dB (0.1 dB corroboration bound)`
        : "external ebur128 comparisons omitted"),
  );
});

test("a known 20 dB amplitude ratio is preserved by raw loudness, report gains and served PCM16", (t) => {
  const ffmpeg = checkExternalAvailability(t);
  let maxRawExternalRatioErrorDb = 0;
  let maxReportRatioErrorDb = 0;
  let maxServedCodeDifference = 0;

  for (const sampleRate of SUPPORTED_SAMPLE_RATES) {
    for (const stereo of [false, true]) {
      const loudSource = tone(sampleRate, 1.2, 0.1, 1000);
      const quietSource = tone(sampleRate, 1.2, 0.01, 1000);
      const loud = pcm(sampleRate, stereo ? [loudSource, loudSource.slice()] : [loudSource]);
      const quiet = pcm(sampleRate, stereo ? [quietSource, quietSource.slice()] : [quietSource]);

      const rawDifference = finiteLufs(loud) - finiteLufs(quiet);
      assert.ok(Math.abs(rawDifference - 20) < 1e-9,
        "a 10x amplitude change on the same stationary waveform must be exactly 20 dB at the shared meter");

      const result = preparePair(cloneAudio(loud), cloneAudio(quiet));
      const reportDifference = result.report.loudness.gainBDb - result.report.loudness.gainADb;
      const reportError = Math.abs(reportDifference - 20);
      maxReportRatioErrorDb = Math.max(maxReportRatioErrorDb, reportError);
      assert.ok(reportError < 1e-9,
        "the independent gains must differ by the same 20 dB ratio");
      assert.equal(result.report.loudness.commonTrimDb, 0);

      // Both delivered sides contain the same mathematical waveform at the
      // target. PCM16 rounding may move a code by at most one integer step.
      const servedA = servedCodes(result.aWav);
      const servedB = servedCodes(result.bWav);
      assert.equal(servedA.length, servedB.length);
      for (let index = 0; index < servedA.length; index += 1) {
        const difference = Math.abs((servedA[index] ?? 0) - (servedB[index] ?? 0));
        maxServedCodeDifference = Math.max(maxServedCodeDifference, difference);
        assert.ok(difference <= 1,
          `served A/B codes differ by more than one quantization step at code ${String(index)}`);
      }
      assert.ok(Math.abs(
        finiteLevel(result.delivered.a.integratedLufs) -
          finiteLevel(result.delivered.b.integratedLufs),
      ) < 1e-9, "both sides must reach the same target loudness");

      if (ffmpeg) {
        const loudLufs = ffmpegIntegratedLufs(ffmpeg, encodePcm16Wav(loud.channels, sampleRate).bytes);
        const quietLufs = ffmpegIntegratedLufs(ffmpeg, encodePcm16Wav(quiet.channels, sampleRate).bytes);
        const externalDifference = loudLufs - quietLufs;
        const externalError = Math.abs(externalDifference - 20);
        maxRawExternalRatioErrorDb = Math.max(maxRawExternalRatioErrorDb, externalError);
        // The shared meter is exactly linear for this stationary pair. FFmpeg's
        // separate ebur128 implementation carries its own filter/accumulation
        // and 0.01 dB printed resolution, so the corroboration bound is 0.02 dB
        // (0.23% amplitude) rather than a forced bit-for-bit ratio.
        assert.ok(externalError < 0.02,
          `FFmpeg measured ${String(externalDifference)} dB for a 20 dB amplitude ratio`);
      }
    }
  }
  t.diagnostic(
    `level ratio: max report 20 dB error = ${maxReportRatioErrorDb.toExponential(3)} dB; ` +
      `max served A/B code difference = ${String(maxServedCodeDifference)}; ` +
      (ffmpeg
        ? `max external 20 dB ratio error = ${maxRawExternalRatioErrorDb.toFixed(4)} dB`
        : "external ratio comparison omitted"),
  );
});

test("400 ms minimum and 75%-overlap block boundaries follow documented meter arithmetic", (t) => {
  const ffmpeg = checkExternalAvailability(t);
  let ffmpegFullTone = Number.NaN;

  for (const sampleRate of SUPPORTED_SAMPLE_RATES) {
    const frames = Math.round(0.4 * sampleRate);
    const exact = tone(sampleRate, 0.4, 0.1, 1000);
    assert.equal(exact.length, frames);
    const exactLevel = finiteLufs(pcm(sampleRate, [exact]));

    const short = tone(sampleRate, 0.399, 0.1, 1000);
    const shortLevel = integratedLoudness(pcm(sampleRate, [short]));
    assert.equal(shortLevel.status, "unavailable",
      "audio shorter than one 400 ms block must be unavailable");
    assert.match(shortLevel.reason, /400 ms/);
    assert.throws(
      () => preparePair(pcm(sampleRate, [short]), pcm(sampleRate, [short.slice()])),
      (error: unknown) =>
        error instanceof PreparationPolicyError && error.code === "short-crop",
      "the 0.4 s policy minimum must reject a shorter aligned output",
    );

    const prepared = preparePair(pcm(sampleRate, [exact]), pcm(sampleRate, [exact.slice()]));
    assert.equal(prepared.report.alignment.outputFrames, frames);
    assert.ok(Math.abs(finiteLevel(prepared.delivered.a.integratedLufs) - PREPARATION_TARGET_LUFS) < 0.005);
    assert.ok(Math.abs(exactLevel) > 0);

    const at045 = finiteLufs(pcm(sampleRate, [tone(sampleRate, 0.45, 0.1, 1000)]));
    // 0.45 s is the round-half-to-even block-count tie: one full block only,
    // so the extra 50 ms beyond the first 400 ms block is not measured.
    assert.ok(Math.abs(at045 - exactLevel) < 1e-9,
      "the 0.45 s tie-to-even case must still count one full block");

    const at046 = finiteLufs(pcm(sampleRate, [tone(sampleRate, 0.46, 0.1, 1000)]));
    const expectedBoundaryOffset = analyticalGatingOffsetDb([1, 0.9]);
    const actualBoundaryOffset = at046 - exactLevel;
    assert.ok(Math.abs(actualBoundaryOffset - expectedBoundaryOffset) < 0.01,
      `0.46 s partial-block offset ${String(actualBoundaryOffset)} dB does not match ` +
        `the analytical ${String(expectedBoundaryOffset)} dB`);
  }

  const rate = 48_000;
  const fullToneLevel = finiteLufs(pcm(rate, [tone(rate, 0.4, 0.1, 1000)]));
  if (ffmpeg) {
    ffmpegFullTone = ffmpegIntegratedLufs(
      ffmpeg,
      encodePcm16Wav([tone(rate, 0.4, 0.1, 1000)], rate).bytes,
    );
    const ffmpegAt046 = ffmpegIntegratedLufs(
      ffmpeg,
      encodePcm16Wav([tone(rate, 0.46, 0.1, 1000)], rate).bytes,
    );
    // Known meter interpretation difference: FFmpeg's integrated summary keeps
    // this steady 0.46 s fixture at the full-tone value, while the product
    // meter (documented above) scales the truncated final block. Record and
    // bound each implementation's own property; do not force TS == FFmpeg.
    assert.ok(Math.abs(ffmpegAt046 - ffmpegFullTone) < 0.05,
      "FFmpeg's partial-block interpretation should remain at the steady full-block value");
    t.diagnostic(
      `block boundary at 48 kHz: shared meter 0.46 s offset = ` +
        `${(finiteLufs(pcm(rate, [tone(rate, 0.46, 0.1, 1000)])) - fullToneLevel).toFixed(4)} dB ` +
        `(analytical ${analyticalGatingOffsetDb([1, 0.9]).toFixed(4)} dB); FFmpeg 0.46 s - 0.4 s = ` +
        `${(ffmpegAt046 - ffmpegFullTone).toFixed(4)} dB (known partial-block interpretation difference)`,
    );
  }

  // Relative gate: a 20 dB-lower second region is mostly excluded, while a
  // 5 dB-lower region remains in the gate. Expected offsets come from the
  // analytical block-energy model above, normalized to the full-tone block.
  for (const [label, quietRatio] of [["-20 dB", 0.01], ["-5 dB", 10 ** -0.5]] as const) {
    const loud = tone(rate, 0.8, 0.1, 1000);
    const quiet = tone(rate, 0.8, 0.1 * Math.sqrt(quietRatio), 1000);
    const combined = concatChannels(loud, quiet);
    const energies = twoRegionBlockEnergies(rate, 0.8, 0.8, quietRatio);
    const expectedOffset = analyticalGatingOffsetDb(energies);
    const actualOffset = finiteLufs(pcm(rate, [combined])) - fullToneLevel;
    assert.ok(Math.abs(actualOffset - expectedOffset) < 0.02,
      `${label} gating offset ${String(actualOffset)} dB does not match analytical ` +
        `${String(expectedOffset)} dB`);

    if (ffmpeg) {
      const external = ffmpegIntegratedLufs(
        ffmpeg,
        encodePcm16Wav([combined], rate).bytes,
      );
      const externalOffset = external - ffmpegFullTone;
      assert.ok(Math.abs(externalOffset - expectedOffset) < 0.1,
        `FFmpeg ${label} gating offset ${String(externalOffset)} dB is outside 0.1 dB of ` +
          `the analytical block/gate model`);
      t.diagnostic(
        `relative gate ${label}: shared ${actualOffset.toFixed(4)} dB, ` +
          `analytical ${expectedOffset.toFixed(4)} dB, FFmpeg ${externalOffset.toFixed(4)} dB`,
      );
    }
  }

  // Absolute gate: every block below -70 LUFS must produce the documented
  // negative-infinity status and a loudness-unavailable preparation failure.
  const below = tone(rate, 1.2, 1e-5, 1000);
  const belowLevel = integratedLoudness(pcm(rate, [below]));
  assert.equal(belowLevel.status, "negative-infinity");
  assert.match(belowLevel.reason, /absolute and relative gates|below-gate/);
  assert.throws(
    () => preparePair(pcm(rate, [below]), pcm(rate, [below.slice()])),
    (error: unknown) =>
      error instanceof PreparationPolicyError && error.code === "loudness-unavailable",
    "material below the absolute gate must not receive a finite preparation gain",
  );
});

test("anti-phase channels and isolated channels follow analytical stereo energy sums without downmix", (t) => {
  const ffmpeg = checkExternalAvailability(t);
  const ffmpegRate = 48_000;
  let externalMono = Number.NaN;
  let externalSame = Number.NaN;
  let externalAnti = Number.NaN;
  let externalLeftOnly = Number.NaN;

  for (const sampleRate of SUPPORTED_SAMPLE_RATES) {
    const source = tone(sampleRate, 1.2, 0.1, 1000);
    const zero = new Float64Array(source.length);
    const negative = source.map((sample) => -sample);
    const mono = finiteLufs(pcm(sampleRate, [source]));
    const same = finiteLufs(pcm(sampleRate, [source, source.slice()]));
    const anti = finiteLufs(pcm(sampleRate, [source, negative]));
    const leftOnly = finiteLufs(pcm(sampleRate, [source, zero]));
    const stereoGainDb = 10 * Math.log10(2);

    // K-weighted loudness is a per-channel energy sum: identical channels add
    // 3.0103 dB, anti-phase channels add the same energy (no correlation term),
    // and a stereo source with one silent channel carries exactly the same
    // one-channel energy as the mono source.
    assert.ok(Math.abs((same - mono) - stereoGainDb) < 1e-9,
      "two identical channels must add exactly 10log10(2) dB");
    assert.ok(Math.abs(anti - same) < 1e-9,
      "a channel polarity inversion must not change the energy-sum loudness");
    assert.ok(Math.abs(mono - leftOnly) < 1e-9,
      "a single active channel must carry the same energy in mono or stereo layout");

    // Preparation must preserve anti-phase stereo and channel isolation.
    const antiInput = pcm(sampleRate, [source.slice(), negative.slice()]);
    const antiBefore = cloneAudio(antiInput);
    const preparedAnti = preparePair(antiInput, cloneAudio(antiInput));
    assert.deepEqual(antiInput.channels, antiBefore.channels, "preparePair mutated anti-phase input");
    assert.equal(preparedAnti.report.alignment.lagSamples, 0);
    assert.equal(preparedAnti.report.alignment.outputFrames, source.length);
    const antiCodes = servedCodes(preparedAnti.aWav);
    for (let frame = 0; frame < source.length; frame += 1) {
      const left = antiCodes[frame * 2] ?? 0;
      const right = antiCodes[frame * 2 + 1] ?? 0;
      assert.ok(Math.abs(left + right) <= 1,
        `anti-phase channels were not preserved at frame ${String(frame)} (${String(left)} + ${String(right)})`);
    }
    assert.ok(
      Math.abs(finiteLevel(preparedAnti.delivered.a.integratedLufs) - PREPARATION_TARGET_LUFS) < 0.005,
    );

    const isolatedInput = pcm(sampleRate, [source.slice(), new Float64Array(source.length)]);
    const preparedIsolated = preparePair(isolatedInput, cloneAudio(isolatedInput));
    const isolatedCodes = servedCodes(preparedIsolated.aWav);
    for (let channel = 1; channel < isolatedCodes.length; channel += 2) {
      assert.equal(isolatedCodes[channel], 0, "a silent channel must remain exactly silent");
    }

    if (sampleRate === ffmpegRate && ffmpeg) {
      externalMono = ffmpegIntegratedLufs(
        ffmpeg,
        encodePcm16Wav([source], sampleRate).bytes,
      );
      externalSame = ffmpegIntegratedLufs(
        ffmpeg,
        encodePcm16Wav([source, source.slice()], sampleRate).bytes,
      );
      externalAnti = ffmpegIntegratedLufs(
        ffmpeg,
        encodePcm16Wav([source, negative], sampleRate).bytes,
      );
      externalLeftOnly = ffmpegIntegratedLufs(
        ffmpeg,
        encodePcm16Wav([source, new Float64Array(source.length)], sampleRate).bytes,
      );
      assert.ok(Math.abs(externalAnti - externalSame) < 0.05,
        "FFmpeg ebur128 must not cancel anti-phase channels in integrated loudness");
      assert.ok(Math.abs((externalSame - externalMono) - stereoGainDb) < 0.1,
        "FFmpeg stereo energy sum should be 10log10(2) dB above mono for this fixture");
      assert.ok(Math.abs(externalMono - externalLeftOnly) < 0.05,
        "FFmpeg must measure one active stereo channel at the same level as mono");
    }
  }
  if (ffmpeg) {
    t.diagnostic(
      "48 kHz external channel checks: mono=" + externalMono.toFixed(3) +
        ", stereo-same=" + externalSame.toFixed(3) +
        ", stereo-anti=" + externalAnti.toFixed(3) +
        ", left-only=" + externalLeftOnly.toFixed(3) + " LUFS",
    );
  }
});

test("common peak attenuation preserves relative gain and exact quantization boundaries", (t) => {
  const ffmpeg = checkExternalAvailability(t);
  let maxTrimMathErrorDb = 0;
  let maxExternalSideDifferenceDb = 0;
  let maxExternalTargetErrorDb = 0;

  for (const sampleRate of SUPPORTED_SAMPLE_RATES) {
    for (const stereo of [false, true]) {
      const loudSource = impulse(sampleRate, 1.2, 0.5);
      const quietSource = impulse(sampleRate, 1.2, 0.05);
      const loud = pcm(sampleRate, stereo ? [loudSource.slice(), loudSource.slice()] : [loudSource]);
      const quiet = pcm(sampleRate, stereo ? [quietSource.slice(), quietSource.slice()] : [quietSource]);
      const beforeLoud = cloneAudio(loud);
      const beforeQuiet = cloneAudio(quiet);
      const result = preparePair(loud, quiet);

      assert.deepEqual(loud.channels, beforeLoud.channels, "preparePair mutated the high-crest input");
      assert.deepEqual(quiet.channels, beforeQuiet.channels, "preparePair mutated the low-crest input");
      assert.ok(result.report.loudness.commonTrimDb > 0,
        "the sparse-impulse peak must force common attenuation");
      assert.ok(Math.abs(
        (result.report.loudness.gainBDb - result.report.loudness.gainADb) - 20,
      ) < 1e-9, "the 10x impulse ratio must remain a 20 dB independent-gain difference");

      // Analytical common-trim property: the trim is exactly the amount by
      // which the largest gained pre-trim sample exceeds 32767/32768.
      const peakOf = (audio: PcmAudio): number => {
        let peak = 0;
        for (const channel of audio.channels) {
          for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
        }
        return peak;
      };
      const inputPeakA = peakOf(loud);
      const inputPeakB = peakOf(quiet);
      assert.ok(inputPeakA > 0 && inputPeakB > 0);
      const gainedPeakA = inputPeakA * 10 ** (result.report.loudness.gainADb / 20);
      const gainedPeakB = inputPeakB * 10 ** (result.report.loudness.gainBDb / 20);
      const gainedPeak = Math.max(gainedPeakA, gainedPeakB);
      const expectedTrimDb = gainedPeak > PREPARATION_PEAK_CEILING
        ? 20 * Math.log10(gainedPeak / PREPARATION_PEAK_CEILING)
        : 0;
      const trimError = Math.abs(result.report.loudness.commonTrimDb - expectedTrimDb);
      maxTrimMathErrorDb = Math.max(maxTrimMathErrorDb, trimError);
      assert.ok(trimError < 1e-9,
        `reported common trim ${String(result.report.loudness.commonTrimDb)} dB does not match ` +
          `the analytical peak excess ${String(expectedTrimDb)} dB`);

      assertServedMatchesReportedGains(result, "a", loud);
      assertServedMatchesReportedGains(result, "b", quiet);

      const deliveredA = finiteLevel(result.delivered.a.integratedLufs);
      const deliveredB = finiteLevel(result.delivered.b.integratedLufs);
      assert.ok(Math.abs(deliveredA - deliveredB) < 1e-9,
        "one common trim must preserve the sides' relative gain");
      assert.ok(Math.abs(
        deliveredA - (PREPARATION_TARGET_LUFS - result.report.loudness.commonTrimDb),
      ) < 0.01, "served side loudness must be the target minus the common trim");

      const servedPeak = (bytes: Uint8Array): number => {
        let peak = 0;
        for (const code of servedCodes(bytes)) peak = Math.max(peak, Math.abs(code));
        return peak / 32768;
      };
      const peakA = servedPeak(result.aWav);
      const peakB = servedPeak(result.bWav);
      for (const peak of [peakA, peakB]) {
        assert.ok(peak <= PREPARATION_PEAK_CEILING + 1e-15,
          "served sample peak must not exceed the published ceiling");
        assert.ok(peak >= PREPARATION_PEAK_CEILING - 2 / 32768,
          "the trimmed impulse peak must reach the published ceiling within two codes");
      }

      const codesA = servedCodes(result.aWav);
      const codesB = servedCodes(result.bWav);
      for (let index = 0; index < codesA.length; index += 1) {
        assert.ok(Math.abs((codesA[index] ?? 0) - (codesB[index] ?? 0)) <= 1,
          `common trim must preserve the 10x ratio to within one code at ${String(index)}`);
      }

      if (ffmpeg) {
        const externalA = ffmpegIntegratedLufs(ffmpeg, result.aWav);
        const externalB = ffmpegIntegratedLufs(ffmpeg, result.bWav);
        const sideDifference = Math.abs(externalA - externalB);
        const targetError = Math.abs(
          externalA - (PREPARATION_TARGET_LUFS - result.report.loudness.commonTrimDb),
        );
        maxExternalSideDifferenceDb = Math.max(maxExternalSideDifferenceDb, sideDifference);
        maxExternalTargetErrorDb = Math.max(maxExternalTargetErrorDb, targetError);
        assert.ok(sideDifference < 0.05,
          "FFmpeg must measure the two sides of one common trim as equally loud");
        assert.ok(targetError < 0.1,
          "FFmpeg ebur128 must corroborate the target-minus-common-trim level within 0.1 dB");
      }
    }
  }

  // Signed PCM16 boundaries with analytically expected code values.
  const bias = PCM16_FLOOR_BIAS;
  const cases: readonly (readonly [number, number, string])[] = [
    [0, 0, "zero"],
    [(1 - bias / 2) / 32768, 1, "just below +1 step, recovered by the positive pre-floor bias"],
    [(1 - 2 * bias) / 32768, 0, "outside the bias recovery at +1 step"],
    [(0.5 - bias) / 32768, 0, "half step minus bias lands on zero after bias"],
    [(0.5 + bias) / 32768, 0, "half step plus one bias unit is still below one step"],
    [1.5 / 32768, 1, "positive half step floors down"],
    [(-1 + bias / 2) / 32768, -1, "just above -1 step remains -1"],
    [(-1 - bias / 2) / 32768, -1, "just below -1 step recovered to -1 by bias"],
    [(-1 - 2 * bias) / 32768, -2, "outside bias recovery below -1 step"],
    [(-0.5 - bias / 2) / 32768, -1, "negative half step floors to -1"],
    [(-0.25 * bias) / 32768, 0, "negative fraction inside the bias floors to zero"],
    [(-1.5) / 32768, -2, "negative half step floors away from zero"],
    [(-1.5 - bias / 2) / 32768, -2, "just below -1.5 still floors to -2"],
    [-bias / (2 * 32768), 0, "tiny negative value inside the bias floors to zero"],
    [(-1.5 * bias) / 32768, -1, "negative value outside the bias floors to -1"],
    [32767 / 32768, 32767, "maximum signed code"],
    [32767.5 / 32768, 32767, "above maximum positive floors then clamps"],
    [1, 32767, "out-of-range positive clamps"],
    [1.2, 32767, "larger positive clamps"],
    [-32768 / 32768, -32768, "minimum signed code"],
    [-32768.5 / 32768, -32768, "below minimum floors then clamps"],
    [-1, -32768, "out-of-range negative clamps"],
    [-1.2, -32768, "larger negative clamps"],
  ];
  for (const [value, expected, label] of cases) {
    assert.equal(quantizePcm16Sample(value), expected, label);
  }
  assert.throws(() => quantizePcm16Sample(Number.NaN), /non-finite/);
  assert.throws(() => quantizePcm16Sample(Number.POSITIVE_INFINITY), /non-finite/);

  const values = new Float64Array(cases.map(([value]) => value));
  const encoded = encodePcm16Wav([values], 44_100);
  assertCanonicalWav(encoded.bytes, 44_100, 1, cases.length);
  const view = new DataView(encoded.bytes.buffer, encoded.bytes.byteOffset, encoded.bytes.byteLength);
  for (let index = 0; index < cases.length; index += 1) {
    const [, expected, label] = cases[index]!;
    assert.equal(view.getInt16(PCM16_WAV_HEADER_BYTES + index * 2, true), expected,
      `serialized code for ${label}`);
  }

  t.diagnostic(
    `common trim: max analytical trim error = ${maxTrimMathErrorDb.toExponential(3)} dB; ` +
      (ffmpeg
        ? `max external A/B difference = ${maxExternalSideDifferenceDb.toFixed(4)} dB; ` +
          `max external target-minus-trim error = ${maxExternalTargetErrorDb.toFixed(4)} dB`
        : "external common-trim comparison omitted") +
      `; signed PCM16 analytical cases = ${String(cases.length)}`,
  );
});
