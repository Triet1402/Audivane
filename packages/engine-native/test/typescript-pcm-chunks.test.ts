import assert from "node:assert/strict";
import test from "node:test";

import { readFloat64PcmChunks } from "../src/typescript/pcm.js";

test("chunked native decode keeps independent stereo samples across read boundaries", async () => {
  const frames = 65_539; // More than the 1 MiB read chunk at stereo Float64.
  const reads: Array<[number, number]> = [];
  const pcm = await readFloat64PcmChunks(frames * 16, async (offset, length) => {
    reads.push([offset, length]);
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    for (let local = 0; local < length; local += 16) {
      const frame = (offset + local) / 16;
      view.setFloat64(local, frame / 131_072, true);
      view.setFloat64(local + 8, -(frame + 1) / 262_144, true);
    }
    return bytes;
  }, 96_000, 2, "fixture");
  assert.deepEqual(reads, [[0, 1_048_576], [1_048_576, 48]]);
  assert.equal(pcm.sampleRate, 96_000);
  for (const frame of [0, 65_535, 65_536, frames - 1]) {
    assert.equal(pcm.channels[0]![frame], frame / 131_072);
    assert.equal(pcm.channels[1]![frame], -(frame + 1) / 262_144);
  }
});

test("chunked decode cancels between ranges without reading or publishing another chunk", async () => {
  let reads = 0;
  const cancelled = new Error("cancelled fixture");
  await assert.rejects(readFloat64PcmChunks(1_048_592, async (_offset, length) => {
    reads++;
    return new Uint8Array(length);
  }, 48_000, 2, "fixture", () => {
    if (reads > 0) throw cancelled;
  }), (error) => error === cancelled);
  assert.equal(reads, 1);
});

test("chunked decode rejects short or nonfinite material without a partial result", async () => {
  await assert.rejects(readFloat64PcmChunks(16, async () => new Uint8Array(8),
    48_000, 2, "fixture"), /changed or ended/);
  await assert.rejects(readFloat64PcmChunks(8, async () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, Number.NaN, true);
    return bytes;
  }, 48_000, 1, "fixture"), /non-finite sample at frame 0/);
});
