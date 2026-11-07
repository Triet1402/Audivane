import assert from "node:assert/strict";
import test from "node:test";
import { CODEC_IDS } from "@codec-abx/contracts";
import {
  codecInputChannels,
  codecInternalRate,
  implementedPlan,
  probedPlan,
  supplementalPlan,
} from "../src/codec-plan.js";

test("browser adapter implements nine ffmpeg round trips plus two supplemental codecs", () => {
  const implemented = CODEC_IDS.filter((id) => implementedPlan(id) !== null);
  assert.deepEqual(implemented, [
    "noop_passthrough", "opus", "aac", "ogg_vorbis", "mp3", "mp2", "sbc", "aptx", "aptx_hd",
  ]);
  // LC3/LDAC never announce themselves in the pinned core's listings; they are
  // supplemental WASM plans, so an mp3-style probedPlan lookup must still fail.
  for (const id of ["lc3", "ldac"] as const) {
    assert.equal(implementedPlan(id), null, `${id} is supplemental, not an ffmpeg plan`);
    assert.ok(supplementalPlan(id) !== null, `${id} must have a supplemental plan`);
    assert.equal(probedPlan(id, new Set([id])), null, `${id} must never claim ffmpeg names`);
  }
  assert.deepEqual(supplementalPlan("lc3")?.extension, "lc3");
  assert.deepEqual(supplementalPlan("ldac")?.extension, "ldac");
  assert.match(supplementalPlan("lc3")!.encoder, /liblc3 1\.1\.3/);
  assert.match(supplementalPlan("ldac")!.encoder, /AOSP libldac 2\.00\.02/);
  assert.match(supplementalPlan("ldac")!.decoder, /hegdi\/libldacdec/);
});

test("MP3 and MP2 explicitly select the actual advertised decoder without altering the encoder", () => {
  assert.equal(probedPlan("mp3", new Set(["mp3float", "mp3"]))?.decoder, "mp3float");
  assert.equal(probedPlan("mp3", new Set(["mp3"]))?.decoder, "mp3");
  assert.equal(probedPlan("mp3", new Set(["mp3"]))?.encoder, "libmp3lame");
  // A missing decoder stays missing, so the engine's capability check refuses it.
  assert.equal(probedPlan("mp3", new Set())?.decoder, "mp3float");

  assert.equal(probedPlan("mp2", new Set(["mp2float", "mp2"]))?.decoder, "mp2float");
  assert.equal(probedPlan("mp2", new Set(["mp2"]))?.decoder, "mp2");
  assert.equal(probedPlan("mp2", new Set(["mp2float"]))?.encoder, "mp2");
});

test("new codec plans use the pinned core's exact built-in names and raw formats", () => {
  assert.deepEqual(implementedPlan("mp2"), {
    encoder: "mp2", decoder: "mp2float", format: "mp2", extension: "mp2",
  });
  assert.deepEqual(implementedPlan("sbc"), {
    encoder: "sbc", decoder: "sbc", format: "sbc", extension: "sbc",
  });
  assert.equal(implementedPlan("aptx")?.encoder, "aptx");
  assert.equal(implementedPlan("aptx")?.format, "aptx");
  assert.equal(implementedPlan("aptx_hd")?.encoder, "aptx_hd");
  assert.equal(implementedPlan("aptx_hd")?.format, "aptx_hd");
});

test("codec internal rates disclose MPEG, SBC and aptX adaptation while preserving native rates", () => {
  for (const codec of ["aac", "mp3", "mp2", "sbc"] as const) {
    assert.equal(codecInternalRate(codec, 96000), 48000);
    assert.equal(codecInternalRate(codec, 44100), 44100);
  }
  for (const codec of ["aptx", "aptx_hd"] as const) {
    for (const rate of [44100, 48000, 96000]) {
      assert.equal(codecInternalRate(codec, rate), 48000);
    }
  }
  for (const rate of [44100, 48000, 96000]) assert.equal(codecInternalRate("opus", rate), 48000);
  for (const rate of [44100, 48000, 96000]) {
    assert.equal(codecInternalRate("lc3", rate), 48000);
    assert.equal(codecInternalRate("ldac", rate), 48000);
  }
  assert.equal(codecInternalRate("ogg_vorbis", 96000), 96000);
  assert.equal(codecInternalRate("noop_passthrough", 96000), 96000);
});

test("only aptX codecs require stereo encoder input; the decoded layout is restored", () => {
  assert.equal(codecInputChannels("aptx", 1), 2);
  assert.equal(codecInputChannels("aptx_hd", 1), 2);
  assert.equal(codecInputChannels("aptx", 2), 2);
  for (const codec of ["noop_passthrough", "opus", "aac", "ogg_vorbis", "mp3", "mp2", "sbc"] as const) {
    assert.equal(codecInputChannels(codec, 1), 1);
    assert.equal(codecInputChannels(codec, 2), 2);
  }
});
