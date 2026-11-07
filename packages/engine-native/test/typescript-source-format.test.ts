import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  NativeCodecExecutor,
  NATIVE_SOURCE_EXTENSIONS,
  acceptsProbedCodec,
  acceptsProbedContainer,
  resolveNativeSourceFormat,
} from "../src/typescript/index.js";

test("extension allowlist selects explicit FFmpeg demuxers", () => {
  const expected: ReadonlyArray<readonly [string, string, string]> = [
    ["track.wav", "wav", "wav"],
    ["track.flac", "flac", "flac"],
    ["track.mp3", "mp3", "mp3"],
    ["track.aac", "aac", "aac"],
    ["track.m4a", "m4a", "mov"],
    ["track.mp4", "m4a", "mov"],
    ["track.ogg", "ogg", "ogg"],
    ["track.oga", "ogg", "ogg"],
    // An Opus bitstream lives in Ogg: `opus` is not an FFmpeg demuxer name.
    ["track.opus", "opus", "ogg"],
  ];
  for (const [file, id, demuxer] of expected) {
    const format = resolveNativeSourceFormat(file);
    assert.ok(format, `${file} must resolve`);
    assert.equal(format.id, id, file);
    assert.equal(format.demuxer, demuxer, file);
  }
  assert.deepEqual(
    [...NATIVE_SOURCE_EXTENSIONS].sort(),
    ["aac", "flac", "m4a", "mp3", "mp4", "oga", "ogg", "opus", "wav"],
  );
  for (const rejected of ["track.m3u", "track.m3u8", "track.pls", "track.webm", "track.txt", "track"]) {
    assert.equal(resolveNativeSourceFormat(rejected), null, rejected);
  }
});

test("probe facts must agree with the selected container and codec family", () => {
  const m4a = resolveNativeSourceFormat("track.m4a");
  assert.ok(m4a);
  assert.equal(
    acceptsProbedContainer(m4a, "mov,mp4,m4a,3gp,3g2,mj2"),
    true,
  );
  assert.equal(acceptsProbedContainer(m4a, "wav"), false);
  assert.equal(acceptsProbedCodec(m4a, "aac"), true);
  assert.equal(acceptsProbedCodec(m4a, "alac"), true);
  assert.equal(acceptsProbedCodec(m4a, "vorbis"), false);

  const opus = resolveNativeSourceFormat("track.opus");
  assert.ok(opus);
  assert.equal(acceptsProbedContainer(opus, "ogg"), true);
  assert.equal(acceptsProbedCodec(opus, "opus"), true);
  assert.equal(acceptsProbedCodec(opus, "vorbis"), false);
});

async function setupFakeTools(
  t: TestContext,
  options: { readonly probeContainer?: string } = {},
): Promise<{
  readonly root: string;
  readonly log: string;
  readonly executor: NativeCodecExecutor;
  readonly source: (name: string) => Promise<string>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-source-format-"));
  const log = path.join(root, "args.log");
  const ffmpeg = path.join(root, "fake-ffmpeg");
  const ffprobe = path.join(root, "fake-ffprobe");
  await fs.writeFile(ffmpeg, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("-version")) { process.stdout.write("ffmpeg version fixture\\n"); process.exit(0); }
if (args.includes("-encoders")) { process.stdout.write(" V..... libopus             Opus\\n"); process.exit(0); }
if (args.includes("-decoders")) { process.stdout.write(" A..... opus                Opus\\n"); process.exit(0); }
if (args.includes("-muxers")) { process.stdout.write("  E.... opus                Ogg Opus\\n"); process.exit(0); }
if (args.includes("-demuxers")) { process.stdout.write("  D.... ogg                 Ogg\\n"); process.exit(0); }
process.stderr.write("synthetic decode failure\\n");
process.exit(2);
`, { mode: 0o700 });
  await fs.writeFile(ffprobe, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("-version")) { process.stdout.write("ffprobe version fixture\\n"); process.exit(0); }
const input = args[args.length - 1] || "";
const forced = ${JSON.stringify(options.probeContainer ?? null)};
if (forced !== null) {
  process.stdout.write(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, duration: "1" }], format: { format_name: forced, duration: "1" } }));
} else if (input.endsWith(".opus")) {
  process.stdout.write(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "opus", sample_rate: "48000", channels: 2, duration: "1" }], format: { format_name: "ogg", duration: "1" } }));
} else {
  process.stdout.write(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2, duration: "1" }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1" } }));
}
`, { mode: 0o700 });
  const executor = new NativeCodecExecutor({
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    tempRoot: path.join(root, "temp"),
  });
  t.after(async () => {
    await executor.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  let index = 0;
  return {
    root,
    log,
    executor,
    source: async (name: string) => {
      const file = path.join(root, `${String(index++)}-${name}`);
      await fs.writeFile(file, "not a real media file");
      return file;
    },
  };
}

const REQUEST = {
  version: 1 as const,
  sampleRateMode: "native" as const,
  a: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
  b: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
};

async function decodeArgs(log: string): Promise<readonly string[] | null> {
  const lines = (await fs.readFile(log, "utf8")).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const args = JSON.parse(line) as string[];
    if (args.includes("-i")) return args;
  }
  return null;
}

test("m4a decode passes -f mov and opus decode passes -f ogg to FFmpeg", async (t) => {
  const h = await setupFakeTools(t);
  const m4a = await h.source("track.m4a");
  await assert.rejects(h.executor.execute({ path: m4a }, REQUEST), /Source decode failed/);
  const m4aArgs = await decodeArgs(h.log);
  assert.ok(m4aArgs);
  const m4aFormat = m4aArgs[m4aArgs.indexOf("-f") + 1];
  assert.equal(m4aFormat, "mov");
  assert.ok(m4aArgs.includes("file,pipe"), "protocol whitelist must stay file,pipe");

  await fs.rm(h.log, { force: true });
  const opus = await h.source("track.opus");
  await assert.rejects(h.executor.execute({ path: opus }, REQUEST), /Source decode failed/);
  const opusArgs = await decodeArgs(h.log);
  assert.ok(opusArgs);
  assert.equal(opusArgs[opusArgs.indexOf("-f") + 1], "ogg");
});

test("a container that disagrees with its extension is refused before decode", async (t) => {
  const h = await setupFakeTools(t, { probeContainer: "wav" });
  const source = await h.source("mismatch.m4a");
  await assert.rejects(
    h.executor.execute({ path: source }, REQUEST),
    /does not match the selected M4A\/MP4 extension/,
  );
  assert.equal(await decodeArgs(h.log), null, "no decode may run for a mismatched container");
});
