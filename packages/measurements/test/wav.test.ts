import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_PCM16_HEADER_BYTES,
  CanonicalPcm16WavStructureError,
  parseCanonicalPcm16WavStructure,
} from "../src/index.js";

interface WavOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly seconds?: number;
}

/** Independent canonical envelope builder; deliberately not the shared writer. */
function makeWav(options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 0.4;
  const frames = Math.round(sampleRate * seconds);
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const bytes = new Uint8Array(CANONICAL_PCM16_HEADER_BYTES + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(44 + frame * blockAlign, (frame * 97) % 20_000, true);
    if (channels === 2) view.setInt16(44 + frame * blockAlign + 2, -(frame * 89) % 20_000, true);
  }
  return bytes;
}

function mutate(bytes: Uint8Array, offset: number, values: readonly number[]): Uint8Array {
  const copy = bytes.slice();
  values.forEach((value, index) => {
    copy[offset + index] = value;
  });
  return copy;
}

function trailing(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength + 1);
  copy.set(bytes);
  return copy;
}

function problemOf(bytes: unknown): CanonicalPcm16WavStructureError["problem"] {
  try {
    parseCanonicalPcm16WavStructure(bytes);
  } catch (error) {
    assert.ok(error instanceof CanonicalPcm16WavStructureError);
    return error.problem;
  }
  assert.fail("expected a canonical WAV structure error");
}

test("shared parser reports canonical PCM16 facts at each supported layout", () => {
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    for (const channels of [1, 2] as const) {
      const facts = parseCanonicalPcm16WavStructure(
        makeWav({ sampleRate, channels, seconds: 0.4 }),
      );
      assert.equal(facts.sampleRate, sampleRate);
      assert.equal(facts.channels, channels);
      assert.equal(facts.frames, Math.round(sampleRate * 0.4));
      assert.equal(facts.dataOffset, 44);
      assert.equal(facts.dataSize, facts.frames * channels * 2);
      assert.ok(Math.abs(facts.durationSeconds - 0.4) < 1e-12);
    }
  }
});

test("shared parser honours a caller view's byte offset and never mutates bytes", () => {
  const wav = makeWav({ channels: 2, seconds: 0.5 });
  const padded = new Uint8Array(wav.byteLength + 37);
  padded.set(wav, 23);
  const view = padded.subarray(23, 23 + wav.byteLength);
  const before = view.slice();
  const facts = parseCanonicalPcm16WavStructure(view);
  assert.equal(facts.frames, Math.round(48_000 * 0.5));
  assert.deepEqual(view, before);
});

test("shared parser leaves resource and duration policy to callers", () => {
  assert.doesNotThrow(() => parseCanonicalPcm16WavStructure(makeWav({ seconds: 0.1 })));
  assert.doesNotThrow(() =>
    parseCanonicalPcm16WavStructure(makeWav({ channels: 2, sampleRate: 96_000, seconds: 11 })),
  );
});

test("shared parser names each excluded layout and corrupt envelope", () => {
  const canonical = makeWav({ seconds: 0.4 });
  const cases: Array<[string, Uint8Array | unknown, CanonicalPcm16WavStructureError["problem"]["code"]]> = [
    ["not bytes", "RIFF", "not-bytes"],
    ["too short", new Uint8Array(10), "too-short"],
    ["not RIFF", mutate(canonical, 0, [0x4e]), "not-riff-wave"],
    ["not WAVE", mutate(canonical, 8, [0x4e]), "not-riff-wave"],
    ["not fmt", mutate(canonical, 12, [0x6e]), "layout"],
    ["not data", mutate(canonical, 36, [0x6e]), "layout"],
    ["wrong riff size", mutate(canonical, 4, [0, 0]), "riff-size"],
    ["wrong fmt size", mutate(canonical, 16, [15, 0, 0, 0]), "fmt-size"],
    ["float PCM", mutate(canonical, 20, [3, 0]), "not-pcm"],
    ["three channels", mutate(canonical, 22, [3, 0]), "channels"],
    ["22050 Hz", mutate(canonical, 24, [0x22, 0x56, 0, 0]), "sample-rate"],
    ["wrong byte rate", mutate(canonical, 28, [0, 0]), "format-fields"],
    ["wrong block align", mutate(canonical, 32, [4, 0]), "format-fields"],
    ["wrong bits", mutate(canonical, 34, [24, 0]), "format-fields"],
    ["empty data", mutate(canonical, 40, [0, 0, 0, 0]), "empty-data"],
    ["partial frame", mutate(canonical, 40, [1, 0, 0, 0]), "partial-frame"],
    ["trailing byte", trailing(canonical), "riff-size"],
    ["data size disagree", mutate(canonical, 40, [2, 0, 0, 0]), "data-size"],
  ];
  for (const [name, bytes, code] of cases) {
    assert.equal(problemOf(bytes).code, code, name);
  }
});

test("shared parser preserves the exact layout and format-field disagreements", () => {
  const canonical = makeWav({ seconds: 0.4 });
  assert.deepEqual(problemOf(mutate(canonical, 12, [0x6e])), {
    code: "layout",
    layout: "fmt",
  });
  assert.deepEqual(problemOf(mutate(canonical, 36, [0x6e])), {
    code: "layout",
    layout: "data",
  });
  assert.deepEqual(problemOf(mutate(canonical, 28, [0, 0])), {
    code: "format-fields",
    field: "byte-rate",
  });
  assert.deepEqual(problemOf(mutate(canonical, 32, [4, 0])), {
    code: "format-fields",
    field: "block-align",
  });
  assert.deepEqual(problemOf(mutate(canonical, 34, [24, 0])), {
    code: "format-fields",
    field: "bits",
  });
});

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}
