import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodePcm16Wav } from "../../preparation-policy/src/pcm16.js";
import { NativeCodecExecutor, resolveNativeBinaries } from "../src/typescript/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const request = {
  version: 1 as const, sampleRateMode: "native" as const,
  a: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
  b: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
};

test("real compressed sources keep original hashes and feed identical native no-op chains", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-audio-import-"));
  const executor = new NativeCodecExecutor({ repositoryRoot, tempRoot: path.join(directory, "jobs") });
  t.after(async () => { await executor.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const ffmpeg = resolveNativeBinaries({ repositoryRoot }).ffmpegPath;
  assert.ok(ffmpeg);
  const channels = [440, 997].map(hz => Float64Array.from({ length: 48_000 },
    (_, frame) => 0.2 * Math.sin(2 * Math.PI * hz * frame / 48_000)));
  const input = path.join(directory, "source.wav");
  await fs.writeFile(input, encodePcm16Wav(channels, 48_000).bytes);
  for (const [extension, codec] of [["flac", "flac"], ["mp3", "libmp3lame"],
    ["m4a", "aac"], ["aac", "aac"], ["ogg", "libvorbis"], ["opus", "libopus"]]) {
    const source = path.join(directory, `source.${extension}`);
    execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-i", input, "-c:a", codec!, source], { timeout: 30_000 });
    const bytes = await fs.readFile(source);
    const result = await executor.execute({ path: source }, request);
    assert.equal(result.source.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.session.channels, 2);
    assert.equal(result.session.sampleRate, 48_000);
    assert.deepEqual(result.a.pcm.channels, result.b.pcm.channels);
    assert.notEqual(result.a.pcm.channels[0]![101], result.a.pcm.channels[1]![101]);
  }
});

test("overestimated probe duration cannot refuse short valid audio before bounded decoding", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-estimated-duration-"));
  const binaries = resolveNativeBinaries({ repositoryRoot });
  assert.ok(binaries.ffmpegPath && binaries.ffprobePath);
  const source = path.join(directory, "source.aac");
  execFileSync(binaries.ffmpegPath, ["-nostdin", "-v", "error", "-f", "lavfi",
    "-i", "sine=frequency=997:sample_rate=48000", "-t", "1", "-c:a", "aac", source]);
  const probe = path.join(directory, "estimated-ffprobe");
  await fs.writeFile(probe, `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const result = spawnSync(${JSON.stringify(binaries.ffprobePath)}, process.argv.slice(2), {encoding:'utf8'});
let output = result.stdout;
try {
  const value = JSON.parse(output);
  // The private snapshot path differs: source probes are selected by -select_streams.
  if (value.streams && process.argv.includes('-select_streams')) {
    for (const stream of value.streams) stream.duration = '600.801864';
    if (value.format) value.format.duration = '600.801864';
  }
  output = JSON.stringify(value);
} catch {}
process.stdout.write(output || ''); process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
  const executor = new NativeCodecExecutor({ repositoryRoot, ffprobePath: probe, tempRoot: path.join(directory, "jobs") });
  t.after(async () => { await executor.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const result = await executor.execute({ path: source }, request);
  assert.ok(result.session.durationSeconds >= 1 && result.session.durationSeconds < 1.1);
});
