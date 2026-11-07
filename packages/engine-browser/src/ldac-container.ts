/**
 * Reader for the ldac_helper v1 container, in the browser's supplemental LDAC
 * codec. The WASM glue is an in-memory port of tools/ldac_helper.c and produces
 * the identical container; this parser only reads its 48-byte header and
 * verifies the CRC-32 record so provenance and bitrate bases can mirror the
 * native engine (encodedSampleRateSource "ldac-container-header", bitrate
 * basis "ldac-container-bytes-over-header-sample-duration").
 *
 * All integers are little-endian per the helper's header contract:
 *
 *   0   4  magic "LDAC"
 *   4   2  container version (1)
 *   6   2  header size in bytes (48)
 *   8   4  sample rate in Hz (44100/48000)
 *   12  4  channels (1/2)
 *   16  4  requested bitrate kbps (330/660/990)
 *   20  4  frame count
 *   24  8  true sample count, sample frames per channel
 *   32  4  actual bitrate as libldac reported (kbps)
 *   36  4  flags (bit 0: CRC-32 present)
 *   40  4  CRC-32 (IEEE) of all bytes after the header
 *   44  4  reserved (0)
 *   48 ... frame records: uint16 length, then one LDAC transport frame.
 *
 * The synchronous `writeLdacContainer`/`parseLdacContainer` stay byte-exact and
 * error-order-identical for the existing callers (native-parity tests, Node
 * consumers). A ten-minute HQ stereo container is ~75 MiB, so its record
 * assembly/copy and the CRC-32 pass would otherwise freeze the main thread for
 * well over a second; `writeLdacContainerAsync`/`parseLdacContainerAsync` run
 * the identical file format, the same validation rules, the same error order
 * and the same CRC-32 bytes, but bound every synchronous slice to a small
 * budget and yield to the event loop between slices, with abort checks and
 * progress callbacks at each boundary. Nothing is validated twice to a
 * different end: both variants share the same record/header/CRC internals, and
 * binding only happens after full assembly, so an abort or failure never
 * exposes a partial container.
 */

export interface LdacContainerHeader {
  readonly containerVersion: number;
  readonly headerSize: number;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly requestedBitrateKbps: number;
  readonly frameCount: number;
  /** Authoritative unpadded true length in sample frames per channel. */
  readonly sampleCount: number;
  /** libldac's own reported bitrate, e.g. 303/606/909 or 165/330/495. */
  readonly reportedBitrateKbps: number;
  readonly crc32: number;
}

const LDAC_MAGIC = "LDAC";
const LDAC_CONTAINER_VERSION = 1;
const LDAC_HEADER_SIZE = 48;
const LDAC_FLAG_CRC32 = 1;
const LDAC_MAX_FRAME_BYTES = 1_027;
const LDAC_RATE_TO_SAMPLE_RATE_ID = { 44_100: 0, 48_000: 1 } as const;

function crc32Step(crc: number, byte: number): number {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit += 1) {
    const mask = -(crc & 1);
    crc = (crc >>> 1) ^ (0xedb88320 & mask);
  }
  return crc >>> 0;
}

/** IEEE CRC-32 over `bytes`, starting from a fresh 0xFFFFFFFF seed. */
export function ldacCrc32AfterHeader(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = crc32Step(crc, bytes[index] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------------- *
 * Shared validation/assembly internals. The synchronous and asynchronous
 * callers below never duplicate a rule: header fields, frame lengths and the
 * per-record checks all live in these helpers so both variants refuse
 * malformed input with identical reasons in identical order.
 * ------------------------------------------------------------------------- */

function validateLdacWriteRequest(request: LdacContainerWriteRequest): void {
  if (request.sampleCount < 0 || !Number.isSafeInteger(request.sampleCount)) {
    throw new Error("LDAC container: invalid sample count");
  }
  if (request.reportedBitrateKbps <= 0) {
    throw new Error("LDAC container: the encoder reported no usable actual bitrate");
  }
}

function validateLdacFrameLength(byteLength: number): void {
  if (byteLength < 4 || byteLength > LDAC_MAX_FRAME_BYTES) {
    throw new Error(`LDAC container: invalid frame length ${String(byteLength)}`);
  }
}

/** Writes the header fields that precede the bound CRC word (0..36). */
function writeLdacHeaderFields(
  bytes: Uint8Array,
  view: DataView,
  request: LdacContainerWriteRequest,
): void {
  bytes.set(new Uint8Array(4).map((_, index) => LDAC_MAGIC.charCodeAt(index)), 0);
  view.setUint16(4, LDAC_CONTAINER_VERSION, true);
  view.setUint16(6, LDAC_HEADER_SIZE, true);
  view.setUint32(8, request.sampleRateHz, true);
  view.setUint32(12, request.channels, true);
  view.setUint32(16, request.requestedBitrateKbps, true);
  view.setUint32(20, request.frames.length, true);
  view.setUint32(24, request.sampleCount >>> 0, true);
  view.setUint32(28, Math.floor(request.sampleCount / 0x1_0000_0000), true);
  view.setUint32(32, request.reportedBitrateKbps, true);
  view.setUint32(36, LDAC_FLAG_CRC32, true);
}

interface LdacRawHeader {
  readonly view: DataView;
  readonly sampleRateHz: 44_100 | 48_000;
  readonly channelsRaw: 1 | 2;
  readonly requestedBitrateKbps: 330 | 660 | 990;
  readonly frameCount: number;
  readonly sampleCountLow: number;
  readonly sampleCountHigh: number;
  readonly reportedBitrateKbps: number;
  readonly crc32: number;
}

/** All header-level checks, in the parser's established order and wording. */
function readLdacHeaderFrame(bytes: Uint8Array): LdacRawHeader {
  if (bytes.byteLength < LDAC_HEADER_SIZE) {
    throw new Error("LDAC container is shorter than its 48-byte header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let magic = "";
  for (let index = 0; index < 4; index += 1) {
    magic += String.fromCharCode(bytes[index] as number);
  }
  if (magic !== LDAC_MAGIC) {
    throw new Error("Not an ldac_helper container (bad magic)");
  }
  const containerVersion = view.getUint16(4, true);
  const headerSize = view.getUint16(6, true);
  if (containerVersion !== LDAC_CONTAINER_VERSION) {
    throw new Error(`Unsupported LDAC container version ${String(containerVersion)}`);
  }
  if (headerSize !== LDAC_HEADER_SIZE) {
    throw new Error(`Bad LDAC container header size ${String(headerSize)}`);
  }
  const sampleRateHz = view.getUint32(8, true);
  const channelsRaw = view.getUint32(12, true);
  const requestedBitrateKbps = view.getUint32(16, true);
  const frameCount = view.getUint32(20, true);
  const sampleCountLow = view.getUint32(24, true);
  const sampleCountHigh = view.getUint32(28, true);
  const reportedBitrateKbps = view.getUint32(32, true);
  const flags = view.getUint32(36, true);
  const crc32 = view.getUint32(40, true);
  const reserved = view.getUint32(44, true);
  if (sampleRateHz !== 44_100 && sampleRateHz !== 48_000) {
    throw new Error(`LDAC container declares unsupported sample rate ${String(sampleRateHz)} Hz`);
  }
  if (channelsRaw !== 1 && channelsRaw !== 2) {
    throw new Error(`LDAC container declares unsupported channel count ${String(channelsRaw)}`);
  }
  if (requestedBitrateKbps !== 330 && requestedBitrateKbps !== 660 && requestedBitrateKbps !== 990) {
    throw new Error(`LDAC container declares unsupported bitrate ${String(requestedBitrateKbps)} kbps`);
  }
  if (flags !== LDAC_FLAG_CRC32) {
    throw new Error(`Unsupported LDAC container flags 0x${flags.toString(16)}`);
  }
  if (reserved !== 0) {
    throw new Error("Nonzero reserved LDAC container field");
  }
  return {
    view,
    sampleRateHz,
    channelsRaw,
    requestedBitrateKbps,
    frameCount,
    sampleCountLow,
    sampleCountHigh,
    reportedBitrateKbps,
    crc32,
  };
}

function freezeLdacHeader(raw: LdacRawHeader): LdacContainerHeader {
  return Object.freeze({
    containerVersion: LDAC_CONTAINER_VERSION,
    headerSize: LDAC_HEADER_SIZE,
    sampleRateHz: raw.sampleRateHz,
    channels: raw.channelsRaw,
    requestedBitrateKbps: raw.requestedBitrateKbps,
    frameCount: raw.frameCount,
    sampleCount: raw.sampleCountLow + raw.sampleCountHigh * 0x1_0000_0000,
    reportedBitrateKbps: raw.reportedBitrateKbps,
    crc32: raw.crc32,
  });
}

/** Per-record validation (length bounds, sync byte, rate/channels ids). */
function assertLdacRecordAt(
  payload: Uint8Array,
  view: DataView,
  offset: number,
  records: number,
  sampleRateHz: 44_100 | 48_000,
  channelsRaw: number,
): number {
  if (offset + 2 > payload.byteLength) {
    throw new Error(`LDAC container is truncated at frame record ${String(records)}`);
  }
  const length = view.getUint16(LDAC_HEADER_SIZE + offset, true);
  if (length < 4 || length > LDAC_MAX_FRAME_BYTES) {
    throw new Error(`Invalid LDAC frame length ${String(length)} at frame ${String(records)}`);
  }
  if (offset + 2 + length > payload.byteLength) {
    throw new Error(`LDAC container is truncated inside frame ${String(records)}`);
  }
  const frame = payload.subarray(offset + 2, offset + 2 + length);
  if (frame[0] !== 0xaa) {
    throw new Error(`Corrupt LDAC frame header at frame ${String(records)}`);
  }
  const sampleRateId = (frame[1]! >> 5) & 0x07;
  const channelConfigId = (frame[1]! >> 3) & 0x03;
  if (sampleRateId !== LDAC_RATE_TO_SAMPLE_RATE_ID[sampleRateHz]) {
    throw new Error(
      `LDAC frame ${String(records)} has sample rate id ${String(sampleRateId)}, ` +
        `container says ${String(sampleRateHz)} Hz`);
  }
  if (channelConfigId !== (channelsRaw === 1 ? 0 : 2)) {
    throw new Error(
      `LDAC frame ${String(records)} has channel config id ${String(channelConfigId)}, ` +
        `container says ${String(channelsRaw)} channel(s)`);
  }
  return length;
}

/** Record-count reconciliation wording, shared by the sync/async walks. */
function assertLdacRecordCount(records: number, frameCount: number): void {
  if (records !== frameCount) {
    throw new Error(
      `LDAC container declares ${String(frameCount)} frames but carries ${String(records)} records`);
  }
}

export interface LdacContainerWriteRequest {
  readonly sampleRateHz: 44_100 | 48_000;
  readonly channels: 1 | 2;
  readonly requestedBitrateKbps: number;
  readonly sampleCount: number;
  /** libldac's own reported bitrate (kbps). */
  readonly reportedBitrateKbps: number;
  /** Transport frames in order (3-byte header at index 0). */
  readonly frames: readonly Uint8Array[];
}

/**
 * Assemble the helper v1 container exactly: 48-byte header, one u16-length
 * record per transport frame, CRC-32 (IEEE) over everything after the header,
 * the CRC flag set and a zero reserved word. Record assembly and the header
 * both precede binding so a failure never produces partial artifacts.
 */
export function writeLdacContainer(request: LdacContainerWriteRequest): Uint8Array {
  validateLdacWriteRequest(request);
  for (const frame of request.frames) validateLdacFrameLength(frame.byteLength);
  let payloadLength = 0;
  for (const frame of request.frames) {
    payloadLength += 2 + frame.byteLength;
  }
  const bytes = new Uint8Array(LDAC_HEADER_SIZE + payloadLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  writeLdacHeaderFields(bytes, view, request);
  const payloadTail = bytes.subarray(LDAC_HEADER_SIZE);
  let recordOffset = 0;
  for (const frame of request.frames) {
    view.setUint16(LDAC_HEADER_SIZE + recordOffset, frame.byteLength, true);
    payloadTail.set(frame, recordOffset + 2);
    recordOffset += 2 + frame.byteLength;
  }
  view.setUint32(40, ldacCrc32AfterHeader(payloadTail), true);
  view.setUint32(44, 0, true);
  return bytes;
}

export function parseLdacContainer(bytes: Uint8Array): LdacContainerHeader {
  const raw = readLdacHeaderFrame(bytes);
  const payload = bytes.subarray(LDAC_HEADER_SIZE);
  if (ldacCrc32AfterHeader(payload) !== raw.crc32) {
    throw new Error("LDAC container checksum mismatch");
  }
  // Walk the frame records so truncated or oversized containers refuse cleanly
  // exactly like the helper's decoder, before any WASM glue is invoked.
  let offset = 0;
  let records = 0;
  while (offset < payload.byteLength) {
    const length = assertLdacRecordAt(
      payload, raw.view, offset, records, raw.sampleRateHz, raw.channelsRaw);
    records += 1;
    offset += 2 + length;
  }
  assertLdacRecordCount(records, raw.frameCount);
  return freezeLdacHeader(raw);
}

/* ------------------------------------------------------------------------- *
 * Bounded asynchronous variants. Same bytes, same rules, same error order;
 * work is split into event-loop slices with abort checks and progress hooks.
 * ------------------------------------------------------------------------- */

export type LdacContainerAsyncPhase = "frames" | "records" | "crc";

export interface LdacContainerAsyncProgress {
  /** Phase of container work; `frames`/`records` count records, `crc` bytes. */
  readonly phase: LdacContainerAsyncPhase;
  readonly done: number;
  readonly total: number;
}

export interface LdacContainerAsyncContext {
  /**
   * Checked at entry and on every slice boundary; abort rejects with an
   * `AbortError` DOMException before any partial container can be bound.
   */
  readonly signal?: AbortSignal | null;
  /**
   * Maximum milliseconds of synchronous work per event-loop slice
   * (default 8 ms). CRC windows smaller than the budget are merged.
   */
  readonly sliceMs?: number;
  /**
   * Awaited progress callback invoked at each slice boundary (never duplicating
   * the underlying indices). Throwing here cancels the operation immediately.
   */
  readonly onSlice?: (progress: LdacContainerAsyncProgress) => void | Promise<void>;
}

const LDAC_DEFAULT_SLICE_MS = 8;
/** CRC bytes evaluated between readiness checks. */
const LDAC_CRC_WINDOW_BYTES = 65_536;

function ldacContainerAbortError(): Error {
  return new DOMException("LDAC container work was aborted", "AbortError");
}

function assertLdacContainerLive(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw ldacContainerAbortError();
}

function yieldLdacSlice(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

interface LdacSlicerOptions {
  readonly signal: AbortSignal | null;
  readonly sliceMs: number;
  readonly onSlice: ((progress: LdacContainerAsyncProgress) => void | Promise<void>) | undefined;
}

/**
 * Time-budgeted slice scheduler. `step` is called at every unit boundary; it
 * only yields (and reports) when the slice budget has been consumed, and every
 * yield rechecks the abort signal before the next unit of work is accepted.
 */
class LdacSliceClock {
  private lastSliceStart: number;

  constructor(private readonly options: LdacSlicerOptions) {
    this.lastSliceStart = performance.now();
  }

  async step(progress: LdacContainerAsyncProgress): Promise<void> {
    assertLdacContainerLive(this.options.signal);
    if (performance.now() - this.lastSliceStart < this.options.sliceMs) return;
    await yieldLdacSlice();
    this.lastSliceStart = performance.now();
    assertLdacContainerLive(this.options.signal);
    if (this.options.onSlice) await this.options.onSlice(progress);
    assertLdacContainerLive(this.options.signal);
  }
}

/** The identical IEEE CRC-32 over `payload`, sliced and abort-checked. */
async function ldacCrc32Sliced(
  payload: Uint8Array,
  clock: LdacSliceClock,
): Promise<number> {
  let crc = 0xffffffff;
  const total = payload.byteLength;
  for (let windowEnd = 0; windowEnd < total; windowEnd += LDAC_CRC_WINDOW_BYTES) {
    const end = Math.min(windowEnd + LDAC_CRC_WINDOW_BYTES, total);
    for (let index = windowEnd; index < end; index += 1) {
      crc = crc32Step(crc, payload[index] as number);
    }
    await clock.step({ phase: "crc", done: end, total });
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function resolveSliceMs(sliceMs: number | undefined): number {
  if (sliceMs === undefined) return LDAC_DEFAULT_SLICE_MS;
  if (!(sliceMs >= 0) || !Number.isFinite(sliceMs)) {
    throw new Error(`LDAC container: invalid slice budget ${String(sliceMs)} ms`);
  }
  return sliceMs;
}

/**
 * Bounded assembly of the same helper v1 container `writeLdacContainer`
 * produces. Validation and record sizing run first, so an invalid frame or an
 * abort never allocates or binds a partial container; the CRC-32 pass runs in
 * event-loop slices. Byte-exact with the synchronous writer.
 */
export async function writeLdacContainerAsync(
  request: LdacContainerWriteRequest,
  context: LdacContainerAsyncContext = {},
): Promise<Uint8Array> {
  assertLdacContainerLive(context.signal);
  validateLdacWriteRequest(request);
  const clock = new LdacSliceClock({
    signal: context.signal ?? null,
    sliceMs: resolveSliceMs(context.sliceMs),
    onSlice: context.onSlice,
  });
  const frames = request.frames;
  // Pass 1: validate every frame and size the container before allocating, so
  // failures bind nothing (same first-error order as the synchronous writer).
  const lengths = new Uint32Array(frames.length);
  let payloadLength = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    validateLdacFrameLength(frame.byteLength);
    lengths[index] = frame.byteLength;
    payloadLength += 2 + frame.byteLength;
    await clock.step({ phase: "frames", done: index + 1, total: frames.length });
  }
  assertLdacContainerLive(context.signal);

  // Pass 2: one deterministic allocation, header fields, then the identical
  // u16-length record sequence written straight into the output bytes.
  const bytes = new Uint8Array(LDAC_HEADER_SIZE + payloadLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  writeLdacHeaderFields(bytes, view, request);
  const payloadTail = bytes.subarray(LDAC_HEADER_SIZE);
  let recordOffset = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const length = lengths[index]!;
    if (frame.byteLength !== length) {
      throw new Error("LDAC container: frame length changed during assembly");
    }
    view.setUint16(LDAC_HEADER_SIZE + recordOffset, length, true);
    payloadTail.set(frame, recordOffset + 2);
    recordOffset += 2 + length;
    await clock.step({ phase: "records", done: index + 1, total: frames.length });
  }
  view.setUint32(40, await ldacCrc32Sliced(payloadTail, clock), true);
  view.setUint32(44, 0, true);
  assertLdacContainerLive(context.signal);
  return bytes;
}

/**
 * Bounded validation of the same helper v1 container `parseLdacContainer`
 * reads. Header checks run synchronously first (identical order/wording),
 * then the CRC-32 pass and the record walk are sliced and abort-checked, so
 * CRC mismatch keeps its precedence over any record-level defect.
 */
export async function parseLdacContainerAsync(
  bytes: Uint8Array,
  context: LdacContainerAsyncContext = {},
): Promise<LdacContainerHeader> {
  assertLdacContainerLive(context.signal);
  const raw = readLdacHeaderFrame(bytes);
  const payload = bytes.subarray(LDAC_HEADER_SIZE);
  const clock = new LdacSliceClock({
    signal: context.signal ?? null,
    sliceMs: resolveSliceMs(context.sliceMs),
    onSlice: context.onSlice,
  });
  const crc = await ldacCrc32Sliced(payload, clock);
  if (crc !== raw.crc32) {
    throw new Error("LDAC container checksum mismatch");
  }
  let offset = 0;
  let records = 0;
  while (offset < payload.byteLength) {
    const length = assertLdacRecordAt(
      payload, raw.view, offset, records, raw.sampleRateHz, raw.channelsRaw);
    records += 1;
    offset += 2 + length;
    await clock.step({ phase: "records", done: records, total: raw.frameCount });
  }
  assertLdacRecordCount(records, raw.frameCount);
  assertLdacContainerLive(context.signal);
  return freezeLdacHeader(raw);
}
