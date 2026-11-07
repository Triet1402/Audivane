/**
 * Deterministic unit coverage for the supplemental LC3/LDAC asset loader and
 * its engine integration. These tests never depend on the optional built WASM
 * artifacts, so they run in every environment and document the exact loading
 * contract:
 *
 * - a configured URL is not availability: the runtime must actually fetch,
 *   validate the WebAssembly magic and the glue entry points before a codec
 *   is "loaded";
 * - 404/SPA-HTML assets and invalid glue fail deterministically and allow retry;
 * - the caller that starts a load owns its cancellation; a joined caller's
 *   abort only stops waiting; engine teardown aborts every in-flight load;
 * - both sibling fetches (glue JS + wasm) share one AbortController, so a
 *   partial failure/abort leaves nothing fetching in the dark;
 * - every LC3/LDAC encoder/decoder session creation propagates the caller's
 *   abort signal into the module load;
 * - engine prepare() refuses a missing/invalid configured asset with
 *   supplemental-codec-unconfigured BEFORE any source audio is read, even
 *   with no prior capabilities() call, and an aborted initial fetch rejects
 *   with AbortError while stopping the in-flight fetch.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PreparationRequest } from "@codec-abx/contracts";

import {
  SupplementalCodecRuntime,
  createLc3DecoderSession,
  createLc3EncoderSession,
  createLdacDecoderSession,
  createLdacEncoderSession,
  type RawEmscriptenModule,
  type SupplementalCodecId,
  type SupplementalLoader,
} from "../src/supplemental-codecs.js";
import { BrowserPreparationEngine } from "../src/index.js";

const ORIGIN = "https://app.test";
const lc3WasmUrl = `${ORIGIN}/codec-assets/lc3_codec.wasm`;
const lc3GlueUrl = `${ORIGIN}/codec-assets/lc3_codec.js`;
const ldacWasmUrl = `${ORIGIN}/codec-assets/ldac_codec.wasm`;
const ldacGlueUrl = `${ORIGIN}/codec-assets/ldac_codec.js`;

interface FetchInvocation {
  readonly url: string;
  readonly signal: AbortSignal | null;
}

type Responder = (invocation: FetchInvocation) => Response | Promise<Response>;

function plainResponse(status: number, body: string | ArrayBuffer, contentType?: string): Response {
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  return new Response(body as BodyInit, { status, headers });
}

/**
 * Installs a URL-keyed fetch stub. Unknown URLs answer 404 like a passive
 * static host; known URLs call their responder with the recorded invocation.
 * Hanging responders must reject on the invocation's abort signal, exactly
 * like a real fetch would.
 */
function installFetch(server: Record<string, Responder>): {
  calls: FetchInvocation[];
  restore(): void;
} {
  const calls: FetchInvocation[] = [];
  const original = globalThis.fetch;
  const stubbed: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)).href;
    const nothingRequested: AbortSignal | null = null;
    const invocation: FetchInvocation = {
      url,
      signal: (init?.signal ?? (input instanceof Request ? input.signal : nothingRequested)) ?? null,
    };
    calls.push(invocation);
    const responder: Responder | undefined = server[url];
    const response = responder ? await responder(invocation) : plainResponse(404, "not found");
    return response;
  }) as unknown as typeof fetch;
  globalThis.fetch = stubbed;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const WASM_MODULE_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer;

const SPA_HTML = "<!DOCTYPE html><html><body>supplemental host fallback</body></html>";

/**
 * A minimal valid glue for the Emscripten MODULARIZE contract used by
 * instantiateGlue: exports the factory, which returns a fake raw module the
 * runtime validates entry-point-wise before considering it "loaded".
 */
function fakeGlueSource(exportName: "createLC3Codec" | "createLDACCodec"): string {
  return `function ${exportName}(options) {
    return globalThis.__fakeSupplementalRawModule(options);
  }`;
}

function fakeRawModule(): RawEmscriptenModule {
  const heap = new ArrayBuffer(1 << 16);
  const view = new DataView(heap);
  let cursor = 1024;
  const malloc = (bytes: number): number => {
    if (cursor + bytes > heap.byteLength) throw new Error("fake heap exhausted");
    const pointer = cursor;
    cursor += bytes + 16;
    return pointer;
  };
  return {
    HEAPU8: new Uint8Array(heap),
    HEAP16: new Int16Array(heap),
    HEAPU16: new Uint16Array(heap),
    HEAPU32: new Uint32Array(heap),
    HEAPF32: new Float32Array(heap),
    _malloc: malloc,
    _free: () => {},
    _lc3_encoder_new: (_rate, _channels, _bitrate, _frameUs, metaPtr) => {
      view.setInt32(metaPtr, 120, true); // block bytes
      view.setInt32(metaPtr + 4, 480, true); // frame samples
      view.setInt32(metaPtr + 8, 0, true); // delay samples
      view.setInt32(metaPtr + 12, 96_000, true); // effective bitrate
      return 7;
    },
    _lc3_encode_block: () => 0,
    _lc3_frame_len: () => 58,
    _lc3_frame_copy: () => 0,
    _lc3_encoder_free: () => {},
    _lc3_decoder_new: () => 9,
    _lc3_decode_block: () => 0,
    _lc3_decoder_free: () => {},
    _ldac_wasm_encoder_new: (_rate, _channels, _bitrate, metaPtr) => {
      view.setInt32(metaPtr, 128, true); // frame samples per block
      view.setInt32(metaPtr + 4, 990, true); // reported bitrate
      return 11;
    },
    _ldac_wasm_encode_block: () => 0,
    _ldac_wasm_encoder_flush: () => 0,
    _ldac_wasm_frame_len: () => 0,
    _ldac_wasm_frame_copy: () => 0,
    _ldac_wasm_encoder_free: () => {},
    _ldac_wasm_decoder_new: () => 13,
    _ldac_wasm_decode_block: () => 128,
    _ldac_wasm_decoder_free: () => {},
  };
}

function withFakeModule<T>(run: () => Promise<T>): Promise<T> {
  const original = (globalThis as Record<string, unknown>).__fakeSupplementalRawModule;
  (globalThis as Record<string, unknown>).__fakeSupplementalRawModule = () => fakeRawModule();
  return run().finally(() => {
    (globalThis as Record<string, unknown>).__fakeSupplementalRawModule = original;
  });
}

function validAssetServer(): Record<string, Responder> {
  return {
    [lc3GlueUrl]: () => plainResponse(200, fakeGlueSource("createLC3Codec"), "application/javascript"),
    [lc3WasmUrl]: () => plainResponse(200, WASM_MODULE_BYTES, "application/wasm"),
    [ldacGlueUrl]: () => plainResponse(200, fakeGlueSource("createLDACCodec"), "application/javascript"),
    [ldacWasmUrl]: () => plainResponse(200, WASM_MODULE_BYTES, "application/wasm"),
  };
}

/** A stalled fetch that rejects when the runtime-provided signal aborts. */
const hangingWasm: Responder = (invocation) =>
  new Promise<Response>((_resolve, reject) => {
    if (invocation.signal?.aborted) {
      reject(invocation.signal.reason ?? new DOMException("stalled", "AbortError"));
      return;
    }
    invocation.signal?.addEventListener("abort", () => {
      reject(invocation.signal?.reason ?? new DOMException("stalled", "AbortError"));
    }, { once: true });
  });

function assertAbortRejected(error: unknown): boolean {
  assert.ok(error instanceof Error, "rejection must be an Error");
  assert.equal(error.name, "AbortError", `expected AbortError, got ${error.name}: ${error.message}`);
  return true;
}

test("supplemental runtime availability requires a validated module, not a configured URL", async () => {
  await withFakeModule(async () => {
    const fetch1 = installFetch(validAssetServer());
    try {
      const runtime = new SupplementalCodecRuntime({
        lc3HelperUrl: lc3WasmUrl,
        ldacHelperUrl: ldacWasmUrl,
      });
      const before = runtime.availability("lc3");
      assert.equal(before.configured, true);
      assert.equal(before.loadState, "unloaded");
      await runtime.load("lc3");
      const after = runtime.availability("lc3");
      assert.equal(after.loadState, "loaded");
      assert.equal(after.reason, null);
      await runtime.dispose();
      assert.equal(runtime.availability("lc3").loadState, "unloaded");
    } finally {
      fetch1.restore();
    }
  });
});

test("a missing WASM asset (HTTP 404) records a failed load state with a reason and stays retryable", async () => {
  await withFakeModule(async () => {
    let serveWasm = false;
    const fetchPersistence = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: () => serveWasm
        ? plainResponse(200, WASM_MODULE_BYTES, "application/wasm")
        : plainResponse(404, "not found", "text/plain"),
    });
    try {
      const runtime = new SupplementalCodecRuntime({
        lc3HelperUrl: lc3WasmUrl,
        ldacHelperUrl: ldacWasmUrl,
      });
      await assert.rejects(
        runtime.load("lc3", null),
        /HTTP 404 fetching .*lc3_codec\.wasm/,
      );
      const failed = runtime.availability("lc3");
      assert.equal(failed.loadState, "failed");
      assert.ok(failed.reason?.includes("404"), `reason: ${String(failed.reason)}`);
      // A corrected/served asset must be loadable again (failures are not
      // cached as poison and cancelled loads stay retryable).
      serveWasm = true;
      const module = await runtime.load("lc3", null);
      assert.ok(module._lc3_encoder_new);
      assert.equal(runtime.availability("lc3").loadState, "loaded");
      await runtime.dispose();
    } finally {
      fetchPersistence.restore();
    }
  });
});

test("a SPA HTML response is refused for both the glue and the wasm asset", async () => {
  await withFakeModule(async () => {
    {
      const probe = installFetch({
        ...validAssetServer(),
        [lc3GlueUrl]: () => plainResponse(200, SPA_HTML, "text/html"),
      });
      try {
        const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
        await assert.rejects(
          runtime.load("lc3", null),
          /lc3_codec\.js.*did not produce a usable module/,
        );
        assert.equal(runtime.availability("lc3").loadState, "failed");
        assert.match(runtime.availability("lc3").reason ?? "", /lc3_codec\.js/);
        await runtime.dispose();
      } finally {
        probe.restore();
      }
    }
    {
      const probe = installFetch({
        ...validAssetServer(),
        [lc3WasmUrl]: () => plainResponse(200, SPA_HTML, "text/html"),
      });
      try {
        const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
        await assert.rejects(
          runtime.load("lc3", null),
          /lc3_codec\.wasm.*does not contain a WebAssembly module/,
        );
        assert.equal(runtime.availability("lc3").loadState, "failed");
        await runtime.dispose();
      } finally {
        probe.restore();
      }
    }
  });
});

test("an aborted initial fetch stops the in-flight fetch and leaves the load retryable", { timeout: 10_000 }, async () => {
  await withFakeModule(async () => {
    let serveWasm = false;
    const probe = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: (invocation) => serveWasm
        ? plainResponse(200, WASM_MODULE_BYTES, "application/wasm")
        : hangingWasm(invocation),
    });
    try {
      const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
      const job = new AbortController();
      const pending = runtime.load("lc3", job.signal);
      const invocation = probe.calls.find((call) => call.url === lc3WasmUrl);
      assert.ok(invocation, "the wasm fetch must have started");
      assert.ok(invocation.signal, "the runtime passes an abort signal into fetch");
      job.abort();
      await assert.rejects(pending, assertAbortRejected);
      assert.equal(invocation.signal.aborted, true, "the in-flight fetch was aborted, not merely abandoned");
      assert.equal(runtime.availability("lc3").loadState, "unloaded", "cancelled loads stay retryable");
      // Retry succeeds once the asset is actually served (a fresh caller; the
      // aborted job is gone).
      serveWasm = true;
      await runtime.load("lc3", new AbortController().signal);
      assert.equal(runtime.availability("lc3").loadState, "loaded");
      await runtime.dispose();
    } finally {
      probe.restore();
    }
  });
});

test("engine teardown aborts an in-flight supplemental load", { timeout: 10_000 }, async () => {
  await withFakeModule(async () => {
    const lifecycle = new AbortController();
    const probe = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: hangingWasm,
    });
    try {
      const runtime = new SupplementalCodecRuntime(
        { lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null }, lifecycle.signal);
      const pending = runtime.load("lc3", null);
      const invocation = probe.calls.find((call) => call.url === lc3WasmUrl);
      assert.ok(invocation?.signal, "fetch received a cancellation signal");
      const settled = pending.then(
        () => { throw new Error("load must not succeed after teardown"); },
        (error: unknown) => error,
      );
      await runtime.dispose();
      const rejection = await settled;
      assertAbortRejected(rejection);
      assert.equal(invocation.signal.aborted, true);
      assert.equal(runtime.availability("lc3").loadState, "unloaded");
    } finally {
      probe.restore();
    }
  });
});

test("a joined caller's abort stops waiting without killing the initiator's load; teardown kills both", { timeout: 10_000 }, async () => {
  await withFakeModule(async () => {
    const lifecycle = new AbortController();
    const probe = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: hangingWasm,
    });
    try {
      const runtime = new SupplementalCodecRuntime(
        { lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null }, lifecycle.signal);
      const initiatorPending = runtime.load("lc3", null);
      const joiner = new AbortController();
      const joinerPending = runtime.load("lc3", joiner.signal);
      // Only one shared fetch starts: loads are coalesced per codec.
      const wasmCalls = probe.calls.filter((call) => call.url === lc3WasmUrl);
      assert.equal(wasmCalls.length, 1);
      const wasmSignal = wasmCalls[0]!.signal;
      assert.ok(wasmSignal);
      joiner.abort();
      await assert.rejects(joinerPending, assertAbortRejected);
      assert.equal(wasmSignal.aborted, false, "a joiner's abort must not cancel the initiator's fetch");
      lifecycle.abort();
      await assert.rejects(initiatorPending, assertAbortRejected);
      assert.equal(wasmSignal.aborted, true, "teardown aborts the shared fetch for the initiator");
      await runtime.dispose();
    } finally {
      probe.restore();
    }
  });
});

test("a partial fetch failure (wasm 500, glue stalled) aborts the sibling fetch", async () => {
  await withFakeModule(async () => {
    const probe = installFetch({
      ...validAssetServer(),
      [lc3GlueUrl]: hangingWasm,
      [lc3WasmUrl]: () => plainResponse(500, "boom", "text/plain"),
    });
    try {
      const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
      const caller = new AbortController();
      await assert.rejects(runtime.load("lc3", caller.signal), /HTTP 500/);
      // The sibling fetch must stop when the other fetch fails.
      const glueCall = probe.calls.find((call) => call.url === lc3GlueUrl);
      assert.ok(glueCall?.signal, "the sibling fetch ran under the load's shared signal");
      assert.equal(glueCall.signal.aborted, true, "a failed load aborts its sibling fetch");
      assert.equal(runtime.availability("lc3").loadState, "failed");
      await runtime.dispose();
    } finally {
      probe.restore();
    }
  });
});

test("an aborted caller stops a stalled sibling fetch", async () => {
  await withFakeModule(async () => {
    const probe = installFetch({
      ...validAssetServer(),
      [lc3GlueUrl]: hangingWasm,
      [lc3WasmUrl]: () => plainResponse(200, WASM_MODULE_BYTES, "application/wasm"),
    });
    try {
      const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
      const caller = new AbortController();
      const pending = runtime.load("lc3", caller.signal);
      caller.abort();
      await assert.rejects(pending, assertAbortRejected);
      const glueCall = probe.calls.find((call) => call.url === lc3GlueUrl);
      assert.ok(glueCall?.signal?.aborted, "the still-in-flight sibling fetch was aborted");
      assert.equal(runtime.availability("lc3").loadState, "unloaded");
      await runtime.dispose();
    } finally {
      probe.restore();
    }
  });
});

const lc3RawCallRequest: PreparationRequest = {
  version: 2, sampleRateMode: "native",
  a: [{ codecId: "lc3", bitrateKbps: 96 }],
  b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
};
const ldacRawCallRequest: PreparationRequest = {
  version: 2, sampleRateMode: "native",
  a: [{ codecId: "ldac", bitrateKbps: 990 }],
  b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
};

test("engine prepare refuses missing supplemental assets before reading the source, with no prior capabilities call", async () => {
  await withFakeModule(async () => {
    // Both glue and wasm resolve to the SPA fallback: the app bundle serves an
    // HTML response instead of the modules.
    const probe = installFetch({
      [lc3GlueUrl]: () => plainResponse(200, SPA_HTML, "text/html"),
      [lc3WasmUrl]: () => plainResponse(200, SPA_HTML, "text/html"),
      [ldacGlueUrl]: () => plainResponse(200, SPA_HTML, "text/html"),
      [ldacWasmUrl]: () => plainResponse(200, SPA_HTML, "text/html"),
    });
    try {
      const engine = new BrowserPreparationEngine({
        coreURL: `${ORIGIN}/codec-assets/ffmpeg-core.js`,
        wasmURL: `${ORIGIN}/codec-assets/ffmpeg-core.wasm`,
        lc3WasmURL: lc3WasmUrl,
        ldacWasmURL: ldacWasmUrl,
      });
      let sourceRead = false;
      const committed = {
        size: 1024,
        arrayBuffer: async () => {
          sourceRead = true;
          return new ArrayBuffer(16);
        },
      };
      for (const request of [lc3RawCallRequest, ldacRawCallRequest]) {
        await assert.rejects(
          engine.prepare(committed as unknown as File, request),
          /Browser supplemental-codec-unconfigured: .* refuses|could not be loaded for use/,
        );
      }
      assert.equal(sourceRead, false, "nothing of the source was read or normalized");
      // Capabilities (even with a broken engine probe) report the missing
      // assets as unavailable, not available.
      const capabilities = await engine.capabilities();
      const byId = new Map(capabilities.codecs.map((codec) => [codec.codecId, codec] as const));
      const lc3 = byId.get("lc3");
      const ldac = byId.get("ldac");
      assert.equal(lc3?.availability, "unavailable");
      assert.match(lc3?.reason ?? "", /supplemental-codec-unconfigured/);
      assert.equal(ldac?.availability, "unavailable");
      assert.match(ldac?.reason ?? "", /supplemental-codec-unconfigured/);
      await engine.dispose();
    } finally {
      probe.restore();
    }
  });
});

test("an aborted prepare while the initial supplemental fetch stalls rejects with AbortError and never reads the source", { timeout: 10_000 }, async () => {
  await withFakeModule(async () => {
    const probe = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: hangingWasm,
    });
    try {
      const engine = new BrowserPreparationEngine({
        coreURL: `${ORIGIN}/codec-assets/ffmpeg-core.js`,
        wasmURL: `${ORIGIN}/codec-assets/ffmpeg-core.wasm`,
        lc3WasmURL: lc3WasmUrl,
        ldacWasmURL: ldacWasmUrl,
      });
      let sourceRead = false;
      const committed = {
        size: 1024,
        arrayBuffer: async () => {
          sourceRead = true;
          return new ArrayBuffer(16);
        },
      };
      const external = new AbortController();
      const pending = engine.prepare(committed as unknown as File, lc3RawCallRequest, {
        signal: external.signal,
      }).then(
        () => { throw new Error("prepare must not succeed without the module"); },
        (error: unknown) => error as unknown,
      );
      const wasmCall = probe.calls.find((call) => call.url === lc3WasmUrl);
      assert.ok(wasmCall?.signal, "the module load received a job-owned cancel signal");
      external.abort();
      const rejection = await pending;
      assertAbortRejected(rejection);
      assert.equal(wasmCall.signal.aborted, true, "teardown of the job aborted the in-flight fetch");
      assert.equal(sourceRead, false);
      await engine.dispose();
    } finally {
      probe.restore();
    }
  });
});

test("engine capabilities refuse the unconfigured-URL case exactly as before", async () => {
  const probe = installFetch({});
  const engine = new BrowserPreparationEngine({
    coreURL: `${ORIGIN}/codec-assets/ffmpeg-core.js`,
    wasmURL: `${ORIGIN}/codec-assets/ffmpeg-core.wasm`,
  });
  try {
    const capabilities = await engine.capabilities();
    const byId = new Map(capabilities.codecs.map((codec) => [codec.codecId, codec] as const));
    assert.equal(byId.get("lc3")?.availability, "unavailable");
    assert.match(byId.get("lc3")?.reason ?? "", /supplemental-codec-unconfigured/);
    assert.equal(byId.get("ldac")?.availability, "unavailable");
    assert.match(byId.get("ldac")?.reason ?? "", /supplemental-codec-unconfigured/);
  } finally {
    await engine.dispose();
    probe.restore();
  }
});

test("validated modules report the FFmpeg probe failure as their remaining dependency", async () => {
  await withFakeModule(async () => {
    const probe = installFetch(validAssetServer());
    const engine = new BrowserPreparationEngine({
      coreURL: `${ORIGIN}/codec-assets/ffmpeg-core.js`,
      wasmURL: `${ORIGIN}/codec-assets/ffmpeg-core.wasm`,
      lc3WasmURL: lc3WasmUrl,
      ldacWasmURL: ldacWasmUrl,
    });
    try {
      // This Node environment has no browser Worker, so the real FFmpeg probe
      // fails while the independent supplemental module validation succeeds.
      const capabilities = await engine.capabilities();
      for (const codecId of ["lc3", "ldac"]) {
        const codec = capabilities.codecs.find((codec) => codec.codecId === codecId);
        assert.equal(codec?.availability, "unknown");
        assert.match(codec?.reason ?? "", /validated.*FFmpeg capability probe/i);
        assert.doesNotMatch(codec?.reason ?? "", /supplemental-codec-unprobed/);
      }
    } finally {
      await engine.dispose();
      probe.restore();
    }
  });
});

test("an immediate retry does not join a cancelled initiator's pending load", async () => {
  await withFakeModule(async () => {
    let serveWasm = false;
    const probe = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: (invocation) => serveWasm
        ? plainResponse(200, WASM_MODULE_BYTES, "application/wasm") : hangingWasm(invocation),
    });
    const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
    try {
      const caller = new AbortController();
      const first = runtime.load("lc3", caller.signal);
      const firstRejected = assert.rejects(first, assertAbortRejected);
      caller.abort();
      serveWasm = true;
      const retried = runtime.load("lc3");
      await firstRejected;
      await retried;
      assert.equal(runtime.availability("lc3").loadState, "loaded");
    } finally {
      await runtime.dispose();
      probe.restore();
    }
  });
});

test("capability module validation has a bounded wait and aborts stalled asset fetches", async (t) => {
  await withFakeModule(async () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const probe = installFetch({
      ...validAssetServer(),
      [lc3WasmUrl]: (invocation) => { started(); return hangingWasm(invocation); },
    });
    const engine = new BrowserPreparationEngine({
      coreURL: `${ORIGIN}/codec-assets/ffmpeg-core.js`,
      wasmURL: `${ORIGIN}/codec-assets/ffmpeg-core.wasm`,
      lc3WasmURL: lc3WasmUrl,
      ldacWasmURL: ldacWasmUrl,
    });
    try {
      let settled = false;
      const pending = engine.capabilities().then((result) => { settled = true; return result; });
      void pending.catch(() => {}); // Observe disposal rejection if a regression fails the assertion below.
      await entered;
      t.mock.timers.tick(10_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, true, "a stalled optional module cannot block discovery indefinitely");
      const result = await pending;
      const lc3 = result.codecs.find((codec) => codec.codecId === "lc3");
      assert.equal(lc3?.availability, "unknown");
      assert.match(lc3?.reason ?? "", /timed out/);
      assert.equal(probe.calls.find((call) => call.url === lc3WasmUrl)?.signal?.aborted, true);
    } finally {
      await engine.dispose();
      probe.restore();
    }
  });
});

test("every LC3/LDAC encoder/decoder session factory propagates the caller's abort signal", async () => {
  const loads: { codecId: SupplementalCodecId; signal: AbortSignal | null }[] = [];
  const loader: SupplementalLoader = {
    load: async (codecId, signal) => {
      loads.push({ codecId, signal: signal ?? null });
      return fakeRawModule();
    },
  };
  const signal = new AbortController().signal;
  await createLc3EncoderSession(loader, 48_000, 2, 96_000, 10_000, signal);
  await createLc3DecoderSession(loader, 48_000, 2, 10_000, false, signal);
  await createLdacEncoderSession(loader, 48_000, 2, 990, signal);
  await createLdacDecoderSession(loader, 48_000, 2, signal);
  assert.deepEqual(loads.map((load) => load.codecId), ["lc3", "lc3", "ldac", "ldac"]);
  assert.ok(loads.every((load) => load.signal === signal),
    "each factory passed the caller's signal into the module load");
  // Omitted signal still reaches the loader as null (same explicit contract).
  loads.length = 0;
  await createLdacDecoderSession(loader, 48_000, 1);
  assert.equal(loads[0]!.signal, null);
});

test("a session factory rejects with AbortError when its load is aborted", async () => {
  const rejectingLoader: SupplementalLoader = {
    load: async () => {
      throw new DOMException("Supplemental codec module load aborted", "AbortError");
    },
  };
  await assert.rejects(
    createLdacEncoderSession(rejectingLoader, 48_000, 2, 330, new AbortController().signal),
    assertAbortRejected,
  );
});

test("a cancelled instantiation cannot publish a late module into the cache", async () => {
  await withFakeModule(async () => {
    let finish!: (module: RawEmscriptenModule) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const delayed = new Promise<RawEmscriptenModule>((resolve) => { finish = resolve; });
    (globalThis as Record<string, unknown>).__fakeSupplementalRawModule = () => {
      started();
      return delayed;
    };
    const probe = installFetch(validAssetServer());
    const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
    try {
      const caller = new AbortController();
      const pending = runtime.load("lc3", caller.signal);
      await entered;
      caller.abort();
      await assert.rejects(pending, assertAbortRejected);
      finish(fakeRawModule());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runtime.availability("lc3").loadState, "unloaded",
        "a late result from an aborted load must never restore the cache");
    } finally {
      finish(fakeRawModule());
      await runtime.dispose();
      probe.restore();
    }
  });
});

test("teardown interrupts instantiation after both fetches have completed", async () => {
  await withFakeModule(async () => {
    let finish!: (module: RawEmscriptenModule) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const delayed = new Promise<RawEmscriptenModule>((resolve) => { finish = resolve; });
    (globalThis as Record<string, unknown>).__fakeSupplementalRawModule = () => {
      started();
      return delayed;
    };
    const probe = installFetch(validAssetServer());
    const runtime = new SupplementalCodecRuntime({ lc3HelperUrl: lc3WasmUrl, ldacHelperUrl: null });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runtime.load("lc3");
      const settled = pending.then(() => "loaded", (error: unknown) => error);
      await entered;
      await runtime.dispose();
      const result = await Promise.race([settled, new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("still pending after teardown"), 100);
      })]);
      assertAbortRejected(result);
      finish(fakeRawModule());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runtime.availability("lc3").loadState, "unloaded");
    } finally {
      clearTimeout(timeout);
      finish(fakeRawModule());
      await runtime.dispose();
      probe.restore();
    }
  });
});
