/**
 * Supplemental codec parity (native↔browser), executed in Node when the built
 * artifacts exist. Mirrors the repository's optional-codec policy: tests skip
 * when third_party/wasm/bin or the vendored native tools are missing, and a
 * skipped test is never evidence of a pass.
 *
 * Boundaries proven here:
 * 1. Browser WASM LDAC encode equals native ldac_helper container bytes
 *    (sha256) for identical padded s16le input; the TS v1 container writer
 *    behaves exactly like the helper's writer.
 * 2. Browser WASM LDAC decode equals the native helper decode PCM on the same
 *    container (warmup skip and trim mirrored engine-side).
 * 3. Browser WASM LC3 frame payloads equal the vendored ffmpeg/liblc3 encode
 *    payloads, including header conventions and the closing zero block.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";

function refVsIndexed(reference: Int16Array, index: number): number {
  return reference[index - 1] ?? -1;
}
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import {
  instantiateGlue,
  createLdacEncoderSession,
  createLdacDecoderSession,
  createLc3EncoderSession,
  createLc3DecoderSession,
  type SupplementalLoader,
} from "../src/supplemental-codecs.js";
import { parseLdacContainer, writeLdacContainer } from "../src/ldac-container.js";
import {
  Lc3ContainerWriter,
  parseLc3Frames,
  parseLc3Header,
} from "../src/lc3-container.js";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const wasmDir = path.join(repoRoot, "third_party", "wasm", "bin");
const ffmpegBin = path.join(repoRoot, "third_party", "ffmpeg", "bin");
const ldacHelperBin = path.join(repoRoot, "third_party", "ldac", "bin");

const wasmPresent = ["lc3_codec.js", "lc3_codec.wasm", "ldac_codec.js", "ldac_codec.wasm"]
  .every((name) => fs.existsSync(path.join(wasmDir, name)));
const nativePresent = fs.existsSync(path.join(ffmpegBin, "ffmpeg")) &&
  fs.existsSync(path.join(ldacHelperBin, "ldac_helper"));

const encodeSkip = wasmPresent && nativePresent
  ? null
  : "requires third_party/wasm/bin builds plus vendored native tools";

async function loaderFor(kind: "lc3" | "ldac"): Promise<SupplementalLoader> {
  const glueSource = fs.readFileSync(path.join(wasmDir, `${kind}_codec.js`), "utf8");
  const wasm = fs.readFileSync(path.join(wasmDir, `${kind}_codec.wasm`));
  const buffer = wasm.buffer.slice(
    wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
  const module = await instantiateGlue(
    glueSource, buffer, kind === "lc3" ? "createLC3Codec" : "createLDACCodec");
  return { load: async () => module as never };
}

/** Deterministic pseudo-random s16le render spanning several periods. */
function renderPcm(rate: number, channels: 1 | 2, seconds: number): Int16Array {
  const frames = Math.round(rate * seconds);
  const pcm = new Int16Array(frames * channels);
  let seed = 21;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2_147_483_648;
      const t = frame / rate;
      const base = channel === 0 ? 440 : 622;
      const envelope = Math.sin(2 * Math.PI * 0.8 * t);
      const value = Math.sin(2 * Math.PI * base * t) * 0.7 * envelope
        + ((seed % 2_000) / 20_000 - 0.05);
      pcm[frame * channels + channel] = Math.max(-32_767, Math.min(32_767,
        Math.round(value * 32_767)));
    }
  }
  return pcm;
}

function writeTemp(dir: string, name: string, bytes: Uint8Array): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, bytes);
  return target;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Read the exact s16le content of a file (fs.readFileSync buffers share
 * pooled ArrayBuffers with nonzero byteOffset; Int16Array views must honor
 * it instead of slicing from zero). */
function fileInt16s(path: string): Int16Array {
  const raw = fs.readFileSync(path);
  if (raw.byteLength % 2 !== 0) throw new Error(`${path} has an odd s16le length`);
  return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
}

test("LDAC WASM encode matches native ldac_helper byte-for-byte", { skip: encodeSkip !== null }, async () => {
  const loader = await loaderFor("ldac");
  for (const [rate, channels, bitrate] of [[48_000, 2, 990], [44_100, 2, 660], [48_000, 1, 330]] as const) {
    const pcm = renderPcm(rate, channels, 0.31);
    const blockSamples = 128;
    // The helper receives the UNPADDED input and pads its own final partial
    // block; the session pads the same way, so the containers must be equal.
    const trueSampleCount = Math.floor(pcm.length / channels);
    const paddedFrames = Math.ceil(pcm.length / (blockSamples * channels)) * blockSamples;
    const padded = new Int16Array(paddedFrames * channels);
    padded.set(pcm);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldac-parity-"));
    const pcmIn = writeTemp(dir, "in.pcm",
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    const nativeOut = path.join(dir, "native.ldac");
    await execFileAsync(path.join(ldacHelperBin, "ldac_helper"), [
      "encode", "--rate", String(rate), "--channels", String(channels),
      "--bitrate", String(bitrate), "--in", pcmIn, "--out", nativeOut,
    ]);
    const nativeBytes = new Uint8Array(fs.readFileSync(nativeOut));
    const nativeHeader = parseLdacContainer(nativeBytes);
    assert.equal(nativeHeader.sampleCount, trueSampleCount);
    // The helper's flush loop appends one encoder-tail frame after the final
    // padded LSU block; the session's flushFrames() must reproduce it.
    assert.equal(nativeHeader.frameCount, paddedFrames / blockSamples + 1);

    const session = await createLdacEncoderSession(loader, rate, channels, bitrate);
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < padded.length; offset += blockSamples * channels) {
      frames.push(...session.encodeBlock(padded.subarray(offset, offset + blockSamples * channels)));
    }
    frames.push(...session.flushFrames());
    const container = writeLdacContainer({
      sampleRateHz: rate, channels, requestedBitrateKbps: bitrate,
      sampleCount: trueSampleCount, reportedBitrateKbps: session.reportedBitrateKbps, frames,
    });
    session.dispose();
    assert.equal(sha256(container), sha256(nativeBytes),
      `${String(rate)} Hz ${String(channels)} ch ${String(bitrate)} kbps: browser LDAC container differs from native`);
    parseLdacContainer(container);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LDAC WASM decode mirrors native helper decode on shared container bytes", { skip: encodeSkip !== null }, async () => {
  const loader = await loaderFor("ldac");
  const rate = 48_000;
  const channels: 1 | 2 = 2;
  const pcm = renderPcm(rate, channels, 0.28);
  const trueSampleCount = Math.floor(pcm.length / channels);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldac-dec-parity-"));
  // Native helper first, decoding exactly its own object:
  const pcmIn = writeTemp(dir, "in.pcm",
    new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const nativeEncoded = path.join(dir, "native.ldac");
  await execFileAsync(path.join(ldacHelperBin, "ldac_helper"), [
    "encode", "--rate", String(rate), "--channels", String(channels),
    "--bitrate", "990", "--in", pcmIn, "--out", nativeEncoded,
  ]);
  const nativeDecoded = path.join(dir, "native.pcm");
  await execFileAsync(path.join(ldacHelperBin, "ldac_helper"), [
    "decode", "--rate", String(rate), "--channels", String(channels),
    "--bitrate", "990", "--in", nativeEncoded, "--out", nativeDecoded,
  ]);
  const nativePcm = fileInt16s(nativeDecoded);
  void nativePcm;

  const container = new Uint8Array(fs.readFileSync(nativeEncoded));
  const session = await createLdacDecoderSession(loader, rate, channels);
  const decoder = session;
  const sampleCount = parseLdacContainer(container).sampleCount;
  const out = new Int16Array(sampleCount * channels);
  let written = 0;
  let warmup = 128;
  let recordOffset = 48;
  const sizes = new DataView(container.buffer, container.byteOffset);
  while (written < sampleCount && recordOffset + 2 <= container.byteLength) {
    const length = sizes.getUint16(recordOffset, true);
    const frame = container.subarray(recordOffset + 2, recordOffset + 2 + length);
    recordOffset += 2 + length;
    const block = decoder.decodeBlock(frame);
    let frames = Math.floor(block.length / channels);
    let start = 0;
    if (warmup > 0) {
      start = Math.min(warmup, frames);
      warmup -= start;
    }
    frames -= start;
    if (frames > sampleCount - written) frames = sampleCount - written;
    out.set(block.subarray(start * channels, (start + frames) * channels), written * channels);
    written += frames;
  }
  session.dispose();
  assert.equal(written, sampleCount, "browser decode length disagrees with the container header");
  for (let index = 0; index < out.length; index += 1) {
    assert.equal(out[index], nativePcm[index],
      `decoded PCM sample ${String(index)} differs from the native helper decode`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LC3 WASM encode matches the vendored ffmpeg/liblc3 payloads", { skip: encodeSkip !== null }, async () => {
  const loader = await loaderFor("lc3");
  for (const [channels, bitrateKbps] of [[2, 96], [1, 128]] as const) {
    const pcm = renderPcm(48_000, channels, 0.31);
    const dataBytes = pcm.byteLength;
    const wavBytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(wavBytes.buffer);
    wavBytes.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, 36 + dataBytes, true);
    wavBytes.set(new TextEncoder().encode("WAVE"), 8);
    wavBytes.set(new TextEncoder().encode("fmt "), 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 96_000, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    wavBytes.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, dataBytes, true);
    wavBytes.set(new Uint8Array(pcm.buffer, 0, pcm.byteLength), 44);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc3-parity-"));
    const wavPath = writeTemp(dir, "src.wav", wavBytes);
    const nativeOut = path.join(dir, "native.lc3");
    await execFileAsync(path.join(ffmpegBin, "ffmpeg"), [
      "-hide_banner", "-loglevel", "error", "-i", wavPath,
      "-c:a", "liblc3", "-b:a", `${String(bitrateKbps)}k`, "-ar", "48000",
      "-f", "lc3", "-frame_duration", "10", nativeOut,
    ]);
    const nativeBytes = new Uint8Array(fs.readFileSync(nativeOut));
    const nativeHeader = parseLc3Header(nativeBytes);
    const nativeFrames = parseLc3Frames(nativeBytes);

    const encoder = await createLc3EncoderSession(loader, 48_000, channels,
      bitrateKbps * 1000, 10_000);
    const writer = new Lc3ContainerWriter({
      sampleRateHz: 48_000, bitrateBps: encoder.effectiveBitrateBps, channels,
      frameDurationUs: 10_000, epMode: false,
      totalSamples: Math.floor(pcm.length / channels), hrMode: false,
    });
    const frameSamples = Math.round(10_000 * 48_000 / 1_000_000);
    const totalBlocks = Math.ceil(pcm.length / channels / frameSamples);
    for (let block = 0; block < totalBlocks; block += 1) {
      const padded = new Int16Array(frameSamples * channels);
      const srcOffset = block * frameSamples * channels;
      padded.set(pcm.subarray(srcOffset, srcOffset + padded.length), 0);
      writer.pushFrame(encoder.encodeBlock(padded));
    }
    writer.pushFrame(encoder.encodeBlock(new Int16Array(frameSamples * channels)));
    encoder.dispose();
    const ourBytes = writer.finish();
    const ourHeader = parseLc3Header(ourBytes);
    const ourFrames = parseLc3Frames(ourBytes);
    assert.equal(ourFrames.length, nativeFrames.length,
      `frame counts differ from native at ${String(channels)} ch (including the closing zero block)`);
    for (let index = 0; index < nativeFrames.length; index += 1) {
      assert.deepEqual(
        Array.from(ourFrames[index] as Uint8Array),
        Array.from(nativeFrames[index] as Uint8Array),
        `LC3 frame ${String(index)} payload differs at ${String(channels)} ch ${String(bitrateKbps)} kbps`,
      );
    }
    assert.equal(ourHeader.sampleRateHz, nativeHeader.sampleRateHz);
    assert.equal(ourHeader.frameDurationUs, nativeHeader.frameDurationUs);
    assert.equal(ourHeader.channels, nativeHeader.channels as 1 | 2);
    assert.equal(ourHeader.totalSamples, nativeHeader.totalSamples,
      "nb_samples convention differs from the native muxer");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LC3 WASM decode matches the vendored ffmpeg decode payload", { skip: encodeSkip !== null }, async () => {
  const loader = await loaderFor("lc3");
  for (const [channels, bitrateKbps] of [[2, 96], [1, 128]] as const) {
    const pcm = renderPcm(48_000, channels, 0.31);
    const dataBytes = pcm.byteLength;
    const wavBytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(wavBytes.buffer);
    wavBytes.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, 36 + dataBytes, true);
    wavBytes.set(new TextEncoder().encode("WAVE"), 8);
    wavBytes.set(new TextEncoder().encode("fmt "), 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 96_000, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    wavBytes.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, dataBytes, true);
    wavBytes.set(new Uint8Array(pcm.buffer, 0, pcm.byteLength), 44);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc3-dec-parity-"));
    const wavPath = writeTemp(dir, "src.wav", wavBytes);
    const nativeOut = path.join(dir, "native.lc3");
    await execFileAsync(path.join(ffmpegBin, "ffmpeg"), [
      "-hide_banner", "-loglevel", "error", "-i", wavPath,
      "-c:a", "liblc3", "-b:a", `${String(bitrateKbps)}k`, "-ar", "48000",
      "-f", "lc3", "-frame_duration", "10", nativeOut,
    ]);
    const nativeBytes = new Uint8Array(fs.readFileSync(nativeOut));
    const header = parseLc3Header(nativeBytes);
    const frames = parseLc3Frames(nativeBytes);
    const nativePcm = path.join(dir, "native.pcm");
    await execFileAsync(path.join(ffmpegBin, "ffmpeg"), [
      "-hide_banner", "-loglevel", "error", "-f", "lc3", "-i", nativeOut,
      "-c:a", "pcm_s16le", "-f", "s16le", "-ar", "48000", "-ac", String(channels), nativePcm,
    ]);
    const reference = fileInt16s(nativePcm);

    const decoder = await createLc3DecoderSession(
      loader, header.sampleRateHz, header.channels, header.frameDurationUs, header.hrMode);
    const out = new Int16Array(header.totalSamples * header.channels);
    let written = 0;
    let delayToSkip = decoder.delaySamples;
    for (const record of frames) {
      if (written >= header.totalSamples) break;
      const block = decoder.decodeBlock(record);
      let sampleFrames = Math.floor(block.length / header.channels);
      let start = 0;
      if (delayToSkip > 0) {
        start = Math.min(delayToSkip, sampleFrames);
        delayToSkip -= start;
      }
      sampleFrames -= start;
      const takeFrames = Math.min(Number(header.totalSamples) - written, sampleFrames);
      if (takeFrames > 0) {
        out.set(block.subarray(start * header.channels, (start + takeFrames) * header.channels),
          written * header.channels);
      }
      written += takeFrames;
    }
    decoder.dispose();
    assert.equal(written, Number(header.totalSamples),
      "browser LC3 decode length differs from the ffmpeg-decoded convention");
    let worst = 0, worstIdx = -1, firstMismatch = -1, lenOut = out.length, lenRef = reference.length;
    for (let index = 0; index < Math.max(out.length, reference.length); index += 1) {
      const d = Math.abs((out[index] ?? 0) - (reference[index] ?? 0));
      if (d > worst) { worst = d; worstIdx = index; }
      if (d > 300 && firstMismatch < 0) firstMismatch = index;
    }
    if (worst > 1) {
      const bits = [out[worstIdx-2], out[worstIdx-1], out[worstIdx], refVsIndexed(reference, worstIdx)];
      console.error("debug decode mismatch", JSON.stringify({ channels, bitrateKbps, lenOut, lenRef, worst, worstIdx, firstMismatch, bits,
        outWins: Array.from(out.slice(Math.max(0,firstMismatch), firstMismatch+10)),
        refWins: Array.from(reference.slice(Math.max(0,firstMismatch), firstMismatch+10)) }));
    }
    assert.ok(worst <= 1,
      `browser LC3 decode differs from ffmpeg decode by ${String(worst)} LSB at ` +
      `${String(channels)} ch (${String(bitrateKbps)} kbps)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
