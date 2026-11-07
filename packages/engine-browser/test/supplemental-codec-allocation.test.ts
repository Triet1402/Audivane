/**
 * Construction-failure allocation custody for the four supplemental session
 * factories, entirely without the built WASM artifacts (a structural fake
 * loader hands the factories a recording fake module).
 *
 * Contract under test: every acquired scratch/input/output heap pointer and
 * the codec handle are freed EXACTLY ONCE when construction fails, for both
 * fault-injected zero-returning and throwing `_malloc`/constructor calls,
 * while the normal success path keeps its exact bytes and its normal dispose.
 *
 * Before the fix, a failed second-buffer malloc leaked the first buffer, a
 * failed first-buffer malloc leaked the second (or leaked it when the second
 * failed after the first), and a throwing codec-handle constructor leaked the
 * meta scratch pointer. Every pointer is unique (bump-allocated), so
 * "free <pointer>" appearing exactly once per acquired pointer proves nothing
 * leaked and nothing was double-freed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createLc3DecoderSession,
  createLc3EncoderSession,
  createLdacDecoderSession,
  createLdacEncoderSession,
  type RawEmscriptenModule,
  type SupplementalLoader,
} from "../src/supplemental-codecs.js";

// Analytical fake glue configuration (written by the fake constructors).
const LC3_RATE = 48_000;
const LC3_FRAME_US = 10_000;
const LC3_BPS = 96_000;
const LC3_BLOCK_BYTES = 120;
const LC3_FRAME_SAMPLES = 480;
const LC3_DELAY_SAMPLES = 0;
const LC3_EFFECTIVE_BPS = 96_000;
const LC3_PAYLOAD_LEN = 58;
const LC3_ENC_HANDLE = 7;
const LC3_DEC_HANDLE = 9;

const LDAC_RATE = 48_000;
const LDAC_KBPS = 990;
const LDAC_BLOCK_SAMPLES = 128;
const LDAC_REPORTED_KBPS = 990;
const LDAC_FRAME_LEN = 130;
const LDAC_ENC_HANDLE = 11;
const LDAC_DEC_HANDLE = 13;
const LDAC_DEC_WRITTEN = 128;

// Factory-observable buffer shapes, derived from the same public formulas the
// factories use:
const LC3_SCRATCH_BYTES = 16;
const lc3InputBytes = (channels: 1 | 2): number => LC3_FRAME_SAMPLES * channels * 2;
const LC3_OUT_BYTES = LC3_BLOCK_BYTES + 3;
const LC3_DEC_IN_BYTES = 1_024 + 8;
const lc3DecOutBytes = (channels: 1 | 2): number => LC3_FRAME_SAMPLES * channels * 2 + 8;

const LDAC_SCRATCH_BYTES = 8;
const ldacInputBytes = (channels: 1 | 2): number => LDAC_BLOCK_SAMPLES * channels * 2;
const LDAC_OUT_BYTES = 1_027 + 3;
const LDAC_DEC_IN_BYTES = 1_027 + 8;
const LDAC_DEC_OUT_BYTES = 512 * 2 * 2 + 8;

type AllocFault = "zero" | "throw";

interface InstrumentOptions {
  channels: 1 | 2;
  /** Fires for each `_malloc(bytes)`; returning undefined allocates normally. */
  mallocFault?: (bytes: number, index: number) => AllocFault | undefined;
  /** Fires for the single codec-handle constructor a test exercises. */
  entryFault?: () => AllocFault | undefined;
  /** Constructors write an implausible (zero) meta block instead. */
  implausibleMeta?: boolean;
  /** `_ldac_wasm_frame_len` return sequence; further calls return 0. */
  ldacFrameLens?: number[];
}

interface InstrumentedModule {
  readonly module: RawEmscriptenModule;
  readonly trace: string[];
  /** Pointers successfully returned by `_malloc`, in allocation order. */
  readonly allocated: number[];
}

const lc3EncoderFree = (handle: number): string => `_lc3_encoder_free ${handle}`;
const lc3DecoderFree = (handle: number): string => `_lc3_decoder_free ${handle}`;
const ldacEncoderFree = (handle: number): string => `_ldac_wasm_encoder_free ${handle}`;
const ldacDecoderFree = (handle: number): string => `_ldac_wasm_decoder_free ${handle}`;

/**
 * A recording structural fake of the glue contract. Every malloc returns a
 * unique bump-allocated pointer, every handle free is traced with its value,
 * and all byte transfers are deterministic so the exact-bytes contract of the
 * happy path is verified, not merely that no error was thrown.
 */
function instrumentedModule(options: InstrumentOptions): InstrumentedModule {
  const { channels, mallocFault, entryFault, implausibleMeta, ldacFrameLens } = options;
  const heap = new ArrayBuffer(1 << 16);
  const heapU8 = new Uint8Array(heap);
  const heap16 = new Int16Array(heap);
  const view = new DataView(heap);
  const trace: string[] = [];
  const allocated: number[] = [];
  let cursor = 1024;
  let frameLenCalls = 0;
  let lastFrameLen = 0;

  const failOrHandle = (): number => {
    const fault = entryFault?.();
    if (fault === "zero") return 0;
    if (fault === "throw") throw new Error("fault-injected codec handle constructor failure");
    throw new Error("fake module has no real constructor outcome");
  };

  const module: RawEmscriptenModule = {
    HEAPU8: heapU8,
    HEAP16: heap16,
    HEAPU16: new Uint16Array(heap),
    HEAPU32: new Uint32Array(heap),
    HEAPF32: new Float32Array(heap),
    _malloc: (bytes: number) => {
      trace.push(`malloc ${bytes}`);
      const fault = mallocFault?.(bytes, allocated.length);
      if (fault === "zero") return 0;
      if (fault === "throw") throw new Error(`fault-injected malloc failure (${bytes} bytes)`);
      if (cursor + bytes > heap.byteLength) throw new Error("fake heap exhausted");
      const pointer = cursor;
      cursor += bytes + 16;
      allocated.push(pointer);
      return pointer;
    },
    _free: (pointer: number) => {
      trace.push(`free ${pointer}`);
    },
    _lc3_encoder_new: (
      rateHz: number, encoderChannels: number, bitrateBps: number,
      frameDurationUs: number, metaPtr: number,
    ): number => {
      trace.push(`_lc3_encoder_new ${rateHz}/${encoderChannels}/${bitrateBps}/${frameDurationUs}`);
      if (entryFault) return failOrHandle();
      view.setInt32(metaPtr, implausibleMeta ? 0 : LC3_BLOCK_BYTES, true);
      view.setInt32(metaPtr + 4, implausibleMeta ? 0 : LC3_FRAME_SAMPLES, true);
      view.setInt32(metaPtr + 8, LC3_DELAY_SAMPLES, true);
      view.setInt32(metaPtr + 12, LC3_EFFECTIVE_BPS, true);
      return LC3_ENC_HANDLE;
    },
    _lc3_encode_block: (handle: number, pcmPtr: number): number => {
      assert.equal(handle, LC3_ENC_HANDLE, "LC3 encode must use the constructed handle");
      trace.push(`encode_seen ${heapU8[pcmPtr]}`);
      return 0;
    },
    _lc3_frame_len: (handle: number): number => {
      assert.equal(handle, LC3_ENC_HANDLE);
      return LC3_PAYLOAD_LEN;
    },
    _lc3_frame_copy: (handle: number, outPtr: number): number => {
      assert.equal(handle, LC3_ENC_HANDLE);
      writeFakePayload(heapU8, outPtr, LC3_PAYLOAD_LEN);
      return 0;
    },
    _lc3_encoder_free: (handle: number): void => {
      trace.push(lc3EncoderFree(handle));
    },
    _lc3_decoder_new: (
      rateHz: number, decoderChannels: number, frameDurationUs: number, hrMode: number,
    ): number => {
      trace.push(`_lc3_decoder_new ${rateHz}/${decoderChannels}/${frameDurationUs}/${hrMode}`);
      if (entryFault) return failOrHandle();
      return LC3_DEC_HANDLE;
    },
    _lc3_decode_block: (handle: number, framePtr: number, frameBytes: number, outPtr: number): number => {
      assert.equal(handle, LC3_DEC_HANDLE, "LC3 decode must use the constructed handle");
      trace.push(`decode_seen ${heapU8[framePtr]}/${frameBytes}`);
      writeFakeSamples(heap16, outPtr, LC3_FRAME_SAMPLES * channels);
      return 0;
    },
    _lc3_decoder_free: (handle: number): void => {
      trace.push(lc3DecoderFree(handle));
    },
    _ldac_wasm_encoder_new: (
      rateHz: number, encoderChannels: number, bitrateKbps: number, metaPtr: number,
    ): number => {
      trace.push(`_ldac_wasm_encoder_new ${rateHz}/${encoderChannels}/${bitrateKbps}`);
      if (entryFault) return failOrHandle();
      view.setInt32(metaPtr, implausibleMeta ? 0 : LDAC_BLOCK_SAMPLES, true);
      view.setInt32(metaPtr + 4, LDAC_REPORTED_KBPS, true);
      return LDAC_ENC_HANDLE;
    },
    _ldac_wasm_encode_block: (handle: number, pcmPtr: number): number => {
      assert.equal(handle, LDAC_ENC_HANDLE, "LDAC encode must use the constructed handle");
      trace.push(`encode_seen ${heapU8[pcmPtr]}`);
      return 0;
    },
    _ldac_wasm_encoder_flush: (handle: number): number => {
      assert.equal(handle, LDAC_ENC_HANDLE);
      return 0;
    },
    _ldac_wasm_frame_len: (handle: number): number => {
      assert.equal(handle, LDAC_ENC_HANDLE);
      lastFrameLen = (ldacFrameLens ?? [LDAC_FRAME_LEN])[frameLenCalls] ?? 0;
      frameLenCalls += 1;
      return lastFrameLen;
    },
    _ldac_wasm_frame_copy: (handle: number, outPtr: number): number => {
      assert.equal(handle, LDAC_ENC_HANDLE);
      writeFakePayload(heapU8, outPtr, lastFrameLen);
      return 0;
    },
    _ldac_wasm_encoder_free: (handle: number): void => {
      trace.push(ldacEncoderFree(handle));
    },
    _ldac_wasm_decoder_new: (rateHz: number, decoderChannels: number): number => {
      trace.push(`_ldac_wasm_decoder_new ${rateHz}/${decoderChannels}`);
      if (entryFault) return failOrHandle();
      return LDAC_DEC_HANDLE;
    },
    _ldac_wasm_decode_block: (handle: number, framePtr: number, frameBytes: number, outPtr: number): number => {
      assert.equal(handle, LDAC_DEC_HANDLE, "LDAC decode must use the constructed handle");
      trace.push(`decode_seen ${heapU8[framePtr]}/${frameBytes}`);
      writeFakeSamples(heap16, outPtr, LDAC_DEC_WRITTEN * channels);
      return LDAC_DEC_WRITTEN;
    },
    _ldac_wasm_decoder_free: (handle: number): void => {
      trace.push(ldacDecoderFree(handle));
    },
  };
  return { module, trace, allocated };
}

const fakeSample = (index: number): number => index - 480;

function writeFakePayload(heapU8: Uint8Array, pointer: number, length: number): void {
  for (let i = 0; i < length; i += 1) heapU8[pointer + i] = (i * 7 + 5) & 0xff;
}

function fakePayloadBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + 5) & 0xff;
  return bytes;
}

function writeFakeSamples(heap16: Int16Array, pointer: number, count: number): void {
  for (let i = 0; i < count; i += 1) heap16[(pointer >> 1) + i] = fakeSample(i);
}

function fakeSamples(count: number): Int16Array {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = fakeSample(i);
  return samples;
}

function loaderFor(instrument: InstrumentedModule): SupplementalLoader {
  return { load: async () => instrument.module };
}

function countEntries(trace: readonly string[], entry: string): number {
  return trace.filter((candidate) => candidate === entry).length;
}

/** Matches a rejection that is an Error with exactly this message. */
function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) =>
    error instanceof Error && error.message === message);
}

/**
 * After ANY failed construction: each successfully acquired pointer was freed
 * exactly once (proving no leak and no double free across the whole trace).
 */
function assertPointerCustody(instrument: InstrumentedModule): void {
  const { trace, allocated } = instrument;
  for (const pointer of allocated) {
    assert.equal(countEntries(trace, `free ${pointer}`), 1,
      `pointer ${pointer} must be freed exactly once on the failure path`);
  }
  const freedValues = trace
    .filter((entry) => entry.startsWith("free "))
    .map((entry) => entry.slice("free ".length));
  assert.equal(freedValues.length, new Set(freedValues).size, "no pointer is freed twice");
}

test("LC3 encoder success keeps exact bytes and frees every resource exactly once on dispose", async () => {
  const instrument = instrumentedModule({ channels: 2 });
  const session = await createLc3EncoderSession(
    loaderFor(instrument), LC3_RATE, 2, LC3_BPS, LC3_FRAME_US);
  assert.equal(session.blockBytes, LC3_BLOCK_BYTES);
  assert.equal(session.frameSamples, LC3_FRAME_SAMPLES);
  assert.equal(session.delaySamples, LC3_DELAY_SAMPLES);
  assert.equal(session.effectiveBitrateBps, LC3_EFFECTIVE_BPS);
  const pcm = new Int16Array(LC3_FRAME_SAMPLES * 2);
  pcm[0] = 0x4142; // observed by the fake glue, proving the block copy target
  const payload = session.encodeBlock(pcm);
  assert.deepEqual(payload, fakePayloadBytes(LC3_PAYLOAD_LEN),
    "encodeBlock must return the payload the glue copied into the out buffer");
  assert.ok(instrument.trace.includes("encode_seen 66"),
    "the PCM block reached the malloc'd input buffer");
  const [scratch, input, out] = instrument.allocated;
  assert.equal(instrument.allocated.length, 3);
  session.dispose();
  assert.equal(countEntries(instrument.trace, `free ${scratch}`), 1,
    "the meta scratch pointer is released during construction, exactly once");
  assert.equal(countEntries(instrument.trace, `free ${input}`), 1);
  assert.equal(countEntries(instrument.trace, `free ${out}`), 1);
  assert.equal(countEntries(instrument.trace, lc3EncoderFree(LC3_ENC_HANDLE)), 1);
  assertPointerCustody(instrument);
});

test("LC3 encoder frees everything exactly once when the input or output buffer malloc fails (zero or throw)", async () => {
  for (const [label, bytes] of [["input", lc3InputBytes(2)] as const, ["output", LC3_OUT_BYTES] as const]) {
    for (const mode of ["zero", "throw"] as const) {
      const instrument = instrumentedModule({
        channels: 2,
        mallocFault: (request) => request === bytes ? mode : undefined,
      });
      const pending = createLc3EncoderSession(
        loaderFor(instrument), LC3_RATE, 2, LC3_BPS, LC3_FRAME_US);
      if (mode === "zero") {
        await rejectsWith(pending, "LC3 encoder could not allocate its heap buffers");
      } else {
        // A thrown allocation failure propagates unchanged.
        await rejectsWith(pending, `fault-injected malloc failure (${bytes} bytes)`);
      }
      const [scratch] = instrument.allocated;
      // A thrown input-malloc failure aborts before the output buffer is
      // requested; a zero failure lets the factory ask for the sibling first.
      const acquired = mode === "zero" || label === "output" ? 2 : 1;
      assert.equal(instrument.allocated.length, acquired,
        "exactly the pointers acquired before the failure were allocated");
      assert.equal(countEntries(instrument.trace, `free ${scratch}`), 1);
      assert.equal(countEntries(instrument.trace, lc3EncoderFree(LC3_ENC_HANDLE)), 1,
        `${mode} ${label} buffer failure frees the codec handle exactly once`);
      assertPointerCustody(instrument);
    }
  }
});

test("LC3 encoder releases the scratch when the handle constructor returns zero or throws", async () => {
  for (const mode of ["zero", "throw"] as const) {
    const instrument = instrumentedModule({ channels: 1, entryFault: () => mode });
    const pending = createLc3EncoderSession(
      loaderFor(instrument), LC3_RATE, 1, LC3_BPS, LC3_FRAME_US);
    if (mode === "zero") {
      await rejectsWith(pending,
        `LC3 encoder rejected a ${LC3_RATE} Hz / 1 ch / ${LC3_BPS} bps configuration`);
    } else {
      await rejectsWith(pending, "fault-injected codec handle constructor failure");
    }
    assert.equal(instrument.allocated.length, 1, "only the scratch pointer was allocated");
    assert.equal(countEntries(instrument.trace, `malloc ${LC3_SCRATCH_BYTES}`), 1);
    assert.equal(instrument.trace.filter((entry) => entry.startsWith("malloc ")).length, 1,
      "no buffer malloc is attempted after constructor failure");
    assert.equal(countEntries(instrument.trace, `free ${instrument.allocated[0]}`), 1,
      "the scratch pointer is freed exactly once");
    assert.equal(countEntries(instrument.trace, lc3EncoderFree(LC3_ENC_HANDLE)), 0,
      "a failed (zero) handle is never freed: it was never acquired");
    assertPointerCustody(instrument);
  }
});

test("LC3 encoder frees the handle on implausible metadata without touching buffers", async () => {
  const instrument = instrumentedModule({ channels: 2, implausibleMeta: true });
  await rejectsWith(
    createLc3EncoderSession(loaderFor(instrument), LC3_RATE, 2, LC3_BPS, LC3_FRAME_US),
    "LC3 encoder metadata was missing or implausible");
  assert.equal(instrument.allocated.length, 1, "only the scratch was allocated");
  assert.equal(countEntries(instrument.trace, `free ${instrument.allocated[0]}`), 1);
  assert.equal(countEntries(instrument.trace, lc3EncoderFree(LC3_ENC_HANDLE)), 1);
  assertPointerCustody(instrument);
});

test("LC3 decoder success keeps exact samples and frees every resource exactly once on dispose", async () => {
  const instrument = instrumentedModule({ channels: 1 });
  const session = await createLc3DecoderSession(
    loaderFor(instrument), LC3_RATE, 1, LC3_FRAME_US, false);
  assert.equal(session.frameSamples, LC3_FRAME_SAMPLES);
  const frame = new Uint8Array(104).fill(0x33);
  const samples = session.decodeBlock(frame);
  assert.deepEqual(samples, fakeSamples(LC3_FRAME_SAMPLES),
    "decodeBlock must return exactly the samples the glue wrote");
  assert.ok(instrument.trace.some((entry) => entry === `decode_seen 51/${frame.byteLength}`),
    "the frame bytes reached the malloc'd input buffer");
  const [input, out] = instrument.allocated;
  assert.equal(instrument.allocated.length, 2);
  session.dispose();
  assert.equal(countEntries(instrument.trace, `free ${input}`), 1);
  assert.equal(countEntries(instrument.trace, `free ${out}`), 1);
  assert.equal(countEntries(instrument.trace, lc3DecoderFree(LC3_DEC_HANDLE)), 1);
  assertPointerCustody(instrument);
});

test("LC3 decoder frees everything exactly once when either buffer malloc fails (zero or throw)", async () => {
  for (const [label, channels, bytes] of [
    ["input", 1 as const, LC3_DEC_IN_BYTES] as const,
    ["output", 2 as const, lc3DecOutBytes(2)] as const,
  ]) {
    for (const mode of ["zero", "throw"] as const) {
      const instrument = instrumentedModule({
        channels,
        mallocFault: (request) => request === bytes ? mode : undefined,
      });
      const pending = createLc3DecoderSession(
        loaderFor(instrument), LC3_RATE, channels, LC3_FRAME_US, false);
      if (mode === "zero") {
        await rejectsWith(pending, "LC3 decoder could not allocate its heap buffers");
      } else {
        await rejectsWith(pending, `fault-injected malloc failure (${bytes} bytes)`);
      }
      // A thrown input-malloc failure aborts before the output buffer is
      // requested; a zero failure lets the factory ask for the sibling first.
      const acquired = mode === "zero" || label === "output" ? 1 : 0;
      assert.equal(instrument.allocated.length, acquired,
        "exactly the buffers acquired before the failure were allocated");
      assert.equal(countEntries(instrument.trace, lc3DecoderFree(LC3_DEC_HANDLE)), 1,
        `${mode} ${label} buffer failure frees the codec handle exactly once`);
      assertPointerCustody(instrument);
    }
  }
});

test("LC3 decoder never allocates and never frees when the constructor returns zero", async () => {
  const instrument = instrumentedModule({ channels: 2, entryFault: () => "zero" });
  await rejectsWith(
    createLc3DecoderSession(loaderFor(instrument), LC3_RATE, 2, LC3_FRAME_US, false),
    `LC3 decoder rejected a ${LC3_RATE} Hz / 2 ch configuration`);
  assert.deepEqual(instrument.trace.filter((entry) => entry.startsWith("malloc ")), [],
    "no buffer malloc after constructor refusal");
  assert.equal(countEntries(instrument.trace, lc3DecoderFree(LC3_DEC_HANDLE)), 0,
    "a failed (zero) handle is never freed: it was never acquired");
  assertPointerCustody(instrument);
});

test("LDAC encoder success drains exact frames and frees every resource exactly once on dispose", async () => {
  const instrument = instrumentedModule({ channels: 2, ldacFrameLens: [LDAC_FRAME_LEN, 0] });
  const session = await createLdacEncoderSession(
    loaderFor(instrument), LDAC_RATE, 2, LDAC_KBPS);
  assert.equal(session.blockSamples, LDAC_BLOCK_SAMPLES);
  assert.equal(session.reportedBitrateKbps, LDAC_REPORTED_KBPS);
  const pcm = new Int16Array(LDAC_BLOCK_SAMPLES * 2);
  pcm[0] = 0x4142;
  const frames = session.encodeBlock(pcm);
  assert.deepEqual(frames, [fakePayloadBytes(LDAC_FRAME_LEN)]);
  assert.ok(instrument.trace.includes("encode_seen 66"),
    "the PCM block reached the malloc'd input buffer");
  assert.deepEqual(session.flushFrames(), [], "no extra tail frames past the drained sequence");
  const [scratch, input, out] = instrument.allocated;
  assert.equal(instrument.allocated.length, 3);
  session.dispose();
  assert.equal(countEntries(instrument.trace, `free ${scratch}`), 1,
    "scratch released during construction, exactly once");
  assert.equal(countEntries(instrument.trace, `free ${input}`), 1);
  assert.equal(countEntries(instrument.trace, `free ${out}`), 1);
  assert.equal(countEntries(instrument.trace, ldacEncoderFree(LDAC_ENC_HANDLE)), 1);
  assertPointerCustody(instrument);
});

test("LDAC encoder frees everything exactly once when either buffer malloc fails (zero or throw)", async () => {
  for (const [label, bytes] of [["input", ldacInputBytes(2)] as const, ["output", LDAC_OUT_BYTES] as const]) {
    for (const mode of ["zero", "throw"] as const) {
      const instrument = instrumentedModule({
        channels: 2,
        mallocFault: (request) => request === bytes ? mode : undefined,
      });
      const pending = createLdacEncoderSession(loaderFor(instrument), LDAC_RATE, 2, LDAC_KBPS);
      if (mode === "zero") {
        await rejectsWith(pending, "LDAC encoder could not allocate its heap buffers");
      } else {
        await rejectsWith(pending, `fault-injected malloc failure (${bytes} bytes)`);
      }
      const [scratch] = instrument.allocated;
      // A thrown input-malloc failure aborts before the output buffer is
      // requested; a zero failure lets the factory ask for the sibling first.
      const acquired = mode === "zero" || label === "output" ? 2 : 1;
      assert.equal(instrument.allocated.length, acquired,
        "exactly the pointers acquired before the failure were allocated");
      assert.equal(countEntries(instrument.trace, `free ${scratch}`), 1);
      assert.equal(countEntries(instrument.trace, ldacEncoderFree(LDAC_ENC_HANDLE)), 1,
        `${mode} ${label} buffer failure frees the codec handle exactly once`);
      assertPointerCustody(instrument);
    }
  }
});

test("LDAC encoder releases the scratch when the handle constructor returns zero or throws", async () => {
  for (const mode of ["zero", "throw"] as const) {
    const instrument = instrumentedModule({ channels: 1, entryFault: () => mode });
    const pending = createLdacEncoderSession(loaderFor(instrument), LDAC_RATE, 1, LDAC_KBPS);
    if (mode === "zero") {
      await rejectsWith(pending,
        `LDAC encoder rejected a ${LDAC_RATE} Hz / 1 ch / ${LDAC_KBPS} kbps configuration`);
    } else {
      await rejectsWith(pending, "fault-injected codec handle constructor failure");
    }
    assert.equal(instrument.allocated.length, 1, "only the scratch was allocated");
    assert.equal(countEntries(instrument.trace, `malloc ${LDAC_SCRATCH_BYTES}`), 1);
    assert.equal(countEntries(instrument.trace, `free ${instrument.allocated[0]}`), 1);
    assert.equal(countEntries(instrument.trace, ldacEncoderFree(LDAC_ENC_HANDLE)), 0);
    assertPointerCustody(instrument);
  }
});

test("LDAC encoder frees the handle when its metadata is implausible", async () => {
  const instrument = instrumentedModule({ channels: 2, implausibleMeta: true });
  await rejectsWith(
    createLdacEncoderSession(loaderFor(instrument), LDAC_RATE, 2, LDAC_KBPS),
    "LDAC encoder metadata was missing or implausible");
  assert.equal(instrument.allocated.length, 1, "only the scratch was allocated");
  assert.equal(countEntries(instrument.trace, `free ${instrument.allocated[0]}`), 1);
  assert.equal(countEntries(instrument.trace, ldacEncoderFree(LDAC_ENC_HANDLE)), 1);
  assertPointerCustody(instrument);
});

test("LDAC decoder frees everything exactly once when either buffer malloc fails (zero or throw)", async () => {
  for (const [label, bytes] of [["input", LDAC_DEC_IN_BYTES] as const, ["output", LDAC_DEC_OUT_BYTES] as const]) {
    for (const mode of ["zero", "throw"] as const) {
      const instrument = instrumentedModule({
        channels: 2,
        mallocFault: (request) => request === bytes ? mode : undefined,
      });
      const pending = createLdacDecoderSession(loaderFor(instrument), LDAC_RATE, 2);
      if (mode === "zero") {
        await rejectsWith(pending, "LDAC decoder could not allocate its heap buffers");
      } else {
        await rejectsWith(pending, `fault-injected malloc failure (${bytes} bytes)`);
      }
      // A thrown input-malloc failure aborts before the output buffer is
      // requested; a zero failure lets the factory ask for the sibling first.
      const acquired = mode === "zero" || label === "output" ? 1 : 0;
      assert.equal(instrument.allocated.length, acquired,
        "exactly the buffers acquired before the failure were allocated");
      assert.equal(countEntries(instrument.trace, ldacDecoderFree(LDAC_DEC_HANDLE)), 1,
        `${mode} ${label} buffer failure frees the codec handle exactly once`);
      assertPointerCustody(instrument);
    }
  }
});

test("LDAC decoder success keeps exact samples and frees every resource exactly once on dispose", async () => {
  const instrument = instrumentedModule({ channels: 2 });
  const session = await createLdacDecoderSession(loaderFor(instrument), LDAC_RATE, 2);
  assert.equal(session.blockSamples, LDAC_BLOCK_SAMPLES);
  const frame = new Uint8Array(260).fill(0x41);
  const samples = session.decodeBlock(frame);
  assert.deepEqual(samples, fakeSamples(LDAC_DEC_WRITTEN * 2),
    "decodeBlock must return exactly the samples the glue wrote");
  assert.ok(instrument.trace.some((entry) => entry === `decode_seen 65/${frame.byteLength}`),
    "the transport frame reached the malloc'd input buffer");
  const [input, out] = instrument.allocated;
  assert.equal(instrument.allocated.length, 2);
  session.dispose();
  assert.equal(countEntries(instrument.trace, `free ${input}`), 1);
  assert.equal(countEntries(instrument.trace, `free ${out}`), 1);
  assert.equal(countEntries(instrument.trace, ldacDecoderFree(LDAC_DEC_HANDLE)), 1);
  assertPointerCustody(instrument);
});

test("LDAC decoder never allocates and never frees when the constructor returns zero", async () => {
  const instrument = instrumentedModule({ channels: 2, entryFault: () => "zero" });
  await rejectsWith(
    createLdacDecoderSession(loaderFor(instrument), LDAC_RATE, 2),
    `LDAC decoder rejected a ${LDAC_RATE} Hz / 2 ch configuration`);
  assert.deepEqual(instrument.trace.filter((entry) => entry.startsWith("malloc ")), [],
    "no buffer malloc after constructor refusal");
  assert.equal(countEntries(instrument.trace, ldacDecoderFree(LDAC_DEC_HANDLE)), 0);
  assertPointerCustody(instrument);
});

test("a failing scratch allocation rejects without creating or freeing anything", async () => {
  for (const mode of ["zero", "throw"] as const) {
    const instrument = instrumentedModule({
      channels: 2,
      mallocFault: (request) => request === LC3_SCRATCH_BYTES ? mode : undefined,
    });
    const pending = createLc3EncoderSession(
      loaderFor(instrument), LC3_RATE, 2, LC3_BPS, LC3_FRAME_US);
    if (mode === "zero") {
      await rejectsWith(pending, "Supplemental codec heap allocation failed");
    } else {
      await rejectsWith(pending, `fault-injected malloc failure (${LC3_SCRATCH_BYTES} bytes)`);
    }
    assert.deepEqual(instrument.allocated, [], "nothing was acquired");
    assert.equal(instrument.trace.filter((entry) => entry.startsWith("_lc3_encoder_new")).length, 0,
      "the codec constructor is never reached");
    assert.equal(instrument.trace.filter((entry) => entry.startsWith("free ")).length, 0,
      "nothing is freed on an empty custody set");
  }
});
