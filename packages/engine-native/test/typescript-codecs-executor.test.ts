import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { CODEC_CATALOG, CODEC_IDS, type CodecId, type PreparationRequest } from "@codec-abx/contracts";

import {
  NativeCodecExecutor,
  nativeCodecInternalRate,
  resolveNativeBinaries,
  type NativeCodecExecutorOptions,
  type NativeCodecRunResult,
} from "../src/typescript/index.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function writePcm16Wav(
  file: string,
  sampleRate: number,
  channels: 1 | 2,
  seconds: number,
  silent = false,
): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * channels * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = silent
        ? 0
        : Math.round(
            6_000 * Math.sin(
              (2 * Math.PI * (440 + channel * 220) * frame) / sampleRate,
            ),
          );
      bytes.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
    }
  }
  writeFileSync(file, bytes);
  return bytes;
}

async function harness(t: TestContext): Promise<{
  readonly root: string;
  readonly tempRoot: string;
  readonly executor: NativeCodecExecutor;
  readonly source: (rate: number, channels: 1 | 2, seconds?: number) => Promise<{ path: string; bytes: Buffer }>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typescript-codecs-"));
  const tempRoot = path.join(root, "temp");
  const options: NativeCodecExecutorOptions = {
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot,
  };
  const executor = new NativeCodecExecutor(options);
  t.after(async () => {
    await executor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  let index = 0;
  return {
    root,
    tempRoot,
    executor,
    source: async (rate, channels, seconds = 0.5) => {
      const file = path.join(root, `source-${String(index++)}.wav`);
      const bytes = writePcm16Wav(file, rate, channels, seconds);
      return { path: file, bytes };
    },
  };
}

async function tempEntries(tempRoot: string): Promise<string[]> {
  return fs.readdir(tempRoot).catch(() => []);
}

function midBitrate(codecId: CodecId): number {
  const options = CODEC_CATALOG[codecId].bitrateOptionsKbps;
  return codecId === "noop_passthrough" ? 0 : options[Math.floor(options.length / 2)]!;
}

function requestFor(codecId: CodecId, bitrateKbps = midBitrate(codecId)): PreparationRequest {
  return {
    version: 1,
    sampleRateMode: "native",
    a: { codecId, bitrateKbps },
    b: { codecId: "noop_passthrough", bitrateKbps: 0 },
  };
}

function assertFinitePcm(result: NativeCodecRunResult, channels: 1 | 2, rate: number): void {
  for (const side of [result.a, result.b] as const) {
    assert.equal(side.pcm.sampleRate, rate);
    assert.equal(side.pcm.channels.length, channels);
    const frames = side.pcm.channels[0]?.length ?? 0;
    assert.ok(frames > 0);
    for (const channel of side.pcm.channels) {
      assert.equal(channel.length, frames);
      for (let index = 0; index < channel.length; index += 1) {
        assert.ok(Number.isFinite(channel[index]!));
      }
    }
    const finalStage = side.stages[side.stages.length - 1]!;
    assert.equal(finalStage.decodedFrames, frames);
    assert.ok(finalStage.decodedDurationSeconds <= 30);
  }
}

test("capability discovery reports every catalog codec from real tool probes", async (t) => {
  const h = await harness(t);
  const capabilities = await h.executor.capabilities();
  assert.equal(capabilities.schema, "native-codec-capabilities-v1");
  assert.match(capabilities.ffmpegVersion ?? "", /ffmpeg version/i);
  assert.match(capabilities.ffprobeVersion ?? "", /ffprobe version/i);
  assert.equal(capabilities.codecs.length, CODEC_IDS.length);
  assert.deepEqual(
    capabilities.codecs.map((entry) => entry.codecId),
    [...CODEC_IDS],
  );
  for (const entry of capabilities.codecs) {
    assert.ok(entry.availability === "available" || entry.availability === "unavailable");
    assert.ok(entry.encoder.length > 0);
    assert.ok(entry.decoder.length > 0);
    if (entry.availability === "unavailable") assert.ok(entry.reason);
  }
  const available = capabilities.codecs.filter((entry) => entry.availability === "available");
  assert.ok(available.some((entry) => entry.codecId === "noop_passthrough"));
  // All locally available native profiles are exercised by the matrix below.
  assert.equal(
    capabilities.codecs.find((entry) => entry.codecId === "ldac")?.availability,
    capabilities.tools.ldacHelper ? "available" : "unavailable",
  );
  await assert.rejects(
    h.executor.execute({ path: "/missing-codec-source.wav" }, requestFor("opus")),
    /not readable|unavailable/,
  );
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("all locally available codecs run at 96 kHz mono and stereo with truthful provenance", async (t) => {
  const h = await harness(t);
  const capabilities = await h.executor.capabilities();
  const available = capabilities.codecs.filter((entry) => entry.availability === "available");
  assert.ok(available.length > 0);

  for (const rate of [96_000] as const) {
    for (const channels of [1, 2] as const) {
      const source = await h.source(rate, channels, 0.4);
      const expectedHash = createHash("sha256").update(source.bytes).digest("hex");
      for (const capability of available) {
        const bitrate = midBitrate(capability.codecId);
        const result = await h.executor.execute(
          { path: source.path },
          requestFor(capability.codecId, bitrate),
        );
        assert.equal(result.source.sha256, expectedHash);
        assert.equal(result.source.format, "wav");
        assert.equal(result.source.formatLabel, "WAV");
        assert.equal(result.source.container, "wav");
        assert.match(result.source.codec, /^pcm_/);
        assert.equal(result.session.sampleRate, rate);
        assert.equal(result.session.channels, channels);
        assert.equal(result.a.stages.length, 1);
        const stage = result.a.stages[0]!;
        assert.deepEqual(stage.requested, { codecId: capability.codecId, bitrateKbps: bitrate });
        assert.equal(
          stage.encodedSampleRate,
          nativeCodecInternalRate(capability.codecId, rate),
        );
        if (capability.codecId === "noop_passthrough") {
          assert.equal(stage.encodedSampleRateSource, "lossless-passthrough");
          assert.equal(stage.actualBitrateKbps, null);
          assert.equal(stage.bitrateBasis, "lossless-passthrough");
        } else {
          assert.ok(stage.actualBitrateKbps !== null && stage.actualBitrateKbps > 0);
          assert.ok(stage.encodedBytes !== null && stage.encodedBytes > 0);
          assert.notEqual(stage.bitrateBasis, "lossless-passthrough");
        }
        if (capability.codecId === "aptx" || capability.codecId === "aptx_hd") {
          assert.equal(stage.encodedChannels, 2);
          if (channels === 1) {
            assert.ok(stage.notes.some((note) => /dual-mono/.test(note)));
          }
        }
        if (capability.codecId === "ldac") {
          assert.equal(stage.encodedSampleRateSource, "ldac-container-header");
          assert.ok(stage.bitrateBasis === "ldac-container-bytes-over-header-sample-duration");
          assert.ok(result.disclosures.some((note) => /hegdi\/libldacdec/.test(note)));
        }
        if (capability.codecId === "mp2") {
          assert.ok(stage.notes.some((note) => /libtwolame/.test(note)));
        }
        assert.ok(stage.decodedDurationSeconds > 0);
        assertFinitePcm(result, channels, rate);
        const serialized = JSON.stringify({
          disclosures: result.disclosures,
          stages: result.a.stages,
        });
        assert.ok(!serialized.includes(h.root));
      }
      assert.deepEqual(await tempEntries(h.tempRoot), []);
    }
  }
});

test("44.1/48 kHz native and force_48k session policy stays explicit", async (t) => {
  const h = await harness(t);
  const capabilities = await h.executor.capabilities();
  if (capabilities.codecs.find((entry) => entry.codecId === "opus")?.availability !== "available") {
    t.diagnostic("Opus is unavailable; native/force48 layout checks still use no-op.");
  }
  const codec: CodecId = capabilities.codecs.find((entry) => entry.codecId === "opus")?.availability === "available"
    ? "opus"
    : "noop_passthrough";
  const bitrate = midBitrate(codec);

  for (const [sourceRate, mode, expected] of [
    [44_100, "native", 44_100],
    [44_100, "force_48k", 48_000],
    [48_000, "native", 48_000],
    [96_000, "native", 96_000],
    [96_000, "force_48k", 48_000],
  ] as const) {
    const source = await h.source(sourceRate, 2, 0.4);
    const result = await h.executor.execute(
      { path: source.path },
      { version: 1, sampleRateMode: mode, a: { codecId: codec, bitrateKbps: bitrate }, b: { codecId: "noop_passthrough", bitrateKbps: 0 } },
    );
    assert.equal(result.session.sourceSampleRate, sourceRate);
    assert.equal(result.session.sampleRate, expected);
    assert.equal(result.session.sampleRateMode, mode);
    assert.equal(result.a.pcm.sampleRate, expected);
    assert.equal(result.a.stages[0]!.encodedSampleRate, nativeCodecInternalRate(codec, expected));
    assert.deepEqual(await tempEntries(h.tempRoot), []);
  }
});

test("representative two- and four-stage chains preserve ordered stage provenance", async (t) => {
  const h = await harness(t);
  const capabilities = await h.executor.capabilities();
  const available = new Set(
    capabilities.codecs.filter((entry) => entry.availability === "available")
      .map((entry) => entry.codecId),
  );
  const need = (id: CodecId): CodecId => {
    if (!available.has(id)) throw new Error(`${id} is required for the chain integration check`);
    return id;
  };
  const two = await h.executor.execute(
    { path: (await h.source(96_000, 2, 0.5)).path },
    {
      version: 2,
      sampleRateMode: "native",
      a: [
        { codecId: need("opus"), bitrateKbps: 96 },
        { codecId: need("mp3"), bitrateKbps: 160 },
      ],
      b: [{ codecId: need("ogg_vorbis"), bitrateKbps: 160 }],
    },
  );
  assert.deepEqual(two.a.stages.map((stage) => stage.codecId), ["opus", "mp3"]);
  assert.deepEqual(two.a.stages.map((stage) => stage.stageIndex), [1, 2]);
  assert.equal(two.a.stages[1]!.requested.bitrateKbps, 160);
  assert.equal(two.a.actualBitrateKbps, two.a.stages[1]!.actualBitrateKbps);
  assert.equal(two.a.pcm.sampleRate, 96_000);
  assertFinitePcm(two, 2, 96_000);

  const four = await h.executor.execute(
    { path: (await h.source(96_000, 1, 0.5)).path },
    {
      version: 2,
      sampleRateMode: "native",
      a: [
        { codecId: need("opus"), bitrateKbps: 64 },
        { codecId: need("aac"), bitrateKbps: 96 },
        { codecId: need("mp3"), bitrateKbps: 128 },
        { codecId: need("ldac"), bitrateKbps: 330 },
      ],
      b: [
        { codecId: need("sbc"), bitrateKbps: 160 },
        { codecId: need("aptx_hd"), bitrateKbps: 576 },
        { codecId: need("aac"), bitrateKbps: 128 },
        { codecId: need("ogg_vorbis"), bitrateKbps: 160 },
      ],
    },
  );
  assert.deepEqual(four.a.stages.map((stage) => stage.codecId), ["opus", "aac", "mp3", "ldac"]);
  assert.deepEqual(four.b.stages.map((stage) => stage.codecId), ["sbc", "aptx_hd", "aac", "ogg_vorbis"]);
  assert.equal(four.a.stages[3]!.requested.bitrateKbps, 330);
  assert.equal(four.b.stages[1]!.encodedChannels, 2);
  assert.ok(four.b.stages[1]!.notes.some((note) => /dual-mono/.test(note)));
  assertFinitePcm(four, 1, 96_000);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("bounded FLAC source is snapshotted, hashed and decoded through the same native path", async (t) => {
  const h = await harness(t);
  const tools = resolveNativeBinaries({ repositoryRoot: REPOSITORY_ROOT });
  assert.ok(tools.ffmpegPath);
  const wav = await h.source(48_000, 2, 0.5);
  const flacPath = path.join(h.root, "source.flac");
  execFileSync(tools.ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", wav.path,
    "-c:a", "flac",
    flacPath,
  ]);
  const flacBytes = await fs.readFile(flacPath);
  const result = await h.executor.execute(
    { path: flacPath },
    requestFor("opus", 128),
  );
  assert.equal(result.source.format, "flac");
  assert.equal(result.source.sha256, createHash("sha256").update(flacBytes).digest("hex"));
  assert.equal(result.source.bytes, flacBytes.byteLength);
  assert.equal(result.session.channels, 2);
  assertFinitePcm(result, 2, 48_000);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});
