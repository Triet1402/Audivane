import assert from "node:assert/strict";
import test from "node:test";
import {
  Lc3ContainerWriter,
  lc3FrameSamples,
  lc3HeaderSize,
  parseLc3Frames,
  parseLc3Header,
  writeLc3Header,
} from "../src/lc3-container.js";

test("LC3 header bytes match the FFmpeg lc3 muxer field layout", () => {
  const header = writeLc3Header({
    sampleRateHz: 48_000, bitrateBps: 96_000, channels: 2,
    frameDurationUs: 10_000, epMode: false, totalSamples: 24_000, hrMode: false,
  });
  assert.equal(header.byteLength, 18);
  // wb16 tag 0x1ccc (big-endian), wl16 pairs (48 kHz/100, 96 kbps/100, 2 ch,
  // 10 ms/10, ep 0), wl32 total, from libavformat/lc3.c.
  assert.deepEqual(
    Array.from(header),
    [0x1c, 0xcc, 18, 0,
     0xe0, 0x01, // srate/100 = 480
     0xc0, 0x03, // bitrate/100 = 960
     2, 0,       // channels
     0xe8, 0x03, // frame_us/10 = 1000
     0, 0,       // ep_mode
     0xc0, 0x5d, 0, 0], // total samples 24000
  );
});

test("high-resolution headers are 20 bytes with the extra marker", () => {
  const header = writeLc3Header({
    sampleRateHz: 96_000, bitrateBps: 128_000, channels: 1,
    frameDurationUs: 10_000, epMode: false, totalSamples: 7, hrMode: true,
  });
  assert.equal(header.byteLength, lc3HeaderSize(true));
  assert.equal(viewHeaderByte(header, 18), 1);
  const parsed = parseLc3Header(header);
  assert.equal(parsed.hrMode, true);
});

function viewHeaderByte(bytes: Uint8Array, offset: number): number {
  assert.ok(offset < bytes.byteLength, `${String(offset)} in range`);
  return bytes[offset] as number;
}

test("header and frame samples round trip and validate rate/duration combinations", () => {
  assert.equal(lc3FrameSamples(48_000, 10_000), 480);
  // 44.1 kHz is deliberately not an LC3 container rate; the native policy
  // encodes internally at 48 kHz and restores the session rate afterwards.
  assert.throws(() => lc3FrameSamples(44_100, 10_000), /unsupported sample rate/);
  assert.throws(() => lc3FrameSamples(9_600, 10_000), /unsupported sample rate/);
  const parsed = parseLc3Header(writeLc3Header({
    sampleRateHz: 32_000, bitrateBps: 160_000, channels: 1,
    frameDurationUs: 2_500, epMode: false, totalSamples: 4_294_000_000, hrMode: false,
  }));
  assert.deepEqual(parsed, {
    sampleRateHz: 32_000, bitrateBps: 160_000, channels: 1,
    frameDurationUs: 2_500, epMode: false, totalSamples: 4_294_000_000, hrMode: false,
  });
  assert.throws(() => writeLc3Header({
    sampleRateHz: 48_000, bitrateBps: 96_000, channels: 1,
    frameDurationUs: 12_500, epMode: false, totalSamples: 1, hrMode: false,
  }), /unsupported frame duration/);
  assert.throws(() => writeLc3Header({
    sampleRateHz: 96_000, bitrateBps: 96_000, channels: 1,
    frameDurationUs: 7_500, epMode: false, totalSamples: 1, hrMode: false,
  }), /7\.5 ms/);
});

test("frames are written and read back as u16-length-prefix records", () => {
  const writer = new Lc3ContainerWriter({
    sampleRateHz: 48_000, bitrateBps: 96_000, channels: 2,
    frameDurationUs: 10_000, epMode: false, totalSamples: 480, hrMode: false,
  });
  writer.pushFrame(new Uint8Array([1, 2, 3, 120]));
  writer.pushFrame(new Uint8Array(120));
  const bytes = writer.finish();
  assert.equal(writer.frames, 2);
  const parsed = parseLc3Header(bytes);
  assert.equal(parsed.totalSamples, 480);
  const frames = parseLc3Frames(bytes);
  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0] as Uint8Array), [1, 2, 3, 120]);
  assert.equal((frames[1] as Uint8Array).byteLength, 120);
});

test("malformed LC3 containers refuse cleanly before any decoder runs", () => {
  const base = new Lc3ContainerWriter({
    sampleRateHz: 48_000, bitrateBps: 96_000, channels: 1,
    frameDurationUs: 10_000, epMode: false, totalSamples: 480, hrMode: false,
  });
  base.pushFrame(new Uint8Array(120));
  const bytes = base.finish();

  const truncated = bytes.subarray(0, bytes.byteLength - 60);
  assert.throws(() => parseLc3Frames(truncated), /invalid frame record/);

  const badTag = new Uint8Array(bytes);
  new DataView(badTag.buffer).setUint16(0, 0x2ccc, false);
  assert.throws(() => parseLc3Header(badTag), /bad tag/);

  assert.throws(() => parseLc3Frames(new Uint8Array([...Array.from(bytes), 9]),
  ), /trailing bytes/);
});
