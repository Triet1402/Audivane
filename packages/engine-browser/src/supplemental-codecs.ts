/**
 * Supplemental same-origin WASM codecs for LC3 and LDAC in the browser.
 *
 * The pinned @ffmpeg/core 0.12.10 lists neither codec, and LDAC can never be an
 * FFmpeg codec. These codecs are compiled from the exact same pinned sources as
 * the native desktop tier (pinned liblc3 1.1.3; AOSP libldac 2.00.02 at commit
 * eeee1a3f5f8df1282e3a6d297085885fd886737b; hegdi/libldacdec at commit
 * 7f3bd6cc1586b764b02f2e4f20b16c7ff18758b9) and loaded as same-origin assets
 * next to the pinned ffmpeg core. There is no CDN and no alias, simulation or
 * native fallback: a missing asset refuses the request exactly like a missing
 * native LDAC helper.
 *
 * Provenance and container behavior mirror packages/engine-native:
 * - LC3 is encoded at an explicit internal 48 kHz / 10 ms configuration into the
 *   FFmpeg `lc3` raw container (no rate header; the encoded rate is the explicit
 *   setting), then every stage is restored to the session rate/channels.
 * - LDAC encodes into the ldac_helper v1 container. The decoder is the
 *   third-party reverse-engineered hegdi/libldacdec implementation; no vendor
 *   validation or bit-exact equivalence with a retail LDAC sink is established.
 *
 * Modules are Emscripten -sMODULARIZE builds with EXPORT_NAME createLC3Codec /
 * createLDACCodec, instantiated with a fetched wasmBinary (the test harness
 * serves assets without the application/wasm MIME type, so
 * WebAssembly.instantiateStreaming is deliberately avoided).
 */

export const LC3_SUPPLEMENTAL_PROVENANCE =
  "liblc3 1.1.3 (same-origin WASM build, pinned with the native FFmpeg tier)" as const;
export const LDAC_SUPPLEMENTAL_PROVENANCE =
  "AOSP libldac 2.00.02 (eeee1a3f) + hegdi/libldacdec 7f3bd6cc (same-origin WASM build of ldac_helper)" as const;

export type SupplementalCodecId = "lc3" | "ldac";

/**
 * The engine (and anything reusing these sessions, e.g. Node parity tests)
 * supplies a loader; a real runtime fetches same-origin assets, a test can
 * instantiate from disk. Kept structural so there is no cast anywhere.
 */
export interface SupplementalLoader {
  load(codecId: SupplementalCodecId, signal?: AbortSignal | null): Promise<RawEmscriptenModule>;
}

/** Engine options keep URLs explicit; absence means the codec stays refused. */
export interface SupplementalAssetUrls {
  readonly lc3HelperUrl: string | null;
  readonly ldacHelperUrl: string | null;
}

export interface SupplementalAvailability {
  readonly configured: boolean;
  readonly loadState: "unloaded" | "loaded" | "failed";
  readonly reason: string | null;
}

/** One decoded/encoded chunk boundary callback result; never carries secrets. */
export interface SupplementalProgress {
  readonly framesDone: number;
  readonly totalFrames: number;
}

/**
 * Exact C glue ABI the engine relies on (documented in the supplemental WASM
 * build README; one adaptor per module keeps adjustments local). All
 * functions return 0 on success and -1 on failure unless stated otherwise.
 *
 * LC3 (frame level, mirroring libavcodec/liblc3enc.c math):
 *   int32_t _lc3_encoder_new(int32_t rate_hz, int channels,
 *       int32_t bitrate_bps, int32_t frame_duration_us, int32_t* meta_out4);
 *     -> encoder handle (0 = failure); meta_out4 receives, in order,
 *        block_bytes, frame_samples, delay_samples, effective_bitrate_bps.
 *   int32_t _lc3_encode_block(int32_t handle, int16_t* pcm_block);
 *     -> encodes exactly frame_samples*channels int16 samples (zero-padded for
 *        the final partial block and the closing zero block; the caller owns
 *        the padding).
 *   int32_t _lc3_frame_len(int32_t handle);            // payload bytes
 *   int32_t _lc3_frame_copy(int32_t handle, uint8_t* out); // copies payload
 *   void    _lc3_encoder_free(int32_t handle);
 *   int32_t _lc3_decoder_new(int32_t rate_hz, int channels,
 *       int32_t frame_duration_us, int32_t hr_mode);   // handle or 0
 *   int32_t _lc3_decode_block(int32_t handle, uint8_t* frame, int32_t frame_bytes,
 *       int16_t* out); // writes frame_samples interleaved samples; 0 ok
 *   void    _lc3_decoder_free(int32_t handle);
 *
 * LDAC (the in-memory port of tools/ldac_helper.c; record level):
 *   int32_t _ldac_wasm_encoder_new(int32_t rate, int channels, int32_t bitrate_kbps,
 *       int32_t* meta_out2); // handle; meta: [0]=encoder LSU samples per frame,
 *                            // [1]=actual bitrate as libldac reports (kbps)
 *   int32_t _ldac_wasm_encode_block(int32_t handle, int16_t* pcm_block);
 *     -> one LSU block (meta[0]*channels int16 samples, zero padded when partial).
 *   int32_t _ldac_wasm_frame_len(int32_t handle); // transport frame bytes, or 0
 *   int32_t _ldac_wasm_frame_copy(int32_t handle, uint8_t* out);
 *   void    _ldac_wasm_encoder_free(int32_t handle);
 *   int32_t _ldac_wasm_decoder_new(int32_t rate, int channels); // handle or 0
 *   int32_t _ldac_wasm_decode_block(int32_t handle, uint8_t* frame,
 *       int32_t frame_bytes, int16_t* out); // returns decoded sample frames (128)
 *   void    _ldac_wasm_decoder_free(int32_t handle);
 *
 * Heap sizes come from module memory growth, so every pointer stays within
 * module.HEAPU8. There is one engine-owned input buffer per session.
 */
export interface RawEmscriptenModule {
  readonly HEAPU8: Uint8Array;
  readonly HEAP16: Int16Array;
  readonly HEAPU16: Uint16Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPF32: Float32Array;
  readonly _malloc?: (bytes: number) => number;
  readonly _free?: (pointer: number) => void;
  // LC3
  readonly _lc3_encoder_new?: (rateHz: number, channels: number, bitrateBps: number,
    frameDurationUs: number, metaPtr: number) => number;
  readonly _lc3_encode_block?: (handle: number, pcmPtr: number) => number;
  readonly _lc3_frame_len?: (handle: number) => number;
  readonly _lc3_frame_copy?: (handle: number, outPtr: number) => number;
  readonly _lc3_encoder_free?: (handle: number) => void;
  readonly _lc3_decoder_new?: (rateHz: number, channels: number,
    frameDurationUs: number, hrMode: number) => number;
  readonly _lc3_decode_block?: (handle: number, framePtr: number, frameBytes: number,
    outPtr: number) => number;
  readonly _lc3_decoder_free?: (handle: number) => void;
  // LDAC
  readonly _ldac_wasm_encoder_new?: (rateHz: number, channels: number, bitrateKbps: number,
    metaPtr: number) => number;
  readonly _ldac_wasm_encode_block?: (handle: number, pcmPtr: number) => number;
  readonly _ldac_wasm_encoder_flush?: (handle: number) => number;
  readonly _ldac_wasm_frame_len?: (handle: number) => number;
  readonly _ldac_wasm_frame_copy?: (handle: number, outPtr: number) => number;
  readonly _ldac_wasm_encoder_free?: (handle: number) => void;
  readonly _ldac_wasm_decoder_new?: (rateHz: number, channels: number) => number;
  readonly _ldac_wasm_decode_block?: (handle: number, framePtr: number, frameBytes: number,
    outPtr: number) => number;
  readonly _ldac_wasm_decoder_free?: (handle: number) => void;
}

/** Sibling `.js` glue for the configured `.wasm` asset URL, per copy contract. */
function glueUrlFor(wasmUrl: string): string {
  if (!wasmUrl.toLowerCase().endsWith(".wasm")) {
    throw new Error(`Supplemental codec asset must point at a .wasm file: ${wasmUrl}`);
  }
  return `${wasmUrl.slice(0, -".wasm".length)}.js`;
}

async function fetchBytes(url: string, signal: AbortSignal | null): Promise<ArrayBuffer> {
  const response = await fetch(url, signal === null
    ? { credentials: "same-origin" }
    : { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} fetching ${url}`);
  return response.arrayBuffer();
}

async function fetchText(url: string, signal: AbortSignal | null): Promise<string> {
  const response = await fetch(url, signal === null
    ? { credentials: "same-origin" }
    : { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} fetching ${url}`);
  return response.text();
}

function supplementalAbortError(): Error {
  return new DOMException("Supplemental codec module load aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Stops waiting for a shared promise when this caller's own signal aborts. */
function waitAborted<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The operation may already be running: still observe a late rejection.
    void promise.catch(() => {});
    return Promise.reject(supplementalAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(supplementalAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The .wasm asset must really be a WebAssembly module, not a SPA fallback. */
function assertWebAssemblyAsset(codecId: SupplementalCodecId, url: string, bytes: ArrayBuffer): void {
  const magic = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  const isWasm = bytes.byteLength >= 4 &&
    magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d;
  if (!isWasm) {
    throw new Error(`Supplemental ${codecId.toUpperCase()} WASM asset at ${url} does not ` +
      `contain a WebAssembly module (${String(new Uint8Array(bytes).byteLength)} bytes; ` +
      "SPA fallback, wrong asset or corruption)");
  }
}

/**
 * Instantiate one Emscripten MODULARIZE glue. Kept as a standalone export so
 * Node-side parity tests can reuse the exact same loading contract as the
 * browser runtime. The wasm binary is always provided (same-origin fetch, or
 * disk in Node); modern Emscripten glues otherwise try to fetch a relative
 * file themselves, which also breaks when a test harness serves assets
 * without the canonical application/wasm MIME type.
 */
export async function instantiateGlue(
  glueSource: string,
  wasmBinary: ArrayBuffer,
  exportName: "createLC3Codec" | "createLDACCodec",
): Promise<unknown> {
  const factory = new Function(glueSource + ";\n" +
    `return typeof ${exportName} === "function" ? ${exportName} : null;`)();
  if (typeof factory !== "function") {
    throw new Error(`Emscripten glue did not export ${exportName}`);
  }
  const binary = () => new Uint8Array(wasmBinary);
  return factory({
    instantiateWasm: (imports: ConstructorParameters<typeof WebAssembly.Instance>[1], callback: (r: WebAssembly.Instance) => void) => {
      // Compilation happens eagerly from the provided bytes; instantiation is
      // synchronous, and returning a value tells the glue to keep going.
      const compiled = new WebAssembly.Module(binary());
      callback(new WebAssembly.Instance(compiled, imports));
      return {};
    },
    locateFile: (path: string) => {
      throw new Error(`Supplemental glue attempted to fetch ${path} instead of using provided bytes`);
    },
  });
}

/**
 * Owns supplemental module fetch/instantiation/caching. Capability discovery
 * and preparation both validate configured modules. Failed diagnostics are
 * retained for capability reports; subsequent loads retry failed or cancelled
 * attempts.
 *
 * Cancellation ownership: the in-flight load is owned by the CALLER that
 * STARTED it, combined with the engine teardown signal. Its abort signal (and
 * teardown) aborts the shared fetch; a joined caller that aborts only stops
 * waiting and never kills the initiator's load. Teardown (dispose) aborts
 * every in-flight load immediately. Both of the sibling fetches (glue and
 * wasm) share one AbortController, so a partial failure or abort cancels the
 * other in-flight fetch too and nothing is left dangling.
 *
 * When `lifecycleSignal` is provided (the engine's lifecycle signal), passing
 * it as a caller signal is redundant but harmless: teardown aborts regardless.
 */
export class SupplementalCodecRuntime {
  private readonly urls: SupplementalAssetUrls;
  private readonly lifecycleSignal: AbortSignal | null;
  private loaded = new Map<SupplementalCodecId, RawEmscriptenModule | null>();
  private loadPromises = new Map<SupplementalCodecId, Promise<RawEmscriptenModule>>();
  private loadControllers = new Map<SupplementalCodecId, AbortController>();
  private loadFailures = new Map<SupplementalCodecId, string>();

  constructor(urls: SupplementalAssetUrls, lifecycleSignal: AbortSignal | null = null) {
    this.urls = Object.freeze({ ...urls });
    this.lifecycleSignal = lifecycleSignal;
  }

  availability(codecId: SupplementalCodecId): SupplementalAvailability {
    const url = codecId === "lc3" ? this.urls.lc3HelperUrl : this.urls.ldacHelperUrl;
    if (url === null) {
      return {
        configured: false,
        loadState: "unloaded",
        reason: `Supplemental ${codecId.toUpperCase()} WASM asset URL was not configured; ` +
          "requests refuse before source reads",
      };
    }
    if (this.loaded.has(codecId)) {
      return this.loaded.get(codecId) === null
        ? {
            configured: true,
            loadState: "failed",
            reason: this.loadFailures.get(codecId) ??
              `Supplemental ${codecId.toUpperCase()} WASM module could not be loaded`,
          }
        : { configured: true, loadState: "loaded", reason: null };
    }
    return { configured: true, loadState: "unloaded", reason: null };
  }

  async load(codecId: SupplementalCodecId, signal: AbortSignal | null = null): Promise<RawEmscriptenModule> {
    if (signal?.aborted) throw supplementalAbortError();
    if (this.lifecycleSignal?.aborted) {
      throw new Error("Supplemental codec loader teardown already started");
    }
    const cached = this.loaded.get(codecId);
    if (cached) return cached;
    const pending = this.loadPromises.get(codecId);
    // A joining caller may stop waiting without aborting the initiating load.
    if (pending && !this.loadControllers.get(codecId)?.signal.aborted) {
      return waitAborted(pending, signal);
    }
    const url = codecId === "lc3" ? this.urls.lc3HelperUrl : this.urls.ldacHelperUrl;
    if (url === null) {
      throw new Error(`Supplemental ${codecId.toUpperCase()} WASM asset URL was not configured`);
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.lifecycleSignal?.addEventListener("abort", onAbort, { once: true });
    const promise = (async (): Promise<RawEmscriptenModule> => {
      try {
        const [glueSource, wasmBytes] = await waitAborted(Promise.all([
          fetchText(glueUrlFor(url), controller.signal),
          fetchBytes(url, controller.signal),
        ]), controller.signal);
        assertWebAssemblyAsset(codecId, url, wasmBytes);
        const exportName = codecId === "lc3" ? "createLC3Codec" : "createLDACCodec";
        let module: unknown;
        try {
          module = await waitAborted(instantiateGlue(glueSource, wasmBytes, exportName), controller.signal);
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          throw new Error(
            `Supplemental ${codecId.toUpperCase()} glue at ${glueUrlFor(url)} did not ` +
              `produce a usable module (${error instanceof Error ? error.message : String(error)}; ` +
              "SPA fallback, wrong asset or corruption)");
        }
        // A completed factory cannot publish after cancellation, teardown or
        // replacement by a retry. Instantiation itself may finish later.
        if (controller.signal.aborted || this.loadControllers.get(codecId) !== controller) {
          throw supplementalAbortError();
        }
        const raw = module as RawEmscriptenModule;
        if (!raw || !(raw.HEAPU8 instanceof Uint8Array) || !(raw.HEAP16 instanceof Int16Array) ||
            !(raw.HEAPU16 instanceof Uint16Array) || !(raw.HEAPU32 instanceof Uint32Array) ||
            !(raw.HEAPF32 instanceof Float32Array)) {
          throw new Error("Supplemental codec glue is missing its required heap views");
        }
        requireMallocFree(raw);
        if (codecId === "lc3") requireLc3Glue(raw); else requireLdacGlue(raw);
        this.loaded.set(codecId, raw);
        this.loadFailures.delete(codecId);
        return raw;
      } catch (error: unknown) {
        controller.abort(); // Also stop a sibling fetch after partial failure.
        if (this.loadControllers.get(codecId) === controller) {
          if (isAbortError(error)) {
            this.loaded.delete(codecId);
            this.loadFailures.delete(codecId);
          } else {
            this.loaded.set(codecId, null);
            this.loadFailures.set(codecId, error instanceof Error ? error.message : String(error));
          }
        }
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.lifecycleSignal?.removeEventListener("abort", onAbort);
        if (this.loadControllers.get(codecId) === controller) {
          this.loadControllers.delete(codecId);
          this.loadPromises.delete(codecId);
        }
      }
    })();
    this.loadPromises.set(codecId, promise);
    this.loadControllers.set(codecId, controller);
    return promise;
  }

  async dispose(): Promise<void> {
    // Teardown aborts every in-flight load (its promise rejects immediately),
    // then drops the whole cache so no module survives disposal.
    for (const controller of this.loadControllers.values()) {
      try {
        controller.abort();
      } catch {
        // Already aborted.
      }
    }
    this.loadControllers.clear();
    this.loaded.clear();
    this.loadPromises.clear();
    this.loadFailures.clear();
  }
}

/**
 * One canonical `encodeAll` of a PCM16 session buffer into LC3 frames; the
 * caller wraps frames into the FFmpeg raw container. Frames up to block_bytes
 * arrive per frame; the encoder owns its internal handles for exactly this
 * call, so no heap state leaks between stages.
 */
export interface Lc3WaveEncodeResult {
  readonly frames: Uint8Array[];
  readonly blockBytes: number;
  readonly frameSamples: number;
  readonly delaySamples: number;
  readonly effectiveBitrateBps: number;
}

/**
 * Releases the engine-owned heap pointers of a failed supplemental session
 * construction. Every factory allocates into zero-initialized sentinel
 * variables and zeroes a slot immediately after releasing it, so 0 always
 * means "never acquired (or already released)": nothing is freed twice and a
 * released slot is never freed again by this cleanup. Frees run in reverse
 * acquisition order (output, input, scratch).
 */
function releaseConstructionPointers(
  mallocFree: { _free: (pointer: number) => void },
  pointers: readonly number[],
): void {
  for (const pointer of pointers) {
    if (pointer !== 0) mallocFree._free(pointer);
  }
}

export interface Lc3EncoderSession {
  readonly blockBytes: number;
  readonly frameSamples: number;
  readonly delaySamples: number;
  readonly effectiveBitrateBps: number;
  /** Encodes one full/padded block; returns that frame's payload bytes. */
  encodeBlock(pcm: Int16Array): Uint8Array;
  dispose(): void;
}

export async function createLc3EncoderSession(
  loader: SupplementalLoader,
  rateHz: number,
  channels: 1 | 2,
  bitrateBps: number,
  frameDurationUs: number,
  signal: AbortSignal | null = null,
): Promise<Lc3EncoderSession> {
  const module = await runtimeLoadModule(loader, "lc3", signal);
  requireLc3Glue(module);
  const mallocFree = requireMallocFree(module);
  // Construction-failure custody (see supplemental-codec-allocation.test.ts):
  // everything acquired below is freed exactly once on both normal disposal
  // and any construction failure, including fault-injected zero-returning or
  // throwing malloc/constructor calls. 0 means "not acquired / released".
  let scratch = 0;
  let handle = 0;
  let inputPtr = 0;
  let outPtr = 0;
  try {
    scratch = mallocFree._malloc!(16);
    if (!scratch) throw new Error("Supplemental codec heap allocation failed");
    handle = module._lc3_encoder_new!(
      rateHz, channels, bitrateBps, frameDurationUs, scratch) as number;
    // Read the heap words before the scratch word is released.
    const meta = new Int32Array(4);
    meta.set(new Int32Array(module.HEAPU8.buffer, scratch, 4));
    mallocFree._free(scratch);
    scratch = 0;
    if (!handle) {
      throw new Error(`LC3 encoder rejected a ${String(rateHz)} Hz / ${String(channels)} ch / ` +
        `${String(bitrateBps)} bps configuration`);
    }
    const blockBytes = meta[0] as number;
    const frameSamples = meta[1] as number;
    if (!blockBytes || blockBytes <= 0 || !frameSamples || frameSamples <= 0) {
      throw new Error("LC3 encoder metadata was missing or implausible");
    }
    const inputBytes = frameSamples * channels * 2;
    inputPtr = mallocFree._malloc!(inputBytes);
    outPtr = mallocFree._malloc!(blockBytes + 3);
    if (!inputPtr || !outPtr) {
      throw new Error("LC3 encoder could not allocate its heap buffers");
    }
    return {
      blockBytes,
      frameSamples,
      delaySamples: meta[2] as number,
      effectiveBitrateBps: meta[3] as number,
      encodeBlock(pcm: Int16Array): Uint8Array {
        if (pcm.byteLength !== inputBytes) {
          throw new Error("LC3 encodeBlock requires an exactly padded interleaved block");
        }
        module.HEAPU8.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), inputPtr);
        if (module._lc3_encode_block!(handle, inputPtr) !== 0) {
          throw new Error("LC3 encoder failed on a frame block");
        }
        const payloadLen = module._lc3_frame_len!(handle);
        if (payloadLen <= 0 || payloadLen > blockBytes) {
          throw new Error(`LC3 encoder emitted an implausible frame length ${String(payloadLen)}`);
        }
        module._lc3_frame_copy!(handle, outPtr);
        return module.HEAPU8.slice(outPtr, outPtr + payloadLen);
      },
      dispose(): void {
        module._free?.(inputPtr);
        module._free?.(outPtr);
        module._lc3_encoder_free!(handle);
      },
    };
  } catch (error: unknown) {
    releaseConstructionPointers(mallocFree, [outPtr, inputPtr, scratch]);
    if (handle !== 0) module._lc3_encoder_free!(handle);
    throw error;
  }
}

export interface Lc3DecoderSession {
  readonly frameSamples: number;
  readonly delaySamples: number;
  /** Decodes one record payload; returns fresh interleaved samples. */
  decodeBlock(frame: Uint8Array): Int16Array;
  dispose(): void;
}

export async function createLc3DecoderSession(
  loader: SupplementalLoader,
  rateHz: number,
  channels: 1 | 2,
  frameDurationUs: number,
  hrMode: boolean,
  signal: AbortSignal | null = null,
): Promise<Lc3DecoderSession> {
  const module = await runtimeLoadModule(loader, "lc3", signal);
  requireLc3Glue(module);
  const mallocFree = requireMallocFree(module);
  let handle = 0;
  let inputPtr = 0;
  let outPtr = 0;
  try {
    handle = module._lc3_decoder_new!(rateHz, channels, frameDurationUs, hrMode ? 1 : 0);
    if (!handle) {
      throw new Error(`LC3 decoder rejected a ${String(rateHz)} Hz / ${String(channels)} ch configuration`);
    }
    const frameSamples = Math.round((frameDurationUs * rateHz) / 1_000_000);
    inputPtr = mallocFree._malloc!(1_024 + 8);
    outPtr = mallocFree._malloc!(frameSamples * channels * 2 + 8);
    if (!inputPtr || !outPtr) {
      throw new Error("LC3 decoder could not allocate its heap buffers");
    }
    return {
      frameSamples,
      delaySamples: Math.round((frameDurationUs === 7_500 ? 4_000 : 2_500) * rateHz / 1_000_000),
      decodeBlock(frame: Uint8Array): Int16Array {
        if (frame.byteLength === 0 || frame.byteLength > 1_024) {
          throw new Error(`LC3 decoder received an implausible frame length ${String(frame.byteLength)}`);
        }
        module.HEAPU8.set(frame, inputPtr);
        if (module._lc3_decode_block!(handle, inputPtr, frame.byteLength, outPtr) !== 0) {
          throw new Error("LC3 decoder failed on a frame block");
        }
        return module.HEAP16.slice(
          outPtr >> 1,
          (outPtr >> 1) + frameSamples * channels,
        );
      },
      dispose(): void {
        module._free?.(inputPtr);
        module._free?.(outPtr);
        module._lc3_decoder_free!(handle);
      },
    };
  } catch (error: unknown) {
    releaseConstructionPointers(mallocFree, [outPtr, inputPtr]);
    if (handle !== 0) module._lc3_decoder_free!(handle);
    throw error;
  }
}

export interface LdacEncoderSession {
  readonly blockSamples: number;
  /** Actual bitrate as libldac reported it (e.g. 990 at 48 kHz stereo). */
  readonly reportedBitrateKbps: number;
  /**
   * Drains every transport frame the encoder produced for this block.
   * ldacBT_encode may packetize several frames per call (helper semantics:
   * every 0xAA frame in the returned stream becomes one container record).
   */
  encodeBlock(pcm: Int16Array): Uint8Array[];
  /**
   * Drains the encoder's internal tail after the final padded block. This is
   * ldac_helper's flush loop: any resulting transport frames are appended.
   */
  flushFrames(): Uint8Array[];
  dispose(): void;
}

export async function createLdacEncoderSession(
  loader: SupplementalLoader,
  rateHz: 44_100 | 48_000,
  channels: 1 | 2,
  bitrateKbps: 330 | 660 | 990,
  signal: AbortSignal | null = null,
): Promise<LdacEncoderSession> {
  const module = await runtimeLoadModule(loader, "ldac", signal);
  requireLdacGlue(module);
  const mallocFree = requireMallocFree(module);
  let scratch = 0;
  let handle = 0;
  let inputPtr = 0;
  let outPtr = 0;
  try {
    scratch = mallocFree._malloc!(8);
    if (!scratch) throw new Error("Supplemental codec heap allocation failed");
    handle = module._ldac_wasm_encoder_new!(
      rateHz, channels, bitrateKbps, scratch) as number;
    const meta = new Int32Array(2);
    meta.set(new Int32Array(module.HEAPU8.buffer, scratch, 2));
    mallocFree._free(scratch);
    scratch = 0;
    if (!handle) {
      throw new Error(`LDAC encoder rejected a ${String(rateHz)} Hz / ${String(channels)} ch / ` +
        `${String(bitrateKbps)} kbps configuration`);
    }
    const blockSamples = meta[0] as number;
    if (!blockSamples || blockSamples <= 0) {
      throw new Error("LDAC encoder metadata was missing or implausible");
    }
    const inputBytes = blockSamples * channels * 2;
    inputPtr = mallocFree._malloc!(inputBytes);
    outPtr = mallocFree._malloc!(1_027 + 3);
    if (!inputPtr || !outPtr) {
      throw new Error("LDAC encoder could not allocate its heap buffers");
    }
    return {
      blockSamples,
      reportedBitrateKbps: meta[1] as number,
      encodeBlock(pcm: Int16Array): Uint8Array[] {
        if (pcm.byteLength !== inputBytes) {
          throw new Error(`LDAC encodeBlock requires an exactly padded block of ` +
            `${String(blockSamples * channels)} samples`);
        }
        module.HEAPU8.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), inputPtr);
        if (module._ldac_wasm_encode_block!(handle, inputPtr) !== 0) {
          throw new Error("LDAC encoder failed on a frame block");
        }
        const frames: Uint8Array[] = [];
        for (;;) {
          const drained = drainFrame(module, handle, outPtr);
          if (drained === null) break;
          if (frames.length > 16) {
            throw new Error("LDAC encoder produced implausibly many frames for one block");
          }
          frames.push(drained);
        }
        return frames;
      },
      flushFrames(): Uint8Array[] {
        const frames: Uint8Array[] = [];
        for (;;) {
          if (module._ldac_wasm_encoder_flush!(handle) !== 0) {
            throw new Error("LDAC encoder flush failed");
          }
          const drained = drainFrame(module, handle, outPtr);
          if (drained === null) break;
          frames.push(drained);
          if (frames.length > 16) {
            throw new Error("LDAC encoder flush produced implausibly many frames");
          }
        }
        return frames;
      },
      dispose(): void {
        module._free?.(inputPtr);
        module._free?.(outPtr);
        module._ldac_wasm_encoder_free!(handle);
      },
    };
  } catch (error: unknown) {
    releaseConstructionPointers(mallocFree, [outPtr, inputPtr, scratch]);
    if (handle !== 0) module._ldac_wasm_encoder_free!(handle);
    throw error;
  }
}

function drainFrame(module: RawEmscriptenModule, handle: number, outPtr: number): Uint8Array | null {
  const payloadLen = module._ldac_wasm_frame_len!(handle);
  if (payloadLen <= 0) return null;
  if (payloadLen > 1_027) {
    throw new Error(`LDAC encoder emitted an implausible frame length ${String(payloadLen)}`);
  }
  module._ldac_wasm_frame_copy!(handle, outPtr);
  return module.HEAPU8.slice(outPtr, outPtr + payloadLen);
}

export interface LdacDecoderSession {
  /** Decodes one transport frame; returns fresh interleaved samples. */
  decodeBlock(frame: Uint8Array): Int16Array;
  readonly blockSamples: number;
  dispose(): void;
}

export async function createLdacDecoderSession(
  loader: SupplementalLoader,
  rateHz: 44_100 | 48_000,
  channels: 1 | 2,
  signal: AbortSignal | null = null,
): Promise<LdacDecoderSession> {
  const module = await runtimeLoadModule(loader, "ldac", signal);
  requireLdacGlue(module);
  const mallocFree = requireMallocFree(module);
  let handle = 0;
  let inputPtr = 0;
  let outPtr = 0;
  try {
    handle = module._ldac_wasm_decoder_new!(rateHz, channels);
    if (!handle) {
      throw new Error(`LDAC decoder rejected a ${String(rateHz)} Hz / ${String(channels)} ch configuration`);
    }
    inputPtr = mallocFree._malloc!(1_027 + 8);
    outPtr = mallocFree._malloc!(512 * 2 * 2 + 8);
    if (!inputPtr || !outPtr) {
      throw new Error("LDAC decoder could not allocate its heap buffers");
    }
    return {
      blockSamples: 128,
      decodeBlock(frame: Uint8Array): Int16Array {
        if (frame.byteLength < 4 || frame.byteLength > 1_027) {
          throw new Error(`LDAC decoder received an implausible frame length ${String(frame.byteLength)}`);
        }
        module.HEAPU8.set(frame, inputPtr);
        const written = module._ldac_wasm_decode_block!(handle, inputPtr, frame.byteLength, outPtr);
        if (written <= 0) throw new Error("LDAC decoder failed on a transport frame");
        return module.HEAP16.slice(outPtr >> 1, (outPtr >> 1) + written * channels);
      },
      dispose(): void {
        module._free?.(inputPtr);
        module._free?.(outPtr);
        module._ldac_wasm_decoder_free!(handle);
      },
    };
  } catch (error: unknown) {
    releaseConstructionPointers(mallocFree, [outPtr, inputPtr]);
    if (handle !== 0) module._ldac_wasm_decoder_free!(handle);
    throw error;
  }
}

async function runtimeLoadModule(
  loader: SupplementalLoader,
  codecId: SupplementalCodecId,
  signal: AbortSignal | null = null,
): Promise<RawEmscriptenModule> {
  return loader.load(codecId, signal);
}



function requireMallocFree(
  module: RawEmscriptenModule,
): { _malloc: (bytes: number) => number; _free: (pointer: number) => void } {
  if (typeof module._malloc !== "function" || typeof module._free !== "function") {
    throw new Error("Supplemental codec glue does not export malloc/free");
  }
  return module as { _malloc: (bytes: number) => number; _free: (pointer: number) => void };
}

function requireLc3Glue(module: RawEmscriptenModule): void {
  const required = ["_lc3_encoder_new", "_lc3_encode_block", "_lc3_frame_len", "_lc3_frame_copy",
    "_lc3_encoder_free", "_lc3_decoder_new", "_lc3_decode_block", "_lc3_decoder_free"] as const;
  for (const name of required) {
    if (typeof module[name] !== "function") throw new Error(`LC3 WASM glue is missing its required entry point ${name}`);
  }
}

function requireLdacGlue(module: RawEmscriptenModule): void {
  const required = ["_ldac_wasm_encoder_new", "_ldac_wasm_encode_block", "_ldac_wasm_encoder_flush", "_ldac_wasm_frame_len",
    "_ldac_wasm_frame_copy", "_ldac_wasm_encoder_free", "_ldac_wasm_decoder_new",
    "_ldac_wasm_decode_block", "_ldac_wasm_decoder_free"] as const;
  for (const name of required) {
    if (typeof module[name] !== "function") throw new Error(`LDAC WASM glue is missing its required entry point ${name}`);
  }
}
