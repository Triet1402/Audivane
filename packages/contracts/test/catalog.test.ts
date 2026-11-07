import assert from "node:assert/strict";
import test from "node:test";
import { CODEC_IDS, CODEC_CATALOG, freezeRequest, samePipelines, requestsEqual, stagesForSide } from "../src/index.js";

test("public real catalog is explicit, frozen and excludes simulated codecs", () => {
  const expected = {
    noop_passthrough: { codecId: "noop_passthrough", displayName: "No-op / Lossless passthrough", bitrateOptionsKbps: [0] },
    opus: { codecId: "opus", displayName: "Opus", bitrateOptionsKbps: [16, 24, 32, 48, 64, 96, 128, 160, 192, 256, 320] },
    aac: { codecId: "aac", displayName: "AAC", bitrateOptionsKbps: [48, 64, 80, 96, 128, 160, 192, 256, 320] },
    ogg_vorbis: { codecId: "ogg_vorbis", displayName: "Ogg Vorbis", bitrateOptionsKbps: [64, 96, 128, 160, 192, 256, 320] },
    mp3: { codecId: "mp3", displayName: "MP3", bitrateOptionsKbps: [64, 96, 128, 160, 192, 256, 320] },
    mp2: { codecId: "mp2", displayName: "MP2", bitrateOptionsKbps: [64, 96, 128, 160, 192, 224, 256, 320, 384] },
    lc3: { codecId: "lc3", displayName: "LC3", bitrateOptionsKbps: [32, 48, 64, 96, 128, 160, 192, 256, 320] },
    sbc: { codecId: "sbc", displayName: "SBC", bitrateOptionsKbps: [96, 128, 160, 192, 256, 320] },
    aptx: { codecId: "aptx", displayName: "aptX", bitrateOptionsKbps: [352] },
    aptx_hd: { codecId: "aptx_hd", displayName: "aptX HD", bitrateOptionsKbps: [576] },
    ldac: { codecId: "ldac", displayName: "LDAC", bitrateOptionsKbps: [330, 660, 990] },
  };
  assert.deepEqual(CODEC_IDS, Object.keys(expected));
  assert.deepEqual(CODEC_CATALOG, expected);
  assert.ok(Object.isFrozen(CODEC_CATALOG));
  for (const id of CODEC_IDS) {
    assert.ok(Object.isFrozen(CODEC_CATALOG[id].bitrateOptionsKbps));
    assert.ok(!id.startsWith("sim_"), "catalog must not expose explicit simulations");
  }
});

test("null identity compares every ordered stage while binding identity retains version and options", () => {
  const opus = { codecId: "opus", bitrateKbps: 128 }, aac = { codecId: "aac", bitrateKbps: 128 };
  const base = { version: 2, sampleRateMode: "native", a: [opus, aac], b: [opus, aac] };
  assert.equal(samePipelines(freezeRequest(base)), true);
  assert.equal(samePipelines(freezeRequest({ ...base, b: [aac, aac] })), false);
  assert.equal(samePipelines(freezeRequest({ ...base, b: [aac, opus] })), false);
  const v1 = freezeRequest({ version: 1, sampleRateMode: "native", a: opus, b: opus });
  const v2 = freezeRequest({ version: 2, sampleRateMode: "native", a: [opus], b: [opus] });
  assert.equal(samePipelines(v1), samePipelines(v2));
  assert.deepEqual(stagesForSide(v1, "a"), stagesForSide(v2, "a"));
  assert.equal(requestsEqual(v1, v2), false);
  assert.equal(requestsEqual(v2, freezeRequest({ ...v2, canaryEnabled: false })), false);
  assert.equal(requestsEqual(v2, freezeRequest(v2)), true);
});
