/**
 * LC3 supplemental WASM lifetime regression (create/dispose churn).
 *
 * lc3_wasm.c allocates one contiguous `calloc(channels, size)` block that
 * carries every per-channel codec state. If lc3_encoder_free/lc3_decoder_free
 * drop that base pointer, every dispose leaks it. This test drives real
 * create/encode/dispose and create/decode/dispose churn for BOTH encoder and
 * decoder in mono and stereo and asserts that WASM linear memory does not grow
 * after warmup. Allocation growth is quantized to 64 KiB WASM pages and is
 * only visible once the leaked allocations exhaust the pre-mapped heap slack,
 * so the churn is sized to make a per-cycle leak cross that boundary many
 * times over (measured leaky rates: ~4.2 KB/cycle encoder, ~7-10 KB/cycle
 * decoder at these parameters; 4096 churn cycles leak tens of MiB, while a
 * bounded, leak-free implementation returns the frontier after every cycle
 * and produces no measurable growth). The assertion therefore observes
 * behavior, not implementation text.
 *
 * Skips when the built artifact is missing, mirroring the repository's
 * optional-codec policy: a skip is never evidence of a pass.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  instantiateGlue,
  type RawEmscriptenModule,
} from "../src/supplemental-codecs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const wasmDir = path.join(repoRoot, "third_party", "wasm", "bin");
const lc3WasmPresent = fs.existsSync(path.join(wasmDir, "lc3_codec.js")) &&
  fs.existsSync(path.join(wasmDir, "lc3_codec.wasm"));
const lc3Skip = lc3WasmPresent
  ? null
  : "requires built third_party/wasm/bin/lc3_codec.*";

const RATE = 48_000;
const FRAME_US = 10_000;
const BITRATE_BPS = 96_000;
const FRAME_SAMPLES = 480; // lc3_hr_frame_samples(0, 10_000, 48_000)

/** Warmup plus two equal churn phases: the second phase proves the memory
 * plateau is steady, not a one-time warmup artifact ("sustained" growth). */
const WARMUP_CYCLES = 384;
const CHURN_CYCLES = 4096;
/** Bound per churn phase on a leak-free implementation (16 WASM pages). The
 * leaky build grows tens of MiB above this. */
const MAX_GROWTH_BYTES = 1_048_576;

async function lc3Module(): Promise<RawEmscriptenModule> {
  if (!lc3ModulePromise) {
    lc3ModulePromise = (async () => {
      const glueSource = fs.readFileSync(path.join(wasmDir, "lc3_codec.js"), "utf8");
      const wasm = fs.readFileSync(path.join(wasmDir, "lc3_codec.wasm"));
      const source = new ArrayBuffer(wasm.byteLength);
      new Uint8Array(source).set(
        new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
      return await instantiateGlue(glueSource, source, "createLC3Codec") as RawEmscriptenModule;
    })();
  }
  return await lc3ModulePromise;
}
let lc3ModulePromise: Promise<RawEmscriptenModule> | null = null;

/** One full-size interleaved s16le block: deterministic analytical tone, the
 * same shape family the parity tests render. */
function renderBlock(channels: 1 | 2): Int16Array {
  const pcm = new Int16Array(FRAME_SAMPLES * channels);
  for (let frame = 0; frame < FRAME_SAMPLES; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const t = frame / RATE;
      const base = channel === 0 ? 440 : 622;
      // Half-rate alternation of polarity keeps every block non-degenerate.
      const sign = Math.floor(t * 10) % 2 === 0 ? 1 : -1;
      pcm[frame * channels + channel] = Math.max(-32_767, Math.min(32_767,
        Math.round(sign * 12_000 * Math.sin(2 * Math.PI * base * t))));
    }
  }
  return pcm;
}

function writeBytes(module: RawEmscriptenModule, view: Uint8Array): number {
  const pointer = module._malloc!(view.byteLength);
  assert.ok(pointer !== 0, "malloc returned null");
  module.HEAPU8.set(view, pointer);
  return pointer;
}

/** Create and dispose `cycles` real encoders; each cycle encodes one block. */
function churnEncoder(module: RawEmscriptenModule, channels: 1 | 2, cycles: number): void {
  for (let i = 0; i < cycles; i += 1) {
    const metaPtr = module._malloc!(16);
    const handle = module._lc3_encoder_new!(
      RATE, channels, BITRATE_BPS, FRAME_US, metaPtr);
    module._free!(metaPtr);
    assert.ok(handle !== 0, `encoder_new failed (${String(channels)} ch, cycle ${String(i)})`);
    const pcmView = renderBlock(channels);
    const pcmPtr = writeBytes(module,
      new Uint8Array(pcmView.buffer, pcmView.byteOffset, pcmView.byteLength));
    const outPtr = module._malloc!(1_024 + 3);
    assert.equal(module._lc3_encode_block!(handle, pcmPtr), 0,
      `encode failed (${String(channels)} ch, cycle ${String(i)})`);
    const payload = module._lc3_frame_len!(handle);
    assert.ok(payload > 0 && payload <= 1_024, `frame_len ${String(payload)}`);
    module._lc3_frame_copy!(handle, outPtr);
    module._free!(pcmPtr);
    module._free!(outPtr);
    module._lc3_encoder_free!(handle);
  }
}

/** Create and dispose `cycles` real decoders; each cycle decodes one frame. */
function churnDecoder(
  module: RawEmscriptenModule, channels: 1 | 2, cycles: number, frame: Uint8Array,
): void {
  for (let i = 0; i < cycles; i += 1) {
    const handle = module._lc3_decoder_new!(RATE, channels, FRAME_US, 0);
    assert.ok(handle !== 0, `decoder_new failed (${String(channels)} ch, cycle ${String(i)})`);
    const framePtr = writeBytes(module, frame.slice());
    const out16Ptr = module._malloc!(FRAME_SAMPLES * channels * 2 + 8);
    assert.equal(module._lc3_decode_block!(handle, framePtr, frame.byteLength, out16Ptr), 0,
      `decode failed (${String(channels)} ch, cycle ${String(i)})`);
    module._free!(framePtr);
    module._free!(out16Ptr);
    module._lc3_decoder_free!(handle);
  }
}

/** Encode one real block and return its payload as a detached JS copy. */
function encodeSeedFrame(module: RawEmscriptenModule, channels: 1 | 2): Uint8Array {
  const metaPtr = module._malloc!(16);
  const handle = module._lc3_encoder_new!(RATE, channels, BITRATE_BPS, FRAME_US, metaPtr);
  module._free!(metaPtr);
  assert.ok(handle !== 0, "seed encoder_new failed");
  const pcmView = renderBlock(channels);
  const pcmPtr = writeBytes(module,
    new Uint8Array(pcmView.buffer, pcmView.byteOffset, pcmView.byteLength));
  const outPtr = module._malloc!(1_024 + 3);
  assert.equal(module._lc3_encode_block!(handle, pcmPtr), 0);
  const payload = module._lc3_frame_len!(handle);
  assert.ok(payload > 0 && payload <= 1_024);
  module._lc3_frame_copy!(handle, outPtr);
  const bytes = module.HEAPU8.slice(outPtr, outPtr + payload);
  module._free!(pcmPtr);
  module._free!(outPtr);
  module._lc3_encoder_free!(handle);
  return bytes;
}

function heapBytes(module: RawEmscriptenModule): number {
  return module.HEAPU8.buffer.byteLength;
}

/** Warm up, then require both consecutive churn phases to keep the linear
 * memory flat (bounded page rounding), proving no sustained allocation
 * growth survives create/dispose cycles. */
function assertFlatMemory(
  module: RawEmscriptenModule, cycles: (count: number) => void,
): void {
  cycles(WARMUP_CYCLES);
  const warm = heapBytes(module);
  cycles(CHURN_CYCLES);
  const churnA = heapBytes(module);
  cycles(CHURN_CYCLES);
  const churnB = heapBytes(module);
  assert.ok(churnA - warm <= MAX_GROWTH_BYTES,
    `linear memory grew ${String(churnA - warm)} bytes over ${String(CHURN_CYCLES)} create/dispose cycles (first phase); ` +
    "sustained growth across warmup means destructors do not release codec state");
  assert.ok(churnB - churnA <= MAX_GROWTH_BYTES,
    `linear memory grew ${String(churnB - churnA)} bytes over a further ${String(CHURN_CYCLES)} create/dispose cycles (plateau phase); ` +
    "growth continues after warmup, so allocation is not returned on dispose");
}

test("LC3 WASM encoder create/dispose churn keeps linear memory flat: mono", { skip: lc3Skip ?? false }, async () => {
  const module = await lc3Module();
  assertFlatMemory(module, (cycles) => churnEncoder(module, 1, cycles));
});

test("LC3 WASM encoder create/dispose churn keeps linear memory flat: stereo", { skip: lc3Skip ?? false }, async () => {
  const module = await lc3Module();
  assertFlatMemory(module, (cycles) => churnEncoder(module, 2, cycles));
});

test("LC3 WASM decoder create/dispose churn keeps linear memory flat: mono", { skip: lc3Skip ?? false }, async () => {
  const module = await lc3Module();
  const frame = encodeSeedFrame(module, 1);
  assertFlatMemory(module, (cycles) => churnDecoder(module, 1, cycles, frame));
});

test("LC3 WASM decoder create/dispose churn keeps linear memory flat: stereo", { skip: lc3Skip ?? false }, async () => {
  const module = await lc3Module();
  const frame = encodeSeedFrame(module, 2);
  assertFlatMemory(module, (cycles) => churnDecoder(module, 2, cycles, frame));
});
