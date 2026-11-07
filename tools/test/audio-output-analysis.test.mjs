import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertAntiPhase,
  assertChannelIsolation,
  assertSilence,
  assertTone,
  decodePcm16,
  encodeWav,
  findActiveSegments,
  readWav,
  rms,
  toneAmplitude,
} from '../virtual-audio/analysis.mjs';

const RATE = 48_000;

function stereo(seconds, sample) {
  const frames = Math.round(RATE * seconds);
  const samples = new Int16Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / RATE;
    for (let channel = 0; channel < 2; channel += 1) {
      samples[frame * 2 + channel] = Math.round(Math.max(-1, Math.min(1, sample(time, channel))) * 32767);
    }
  }
  return { sampleRate: RATE, channels: 2, frames, samples };
}

const sine = (frequency, amplitude) => (time) => amplitude * Math.sin(2 * Math.PI * frequency * time);

test('PCM analysis detects the expected tone but not a wrong frequency or channel', () => {
  const capture = stereo(0.5, (time, channel) => channel === 0 ? sine(440, 0.4)(time) : 0);
  assert.ok(toneAmplitude(capture, 0, 0.1, 0.4, 440) > 0.35);
  assert.ok(toneAmplitude(capture, 0, 0.1, 0.4, 880) < 0.02);
  assertChannelIsolation(capture, 0.1, 0.4, { activeChannel: 0, otherChannel: 1, frequency: 440 });
});

test('channel-isolation negative control fails when the other channel carries the tone', () => {
  const capture = stereo(0.5, sine(440, 0.4));
  assert.throws(() => assertChannelIsolation(capture, 0.1, 0.4, {
    activeChannel: 0, otherChannel: 1, frequency: 660,
  }), /missing|leaked/);
});

test('anti-phase is preserved and in-phase is rejected', () => {
  const anti = stereo(0.5, (time, channel) => sine(880, 0.4)(time) * (channel === 0 ? 1 : -1));
  const antiResult = assertAntiPhase(anti, 0.1, 0.4);
  assert.ok(antiResult.correlation < -0.99);
  const inPhase = stereo(0.5, sine(880, 0.4));
  assert.throws(() => assertAntiPhase(inPhase, 0.1, 0.4), /lost polarity/);
});

test('silence is measured as silence and an audible window fails the negative control', () => {
  const silent = stereo(0.3, () => 0);
  assert.equal(assertSilence(silent, 0.05, 0.25), 0);
  const audible = stereo(0.3, sine(440, 0.4));
  assert.throws(() => assertSilence(audible, 0.05, 0.25), /was not silent/);
  assert.throws(() => assertTone(silent, 0, 0.05, 0.25, 440), /missing/);
});

test('active-segment detection preserves action order and silence gaps', () => {
  const capture = stereo(1.2, (time) => {
    if (time >= 0.1 && time < 0.3) return sine(440, 0.4)(time);
    if (time >= 0.6 && time < 0.9) return sine(1000, 0.4)(time);
    return 0;
  });
  const segments = findActiveSegments(capture);
  assert.equal(segments.length, 2);
  assert.ok(Math.abs(segments[0].startSeconds - 0.1) < 0.02);
  assert.ok(Math.abs(segments[1].startSeconds - 0.6) < 0.02);
  assert.ok(segments[1].startSeconds > segments[0].endSeconds);
});

test('WAV writer and independent reader round-trip PCM16 stereo', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'audio-output-analysis-'));
  try {
    const capture = stereo(0.2, (time, channel) => sine(channel === 0 ? 440 : 660, 0.3)(time));
    const file = path.join(directory, 'capture.wav');
    await writeFile(file, encodeWav(capture.samples, capture.sampleRate, capture.channels));
    const read = readWav(file);
    assert.equal(read.sampleRate, RATE);
    assert.equal(read.channels, 2);
    assert.equal(read.frames, capture.frames);
    assert.ok(rms(read, 0, 0.05, 0.15) > 0.15);
    assert.ok(toneAmplitude(read, 1, 0.05, 0.15, 660) > 0.2);
    const decoded = decodePcm16(Buffer.from(capture.samples.buffer), RATE, 2);
    assert.equal(decoded.frames, capture.frames);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('empty or unrecorded windows cannot count as proof of silence', () => {
  const capture = stereo(0.3, () => 0);
  for (const [start, end] of [[0.5, 1], [0.1, 0.1], [0.1, 0.5], [NaN, 0.2], [0, Infinity]]) {
    assert.throws(() => assertSilence(capture, start, end), /window|recorded/);
  }
});

test('routing windows reject early, late and simultaneous leakage using control events', async () => {
  const { assertSoftwareSinkRouting, peakMeasurement } = await import('../virtual-audio/analysis.mjs');
  const timing = { playAtMs: 500, moveRequestedAtMs: 3000, moveConfirmedAtMs: 3100,
    pauseAtMs: 5000, firstDataAtMsA: 0, firstDataAtMsB: 0 };
  const tone = (start, end) => stereo(6, time => time >= start && time < end ? sine(440, 0.4)(time) : 0);
  const correctA = tone(.5, 3), correctB = tone(3.1, 5);
  const result = assertSoftwareSinkRouting(correctA, correctB, timing);
  assert.deepEqual(result.wrongSinkBLeading, { peakAmplitude: 0, status: 'negative-infinity', dbfs: null });
  assert.equal(result.wrongSinkATrailing.peakAmplitude, 0);
  for (const [a, b] of [[correctA, tone(.5, 5)], [tone(.5, 4), correctB], [tone(2, 4), tone(.5, 5)]]) {
    assert.throws(() => assertSoftwareSinkRouting(a, b, timing), /not silent|before|after|missing/);
  }
  assert.equal(peakMeasurement(.001).dbfs, -60);
  assert.throws(() => assertSoftwareSinkRouting(correctA, correctB, { ...timing, pauseAtMs: 3200 }), /window/);
});

test('control silence rejects audio continuing after the recorded stop instead of moving past it', async () => {
  const { assertControlSilence } = await import('../virtual-audio/analysis.mjs');
  const timing = { firstDataAtMs: 0, afterAtMs: 3000 };
  const correct = stereo(6.5, time => time < 3 ? sine(440, 0.4)(time) : 0);
  assert.equal(assertControlSilence(correct, timing).measurement.peakAmplitude, 0);
  const late = stereo(6.5, time => time < 4.5 ? sine(440, 0.4)(time) : 0);
  assert.throws(() => assertControlSilence(late, timing), /not silent/);
  assert.throws(() => assertControlSilence(correct, { ...timing, afterAtMs: 8000 }), /window/);
});
