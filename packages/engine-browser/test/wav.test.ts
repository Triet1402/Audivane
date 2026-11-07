import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_MAX_DURATION_SECONDS,
  buildPcm16Wav,
  parsePcm16Wav,
  sha256Hex,
  validateSourceWav,
} from "../src/wav.js";
import { assertCanonicalFacts, assertSourceByteLength } from "../src/source-import.js";

interface WavOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly frames?: number;
  readonly antiPhase?: boolean;
  readonly extensible?: boolean;
}

function makeWav(options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 48000;
  const channels = options.channels ?? 1;
  const frames = options.frames ?? 480;
  const dataSize = frames * channels * 2;
  const headerSize = options.extensible ? 68 : 44;
  const bytes = Buffer.alloc(headerSize + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(headerSize - 8 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(options.extensible ? 40 : 16, 16);
  bytes.writeUInt16LE(options.extensible ? 0xfffe : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  if (options.extensible) {
    bytes.writeUInt16LE(22, 36);
    bytes.writeUInt16LE(16, 38);
    bytes.writeUInt32LE(channels === 1 ? 4 : 3, 40);
    bytes.set([1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 44);
  }
  const dataIdOffset = options.extensible ? 60 : 36;
  bytes.write("data", dataIdOffset, "ascii");
  bytes.writeUInt32LE(dataSize, dataIdOffset + 4);
  const dataOffset = dataIdOffset + 8;
  // Fill only a short prefix; the remaining declared frames are silence. Large
  // envelope fixtures must not spend seconds synthesizing unused samples.
  for (let frame = 0; frame < Math.min(frames, 4800); frame += 1) {
    const left = Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
    const right = options.antiPhase
      ? -left
      : Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * 660 * frame) / sampleRate));
    for (let channel = 0; channel < channels; channel += 1) {
      bytes.writeInt16LE(channel === 1 ? right : left, dataOffset + (frame * channels + channel) * 2);
    }
  }
  return new Uint8Array(bytes);
}

test("parses canonical and WAVE_FORMAT_EXTENSIBLE PCM16 mono/stereo", () => {
  const mono = makeWav({ sampleRate: 44100, channels: 1, frames: 441 });
  const monoFacts = parsePcm16Wav(mono);
  assert.equal(monoFacts.sampleRate, 44100);
  assert.equal(monoFacts.channels, 1);
  assert.equal(monoFacts.frames, 441);
  assert.equal(monoFacts.bitsPerSample, 16);
  assert.equal(monoFacts.durationSeconds, 0.01);

  const stereo = makeWav({ sampleRate: 48000, channels: 2, frames: 480 });
  const stereoFacts = parsePcm16Wav(stereo);
  assert.equal(stereoFacts.channels, 2);
  assert.equal(stereoFacts.frames, 480);

  const extensible = makeWav({ sampleRate: 96000, channels: 2, frames: 96, extensible: true });
  const extensibleFacts = parsePcm16Wav(extensible);
  assert.equal(extensibleFacts.sampleRate, 96000);
  assert.equal(extensibleFacts.channels, 2);
  assert.equal(extensibleFacts.frames, 96);
});

test("source validation enforces the shared 1800 s local-audio envelope", () => {
  assert.equal(validateSourceWav(makeWav({ sampleRate: 44100 })).sampleRate, 44100);
  assert.equal(validateSourceWav(makeWav({ sampleRate: 48000 })).sampleRate, 48000);
  assert.equal(validateSourceWav(makeWav({ sampleRate: 96000 })).sampleRate, 96000);

  assert.throws(
    () => validateSourceWav(makeWav({ sampleRate: 32000 })),
    /unsupported in native mode; use 44100, 48000 or 96000/,
  );
  // Exercise the shared duration guard numerically. Allocating a 1801 s WAV
  // would add no evidence over the exact frame/duration boundary below.
  const frames = 44100 * (BROWSER_MAX_DURATION_SECONDS + 1);
  assert.throws(
    () => assertCanonicalFacts({
      sampleRate: 44100,
      channels: 1,
      frames,
      bitsPerSample: 16,
      dataOffset: 44,
      dataSize: frames * 2,
      durationSeconds: frames / 44100,
    }, "native"),
    /refused rather than silently cropped/,
  );

  // The encoded-input boundary is exercised numerically; allocating 512 MiB
  // would add no evidence and would slow the unit suite.
  assert.doesNotThrow(() => assertSourceByteLength(512 * 1024 * 1024));
  assert.throws(
    () => assertSourceByteLength(512 * 1024 * 1024 + 1),
    /encoded\/container limit/,
  );
});

test("rejects truncated, malformed, non-PCM and inconsistent WAV files", () => {
  const valid = makeWav({ sampleRate: 48000, channels: 2, frames: 96 });
  assert.throws(() => parsePcm16Wav(valid.slice(0, 20)), /shorter than/);
  assert.throws(() => parsePcm16Wav(valid.slice(0, valid.length - 10)), /exceeds the available bytes/);

  const notRiff = Uint8Array.from(valid);
  notRiff.set([0x4e, 0x4f], 0);
  assert.throws(() => parsePcm16Wav(notRiff), /not a RIFF\/WAVE/);

  const eightBit = Uint8Array.from(valid);
  new DataView(eightBit.buffer).setUint16(34, 8, true);
  assert.throws(() => parsePcm16Wav(eightBit), /16-bit PCM only/);

  const threeChannels = Uint8Array.from(valid);
  new DataView(threeChannels.buffer).setUint16(22, 3, true);
  assert.throws(() => parsePcm16Wav(threeChannels), /unsupported channel count/);

  const badBlockAlign = Uint8Array.from(valid);
  new DataView(badBlockAlign.buffer).setUint16(32, 2, true);
  assert.throws(() => parsePcm16Wav(badBlockAlign), /inconsistent/);

  const noData = valid.slice(0, 44);
  new DataView(noData.buffer).setUint32(4, 36, true);
  noData.set(new TextEncoder().encode("LIST"), 36);
  new DataView(noData.buffer).setUint32(40, 0, true);
  assert.throws(() => parsePcm16Wav(noData), /data chunk/);

  const trailing = new Uint8Array(valid.length + 3);
  trailing.set(valid);
  assert.throws(() => parsePcm16Wav(trailing), /trailing bytes/);
});

test("SHA-256 covers the exact bytes supplied", async () => {
  const bytes = makeWav({ sampleRate: 44100, channels: 1, frames: 441 });
  assert.match(await sha256Hex(bytes), /^[0-9a-f]{64}$/);
  const changed = Uint8Array.from(bytes);
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0xff;
  assert.notEqual(await sha256Hex(bytes), await sha256Hex(changed));
});

test("rejects ambiguous RIFF boundaries, duplicate format and malformed extensible PCM", () => {
  const undersized = makeWav();
  new DataView(undersized.buffer).setUint32(4, 36, true);
  assert.throws(() => parsePcm16Wav(undersized), /RIFF size/);

  const original = makeWav();
  const duplicateFormat = new Uint8Array(original.length + 24);
  duplicateFormat.set(original.subarray(0, 36));
  duplicateFormat.set(original.subarray(12, 36), 36);
  duplicateFormat.set(original.subarray(36), 60);
  new DataView(duplicateFormat.buffer).setUint32(4, duplicateFormat.length - 8, true);
  assert.throws(() => parsePcm16Wav(duplicateFormat), /exactly one fmt/);

  const badGuid = makeWav({ extensible: true });
  badGuid[48] = 1;
  assert.throws(() => parsePcm16Wav(badGuid), /subformat/);

  const badValidBits = makeWav({ extensible: true });
  new DataView(badValidBits.buffer).setUint16(38, 12, true);
  assert.throws(() => parsePcm16Wav(badValidBits), /valid bits/);

  const badLayout = makeWav({ extensible: true, channels: 2 });
  new DataView(badLayout.buffer).setUint32(40, 0x0c, true);
  assert.throws(() => parsePcm16Wav(badLayout), /channel mask/);
});

test("buildPcm16Wav emits a canonical file that parses back to identical PCM", () => {
  const pcm = new Int16Array([0, 1000, -1000, 2, -2, 7]);
  for (const [rate, channels] of [[44100, 1], [48000, 2]] as const) {
    const bytes = buildPcm16Wav(pcm, rate, channels);
    assert.equal(bytes.byteLength, 44 + pcm.byteLength);
    const facts = parsePcm16Wav(bytes);
    assert.equal(facts.sampleRate, rate);
    assert.equal(facts.channels, channels);
    assert.equal(facts.bitsPerSample, 16);
    assert.equal(facts.frames, pcm.length / channels);
    assert.equal(facts.dataSize, facts.frames * channels * 2);
  }
  assert.throws(() => buildPcm16Wav(new Int16Array(3), 48000, 2),
    /whole number of sample frames/);
  assert.throws(() => buildPcm16Wav(new Int16Array(2), 0, 1), /invalid sample rate/);
});
