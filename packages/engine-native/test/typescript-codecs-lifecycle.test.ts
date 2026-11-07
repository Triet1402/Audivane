import assert from "node:assert/strict";
import { chmodSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  CODEC_CATALOG,
  type CodecId,
  type PreparationRequest,
} from "@codec-abx/contracts";

import {
  NativeCodecExecutor,
  resolveNativeBinaries,
  NATIVE_CODEC_MAX_DURATION_SECONDS,
  NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE,
  NATIVE_CODEC_MAX_RETAINED_PCM_BYTES,
  NATIVE_CODEC_MAX_SOURCE_BYTES,
  nativeSessionFrameBound,
  type NativeCodecCapabilities,
  type NativeCodecExecutorOptions,
  type NativeProcessObservation,
} from "../src/typescript/index.js";

test("decoded PCM and retained bounds cover the maximum layout without multi-GiB fixtures", () => {
  const deliveryFrames = 1800.5 * 96_000;
  const sentinelFrames = (NATIVE_CODEC_MAX_DURATION_SECONDS + 10) * 44_100;
  assert.equal(NATIVE_CODEC_MAX_SOURCE_BYTES, 512 * 1024 * 1024);
  assert.equal(NATIVE_CODEC_MAX_DURATION_SECONDS, 1800);
  // The per-side read bound admits the refusal sentinel at the maximum layout,
  // but not an unbounded prefix.
  assert.equal(nativeSessionFrameBound(96_000, 2), 1810 * 96_000);
  assert.ok(nativeSessionFrameBound(96_000, 1) > sentinelFrames);
  assert.equal(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE, 1810 * 96_000 * 2 * 8);
  assert.ok(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE >= deliveryFrames * 2 * 8);
  // The retained pair covers two maximum-length delivery sides, not the sentinel.
  assert.equal(NATIVE_CODEC_MAX_RETAINED_PCM_BYTES, 2 * deliveryFrames * 2 * 8);
  assert.ok(Number.isSafeInteger(NATIVE_CODEC_MAX_RETAINED_PCM_BYTES));
});

test("decode expansion is bounded even when probe duration is unavailable; no truncated success", async (t) => {
  const h = await harness(t);
  const binaries = resolveNativeBinaries({ repositoryRoot: REPOSITORY_ROOT });
  assert.ok(binaries.ffmpegPath);
  // A silent 1801 s FLAC stays small on disk while still expanding beyond the
  // decoded-source ceiling. This exercises the sentinel without a 173 MB WAV.
  const source = path.join(h.root, "overlong.flac");
  execFileSync(binaries.ffmpegPath, [
    "-nostdin", "-v", "error", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-t", "1801", "-c:a", "flac", source,
  ]);
  const realProbe = resolveNativeBinaries({ repositoryRoot: REPOSITORY_ROOT }).ffprobePath;
  assert.ok(realProbe);
  const probe = path.join(h.root, "durationless-ffprobe");
  await fs.writeFile(probe, `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const result = spawnSync(${JSON.stringify(realProbe)}, process.argv.slice(2), {encoding:'utf8'});
let output = result.stdout;
try {
  const value = JSON.parse(output);
  if (value.format) delete value.format.duration;
  for (const stream of value.streams || []) delete stream.duration;
  output = JSON.stringify(value);
} catch {}
process.stdout.write(output || ''); process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
  const executor = new NativeCodecExecutor({ repositoryRoot: REPOSITORY_ROOT,
    ffprobePath: probe, tempRoot: h.tempRoot });
  try {
    await assert.rejects(executor.execute({ path: source }, noopRequest()), /1801\.000000 s exceeds the 1800 s bound/);
    assert.deepEqual(await tempEntries(h.tempRoot), []);
  } finally { await executor.dispose(); }
});

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("a playlist disguised as WAV cannot probe or fetch external audio", async (t) => {
  const h = await harness(t);
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const source = path.join(h.root, "playlist.wav");
  await fs.writeFile(source, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${address.port}/audio.ts\n#EXT-X-ENDLIST\n`);
  try {
    await assert.rejects(h.executor.execute({ path: source }, noopRequest()), /Source probe/);
    assert.equal(requests, 0);
    assert.deepEqual(await tempEntries(h.tempRoot), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function writePcm16Wav(
  file: string,
  sampleRate: number,
  channels: 1 | 2,
  seconds: number,
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
      bytes.writeInt16LE(
        Math.round(6_000 * Math.sin((2 * Math.PI * (440 + channel * 220) * frame) / sampleRate)),
        44 + (frame * channels + channel) * 2,
      );
    }
  }
  writeFileSync(file, bytes);
  return bytes;
}

function writePcm32Wav(
  file: string,
  format: "int" | "float",
  sampleRate: number,
  channels: 1 | 2,
  frames: readonly (readonly number[])[],
): Buffer {
  const bits = 32;
  const bytesPerSample = bits / 8;
  const dataSize = frames.length * channels * bytesPerSample;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(format === "float" ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  bytes.writeUInt16LE(channels * bytesPerSample, 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  frames.forEach((frame, frameIndex) => {
    frame.forEach((value, channel) => {
      const offset = 44 + (frameIndex * channels + channel) * bytesPerSample;
      if (format === "float") bytes.writeFloatLE(value, offset);
      else bytes.writeInt32LE(value, offset);
    });
  });
  writeFileSync(file, bytes);
  return bytes;
}

function writeFloat32WavWithNonFinite(file: string, sampleRate: number): void {  const frames = Math.round(sampleRate * 0.5);
  const dataSize = frames * 4;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); // IEEE float
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = frame === 100
      ? Number.NaN
      : frame === 200
        ? Number.POSITIVE_INFINITY
        : 0.1 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    bytes.writeFloatLE(value, 44 + frame * 4);
  }
  writeFileSync(file, bytes);
}

interface Harness {
  readonly root: string;
  readonly tempRoot: string;
  readonly executor: NativeCodecExecutor;
  readonly observations: NativeProcessObservation[];
  readonly source: (rate: number, channels: 1 | 2, seconds?: number) => Promise<string>;
}

async function harness(
  t: TestContext,
  extra: Partial<NativeCodecExecutorOptions> = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typescript-codecs-lifecycle-"));
  const tempRoot = path.join(root, "temp");
  const observations: NativeProcessObservation[] = [];
  const executor = new NativeCodecExecutor({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot,
    processObserver: (event) => observations.push(event),
    ...extra,
  });
  t.after(async () => {
    await executor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  let index = 0;
  return {
    root,
    tempRoot,
    executor,
    observations,
    source: async (rate, channels, seconds = 0.5) => {
      const file = path.join(root, `source-${String(index++)}.wav`);
      writePcm16Wav(file, rate, channels, seconds);
      return file;
    },
  };
}

async function tempEntries(tempRoot: string): Promise<string[]> {
  return fs.readdir(tempRoot).catch(() => []);
}

function noopRequest(): PreparationRequest {
  return {
    version: 1,
    sampleRateMode: "native",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "noop_passthrough", bitrateKbps: 0 },
  };
}

function codecRequest(codecId: CodecId, bitrateKbps: number): PreparationRequest {
  return {
    version: 1,
    sampleRateMode: "native",
    a: { codecId, bitrateKbps },
    b: { codecId: "noop_passthrough", bitrateKbps: 0 },
  };
}

function midBitrate(codecId: CodecId): number {
  const options = CODEC_CATALOG[codecId].bitrateOptionsKbps;
  return codecId === "noop_passthrough" ? 0 : options[Math.floor(options.length / 2)]!;
}

function firstUsableCodec(capabilities: NativeCodecCapabilities): CodecId {
  const entry = capabilities.codecs.find(
    (candidate) => candidate.availability === "available" && candidate.codecId !== "noop_passthrough",
  );
  if (!entry) throw new Error("No non-noop native codec is available for the lifecycle check");
  return entry.codecId;
}

const FAKE_FFMPEG_SOURCE = (missingEncoder: string, missingDecoder: string): string => `#!/usr/bin/env node
const args = process.argv.slice(2);
const encoders = ["aac","aptx","aptx_hd","liblc3","libtwolame","libmp3lame","libopus","sbc","libvorbis"];
const decoders = ["aac","aptx","aptx_hd","liblc3","mp2float","mp3float","opus","sbc","vorbis"];
const muxers = ["adts","aptx","aptx_hd","flac","ipod","lc3","mp2","mp3","ogg","opus","sbc","wav"];
const demuxers = ["aac","aptx","aptx_hd","flac","lc3","mov,mp4,m4a,3gp,3g2,mj2","mp3","ogg","sbc","wav"];
if (args.includes("-version")) {
  console.log("ffmpeg version fake-native-probe");
} else if (args.includes("-encoders")) {
  console.log("Encoders:");
  for (const name of encoders) if (name !== ${JSON.stringify(missingEncoder)}) console.log(" A....D " + name + " fake");
} else if (args.includes("-decoders")) {
  console.log("Decoders:");
  for (const name of decoders) if (name !== ${JSON.stringify(missingDecoder)}) console.log(" A....D " + name + " fake");
} else if (args.includes("-muxers")) {
  console.log("Muxers:");
  for (const name of muxers) console.log("  E  " + name + " fake");
} else if (args.includes("-demuxers")) {
  console.log("Demuxers:");
  for (const name of demuxers) console.log(" D   " + name + " fake");
} else {
  console.error("fake ffmpeg is capability-probe only");
  process.exit(90);
}
`;

function makeFakeFfmpeg(root: string, missingEncoder: string, missingDecoder: string): string {
  const file = path.join(root, `fake-ffmpeg-${missingEncoder}-${missingDecoder}`);
  writeFileSync(file, FAKE_FFMPEG_SOURCE(missingEncoder, missingDecoder));
  chmodSync(file, 0o755);
  return file;
}

function makeSleepingFfmpeg(root: string): string {
  const file = path.join(root, "sleeping-ffmpeg");
  writeFileSync(file, `#!/usr/bin/env node
setTimeout(() => process.exit(0), 60000);
`);
  chmodSync(file, 0o755);
  return file;
}

test("missing encoded output reports failure without leaking the private workspace", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 1);
  const real = resolveNativeBinaries({ repositoryRoot: REPOSITORY_ROOT }).ffmpegPath;
  assert.ok(real);
  const fake = path.join(h.root, "empty-encode-ffmpeg");
  await fs.writeFile(fake, `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('libopus') && args.includes('-i')) process.exit(0);
const result = spawnSync(${JSON.stringify(real)}, args, {stdio:'inherit'});
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
  const executor = new NativeCodecExecutor({ repositoryRoot: REPOSITORY_ROOT, ffmpegPath: fake, tempRoot: h.tempRoot });
  try {
    await assert.rejects(executor.execute({ path: source }, codecRequest("opus", 128)), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /encoded container is unavailable/);
      assert.ok(!error.message.includes(h.root));
      assert.doesNotMatch(error.message, /codec-abx-codecs-|\/tmp\//);
      return true;
    });
    assert.deepEqual(await tempEntries(h.tempRoot), []);
  } finally { await executor.dispose(); }
});

test("a regular source replaced by FIFO during discovery refuses without hanging disposal", { timeout: 8_000 }, async (t) => {
  if (process.platform !== "linux") return t.skip("Linux FIFO acceptance");
  const h = await harness(t);
  const source = await h.source(48_000, 1);
  let replaced = false;
  const executor = new NativeCodecExecutor({ repositoryRoot: REPOSITORY_ROOT, tempRoot: h.tempRoot,
    processObserver: event => {
      if (event.type === "spawn" && !replaced) {
        replaced = true;
        unlinkSync(source);
        execFileSync("mkfifo", [source]);
      }
    } });
  try {
    await assert.rejects(executor.execute({ path: source }, noopRequest()), /source file is not readable/);
    assert.equal(replaced, true);
    assert.deepEqual(await tempEntries(h.tempRoot), []);
  } finally { await executor.dispose(); }
});

test("abort while awaiting shared discovery cleans every probe before rejecting", { timeout: 8_000 }, async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 1);
  const observations: NativeProcessObservation[] = [];
  const executor = new NativeCodecExecutor({ repositoryRoot: REPOSITORY_ROOT,
    ffmpegPath: makeSleepingFfmpeg(h.root), tempRoot: h.tempRoot,
    processObserver: event => observations.push(event) });
  const abort = new AbortController();
  try {
    const discovery = assert.rejects(executor.capabilities(), { name: "AbortError" });
    const preparing = assert.rejects(executor.execute({ path: source }, noopRequest(),
      { signal: abort.signal }), { name: "AbortError" });
    // Let intake reach the already-owned discovery, then abort the joined job.
    await delay(50);
    abort.abort();
    await Promise.all([preparing, discovery]);
    assert.ok(observations.some(event => event.type === "spawn"));
    assert.equal(observations.filter(event => event.type === "spawn").length,
      observations.filter(event => event.type === "exit").length);
    assert.deepEqual(await tempEntries(h.tempRoot), []);
  } finally { await executor.dispose(); }
});

test("missing real encoder, decoder and LDAC helper refuse explicitly without a fallback", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.4);

  const missingEncoder = makeFakeFfmpeg(h.root, "libopus", "");
  const encoderExecutor = new NativeCodecExecutor({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot: path.join(h.root, "encoder-temp"),
    ffmpegPath: missingEncoder,
  });
  t.after(() => encoderExecutor.dispose());
  const encoderCaps = await encoderExecutor.capabilities();
  const opus = encoderCaps.codecs.find((entry) => entry.codecId === "opus")!;
  assert.equal(opus.availability, "unavailable");
  assert.match(opus.reason ?? "", /encoder libopus is missing/);
  await assert.rejects(
    encoderExecutor.execute({ path: source }, codecRequest("opus", 128)),
    /unavailable.*encoder libopus/,
  );
  assert.deepEqual(await tempEntries(path.join(h.root, "encoder-temp")), []);

  const missingDecoder = makeFakeFfmpeg(h.root, "", "mp3float");
  const decoderExecutor = new NativeCodecExecutor({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot: path.join(h.root, "decoder-temp"),
    ffmpegPath: missingDecoder,
  });
  t.after(() => decoderExecutor.dispose());
  const decoderCaps = await decoderExecutor.capabilities();
  const mp3 = decoderCaps.codecs.find((entry) => entry.codecId === "mp3")!;
  assert.equal(mp3.availability, "unavailable");
  assert.match(mp3.reason ?? "", /decoder mp3float is missing/);
  await assert.rejects(
    decoderExecutor.execute({ path: source }, codecRequest("mp3", 128)),
    /unavailable.*decoder mp3float/,
  );

  const helperExecutor = new NativeCodecExecutor({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot: path.join(h.root, "helper-temp"),
    ldacHelperPath: path.join(h.root, "missing-ldac-helper"),
  });
  t.after(() => helperExecutor.dispose());
  const helperCaps = await helperExecutor.capabilities();
  const ldac = helperCaps.codecs.find((entry) => entry.codecId === "ldac")!;
  assert.equal(ldac.availability, "unavailable");
  assert.match(ldac.reason ?? "", /LDAC helper/);
  await assert.rejects(
    helperExecutor.execute({ path: source }, codecRequest("ldac", 660)),
    /unavailable.*LDAC helper/,
  );
  assert.deepEqual(await tempEntries(path.join(h.root, "helper-temp")), []);
});

test("malformed, oversized and non-finite sources fail closed and leave no private files", async (t) => {
  const h = await harness(t);

  const malformed = path.join(h.root, "malformed.wav");
  writeFileSync(malformed, "this is not a wave file\n");
  await assert.rejects(
    h.executor.execute({ path: malformed }, noopRequest()),
    (error: Error) => {
      assert.match(error.message, /Source probe|audio stream|WAV|FLAC/);
      assert.ok(!error.message.includes(malformed));
      assert.ok(!error.message.includes(h.root));
      return true;
    },
  );
  assert.deepEqual(await tempEntries(h.tempRoot), []);

  const oversized = path.join(h.root, "oversized.wav");
  const handle = await fs.open(oversized, "w");
  try {
    await handle.truncate(NATIVE_CODEC_MAX_SOURCE_BYTES + 1);
  } finally {
    await handle.close();
  }
  await assert.rejects(
    h.executor.execute({ path: oversized }, noopRequest()),
    /exceeds the .* byte bound/,
  );
  assert.deepEqual(await tempEntries(h.tempRoot), []);

  const nonFinite = path.join(h.root, "nonfinite.wav");
  writeFloat32WavWithNonFinite(nonFinite, 48_000);
  await assert.rejects(
    h.executor.execute({ path: nonFinite }, noopRequest()),
    /non-finite/,
  );
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("32-bit integer and float WAV sources decode analytically to Float64 before PCM16 policy", async (t) => {
  const h = await harness(t);

  const intFrames = [
    [0, 0],
    [65_536, -65_536],
    [1_073_741_824, -1_073_741_824],
    [2_147_483_647, -2_147_483_648],
  ];
  const intFile = path.join(h.root, "source-s32.wav");
  const intBytes = writePcm32Wav(intFile, "int", 48_000, 2, intFrames);
  const intResult = await h.executor.execute({ path: intFile }, noopRequest());
  assert.equal(intResult.session.sampleRate, 48_000);
  assert.equal(intResult.session.channels, 2);
  assert.equal(intResult.session.frames, intFrames.length);
  assert.equal(intResult.source.bytes, intBytes.byteLength);
  const intPcm = intResult.a.pcm;
  for (let frame = 0; frame < intFrames.length; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      assert.equal(intPcm.channels[channel]![frame], intFrames[frame]![channel]! / 2 ** 31);
    }
  }
  assert.equal(intResult.a.stages[0]!.inputSamplesOutsideUnitRange, 0);
  assert.equal(intResult.a.stages[0]!.pcm16ClampedSamples, 0);

  const floatFrames = [
    [0, -0],
    [1 / 1_048_576, -1 / 1_048_576],
    [2 / 32_768, -2 / 32_768],
    [0.5, -0.5],
    [1, -1],
    [1.5, -1.5],
  ];
  const floatFile = path.join(h.root, "source-f32.wav");
  const floatBytes = writePcm32Wav(floatFile, "float", 48_000, 2, floatFrames);
  const floatResult = await h.executor.execute({ path: floatFile }, noopRequest());
  assert.equal(floatResult.session.frames, floatFrames.length);
  assert.equal(floatResult.source.bytes, floatBytes.byteLength);
  const floatPcm = floatResult.a.pcm;
  for (let frame = 0; frame < floatFrames.length; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      // Float32 source values become exact doubles; no policy gain or clamp is
      // applied by the codec executor itself.
      assert.equal(floatPcm.channels[channel]![frame], Math.fround(floatFrames[frame]![channel]!));
    }
  }
  // The two out-of-range frames are counted, not silently clipped, by the
  // executor; the shared PCM16 policy owns the eventual clamp.
  assert.equal(floatResult.a.stages[0]!.inputSamplesOutsideUnitRange, 2);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("exact source bytes are privately snapshotted before progress observes them and source mutation does not change the run", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 1, 0.5);
  const original = await fs.readFile(source);
  const originalHash = (await import("node:crypto")).createHash("sha256").update(original).digest("hex");
  let mutated = false;

  const result = await h.executor.execute({ path: source }, noopRequest(), {
    onProgress: (progress) => {
      if (progress.phase === "loading" && !mutated) {
        mutated = true;
        writePcm16Wav(source, 48_000, 1, 0.2);
      }
    },
  });
  assert.equal(mutated, true);
  const mutatedBytes = await fs.readFile(source);
  const mutatedHash = (await import("node:crypto")).createHash("sha256").update(mutatedBytes).digest("hex");
  assert.notEqual(mutatedHash, originalHash);
  assert.equal(result.source.sha256, originalHash);
  assert.equal(result.source.bytes, original.byteLength);
  assert.equal(result.session.frames, Math.round(48_000 * 0.5));
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("cancellation during a native subprocess rejects AbortError, cleans every child, and allows retry", async (t) => {
  const h = await harness(t);
  const capabilities = await h.executor.capabilities();
  const codec = firstUsableCodec(capabilities);
  const bitrate = midBitrate(codec);
  const longSource = await h.source(96_000, 2, 12);
  const request: PreparationRequest = {
    version: 2,
    sampleRateMode: "native",
    a: [
      { codecId: codec, bitrateKbps: bitrate },
      { codecId: codec, bitrateKbps: bitrate },
      { codecId: codec, bitrateKbps: bitrate },
      { codecId: codec, bitrateKbps: bitrate },
    ],
    b: [
      { codecId: codec, bitrateKbps: bitrate },
      { codecId: codec, bitrateKbps: bitrate },
    ],
  };
  const before = h.observations.length;
  const controller = new AbortController();
  let scheduled = false;
  const running = h.executor.execute(
    { path: longSource },
    request,
    {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "probing" && !scheduled) {
          scheduled = true;
          // The source-decode subprocess starts immediately after this report.
          setTimeout(() => controller.abort(), 5);
        }
      },
    },
  );
  await assert.rejects(
    h.executor.execute({ path: longSource }, request),
    /already in progress/,
  );
  await assert.rejects(running, (error: Error) => error.name === "AbortError");
  assert.deepEqual(await tempEntries(h.tempRoot), []);

  const during = h.observations.slice(before);
  assert.ok(during.some((event) => event.type === "spawn"));
  assert.ok(during.some((event) => event.type === "exit"));
  for (const event of during) assert.equal(typeof event.detached, "boolean");
  const spawned = h.observations.filter((event) => event.type === "spawn").length;
  const exited = h.observations.filter((event) => event.type === "exit").length;
  assert.equal(spawned, exited);

  const retry = await h.executor.execute(
    { path: await h.source(48_000, 1, 0.4) },
    noopRequest(),
  );
  assert.equal(retry.session.sampleRate, 48_000);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("throwing progress callbacks cancel with the original failure, clean up, and permit retry", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.4);
  await assert.rejects(
    h.executor.execute({ path: source }, noopRequest(), {
      onProgress: (progress) => {
        if (progress.phase === "encoding") throw new Error("progress-callback-boom");
      },
    }),
    /progress-callback-boom/,
  );
  assert.deepEqual(await tempEntries(h.tempRoot), []);

  const retry = await h.executor.execute({ path: source }, noopRequest());
  assert.equal(retry.session.channels, 2);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("dispose is idempotent, cancels an in-flight capability probe and rejects later work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typescript-codecs-dispose-"));
  const tempRoot = path.join(root, "temp");
  const executor = new NativeCodecExecutor({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot,
    ffmpegPath: makeSleepingFfmpeg(root),
  });
  t.after(async () => {
    await executor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const probe = executor.capabilities();
  // Attach a rejection handler before disposal so cancellation is observed,
  // not reported as an unhandled rejection process failure.
  const probeResult = probe.then(
    () => null,
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  );
  await delay(100);
  await executor.dispose();
  await executor.dispose();
  const probeError = await probeResult;
  assert.ok(probeError !== null && probeError.name === "AbortError");
  await assert.rejects(executor.capabilities(), /disposed/);
  await assert.rejects(
    executor.execute(
      { path: path.join(root, "missing.wav") },
      noopRequest(),
    ),
    /disposed/,
  );
  assert.deepEqual(await tempEntries(tempRoot), []);
});
