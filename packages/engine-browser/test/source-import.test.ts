import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_WAV_BYTES,
} from "@codec-abx/contracts";

import {
  BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS,
  parseSourceWav,
  sha256Hex,
  type WavFacts,
} from "../src/wav.js";
import {
  BROWSER_AUDIO_IMPORT_FORMATS,
  DECODE_OUTPUT_CAP_HIT_TOLERANCE_BYTES,
  DECODE_OUTPUT_CAP_MARGIN_BYTES,
  SOURCE_DECODE_OUTPUT_CAP_BYTES,
  SOURCE_DECODE_SENTINEL_SECONDS,
  assertCanonicalByteLength,
  assertCanonicalFacts,
  assertDecodeOutputNotCapped,
  assertSourceByteLength,
  buildSourceDecodeArgs,
  classifyAudioSource,
  declaredFactNotes,
  decodeAudioSource,
  parseAudioProbeLog,
  snapshotAudioSource,
  type SourceImportCapture,
  type SourceImportHooks,
} from "../src/source-import.js";

interface WavOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2 | 3;
  readonly frames?: number;
  readonly bitsPerSample?: 16 | 24 | 32;
  readonly float?: boolean;
}

function makeWav(options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 48000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const float = options.float === true;
  if (float && bitsPerSample !== 32) throw new Error("test float WAV must be 32-bit");
  const frames = options.frames ?? Math.round(sampleRate * 0.01);
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(float ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  return new Uint8Array(bytes);
}

function facts(overrides: Partial<WavFacts> = {}): WavFacts {
  const sampleRate = overrides.sampleRate ?? 48000;
  const channels = overrides.channels ?? 1;
  const durationSeconds = overrides.durationSeconds ?? 1;
  const frames = overrides.frames ?? Math.round(sampleRate * durationSeconds);
  return {
    sampleRate,
    channels,
    frames,
    bitsPerSample: 16,
    dataOffset: 44,
    dataSize: frames * channels * 2,
    durationSeconds,
    ...overrides,
  };
}

function riffWav(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
}

function flacBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("fLaC"), 0);
  bytes[4] = 0x80;
  return bytes;
}

function oggBytes(): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set(new TextEncoder().encode("OggS"), 0);
  bytes.set(new TextEncoder().encode("OpusHead"), 28);
  return bytes;
}

function m4aBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, 24, false);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode("M4A "), 8);
  return bytes;
}

function mp3Bytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
  return bytes;
}

test("MPEG 2.5 MP3 sync is accepted without mistaking a reserved layer for ADTS", () => {
  const bytes = mp3Bytes();
  bytes[1] = 0xe3; // MPEG 2.5, Layer III, 11-bit sync (8/11.025/12 kHz).
  assert.equal(classifyAudioSource(bytes).id, "mp3");
  bytes[1] = 0xe1; // MPEG 2.5 with reserved layer, not a 12-bit ADTS sync.
  assert.throws(() => classifyAudioSource(bytes), /Unsupported audio source/);
});

test("WAV normalization cannot rescue truncated or inconsistent linear source structure", async () => {
  const complete = makeWav({ bitsPerSample: 24 });
  const snapshot = await snapshotAudioSource(complete, { sampleRateMode: "native" });
  assert.equal(snapshot.fastPcm16, null);
  await assert.rejects(
    snapshotAudioSource(complete.subarray(0, complete.length - 3), { sampleRateMode: "native" }),
    /RIFF size.*truncated/,
  );
  const inconsistent = complete.slice();
  new DataView(inconsistent.buffer).setUint16(32, 2, true);
  await assert.rejects(snapshotAudioSource(inconsistent, { sampleRateMode: "native" }), /inconsistent/);
});

function id3Mp3Bytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode("ID3"), 0);
  bytes[3] = 4;
  bytes[4] = 0;
  bytes[5] = 0;
  // Syncsafe tag size 0, so the MPEG frame starts at byte 10.
  bytes.set([0xff, 0xfb, 0x90, 0x64], 10);
  return bytes;
}

function adtsBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  // ADTS, MPEG-4, layer 00, protection absent, 44.1 kHz sampling index 4.
  bytes.set([0xff, 0xf1, 0x50, 0x80], 0);
  return bytes;
}

function durationText(seconds: number): string {
  const whole = Math.floor(seconds);
  const centis = Math.round((seconds - whole) * 100);
  return `00:${String(Math.floor(whole / 60)).padStart(2, "0")}:` +
    `${String(whole % 60).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

interface ProbeFacts {
  readonly container: string;
  readonly codec: string;
  readonly rate: number;
  readonly layout: string;
  readonly seconds: number;
}

function probeLog(options: ProbeFacts): string {
  return [
    "ffmpeg version 5.1.4",
    `Input #0, ${options.container}, from 'source':`,
    `  Duration: ${durationText(options.seconds)}, start: 0.000000, bitrate: 128 kb/s`,
    `  Stream #0:0: Audio: ${options.codec}, ${String(options.rate)} Hz, ${options.layout}, fltp, 128 kb/s`,
  ].join("\n");
}

class FakeHooks implements SourceImportHooks {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: string[][] = [];
  readonly deleteAttempts: string[] = [];
  readonly tracked: string[] = [];
  probeOutput = "";
  canonical: Uint8Array | null = null;
  decodeCode = 0;
  decodeOutput = "";
  checkCalls = 0;
  cancelOnCheck: number | null = null;
  readonly abortError = new DOMException("Source import aborted", "AbortError");

  async exec(args: readonly string[]): Promise<SourceImportCapture> {
    this.calls.push([...args]);
    const isDecode = args[args.length - 3] === "-f" && args[args.length - 2] === "wav";
    if (!isDecode) return { code: 1, output: this.probeOutput };
    const outputName = args[args.length - 1]!;
    if (this.canonical !== null) this.files.set(outputName, this.canonical);
    return { code: this.decodeCode, output: this.decodeOutput };
  }

  async writeFile(name: string, bytes: Uint8Array): Promise<void> {
    this.files.set(name, bytes);
  }

  async readFile(name: string): Promise<Uint8Array> {
    const bytes = this.files.get(name);
    if (!bytes) throw new Error(`Fake MEMFS has no ${name}`);
    return bytes;
  }

  async deleteFile(name: string): Promise<void> {
    this.deleteAttempts.push(name);
    if (!this.files.delete(name)) throw new Error(`Fake MEMFS has no ${name}`);
  }

  trackFile(name: string): void {
    this.tracked.push(name);
  }

  async checkCancelled(): Promise<void> {
    this.checkCalls += 1;
    if (this.cancelOnCheck === this.checkCalls) throw this.abortError;
  }
}

test("classifies supported containers from bytes rather than names", () => {
  assert.equal(classifyAudioSource(riffWav()).id, "wav");
  assert.equal(classifyAudioSource(flacBytes()).id, "flac");
  assert.equal(classifyAudioSource(mp3Bytes()).id, "mp3");
  assert.equal(classifyAudioSource(id3Mp3Bytes()).id, "mp3");
  const taggedFlac = new Uint8Array(10 + flacBytes().length);
  taggedFlac.set(new TextEncoder().encode("ID3"));
  taggedFlac[3] = 4;
  taggedFlac.set(flacBytes(), 10);
  assert.equal(classifyAudioSource(taggedFlac).id, "flac");
  assert.equal(classifyAudioSource(adtsBytes()).id, "aac");
  assert.equal(classifyAudioSource(oggBytes()).id, "ogg");
  assert.equal(classifyAudioSource(m4aBytes()).id, "m4a");

  assert.deepEqual(
    BROWSER_AUDIO_IMPORT_FORMATS.map((format) => format.demuxer),
    ["wav", "flac", "mp3", "mov", "ogg", "aac"],
  );
});

test("refuses playlists, network lists and unknown bytes before FFmpeg runs", () => {
  assert.throws(() => classifyAudioSource(new TextEncoder().encode("#EXTM3U\n")), /Unsupported/);
  assert.throws(
    () => classifyAudioSource(new TextEncoder().encode("http://example.invalid/a.flac\n")),
    /Unsupported/,
  );
  assert.throws(() => classifyAudioSource(new Uint8Array(64)), /Unsupported/);
  assert.throws(() => classifyAudioSource(new Uint8Array(0)), /Unsupported/);
});

test("parses real FFmpeg input-probe lines including multichannel layouts", () => {
  const flac = parseAudioProbeLog(probeLog({
    container: "flac", codec: "flac", rate: 44100, layout: "stereo", seconds: 200.5,
  }));
  assert.equal(flac.container, "flac");
  assert.equal(flac.codec, "flac");
  assert.equal(flac.sampleRate, 44100);
  assert.equal(flac.channels, 2);
  assert.equal(flac.durationSeconds, 200.5);

  const multichannel = parseAudioProbeLog(probeLog({
    container: "wav", codec: "pcm_s24le", rate: 96000, layout: "5.1(side)", seconds: 3,
  }));
  assert.equal(multichannel.channels, 6);
  assert.equal(multichannel.sampleRate, 96000);

  const counted = parseAudioProbeLog(
    "Input #0, ogg, from 'x':\n  Duration: N/A, start: 0.000000\n" +
      "  Stream #0:0: Audio: opus, 48000 Hz, 3 channels, fltp",
  );
  assert.equal(counted.channels, 3);
  assert.equal(counted.durationSeconds, null);

  const missing = parseAudioProbeLog("Input #0, mov, from 'x':\n  Duration: 00:00:01.00");
  assert.equal(missing.codec, null);
  assert.equal(missing.channels, null);
  assert.equal(missing.durationSeconds, 1);
});

test("strict PCM16 WAV is already canonical; non-PCM16 WAV falls back to decode", async () => {
  const pcm = makeWav({ sampleRate: 48000, channels: 2, frames: 48000 });
  const snapshot = await snapshotAudioSource(pcm, { sampleRateMode: "native" });
  assert.equal(snapshot.format.id, "wav");
  assert.equal(snapshot.fastPcm16?.sampleRate, 48000);
  assert.equal(snapshot.fastPcm16?.channels, 2);
  assert.equal(snapshot.sha256, await sha256Hex(pcm));

  const wide = makeWav({ sampleRate: 48000, channels: 2, frames: 480, bitsPerSample: 24 });
  const wideSnapshot = await snapshotAudioSource(wide, { sampleRateMode: "native" });
  assert.equal(wideSnapshot.fastPcm16, null);

  const forced = await snapshotAudioSource(
    makeWav({ sampleRate: 44100 }),
    { sampleRateMode: "force_48k" },
  );
  assert.equal(forced.fastPcm16, null);
  assert.notEqual(
    (await snapshotAudioSource(pcm, { sampleRateMode: "force_48k" })).fastPcm16,
    null,
  );

  await assert.rejects(
    snapshotAudioSource(makeWav({ sampleRate: 32000 }), { sampleRateMode: "native" }),
    /unsupported in native mode/,
  );
  await assert.doesNotReject(
    snapshotAudioSource(makeWav({ sampleRate: 32000 }), { sampleRateMode: "force_48k" }),
  );
});

test("source and canonical limits are enforced numerically and never crop", () => {
  assert.throws(() => assertSourceByteLength(0), /empty/);
  assert.doesNotThrow(() => assertSourceByteLength(AUDIO_MAX_INPUT_BYTES));
  assert.throws(
    () => assertSourceByteLength(AUDIO_MAX_INPUT_BYTES + 1),
    /encoded\/container limit/,
  );

  assert.doesNotThrow(() => assertCanonicalByteLength(AUDIO_MAX_WAV_BYTES));
  assert.throws(
    () => assertCanonicalByteLength(AUDIO_MAX_WAV_BYTES + 1),
    /No truncated excerpt/,
  );

  const capCeiling = SOURCE_DECODE_OUTPUT_CAP_BYTES -
    DECODE_OUTPUT_CAP_HIT_TOLERANCE_BYTES;
  assert.equal(
    SOURCE_DECODE_OUTPUT_CAP_BYTES,
    AUDIO_MAX_WAV_BYTES + DECODE_OUTPUT_CAP_MARGIN_BYTES,
  );
  assert.throws(() => assertDecodeOutputNotCapped(capCeiling), /safety cap/);
  assert.doesNotThrow(() => assertDecodeOutputNotCapped(capCeiling - 1));

  assert.doesNotThrow(() => assertCanonicalFacts(
    facts({ durationSeconds: AUDIO_MAX_DURATION_SECONDS + BROWSER_SOURCE_PADDING_TOLERANCE_SECONDS - 1e-9 }),
    "native",
  ));
  assert.throws(
    () => assertCanonicalFacts(
      facts({ durationSeconds: AUDIO_MAX_DURATION_SECONDS + 1 }),
      "native",
    ),
    /refused rather than silently cropped/,
  );
  assert.throws(
    () => assertCanonicalFacts(facts({ sampleRate: 32000 }), "native"),
    /unsupported in native mode/,
  );
  assert.throws(
    () => assertCanonicalFacts(facts({ sampleRate: 44100 }), "force_48k"),
    /produced 44100 Hz/,
  );

  const multichannel = declaredFactNotes(
    { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 6, durationSeconds: 1 },
    "native",
  );
  assert.ok(multichannel.some((line) => /never downmixed/.test(line)));

  const overlong = declaredFactNotes(
    { container: "flac", codec: "flac", sampleRate: 44100, channels: 2, durationSeconds: 1801 },
    "native",
  );
  assert.ok(overlong.some((line) => /bounded 1810 s decode/.test(line)));

  const badRate = declaredFactNotes(
    { container: "flac", codec: "flac", sampleRate: 32000, channels: 2, durationSeconds: 1 },
    "native",
  );
  assert.ok(badRate.some((line) => /decoded canonical rate is authoritative/.test(line)));
  assert.deepEqual(declaredFactNotes(
    { container: "flac", codec: "flac", sampleRate: 32000, channels: 2, durationSeconds: 1 },
    "force_48k",
  ), []);
});

test("decode arguments bound time and bytes without forcing rate or channels", () => {
  const flac = BROWSER_AUDIO_IMPORT_FORMATS.find((format) => format.id === "flac")!;
  assert.deepEqual(buildSourceDecodeArgs(flac, "native", "in.flac", "canon.wav"), [
    "-hide_banner", "-nostdin", "-xerror", "-protocol_whitelist", "file",
    "-f", "flac", "-i", "in.flac",
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
    "-c:a", "pcm_s16le",
    "-t", String(AUDIO_MAX_DURATION_SECONDS + SOURCE_DECODE_SENTINEL_SECONDS),
    "-fs", String(SOURCE_DECODE_OUTPUT_CAP_BYTES),
    "-f", "wav", "canon.wav",
  ]);
  const forced = buildSourceDecodeArgs(flac, "force_48k", "in.flac", "canon.wav");
  assert.deepEqual(forced.slice(forced.indexOf("-ar"), forced.indexOf("-ar") + 2), ["-ar", "48000"]);
  assert.equal(forced.includes("-ac"), false);
});

test("decodes a FLAC source exactly once, deletes the encoded MEMFS file and discloses quantization", async () => {
  const source = flacBytes();
  const snapshot = await snapshotAudioSource(source, { sampleRateMode: "native" });
  const hooks = new FakeHooks();
  hooks.probeOutput = probeLog({
    container: "flac", codec: "flac", rate: 44100, layout: "stereo", seconds: 1,
  });
  hooks.canonical = makeWav({ sampleRate: 44100, channels: 2, frames: 44100 });

  const imported = await decodeAudioSource(hooks, snapshot, {
    inputName: "src_job", canonicalName: "canon_job.wav",
  });

  assert.equal(imported.decodedByFfmpeg, true);
  assert.equal(imported.canonical.sampleRate, 44100);
  assert.equal(imported.canonical.channels, 2);
  assert.equal(imported.canonical.frames, 44100);
  assert.equal(imported.sourceSha256, snapshot.sha256);
  assert.equal(imported.sourceByteLength, source.byteLength);
  assert.ok(hooks.files.has("canon_job.wav"));
  assert.equal(hooks.files.has("src_job"), false);
  assert.deepEqual(hooks.deleteAttempts, ["src_job"]);
  assert.deepEqual(hooks.tracked, ["canon_job.wav"]);
  assert.equal(hooks.calls.length, 2);

  const [probeArgs, decodeArgs] = hooks.calls;
  assert.ok(probeArgs?.includes("-protocol_whitelist"));
  assert.ok(probeArgs?.includes("file"));
  assert.deepEqual(probeArgs?.slice(probeArgs.indexOf("-f"), probeArgs.indexOf("-f") + 2), ["-f", "flac"]);
  assert.ok(decodeArgs?.includes("pcm_s16le"));
  assert.ok(decodeArgs?.includes("-map"));
  assert.ok(decodeArgs?.includes("-t"));
  assert.ok(decodeArgs?.includes("-fs"));
  assert.equal(decodeArgs?.includes("-ar"), false);
  assert.equal(decodeArgs?.includes("-ac"), false);

  assert.ok(imported.disclosures.some((line) => /decoded the source exactly once/.test(line) &&
    /Both Side A and Side B/.test(line)));
  assert.ok(imported.disclosures.some((line) => /lossless, but the canonical snapshot/.test(line)));
  assert.ok(imported.disclosures.some((line) => /file extension and MIME type were not used/.test(line)));
  assert.ok(imported.disclosures.some((line) => /Source SHA-256 covers the original/.test(line)));
});

test("an MP3 renamed as WAV still uses the MP3 demuxer and states lossy irreversibility", async () => {
  const source = mp3Bytes();
  const snapshot = await snapshotAudioSource(source, { sampleRateMode: "native" });
  const hooks = new FakeHooks();
  hooks.probeOutput = probeLog({
    container: "mp3", codec: "mp3", rate: 44100, layout: "stereo", seconds: 1,
  });
  hooks.canonical = makeWav({ sampleRate: 44100, channels: 2, frames: 44100 });

  const imported = await decodeAudioSource(hooks, snapshot, {
    inputName: "renamed.wav", canonicalName: "canon.wav",
  });

  assert.equal(imported.format.id, "mp3");
  const decodeArgs = hooks.calls[1]!;
  assert.deepEqual(decodeArgs.slice(decodeArgs.indexOf("-f"), decodeArgs.indexOf("-f") + 2), ["-f", "mp3"]);
  assert.ok(imported.disclosures.some((line) => /is lossy; decoding does not restore/.test(line)));
});

test("explicit force-48k resamples once at import and preserves stereo", async () => {
  const source = makeWav({ sampleRate: 44100, channels: 2, frames: 44100 });
  const snapshot = await snapshotAudioSource(source, { sampleRateMode: "force_48k" });
  assert.equal(snapshot.fastPcm16, null);
  const hooks = new FakeHooks();
  hooks.probeOutput = probeLog({
    container: "wav", codec: "pcm_s16le", rate: 44100, layout: "stereo", seconds: 1,
  });
  hooks.canonical = makeWav({ sampleRate: 48000, channels: 2, frames: 48000 });

  const imported = await decodeAudioSource(hooks, snapshot, {
    inputName: "src", canonicalName: "canon.wav",
  });
  assert.equal(imported.canonical.sampleRate, 48000);
  assert.equal(imported.canonical.channels, 2);
  const decodeArgs = hooks.calls[1]!;
  assert.deepEqual(decodeArgs.slice(decodeArgs.indexOf("-ar"), decodeArgs.indexOf("-ar") + 2), ["-ar", "48000"]);
  assert.ok(imported.disclosures.some((line) => /force-48k policy resampled once/.test(line)));
  assert.ok(imported.disclosures.some((line) => /intentional request, not a hidden browser resample/.test(line)));
});

test("declared probe facts never override decoded canonical facts", async () => {
  // Real raw ADTS AAC commonly declares a slightly longer duration than the
  // decoded frames. Here the declaration also overstates the layout; the
  // bounded decode's actual 600.027 s mono snapshot is authoritative.
  const snapshot = await snapshotAudioSource(flacBytes(), { sampleRateMode: "native" });
  const hooks = new FakeHooks();
  hooks.probeOutput = probeLog({
    container: "aac", codec: "aac", rate: 48000, layout: "6.1", seconds: 601.82,
  });
  hooks.canonical = makeWav({
    sampleRate: 48000,
    channels: 1,
    frames: Math.round(48000 * 600.027),
  });

  const imported = await decodeAudioSource(hooks, snapshot, {
    inputName: "src", canonicalName: "canon.wav",
  });
  assert.equal(imported.canonical.channels, 1);
  assert.equal(imported.canonical.sampleRate, 48000);
  assert.ok(Math.abs(imported.canonical.durationSeconds - 600.027) < 1e-9);
  assert.equal(hooks.calls.length, 2);
  assert.ok(imported.disclosures.some((line) => /probe differed on channel count, duration/.test(line)));
  assert.ok(imported.disclosures.some((line) => /never downmixed/.test(line)));
  // A 601.82 s declaration is inside the expanded 1800 s envelope, so it adds
  // no overlong-probe note; the overlong note is exercised separately.
  assert.equal(
    imported.disclosures.some((line) => /above the 1800 s limit/.test(line)),
    false,
  );
});

test("lying-short metadata cannot smuggle decoded material past the duration limit", async () => {
  const snapshot = await snapshotAudioSource(flacBytes(), { sampleRateMode: "native" });
  const hooks = new FakeHooks();
  hooks.probeOutput = probeLog({
    container: "flac", codec: "flac", rate: 48000, layout: "stereo", seconds: 100,
  });
  // 1801 s exceeds the limit even though the probe declared 100 s. The decoded
  // facts, not the declared duration, are authoritative. The unsupported 8 kHz
  // rate keeps the fixture small: the duration guard runs before the rate guard.
  hooks.canonical = makeWav({ sampleRate: 8000, channels: 1, frames: 8000 * 1801 });

  await assert.rejects(
    decodeAudioSource(hooks, snapshot, { inputName: "src", canonicalName: "canon.wav" }),
    /refused rather than silently cropped/,
  );
  assert.equal(hooks.calls.length, 2);
  assert.equal(hooks.files.has("src"), false);
});

test("a corrupt or truncated source with no probeable audio stream is refused", async () => {
  const snapshot = await snapshotAudioSource(flacBytes(), { sampleRateMode: "native" });
  const hooks = new FakeHooks();
  hooks.probeOutput =
    "Input #0, flac, from 'source':\n  Duration: N/A, start: 0.000000\n" +
    "[flac @ 0x1] invalid frame header\n";
  await assert.rejects(
    decodeAudioSource(hooks, snapshot, { inputName: "src", canonicalName: "canon.wav" }),
    /did not identify a decodable audio stream/,
  );
  assert.equal(hooks.calls.length, 1);
  assert.ok(hooks.deleteAttempts.includes("canon.wav"));
});

test("decoded multichannel, malformed and failed decodes are refused without bad bytes", async () => {
  const snapshot = await snapshotAudioSource(flacBytes(), { sampleRateMode: "native" });

  const multichannel = new FakeHooks();
  multichannel.probeOutput = probeLog({
    container: "flac", codec: "flac", rate: 48000, layout: "stereo", seconds: 1,
  });
  multichannel.canonical = makeWav({ sampleRate: 48000, channels: 3, frames: 4800 });
  await assert.rejects(
    decodeAudioSource(multichannel, snapshot, { inputName: "src", canonicalName: "canon.wav" }),
    /not a valid canonical PCM16 WAV.*unsupported channel count/,
  );
  assert.ok(multichannel.deleteAttempts.includes("canon.wav"));

  const malformed = new FakeHooks();
  malformed.probeOutput = probeLog({
    container: "flac", codec: "flac", rate: 48000, layout: "stereo", seconds: 1,
  });
  malformed.canonical = new Uint8Array(64);
  await assert.rejects(
    decodeAudioSource(malformed, snapshot, { inputName: "src", canonicalName: "canon.wav" }),
    /not a valid canonical PCM16 WAV/,
  );

  const failed = new FakeHooks();
  failed.probeOutput = probeLog({
    container: "flac", codec: "flac", rate: 48000, layout: "stereo", seconds: 1,
  });
  failed.decodeCode = 1;
  failed.decodeOutput = "Invalid data found when processing input\n";
  failed.canonical = makeWav({ sampleRate: 48000, channels: 2, frames: 4800 });
  await assert.rejects(
    decodeAudioSource(failed, snapshot, { inputName: "src", canonicalName: "canon.wav" }),
    /FFmpeg source decode failed with exit code 1.*Invalid data/s,
  );
  assert.ok(failed.deleteAttempts.includes("canon.wav"));
});

test("cancellation stops import between stages and propagates the caller's error", async () => {
  const snapshot = await snapshotAudioSource(flacBytes(), { sampleRateMode: "native" });
  const hooks = new FakeHooks();
  hooks.probeOutput = probeLog({
    container: "flac", codec: "flac", rate: 48000, layout: "stereo", seconds: 1,
  });
  hooks.canonical = makeWav({ sampleRate: 48000, channels: 2, frames: 4800 });
  // Call 1: entry; 2: before probe; 3: after probe. Cancel there, before decode.
  hooks.cancelOnCheck = 3;

  await assert.rejects(
    decodeAudioSource(hooks, snapshot, { inputName: "src", canonicalName: "canon.wav" }),
    (error: unknown) => error === hooks.abortError,
  );
  assert.equal(hooks.calls.length, 1);
  assert.ok(hooks.deleteAttempts.includes("canon.wav"));
  // The engine's owned-file cleanup owns the still-pending encoded input.
  assert.ok(hooks.files.has("src"));
});

test("an already-canonical PCM16 source is written once and never decoded", async () => {
  const source = makeWav({ sampleRate: 48000, channels: 1, frames: 4800 });
  const snapshot = await snapshotAudioSource(source, { sampleRateMode: "native" });
  const hooks = new FakeHooks();

  const imported = await decodeAudioSource(hooks, snapshot, {
    inputName: "src", canonicalName: "canon.wav",
  });

  assert.equal(hooks.calls.length, 0);
  assert.deepEqual(hooks.deleteAttempts, []);
  assert.equal(imported.decodedByFfmpeg, false);
  assert.equal(imported.canonical.frames, 4800);
  assert.ok(hooks.files.has("canon.wav"));
  assert.ok(imported.disclosures.some((line) => /adopted directly as the shared canonical snapshot/.test(line)));
  assert.ok(imported.disclosures.some((line) => /adopted unchanged; import did not quantize/.test(line)));
});

test("32-bit integer and float WAV sources are structurally accepted then decoded", async () => {
  for (const options of [
    { bitsPerSample: 32 as const, float: false, codec: "pcm_s32le", label: "32-bit integer" },
    { bitsPerSample: 32 as const, float: true, codec: "pcm_f32le", label: "32-bit float" },
  ]) {
    const source = makeWav({
      sampleRate: 48000,
      channels: 2,
      frames: 960,
      bitsPerSample: options.bitsPerSample,
      float: options.float,
    });
    // Source facts are established before any canonical conversion.
    const sourceFacts = parseSourceWav(source);
    assert.equal(sourceFacts.bitsPerSample, 32);
    assert.equal(sourceFacts.format, options.float ? 3 : 1);
    assert.equal(sourceFacts.validBits, 32);
    assert.equal(sourceFacts.channels, 2);
    assert.equal(sourceFacts.frames, 960);
    assert.equal(sourceFacts.dataSize, 960 * 2 * 4);

    const snapshot = await snapshotAudioSource(source, { sampleRateMode: "native" });
    assert.equal(snapshot.format.id, "wav");
    // Higher precision is a source, never the canonical delivery snapshot.
    assert.equal(snapshot.fastPcm16, null);
    assert.equal(snapshot.byteLength, source.byteLength);

    const hooks = new FakeHooks();
    hooks.probeOutput = probeLog({
      container: "wav", codec: options.codec, rate: 48000, layout: "stereo", seconds: 0.02,
    });
    hooks.canonical = makeWav({ sampleRate: 48000, channels: 2, frames: 960 });
    const imported = await decodeAudioSource(hooks, snapshot, {
      inputName: "src", canonicalName: "canon.wav",
    });
    assert.equal(imported.decodedByFfmpeg, true);
    assert.equal(imported.canonical.sampleRate, 48000);
    assert.equal(imported.canonical.channels, 2);
    assert.ok(imported.disclosures.some((line) =>
      /any source precision above 16 bits \(including 32-bit integer or float WAV\)/.test(line)));
    assert.ok(imported.disclosures.some((line) =>
      /No lossless restoration beyond that snapshot is claimed/.test(line)));
    const decodeArgs = hooks.calls[1]!;
    assert.ok(decodeArgs.includes("pcm_s16le"));
    assert.equal(
      decodeArgs.slice(decodeArgs.indexOf("-f"), decodeArgs.indexOf("-f") + 2)[1],
      "wav",
    );
  }
});
