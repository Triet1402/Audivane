import assert from "node:assert/strict";
import { expectedLdacContainerRate } from "./fixtures/ldac-rate-expectation.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32 as zlibCrc32 } from "node:zlib";
import {
  ldacCrc32AfterHeader,
  parseLdacContainer,
} from "../src/ldac-container.js";

const KNOWN_CRC32 = new TextEncoder().encode("123456789");

test("the LDAC CRC-32 is the IEEE 802.3 polynomial zlib also uses", () => {
  assert.equal(ldacCrc32AfterHeader(KNOWN_CRC32), zlibCrc32(KNOWN_CRC32));
  assert.equal(zlibCrc32(KNOWN_CRC32), 0xcbf43926);
});

function encodeU16(bytes: number[]): number[] {
  return [bytes[0]! & 0xff, ((bytes[0]! >> 8) & 0xff)];
}

/** Build a minimal valid v1 container with one transport frame record. */
function makeContainer(options: {
  rate: 44_100 | 48_000;
  channels: 1 | 2;
  bitrate: 330 | 660 | 990;
  frames?: number;
  sampleCount?: number;
  reported?: number;
  corruptCrc?: boolean;
}): Uint8Array {
  const frames = options.frames ?? 1;
  const sampleCount = options.sampleCount ?? 128;
  const reported = options.reported ?? options.bitrate;
  // One record: u16 length, then a 3-byte LDAC transport header with 0xAA sync
  // and the configured sample-rate/channel ids, padded to length 4.
  const frame = [0xaa,
    ((options.rate === 44_100 ? 0 : 1) << 5) | ((options.channels === 1 ? 0 : 2) << 3),
    0, 0];
  const recordLength = 4;
  const records: number[] = [];
  for (let index = 0; index < frames; index += 1) {
    records.push(...encodeU16([recordLength]), ...frame);
  }
  const payload = new Uint8Array(records);
  const bytes = new Uint8Array(48 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index += 1) {
    bytes[index] = "LDAC".charCodeAt(index);
  }
  view.setUint16(4, 1, true);
  view.setUint16(6, 48, true);
  view.setUint32(8, options.rate, true);
  view.setUint32(12, options.channels, true);
  view.setUint32(16, options.bitrate, true);
  view.setUint32(20, frames, true);
  view.setUint32(24, sampleCount >>> 0, true);
  view.setUint32(28, 0, true); // sample counts stay below 2^32 in tests
  view.setUint32(32, reported, true);
  view.setUint32(36, 1, true);
  const crc = ldacCrc32AfterHeader(payload);
  view.setUint32(40, options.corruptCrc === true ? crc ^ 0xffff : crc, true);
  view.setUint32(44, 0, true);
  bytes.set(payload, 48);
  return bytes;
}

test("a synthetic v1 container parses with header and record-level checks", () => {
  const parsed = parseLdacContainer(makeContainer({ rate: 48_000, channels: 2, bitrate: 990 }));
  assert.equal(parsed.containerVersion, 1);
  assert.equal(parsed.sampleRateHz, 48_000);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.requestedBitrateKbps, 990);
  assert.equal(parsed.frameCount, 1);
  assert.equal(parsed.sampleCount, 128);
  assert.equal(parsed.reportedBitrateKbps, 990);
  assert.equal(parsed.crc32, ldacCrc32AfterHeader(makeContainer({ rate: 48_000, channels: 2, bitrate: 990 }).subarray(48)));
});

test("malformed LDAC containers refuse with reason-specific errors", () => {
  assert.throws(() => parseLdacContainer(new Uint8Array(47)), /shorter than its 48-byte header/);

  const badMagic = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
  badMagic[0] = 0x58;
  assert.throws(() => parseLdacContainer(badMagic), /bad magic/);

  const badVersion = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
  badVersion[4] = 2;
  assert.throws(() => parseLdacContainer(badVersion), /Unsupported LDAC container version 2/);

  const badSize = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
  badSize[6] = 52;
  assert.throws(() => parseLdacContainer(badSize), /Bad LDAC container header size 52/);

  for (const [offset, bitValue] of [[12, 3], [16, 132], [36, 0], [44, 7]] as const) {
    const bytes = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
    new DataView(bytes.buffer).setUint32(offset, bitValue, true);
    assert.throws(() => parseLdacContainer(bytes), offset === 44 ? /reserved/ : /unsupported|Unsupported/);
  }

  // Truncated record count: header claims 3 frames but only 2 records present.
  const recordCountMismatch = makeContainer({ rate: 48_000, channels: 1, bitrate: 330, frames: 2 });
  new DataView(recordCountMismatch.buffer).setUint32(20, 3, true);
  assert.throws(() => parseLdacContainer(recordCountMismatch), /declares 3 frames but carries 2/);

  // Frame record truncated inside the payload.
  const cutInFrame = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
  const cut = new Uint8Array(cutInFrame.byteLength - 1);
  cut.set(cutInFrame.subarray(0, cut.byteLength));
  assert.throws(() => parseLdacContainer(cut), /truncated|checksum/i);

  // Mismatched frame sample-rate identifier: 48 kHz records presented under a
  // 44.1 kHz container header.
  const rateIdMismatch = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
  new DataView(rateIdMismatch.buffer).setUint32(8, 44_100, true);
  assert.throws(() => parseLdacContainer(rateIdMismatch), /sample rate id 1, container says 44100/);

  // Mismatched channel configuration: mono records under a stereo header.
  const channelIdMismatch = makeContainer({ rate: 48_000, channels: 1, bitrate: 330 });
  new DataView(channelIdMismatch.buffer).setUint32(12, 2, true);
  assert.throws(() => parseLdacContainer(channelIdMismatch), /channel config id 0, container says 2/);

  // Corrupt CRC.
  assert.throws(() => parseLdacContainer(makeContainer({
    rate: 48_000, channels: 1, bitrate: 330, corruptCrc: true,
  })), /checksum mismatch/);
});

/* ---------------------------------------------------------------------- *
 * Documented measured-rate expectation (ldac-container-bytes-over-
 * header-sample-duration). These checks keep the supplemental e2e's
 * measured-bitrate gates anchored to the documented helper behavior instead
 * of the requested stereo bitrate number.
 * ---------------------------------------------------------------------- */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const ldacHelper = path.join(repoRoot, "third_party", "ldac", "bin", "ldac_helper");
const helperPresent = fs.existsSync(ldacHelper);
const helperSkip = helperPresent
  ? null
  : "requires the vendored third_party/ldac/bin/ldac_helper build";
const execLdac = promisify(execFile);

/** The 0.6 s canonical supplemental e2e source, 28800 sample frames. */
const E2E_SAMPLE_COUNT = 28_800;

test("the LDAC container rate model reproduces the documented helper rates and sizes", () => {
  // Expected container bytes and measured kbps for the shapes the tiers
  // encode (verified against real ldac_helper/WASM container sizes below and
  // by the supplemental parity tests):
  const expectations: ReadonlyArray<[
    Parameters<typeof expectedLdacContainerRate>[0],
    Parameters<typeof expectedLdacContainerRate>[1],
    Parameters<typeof expectedLdacContainerRate>[2],
    number, number, number,
  ]> = [
    // rate, channels, requested, sampleCount, containerBytes, measuredKbps
    [48_000, 2, 990, E2E_SAMPLE_COUNT, 75_080, 1_001.066_666_666_666_7],
    [48_000, 1, 660, E2E_SAMPLE_COUNT, 25_360, 338.133_333_333_333_3],
    [48_000, 1, 330, E2E_SAMPLE_COUNT, 12_930, 172.4],
    [48_000, 1, 990, E2E_SAMPLE_COUNT, 37_790, 503.866_666_666_666_7],
    [44_100, 2, 990, 26_460, 69_104, 921.386_666_666_666_7],
    [44_100, 2, 660, 26_460, 46_224, 616.32],
  ];
  for (const [rate, channels, requested, sampleCount, containerBytes, measuredKbps] of expectations) {
    const expected = expectedLdacContainerRate(rate, channels, requested, sampleCount);
    assert.equal(expected.containerBytes, containerBytes,
      `${String(rate)} Hz ${String(channels)} ch ${String(requested)} kbps container bytes`);
    assert.ok(Math.abs(expected.measuredKbps - measuredKbps) < 1e-6,
      `${String(rate)} Hz ${String(channels)} ch ${String(requested)} kbps measured`);
    // The helper's flush loop always appends one encoder-tail frame.
    assert.equal(expected.frameCount, Math.ceil(sampleCount / 128) + 1);
  }
  // Mono 44.1 kHz is outside both tiers' encode policy: refuse, never guess.
  assert.throws(() => expectedLdacContainerRate(44_100, 1, 330, E2E_SAMPLE_COUNT),
    /mono at 44\.1 kHz/);
});

test("the documented mono LDAC rate stays far outside the requested-number gate", () => {
  // Regression guard for the supplemental e2e fix: the previously requested
  // tolerance (max(24, 15% of requested)) rejects the true half-stereo mono
  // rate plus container overhead, so the gate must never compare the LDAC
  // measured basis against the requested stereo number again.
  for (const [requested, tolerance] of [[660, 99], [330, 49.5]] as const) {
    const expected = expectedLdacContainerRate(48_000, 1, requested, E2E_SAMPLE_COUNT);
    assert.ok(Math.abs(expected.measuredKbps - requested) > tolerance,
      `${String(requested)} kbps mono must sit outside the stale requested gate`);

    // The model also reproduces the exact disclosed measurement rounding
    // (0.1 kbps) the engine applies: 338.1 / 172.4 from the last failing run.
    assert.equal(Math.round(expected.measuredKbps * 10) / 10,
      requested === 660 ? 338.1 : 172.4);
  }
});

test("the LDAC container rate model matches native ldac_helper container bytes", { skip: helperSkip ?? undefined }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldac-rate-model-"));
  try {
    for (const [rate, channels, requested] of [
      [48_000, 1, 660], [48_000, 1, 330], [48_000, 2, 990],
      [44_100, 2, 660],
    ] as const) {
      const sampleCount = Math.round(0.6 * rate);
      const pcm = new Int16Array(sampleCount * channels);
      for (let frame = 0; frame < sampleCount; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          pcm[frame * channels + channel] = Math.round(
            20_000 * Math.sin(2 * Math.PI * (channel === 0 ? 440 : 622) * frame / rate));
        }
      }
      const pcmIn = path.join(dir, `in-${String(rate)}-${String(requested)}.pcm`);
      fs.writeFileSync(pcmIn, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      const out = path.join(dir, `out-${String(rate)}-${String(channels)}-${String(requested)}.ldac`);
      await execLdac(ldacHelper, [
        "encode", "--rate", String(rate), "--channels", String(channels),
        "--bitrate", String(requested), "--in", pcmIn, "--out", out,
      ]);
      const nativeBytes = fs.readFileSync(out);
      const header = parseLdacContainer(new Uint8Array(nativeBytes));
      const expected = expectedLdacContainerRate(rate, channels, requested, header.sampleCount);
      assert.equal(nativeBytes.byteLength, expected.containerBytes,
        `${String(rate)} Hz ${String(channels)} ch ${String(requested)} kbps: native container size differs from the model`);
      const reported = rate === 44_100
        ? { 330: 303, 660: 606, 990: 909 }[requested]
        : channels === 1 ? requested / 2 : requested;
      assert.equal(header.reportedBitrateKbps, reported,
        `${String(rate)} Hz ${String(channels)} ch ${String(requested)} kbps reported bitrate`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
