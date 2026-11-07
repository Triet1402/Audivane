/**
 * Artifact-free bounded-async behavior of the LDAC container module.
 *
 * These checks need no WASM module and no native helper. They establish:
 * - `writeLdacContainerAsync`/`parseLdacContainerAsync` are byte-exact and
 *   reason-order-identical with the synchronous `writeLdacContainer`/
 *   `parseLdacContainer`, which must stay usable for the existing callers;
 * - the async variants remain correct independently of each other and of the
 *   synchronous implementation (independent hand assembly, zlib CRC-32 as an
 *   independent checksum authority, and cross-parse round trips);
 * - large work actually yields the event loop, reports incremental progress
 *   and honors cancellation (heartbeat counters and structural slice
 *   accounting — never a wall-clock performance threshold).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as zlibCrc32 } from "node:zlib";
import {
  parseLdacContainer,
  writeLdacContainer,
  type LdacContainerAsyncProgress,
  type LdacContainerWriteRequest,
  parseLdacContainerAsync,
  writeLdacContainerAsync,
} from "../src/ldac-container.js";

/** One LDAC transport frame with valid sync/rate/channel framing. */
function buildFrame(
  length: number,
  variant: number,
  rate: 44_100 | 48_000,
  channels: 1 | 2,
): Uint8Array {
  assert.ok(length >= 3, "fixture frames keep their 3-byte header room");
  const rateId = rate === 44_100 ? 0 : 1;
  const channelId = channels === 1 ? 0 : 2;
  const frame = new Uint8Array(length);
  frame[0] = 0xaa;
  frame[1] = ((rateId & 0x07) << 5) | ((channelId & 0x03) << 3);
  let state = (variant * 2654435761 + 12345) >>> 0;
  for (let index = 2; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    frame[index] = state & 0xff;
  }
  return frame;
}

/**
 * Decompose a payload byte target into round-trippable records. Each record
 * consumes 2 + frameLength bytes with 4 <= frameLength <= 1027; the greedy
 * split keeps every remainder splittable (every remainder stays >= 6).
 */
function framesForPayload(
  targetPayload: number,
  rate: 44_100 | 48_000,
  channels: 1 | 2,
): Uint8Array[] {
  assert.ok(targetPayload >= 6, "payload targets need at least one record");
  const frames: Uint8Array[] = [];
  let remaining = targetPayload;
  let variant = 1;
  while (remaining > 0) {
    const recordSize = remaining > 1_029 + 6
      ? 1_029
      : (remaining > 1_029 ? remaining - 6 : remaining);
    frames.push(buildFrame(recordSize - 2, variant, rate, channels));
    variant += 1;
    remaining -= recordSize;
  }
  return frames;
}

interface ShapeOptions {
  readonly rate: 44_100 | 48_000;
  readonly channels: 1 | 2;
  readonly requested: 330 | 660 | 990;
  readonly reported: number;
  readonly sampleCount: number;
}

function writeRequest(
  shape: ShapeOptions,
  frames: readonly Uint8Array[],
): LdacContainerWriteRequest {
  return {
    sampleRateHz: shape.rate,
    channels: shape.channels,
    requestedBitrateKbps: shape.requested,
    sampleCount: shape.sampleCount,
    reportedBitrateKbps: shape.reported,
    frames,
  };
}

/** Small shapes; record lengths deliberately exercise the 4/1027 bounds. */
function smallFrameSet(variantSeed: number, shape: ShapeOptions = BASE_SHAPES[0]!): readonly Uint8Array[] {
  return [
    buildFrame(4, variantSeed, shape.rate, shape.channels),
    buildFrame(733, variantSeed + 1, shape.rate, shape.channels),
    buildFrame(1_027, variantSeed + 2, shape.rate, shape.channels),
    buildFrame(22, variantSeed + 3, shape.rate, shape.channels),
  ];
}

const BASE_SHAPES: readonly ShapeOptions[] = [
  { rate: 48_000, channels: 2, requested: 990, reported: 990, sampleCount: 28_800 },
  { rate: 48_000, channels: 1, requested: 660, reported: 330, sampleCount: 737 },
  { rate: 44_100, channels: 2, requested: 990, reported: 909, sampleCount: 26_460 },
  { rate: 44_100, channels: 2, requested: 660, reported: 606, sampleCount: 12_801 },
];

/** Exact error message of a synchronous operation, keeping a stale-throw guard. */
function syncErrorMessage(operation: () => unknown): string {
  try {
    operation();
    throw new Error("expected the synchronous operation to throw");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "expected the synchronous operation to throw") throw error;
    return message;
  }
}

async function rejectsWithMessage(
  run: Promise<unknown> | (() => Promise<unknown>),
  message: string,
): Promise<void> {
  const promise = typeof run === "function" ? run() : run;
  await assert.rejects(() => promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error).message, message);
    return true;
  });
}

async function rejectsAborted(
  run: Promise<unknown> | (() => Promise<unknown>),
): Promise<void> {
  const promise = typeof run === "function" ? run() : run;
  await assert.rejects(() => promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
}

/**
 * Event-loop liveness monitor. While pending it schedules one macrotask per
 * turn; the counter only advances while the operation under test gives the
 * event loop back, so no timing threshold is involved. A synchronous block
 * below the slice budget can never run this counter's timer, and the hard
 * turn cap keeps a failed assertion from retaining the event loop forever.
 */
class HeartbeatMonitor {
  heartbeats = 0;
  private running = true;
  private readonly loop: Promise<void>;

  constructor() {
    this.loop = (async (): Promise<void> => {
      while (this.running && this.heartbeats < 100_000) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        if (this.running) this.heartbeats += 1;
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/** Edit a container copy at the record level, re-binding a valid CRC with zlib. */
function editedContainer(
  container: Uint8Array,
  mutate: (bytes: Uint8Array, view: DataView) => void,
): Uint8Array {
  const bytes = new Uint8Array(container);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  mutate(bytes, view);
  view.setUint32(40, zlibCrc32(bytes.subarray(48)), true);
  return bytes;
}

/* ------------------------------------------------------------------------ *
 * Byte exactness and independent correctness of the async writer.
 * ------------------------------------------------------------------------ */

test("async LDAC container write is byte-exact with the synchronous writer", async () => {
  for (const shape of BASE_SHAPES) {
    const request = writeRequest(shape, smallFrameSet(shape.sampleCount & 0xff));
    const syncBytes = writeLdacContainer(request);
    const asyncBytes = await writeLdacContainerAsync(request);
    assert.ok(bytesEqual(syncBytes, asyncBytes), `${String(shape.rate)} Hz shape bytes`);
  }
});

test("the async writer reproduces an independently hand-assembled container and CRC", async () => {
  const shape = BASE_SHAPES[0]!;
  const frames = smallFrameSet(7);
  const container = await writeLdacContainerAsync(writeRequest(shape, frames));

  // Independent byte-wise construction of the helper v1 format.
  const expected = new Uint8Array(48 + frames.length * 2 + frames.reduce(
    (sum, frame) => sum + frame.byteLength, 0));
  const view = new DataView(expected.buffer);
  for (const [index, char] of "LDAC".split("").entries()) {
    expected[index] = char.charCodeAt(0);
  }
  view.setUint16(4, 1, true);
  view.setUint16(6, 48, true);
  view.setUint32(8, shape.rate, true);
  view.setUint32(12, shape.channels, true);
  view.setUint32(16, shape.requested, true);
  view.setUint32(20, frames.length, true);
  view.setUint32(24, shape.sampleCount >>> 0, true);
  view.setUint32(28, Math.floor(shape.sampleCount / 2 ** 32), true);
  view.setUint32(32, shape.reported, true);
  view.setUint32(36, 1, true);
  let payloadOffset = 48;
  for (const frame of frames) {
    view.setUint16(payloadOffset, frame.byteLength, true);
    expected.set(frame, payloadOffset + 2);
    payloadOffset += 2 + frame.byteLength;
  }
  const payload = expected.subarray(48);
  // Identity of the IEEE polynomial, fixed here against the known constant
  // (same check policy as ldac-container.test.ts's zlib anchor).
  view.setUint32(40, zlibCrc32(payload), true);
  view.setUint32(44, 0, true);

  assert.ok(bytesEqual(expected, container), "matches the independent hand assembly");
  const crcField = view.getUint32(40, true);
  assert.equal(crcField, zlibCrc32(container.subarray(48)),
    "the bound CRC equals the independent authority");
  const reference = new TextEncoder().encode("123456789");
  assert.equal(zlibCrc32(reference), 0xcbf43926);
});

test("u64 sample counts bind both header words and round-trip", async () => {
  const request = writeRequest(BASE_SHAPES[1]!, []);
  const sampleCount = 2 ** 32 + 12_345;
  const requestHigh = { ...request, sampleCount };
  const syncBytes = writeLdacContainer(requestHigh);
  const asyncBytes = await writeLdacContainerAsync(requestHigh);
  assert.ok(bytesEqual(syncBytes, asyncBytes));

  const view = new DataView(asyncBytes.buffer);
  assert.equal(view.getUint32(24, true), 12_345, "low word");
  assert.equal(view.getUint32(28, true), 1, "high word");
  const parsedAsync = await parseLdacContainerAsync(asyncBytes);
  assert.deepEqual(parsedAsync, { ...parseLdacContainer(asyncBytes) });
  assert.equal(parsedAsync.sampleCount, sampleCount);
});

test("invalid write requests reject with the synchronous writer's exact reasons", async () => {
  const shape = BASE_SHAPES[0]!;
  const cases: readonly LdacContainerWriteRequest[] = [
    writeRequest({ ...shape, sampleCount: -1 }, smallFrameSet(1)),
    writeRequest({ ...shape, sampleCount: 2 ** 53 }, smallFrameSet(1)),
    writeRequest({ ...shape, reported: 0 }, smallFrameSet(1)),
    writeRequest(shape, [new Uint8Array(3)]),
    writeRequest(shape, [new Uint8Array(1_028)]),
    // Request-field errors keep precedence over frame errors.
    writeRequest({ ...shape, sampleCount: -1 }, [new Uint8Array(1_028)]),
  ];
  for (const request of cases) {
    const message = syncErrorMessage(() => writeLdacContainer(request));
    assert.match(message,
      /LDAC container: (invalid sample count|the encoder reported no usable actual bitrate|invalid frame length \d+)/);
    await rejectsWithMessage(() => writeLdacContainerAsync(request), message);
  }
});

test("an invalid slice budget refuses before any assembly", async () => {
  const request = writeRequest(BASE_SHAPES[0]!, smallFrameSet(1));
  await rejectsWithMessage(
    () => writeLdacContainerAsync(request, { sliceMs: -1 }),
    "LDAC container: invalid slice budget -1 ms",
  );
});

/* ------------------------------------------------------------------------ *
 * The async parser's independence: same headers, same refusals, same order.
 * ------------------------------------------------------------------------ */

test("async parse matches the synchronous parser's frozen header on shared containers", async () => {
  for (const shape of BASE_SHAPES) {
    const frames = smallFrameSet(shape.sampleCount & 0xff, shape);
    const container = writeLdacContainer(writeRequest(shape, frames));
    const syncHeader = parseLdacContainer(container);
    const asyncHeader = await parseLdacContainerAsync(container);
    assert.deepEqual(asyncHeader, { ...syncHeader });
    assert.ok(Object.isFrozen(asyncHeader));
    assert.equal(asyncHeader.frameCount, frames.length);
  }
});

test("the async and sync parsers refuse malformed containers with identical reasons", async () => {
  const frame = (variant = 1): Uint8Array =>
    buildFrame(8, variant, BASE_SHAPES[0]!.rate, BASE_SHAPES[0]!.channels);
  const base = (): Uint8Array =>
    writeLdacContainer(writeRequest(BASE_SHAPES[0]!, [frame(), frame(2)]));
  const corruption = (operation: (bytes: Uint8Array, view: DataView) => void): Uint8Array =>
    editedContainer(base(), operation);
  const caseList: ReadonlyArray<{ bytes: Uint8Array }> = [
    { bytes: new Uint8Array(47) }, // shorter than the header
    { bytes: ((): Uint8Array => { const b = base(); b[0] = 0x58; return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); b[4] = 2; return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); b[6] = 52; return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(8, 96_000, true); return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(12, 3, true); return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint16(16, 132, true); return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(36, 0, true); return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(44, 7, true); return b; })() },
    { bytes: base().subarray(0, base().byteLength - 1) }, // truncated payload
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(40, 0xdeadbeef, true); return b; })() },
    // Header fields are outside the CRC scope, so these edits need no recheck.
    { bytes: ((): Uint8Array => { const b = writeLdacContainer(writeRequest(BASE_SHAPES[0]!, [frame(), frame(2), frame(3)])); new DataView(b.buffer).setUint32(20, 2, true); return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(8, 44_100, true); return b; })() },
    { bytes: ((): Uint8Array => { const b = base(); new DataView(b.buffer).setUint32(12, 1, true); return b; })() },
    // Record-level defects keep a valid CRC (re-bound with the zlib authority).
    { bytes: corruption((bytes) => { bytes[48] = 0x57; }) }, // corrupt 0xAA sync byte
    { bytes: corruption((bytes, view) => { view.setUint16(48, 2_000, true); }) }, // oversized length
  ];
  for (const { bytes } of caseList) {
    const message = syncErrorMessage(() => parseLdacContainer(bytes));
    assert.notEqual(message, "expected the synchronous operation to throw");
    await rejectsWithMessage(() => parseLdacContainerAsync(bytes), message);
  }
});

test("record refusals carry the synchronous parser's specific wordings", async () => {
  const frame = (variant = 1): Uint8Array =>
    buildFrame(8, variant, BASE_SHAPES[0]!.rate, BASE_SHAPES[0]!.channels);
  const truncatedInsideRecord = editedContainer(
    writeLdacContainer(writeRequest(BASE_SHAPES[0]!, [frame(), frame(2)])),
    (bytes, view) => {
      // First record claims 900 payload bytes; a valid length, but the
      // container payload ends long before (CRC rebound to an intact value).
      view.setUint16(48, 900, true);
    });
  await rejectsWithMessage(() => parseLdacContainerAsync(truncatedInsideRecord),
    "LDAC container is truncated inside frame 0");
  const oversizedRecord = editedContainer(
    writeLdacContainer(writeRequest(BASE_SHAPES[0]!, [frame(), frame(2)])),
    (bytes, view) => {
      // First record claims 2000 bytes: an invalid length, not a truncation.
      view.setUint16(48, 2_000, true);
    });
  await rejectsWithMessage(() => parseLdacContainerAsync(oversizedRecord),
    "Invalid LDAC frame length 2000 at frame 0");
  const rateIdMismatch = ((): Uint8Array => {
    const bytes = writeLdacContainer(writeRequest(BASE_SHAPES[0]!, [frame()]));
    new DataView(bytes.buffer).setUint32(8, 44_100, true);
    return bytes;
  })();
  await rejectsWithMessage(() => parseLdacContainerAsync(rateIdMismatch),
    "LDAC frame 0 has sample rate id 1, container says 44100 Hz");
  const corruptSync = ((): Uint8Array => {
    const bytes = writeLdacContainer(writeRequest(BASE_SHAPES[0]!, [frame(), frame(2)]));
    bytes[50] = 0x57; // the first record's transport frame starts at 50; break 0xAA
    new DataView(bytes.buffer).setUint32(40, zlibCrc32(bytes.subarray(48)), true);
    return bytes;
  })();
  await rejectsWithMessage(() => parseLdacContainerAsync(corruptSync),
    "Corrupt LDAC frame header at frame 0");
});

/* ------------------------------------------------------------------------ *
 * Bounded work on a realistic large container (~8 MiB payload, 128 CRC
 * windows): byte exactness against the sync writer, an independent CRC pass,
 * real event-loop liveness and bounded progress.
 * ------------------------------------------------------------------------ */

const LARGE_PAYLOAD = 8 * 2 ** 20;

const LARGE_FIXTURE = ((): LdacContainerWriteRequest => {
  const frames = framesForPayload(LARGE_PAYLOAD, 48_000, 2);
  return writeRequest(
    { rate: 48_000, channels: 2, requested: 990, reported: 990, sampleCount: 480_000 },
    frames);
})();

/** Exactly three CRC windows: cheap enough for per-slice accounting. */
const SLICE_FIXTURE = ((): LdacContainerWriteRequest => {
  const frames = framesForPayload(3 * 65_536, 48_000, 2);
  return writeRequest(
    { rate: 48_000, channels: 2, requested: 990, reported: 990, sampleCount: 48_000 },
    frames);
})();

test("a large container validates byte-exactly, independently, and yields by default", async () => {
  const writeBeat = new HeartbeatMonitor();
  const parseBeat = new HeartbeatMonitor();
  try {
    // Synchronous reference (single bounded run; no timing assertion anywhere).
    const syncBytes = writeLdacContainer(LARGE_FIXTURE);
    const writeSlices: LdacContainerAsyncProgress[] = [];
    const asyncBytes = await writeLdacContainerAsync(LARGE_FIXTURE, {
      onSlice: (progress) => { writeSlices.push(progress); },
    });
    assert.ok(bytesEqual(syncBytes, asyncBytes), "8 MiB container bytes are byte-exact");

    // Independent CRC authority across all 129 window boundaries.
    const crcField = new DataView(asyncBytes.buffer).getUint32(40, true);
    assert.equal(crcField, zlibCrc32(asyncBytes.subarray(48)));

    // The CRC phase was sliced: it yields to the event loop and reports
    // monotonically increasing bounded progress.
    const crcSlices = writeSlices.filter((progress) => progress.phase === "crc");
    assert.ok(writeBeat.heartbeats >= 2, "the event loop kept breathing during large write");
    assert.ok(crcSlices.length >= 2, "the CRC phase reported at slice boundaries");
    for (let index = 1; index < crcSlices.length; index += 1) {
      assert.ok(crcSlices[index]!.done > crcSlices[index - 1]!.done, "crc progress increases");
    }
    const finalCrc = crcSlices[crcSlices.length - 1]!;
    assert.equal(finalCrc.total, syncBytes.byteLength - 48);
    assert.ok(finalCrc.done > crcSlices[0]!.done, "crc progress advanced past its first slice");
    assert.ok(finalCrc.done <= finalCrc.total, "progress stays within the payload");

    // The async parser independently agrees and keeps breathing too.
    const parsed = await parseLdacContainerAsync(asyncBytes);
    assert.deepEqual(parsed, { ...parseLdacContainer(asyncBytes) });
    assert.ok(parseBeat.heartbeats >= 1, "large parse also yields to the event loop");
  } finally {
    await writeBeat.stop();
    await parseBeat.stop();
  }
});

test("sliceMs 0 gives a structural per-window and per-record yield account", async () => {
  const frameCount = SLICE_FIXTURE.frames.length;
  const onSlice: LdacContainerAsyncProgress[] = [];
  const container = await writeLdacContainerAsync(SLICE_FIXTURE, {
    sliceMs: 0,
    onSlice: (progress) => { onSlice.push(progress); },
  });
  const windows = (container.byteLength - 48) / 65_536;
  assert.ok(Number.isInteger(windows), "the fixture lines up with CRC windows");
  // With an always-exhausted budget, every record and CRC window takes its
  // own slice: a deterministic account of the bounded scheduling.
  assert.equal(onSlice.filter((progress) => progress.phase === "records").length, frameCount);
  assert.equal(onSlice.filter((progress) => progress.phase === "crc").length, windows);

  const parseSlices: LdacContainerAsyncProgress[] = [];
  await parseLdacContainerAsync(container, {
    sliceMs: 0,
    onSlice: (progress) => { parseSlices.push(progress); },
  });
  assert.equal(parseSlices.filter((progress) => progress.phase === "crc").length, windows);
  assert.equal(parseSlices.filter((progress) => progress.phase === "records").length, frameCount);
});

test("tiny container work completes inside one event-loop turn", async () => {
  const request = writeRequest(BASE_SHAPES[0]!, smallFrameSet(3));
  const writeSlices: LdacContainerAsyncProgress[] = [];
  const parseSlices: LdacContainerAsyncProgress[] = [];
  const beat = new HeartbeatMonitor();
  try {
    const container = await writeLdacContainerAsync(request, {
      onSlice: (progress) => { writeSlices.push(progress); },
    });
    const parsed = await parseLdacContainerAsync(container, {
      onSlice: (progress) => { parseSlices.push(progress); },
    });
    assert.equal(beat.heartbeats, 0, "no yield below the slice budget");
    assert.equal(writeSlices.length, 0);
    assert.equal(parseSlices.length, 0);
    assert.equal(parsed.frameCount, 4);
  } finally {
    await beat.stop();
  }
});

/* ------------------------------------------------------------------------ *
 * Cancellation:
 * ------------------------------------------------------------------------ */

test("cancellation during large container write rejects without binding a container", async () => {
  const controller = new AbortController();
  const onSlice: LdacContainerAsyncProgress[] = [];
  await rejectsAborted((async () => {
    return writeLdacContainerAsync(LARGE_FIXTURE, {
      signal: controller.signal,
      onSlice: (progress) => {
        onSlice.push(progress);
        if (progress.phase === "crc" &&
            onSlice.filter((entry) => entry.phase === "crc").length === 1) {
          controller.abort();
        }
      },
    });
  })());
  const crcWritings = onSlice.filter((entry) => entry.phase === "crc");
  assert.equal(crcWritings.length, 1, "no CRC slices follow the abort");
  assert.ok(crcWritings[0]!.done < crcWritings[0]!.total, "the abort lands inside the CRC work");
});

test("cancellation during large container validation rejects identically", async () => {
  const container = writeLdacContainer(LARGE_FIXTURE);
  const controller = new AbortController();
  const onSlice: LdacContainerAsyncProgress[] = [];
  await rejectsAborted((async () => {
    return parseLdacContainerAsync(container, {
      signal: controller.signal,
      onSlice: (progress) => {
        onSlice.push(progress);
        if (progress.phase === "crc" &&
            onSlice.filter((entry) => entry.phase === "crc").length === 1) {
          controller.abort();
        }
      },
    });
  })());
  const crcSlices = onSlice.filter((entry) => entry.phase === "crc");
  assert.equal(crcSlices.length, 1, "no CRC slices follow the abort");
  assert.ok(onSlice.every((entry) => entry.phase === "crc"),
    "the record walk never started behind a rejected checksum");
});

test("cancellation at the record-copy slice stops assembly before CRC", async () => {
  const controller = new AbortController();
  const onSlice: LdacContainerAsyncProgress[] = [];
  await rejectsAborted((async () => {
    return writeLdacContainerAsync(SLICE_FIXTURE, {
      sliceMs: 0,
      signal: controller.signal,
      onSlice: (progress) => {
        onSlice.push(progress);
        if (progress.phase === "records" && progress.done === 1) controller.abort();
      },
    });
  })());
  const recordSlices = onSlice.filter((progress) => progress.phase === "records");
  assert.equal(recordSlices.length, 1, "no record slices after the abort");
  assert.equal(onSlice.filter((progress) => progress.phase === "crc").length, 0,
    "the CRC never ran after record-phase cancellation");
});

for (const operation of ["write", "parse"] as const) {
  test(`${operation} rejects cancellation from the final awaited progress callback`, async () => {
    const request = writeRequest(BASE_SHAPES[0]!, [buildFrame(4, 1, 48_000, 2)]);
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      sliceMs: 0,
      onSlice: async (progress: LdacContainerAsyncProgress): Promise<void> => {
        const finalPhase = operation === "write" ? "crc" : "records";
        if (progress.phase === finalPhase && progress.done === progress.total) {
          await Promise.resolve();
          controller.abort();
        }
      },
    };
    await rejectsAborted(operation === "write"
      ? writeLdacContainerAsync(request, context)
      : parseLdacContainerAsync(writeLdacContainer(request), context));
    assert.equal(controller.signal.aborted, true);
  });
}

test("empty container operations reject an abort while their final await settles", async () => {
  const request = writeRequest(BASE_SHAPES[0]!, []);
  for (const operation of ["write", "parse"] as const) {
    const controller = new AbortController();
    const pending = operation === "write"
      ? writeLdacContainerAsync(request, { signal: controller.signal })
      : parseLdacContainerAsync(writeLdacContainer(request), { signal: controller.signal });
    controller.abort();
    await rejectsAborted(pending);
  }
});

test("assembly refuses a frame whose length changes across a yield", async () => {
  const frames = [buildFrame(4, 1, 48_000, 2)];
  await assert.rejects(writeLdacContainerAsync(writeRequest(BASE_SHAPES[0]!, frames), {
    sliceMs: 0,
    onSlice: (progress) => {
      if (progress.phase === "frames") frames[0] = buildFrame(5, 2, 48_000, 2);
    },
  }), /frame length changed during assembly/);
});

test("pre-aborted signals refuse before any slicing or validation", async () => {
  const validRequest = writeRequest(BASE_SHAPES[0]!, smallFrameSet(1));
  const invalidRequest = { ...validRequest, sampleCount: -1 };
  const malformed = new Uint8Array(47);
  const validContainer = writeLdacContainer(validRequest);
  const cases: ReadonlyArray<[string, LdacContainerWriteRequest | Uint8Array]> = [
    ["write", validRequest],
    ["write-invalid-request", invalidRequest],
    ["parse", malformed],
    ["parse-valid-but-large-enough-to-slice", validContainer],
  ];
  for (const [name, arg] of cases) {
    const controller = new AbortController();
    controller.abort();
    const slices: LdacContainerAsyncProgress[] = [];
    const callback = (progress: LdacContainerAsyncProgress): void => { slices.push(progress); };
    if (arg instanceof Uint8Array) {
      await rejectsAborted(
        parseLdacContainerAsync(arg, { signal: controller.signal, onSlice: callback }));
    } else {
      await rejectsAborted(
        writeLdacContainerAsync(arg, { signal: controller.signal, onSlice: callback }));
    }
    assert.equal(slices.length, 0, `${name}: no callbacks behind an aborted signal`);
  }
});

test("a throwing progress callback cancels the bounded operation directly", async () => {
  const controller = new AbortController();
  const cancellation = Object.assign(new Error("engine-level cancel"), { name: "EngineCancelled" });
  await assert.rejects(async () => {
    return writeLdacContainerAsync(LARGE_FIXTURE, {
      signal: controller.signal,
      onSlice: (progress) => {
        if (progress.phase === "crc" && progress.done > 0) throw cancellation;
      },
    });
  }, (error: unknown) => error === cancellation);
  assert.equal(controller.signal.aborted, false,
    "the callback error alone stopped the work, not the signal");
});

/* ------------------------------------------------------------------------ *
 * Error-order regression: sliced parsing keeps CRC precedence over record
 * defects (the record walk must never run past a checksum mismatch).
 * ------------------------------------------------------------------------ */
test("a large container with both a corrupt CRC and bad records reports the checksum first", async () => {
  const container = writeLdacContainer(LARGE_FIXTURE);
  container[50] = 0x57; // first record's transport sync byte also fails the walk
  new DataView(container.buffer).setUint32(40, 0xdeadbeef, true);
  const message = syncErrorMessage(() => parseLdacContainer(container));
  assert.match(message, /checksum mismatch/);
  const onSlice: LdacContainerAsyncProgress[] = [];
  await rejectsWithMessage(() => parseLdacContainerAsync(container, {
    sliceMs: 0,
    onSlice: (progress) => { onSlice.push(progress); },
  }), message);
  assert.ok(onSlice.every((progress) => progress.phase === "crc"),
    "no record slices past the rejected checksum");
});

/* ------------------------------------------------------------------------ *
 * Byte-exactness across CRC window boundaries (64 KiB window edge).
 * ------------------------------------------------------------------------ */
test("CRC window boundaries stay exact across the 64 KiB window edge", async () => {
  for (const payloadTarget of [65_534, 65_536, 65_540, 131_072]) {
    const frames = framesForPayload(payloadTarget, 48_000, 1);
    const request = writeRequest(
      { rate: 48_000, channels: 1, requested: 660, reported: 330, sampleCount: 12_345 },
      frames);
    const syncBytes = writeLdacContainer(request);
    const asyncBytes = await writeLdacContainerAsync(request);
    assert.ok(bytesEqual(syncBytes, asyncBytes), `${String(payloadTarget)}-byte payload is byte-exact`);
    const crcField = new DataView(asyncBytes.buffer).getUint32(40, true);
    assert.equal(crcField, zlibCrc32(asyncBytes.subarray(48)),
      `${String(payloadTarget)}-byte payload CRC matches the independent authority`);
    const parsed = await parseLdacContainerAsync(asyncBytes);
    assert.deepEqual(parsed, { ...parseLdacContainer(asyncBytes) });
    assert.equal(parsed.frameCount, frames.length);
  }
});
