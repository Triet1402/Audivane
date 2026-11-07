import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import type { CodecSelection, PreparationRequest } from "@codec-abx/contracts";
import { guardNetwork, inspectWav, makePcm16Wav, sha256 } from "./fixtures.js";

// Compile the real adapter and real workers into a temporary library bundle.
// Routes serve it on both dev/preview origins; no app global or production hook.
let directory: string | null = null;
const assets = new Map<string, Buffer>();
async function collect(current: string, root: string): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await collect(absolute, root);
    else assets.set(path.relative(root, absolute).split(path.sep).join("/"), await readFile(absolute));
  }
}

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codec-chain-harness-"));
  await build({ configFile: false, root: process.cwd(), logLevel: "error",
    worker: { format: "es" },
    build: { target: "es2022", minify: false, outDir: directory, emptyOutDir: true,
      lib: { entry: path.join(process.cwd(), "packages/engine-browser/src/index.ts"),
        formats: ["es"], fileName: () => "codec-chain-engine.js" },
      rollupOptions: { output: { entryFileNames: "codec-chain-engine.js",
        chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } },
    },
  });
  await collect(directory, directory);
  expect([...assets.keys()].some((name) => name.includes("measurement-worker"))).toBe(true);
});

test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  assets.clear();
});

async function host(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const guard = await guardNetwork(page, origin);
  const byName = new Map([...assets.entries()].map(([name, data]) => [path.posix.basename(name), data]));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !["GET", "HEAD"].includes(route.request().method())) {
      await route.fallback();
      return;
    }
    const pathname = url.pathname;
    if (pathname === "/codec-chain-host") {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Codec chain test</title>" });
      return;
    }
    const data = assets.get(pathname.replace(/^\/+/, "")) ?? byName.get(path.posix.basename(pathname));
    if (data) await route.fulfill({ contentType: "application/javascript", body: data });
    else await route.fallback();
  });
  await page.goto(`${origin}/codec-chain-host`);
  return guard;
}

const noop: CodecSelection = { codecId: "noop_passthrough", bitrateKbps: 0 };
const opus: CodecSelection = { codecId: "opus", bitrateKbps: 64 };
const aac: CodecSelection = { codecId: "aac", bitrateKbps: 128 };
const mp3: CodecSelection = { codecId: "mp3", bitrateKbps: 128 };
const vorbis: CodecSelection = { codecId: "ogg_vorbis", bitrateKbps: 128 };
const mp2: CodecSelection = { codecId: "mp2", bitrateKbps: 128 };
const sbc: CodecSelection = { codecId: "sbc", bitrateKbps: 128 };
const aptx: CodecSelection = { codecId: "aptx", bitrateKbps: 352 };
const aptxHd: CodecSelection = { codecId: "aptx_hd", bitrateKbps: 576 };

const codecFacts: Readonly<Record<string, {
  encoder: string;
  decoder: string;
  internalRate: (targetRate: number) => number;
  headerRate: boolean;
}>> = {
  noop_passthrough: { encoder: "pcm_s16le", decoder: "pcm_s16le", internalRate: (rate) => rate, headerRate: true },
  opus: { encoder: "libopus", decoder: "opus", internalRate: () => 48000, headerRate: true },
  aac: { encoder: "aac", decoder: "aac", internalRate: (rate) => rate > 48000 ? 48000 : rate, headerRate: true },
  mp3: { encoder: "libmp3lame", decoder: "mp3float", internalRate: (rate) => rate > 48000 ? 48000 : rate, headerRate: true },
  ogg_vorbis: { encoder: "libvorbis", decoder: "vorbis", internalRate: (rate) => rate, headerRate: true },
  // Built-in FFmpeg MP2, not native libtwolame. Raw MP2 carries an MPEG header.
  mp2: { encoder: "mp2", decoder: "mp2float", internalRate: (rate) => rate > 48000 ? 48000 : rate, headerRate: true },
  // Raw SBC/aptX have no rate header; internal rates are asserted from provenance.
  sbc: { encoder: "sbc", decoder: "sbc", internalRate: (rate) => rate > 48000 ? 48000 : rate, headerRate: false },
  aptx: { encoder: "aptx", decoder: "aptx", internalRate: () => 48000, headerRate: false },
  aptx_hd: { encoder: "aptx_hd", decoder: "aptx_hd", internalRate: () => 48000, headerRate: false },
};

const chainCases: readonly {
  stages: readonly CodecSelection[];
  sourceRate: number;
  channels?: 1 | 2;
  mode?: "native" | "force_48k";
}[] = [
  { stages: [aac], sourceRate: 96000 },
  { stages: [mp3], sourceRate: 96000 },
  { stages: [vorbis], sourceRate: 44100 },
  { stages: [vorbis], sourceRate: 48000 },
  { stages: [mp2], sourceRate: 44100, channels: 1 },
  { stages: [mp2], sourceRate: 48000 },
  { stages: [mp2], sourceRate: 96000 },
  { stages: [sbc], sourceRate: 44100, channels: 1 },
  { stages: [sbc], sourceRate: 48000 },
  { stages: [sbc], sourceRate: 96000 },
  { stages: [aptx], sourceRate: 44100 },
  { stages: [aptx], sourceRate: 48000, channels: 1 },
  { stages: [aptx], sourceRate: 96000 },
  { stages: [aptxHd], sourceRate: 44100, channels: 1 },
  { stages: [aptxHd], sourceRate: 48000 },
  { stages: [aptx], sourceRate: 96000, mode: "force_48k" },
  { stages: [opus, mp3], sourceRate: 96000 },
  { stages: [mp2, sbc, aptxHd, mp3], sourceRate: 48000 },
  { stages: [aac, vorbis, opus, mp3], sourceRate: 48000 },
];
for (const { stages, sourceRate, channels = 2, mode = "native" } of chainCases) {
  const targetRate = mode === "force_48k" ? 48000 : sourceRate;
  test(`real WASM ${stages.map((stage) => stage.codecId).join(" → ")} at ${sourceRate} Hz ${channels}ch ${mode} preserves byte facts and stage provenance`, async ({ page, baseURL }) => {
    const guard = await host(page, baseURL!);
    const source = makePcm16Wav({ channels, sampleRate: sourceRate, seconds: 0.6 });
    const request: PreparationRequest = { version: 2, sampleRateMode: mode, a: stages, b: [noop] };
    const result = await page.evaluate(async ({ bytes, request }) => {
      // @ts-expect-error This test-only bundle is served by the route above.
      const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");
      const logs: string[] = [];
      const engine = new BrowserPreparationEngine({
        coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
        logger: (line: string) => logs.push(line),
      });
      const captures: { name: string; size: number; frames: number | null; sampleRate: number | null }[] = [];
      // Observe real MEMFS reads/commands, without replacing any codec operation.
      const originalRead = engine.readOwnedFile.bind(engine);
      engine.readOwnedFile = async (...args: unknown[]) => {
        const value: Uint8Array = await originalRead(...args);
        const name = String(args[1]);
        let frames: number | null = null, sampleRate: number | null = null;
        if (name.endsWith(".wav")) {
          const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
          let channels = 0;
          for (let offset = 12; offset + 8 <= value.length;) {
            const chunk = String.fromCharCode(...value.subarray(offset, offset + 4));
            const size = view.getUint32(offset + 4, true);
            if (chunk === "fmt ") { channels = view.getUint16(offset + 10, true); sampleRate = view.getUint32(offset + 12, true); }
            if (chunk === "data") frames = size / (channels * 2);
            offset += 8 + size + (size % 2);
          }
        }
        if (name.endsWith(".aac")) {
          // ADTS sampling_frequency_index, independent of requested metadata.
          sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000][(value[2]! >> 2) & 15] ?? null;
        } else if (name.endsWith(".mp3") || name.endsWith(".mp2")) {
          let start = 0;
          if (String.fromCharCode(...value.subarray(0, 3)) === "ID3") {
            start = 10 + ((value[6]! & 127) * 2097152 + (value[7]! & 127) * 16384 + (value[8]! & 127) * 128 + (value[9]! & 127));
          }
          for (let offset = start; offset + 4 <= value.length; offset += 1) {
            if (value[offset] !== 255 || (value[offset + 1]! & 224) !== 224) continue;
            const version = (value[offset + 1]! >> 3) & 3;
            const index = (value[offset + 2]! >> 2) & 3;
            if (version === 1 || index === 3) continue;
            sampleRate = [44100, 48000, 32000][index]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
            break;
          }
        } else if (name.endsWith(".ogg") || name.endsWith(".opus")) {
          const signature = name.endsWith(".opus") ? "OpusHead" : "vorbis";
          const header = String.fromCharCode(...value.subarray(0, 256));
          const offset = header.indexOf(signature);
          if (offset >= 0) sampleRate = new DataView(value.buffer, value.byteOffset, value.byteLength)
            .getUint32(offset + (signature === "OpusHead" ? 12 : 11), true);
        }
        captures.push({ name, size: value.length, frames, sampleRate });
        return value;
      };
      const deleted: string[] = [];
      const originalRemove = engine.removeStageFile.bind(engine);
      engine.removeStageFile = async (...args: unknown[]) => { await originalRemove(...args); deleted.push(String(args[2])); };
      try {
        const capabilities = await engine.capabilities();
        const artifact = await engine.prepare(new File([new Uint8Array(bytes)], "chain.wav"), request);
        const a = Array.from(new Uint8Array(await engine.readAudio(artifact.id, "a")));
        const b = Array.from(new Uint8Array(await engine.readAudio(artifact.id, "b")));
        await engine.release(artifact.id);
        return { capabilities, artifact, a, b, captures, deleted, logs };
      } finally { await engine.dispose(); }
    }, { bytes: Array.from(source), request });
    const bytes = new Uint8Array(result.a);
    const facts = inspectWav(bytes);
    expect(result.artifact.sourceSha256).toBe(sha256(source));
    expect(result.artifact.a.delivered).toEqual({ sampleRate: targetRate, channels, frames: facts.frames, wavSha256: sha256(bytes) });
    expect(result.artifact.a.requested).toEqual(stages.at(-1));
    expect(result.capabilities.maxStagesPerSide).toBe(4);
    expect(result.capabilities.codecs.filter((codec: { availability: string }) => codec.availability === "available").map((codec: { codecId: string }) => codec.codecId))
      .toEqual(["noop_passthrough", "opus", "aac", "ogg_vorbis", "mp3", "mp2", "sbc", "aptx", "aptx_hd"]);
    expect(result.artifact.a.stages).toHaveLength(stages.length);
    for (const [index, stage] of stages.entries()) {
      const evidence = result.artifact.a.stages![index]!;
      const expected = codecFacts[stage.codecId]!;
      expect(evidence.stageIndex).toBe(index + 1);
      expect(evidence.requested).toEqual(stage);
      expect(evidence.encoder).toBe(expected.encoder);
      expect(evidence.decoder).toBe(expected.decoder);
      expect(evidence.encodedSampleRate).toBe(expected.internalRate(targetRate));
      const encoded = result.captures.find((capture: { name: string }) => capture.name.startsWith(`enc_a_${index + 1}_`))!;
      const decoded = result.captures.find((capture: { name: string }) => capture.name.startsWith(`out_a_${index + 1}_`))!;
      // Raw SBC/aptX containers carry no sample-rate header; only header-bearing
      // formats are independently parsed. Provenance above remains explicit.
      if (expected.headerRate) expect(encoded.sampleRate).toBe(evidence.encodedSampleRate);
      else expect(encoded.sampleRate).toBeNull();
      expect(decoded.sampleRate).toBe(targetRate);
      expect(decoded.frames).not.toBeNull();
      expect(evidence.actualBitrateKbps).toBe(Math.round(encoded.size * 8 / (decoded.frames! / decoded.sampleRate!) / 100) / 10);
      expect(result.deleted).toContain(encoded.name);
      expect(result.deleted).toContain(decoded.name);
      if (stage.codecId === "aptx" || stage.codecId === "aptx_hd") {
        expect(result.artifact.disclosures.some((line: string) => line.includes("fixed-rate"))).toBe(true);
        if (channels === 1) {
          expect(result.artifact.disclosures.some((line: string) => line.includes("dual-mono"))).toBe(true);
        }
        expect(result.artifact.disclosures.some((line: string) => line.includes("pinned to 48 kHz internally"))).toBe(true);
      }
      if (stage.codecId === "mp2") {
        expect(result.artifact.disclosures.some((line: string) => line.includes("not native libtwolame"))).toBe(true);
      }
    }
    const final = result.artifact.a.stages!.at(-1)!;
    for (const field of ["encoder", "decoder", "actualBitrateKbps", "encodedSampleRate"] as const) expect(result.artifact.a[field]).toBe(final[field]);
    expect(result.artifact.preparation).toBeUndefined();
    expect(result.artifact.validity).toBeUndefined();
    expect(result.artifact.a.delivered.frames).toBe(result.captures.find((capture: { name: string }) => capture.name.startsWith(`out_a_${stages.length}_`))!.frames);
    expect(inspectWav(new Uint8Array(result.b)).frames).toBe(Math.round(0.6 * targetRate));
    expect(guard.disallowed).toEqual([]);
    expect(guard.wasmAssets.length).toBeGreaterThan(0);
  });
}

for (const variant of ["same-final-different-prefix", "reordered", "identical"] as const) {
  test(`prepared mixed chains ${variant} evaluate final gates and canary once`, async ({ page, baseURL }) => {
    const guard = await host(page, baseURL!);
    const a = [opus, aac];
    const b = variant === "identical" ? a : variant === "reordered" ? [aac, opus] : [mp3, aac];
    const request: PreparationRequest = { version: 2, sampleRateMode: "native", a, b,
      preparationPolicy: "aligned-gain-matched-v1", canaryEnabled: true };
    const result = await page.evaluate(async ({ bytes, request }) => {
      // @ts-expect-error Test-only route.
      const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");
      const engine = new BrowserPreparationEngine({ coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href });
      const progress: string[] = [];
      try {
        const artifact = await engine.prepare(new File([new Uint8Array(bytes)], "prepared-chain.wav"), request,
          { onProgress: ({ message }: { message: string }) => progress.push(message) });
        const a = Array.from(new Uint8Array(await engine.readAudio(artifact.id, "a")));
        const pristine = artifact.canary?.report.usable
          ? Array.from(new Uint8Array(await engine.readCanaryAudio(artifact.id, "pristine"))) : null;
        return { artifact, a, pristine, progress };
      } finally { await engine.dispose(); }
    }, { bytes: Array.from(makePcm16Wav({ channels: 1, seconds: 0.6 })), request });
    const bytes = new Uint8Array(result.a);
    expect(result.artifact.a.delivered.wavSha256).toBe(sha256(bytes));
    expect(result.artifact.preparation!.alignment.outputFrames).toBe(inspectWav(bytes).frames);
    expect(result.artifact.measurements.delivered!.a.frames).toBe(inspectWav(bytes).frames);
    expect(result.artifact.validity!.nullGate.status).toBe(variant === "identical" ? "passed" : "not-applicable");
    expect(result.progress.filter((line: string) => line.startsWith("Applying aligned-gain-matched-v1"))).toHaveLength(1);
    expect(result.progress.filter((line: string) => line.startsWith("Canary material is being generated"))).toHaveLength(1);
    expect(result.artifact.a.stages).toHaveLength(2);
    expect(result.artifact.canary!.report.frames).toBe(inspectWav(bytes).frames);
    if (result.pristine) expect(inspectWav(new Uint8Array(result.pristine)).frames).toBe(inspectWav(bytes).frames);
    expect(guard.disallowed).toEqual([]);
  });
}

test("real core unavailable requests refuse, intermediate cancellation clears runtime and retry works", async ({ page, baseURL }) => {
  const guard = await host(page, baseURL!);
  const result = await page.evaluate(async (bytes) => {
    // @ts-expect-error Test-only route.
    const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");
    const engine = new BrowserPreparationEngine({ coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href });
    const file = new File([new Uint8Array(bytes)], "cancel-chain.wav");
    let sourceRead = false;
    const unread = { size: file.size, arrayBuffer: async () => { sourceRead = true; return file.arrayBuffer(); } };
    const unavailable: string[] = [];
    try {
      const capabilities = await engine.capabilities();
      for (const codec of capabilities.codecs.filter((codec: { availability: string }) => codec.availability === "unavailable")) {
        try {
          await engine.prepare(unread, { version: 2, sampleRateMode: "native",
            a: [{ codecId: codec.codecId, bitrateKbps: ({ mp2: 128, lc3: 128, sbc: 128, aptx: 352, aptx_hd: 576, ldac: 330 } as Record<string, number>)[codec.codecId] }],
            b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] });
        } catch (error) { unavailable.push(error instanceof Error ? error.message : String(error)); }
      }
      const request = { version: 2, sampleRateMode: "native",
        a: [{ codecId: "aac", bitrateKbps: 128 }, { codecId: "mp3", bitrateKbps: 128 }, { codecId: "opus", bitrateKbps: 64 }],
        b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] };
      const controller = new AbortController();
      let outcome = "resolved";
      try {
        await engine.prepare(file, request, { signal: controller.signal,
          onProgress: ({ message }: { message: string }) => {
            if (message.startsWith("Side A stage 2/3: decoding")) controller.abort();
          } });
      } catch (error) { outcome = error instanceof Error ? error.name : String(error); }
      const workerWasCleared = engine.worker === null;
      const retry = await engine.prepare(file, request);
      const valid = new Uint8Array(await engine.readAudio(retry.id, "a"))[0] === 0x52;
      await engine.release(retry.id);
      let released = false;
      try { await engine.readAudio(retry.id, "a"); } catch { released = true; }
      return { unavailable, sourceRead, outcome, workerWasCleared, valid, released };
    } finally { await engine.dispose(); }
  }, Array.from(makePcm16Wav({ channels: 2, seconds: 0.6 })));
  expect(result.unavailable).toHaveLength(2);
  expect(result.unavailable.every((message: string) => message.includes("supplemental-codec-unconfigured"))).toBe(true);
  expect(result.sourceRead).toBe(false);
  expect(result.outcome).toBe("AbortError");
  expect(result.workerWasCleared).toBe(true);
  expect(result.valid).toBe(true);
  expect(result.released).toBe(true);
  expect(guard.disallowed).toEqual([]);
});

test("deterministic absent encoder or decoder refuses before source audio is read", async ({ page, baseURL }) => {
  const guard = await host(page, baseURL!);
  const result = await page.evaluate(async (bytes) => {
    // @ts-expect-error Test-only route.
    const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");
    const engine = new BrowserPreparationEngine({ coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href });
    const file = new File([new Uint8Array(bytes)], "absent-codec.wav");
    let sourceRead = false;
    const unread = { size: file.size, arrayBuffer: async () => { sourceRead = true; return file.arrayBuffer(); } };
    const messages: string[] = [];
    const request = { version: 2, sampleRateMode: "native",
      a: [{ codecId: "sbc", bitrateKbps: 128 }], b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] };
    try {
      // A deterministic cache stands in for a core listing only one half of the pair.
      engine.probeCache = { ffmpegVersion: "probe-stub", encoderNames: new Set(["sbc"]), decoderNames: new Set() };
      try { await engine.prepare(unread, request); } catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
      engine.probeCache = { ffmpegVersion: "probe-stub", encoderNames: new Set(), decoderNames: new Set(["sbc"]) };
      try { await engine.prepare(unread, request); } catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
      return { messages, sourceRead, worker: engine.worker, probeAfterRejection: engine.probeCache };
    } finally { engine.probeCache = null; await engine.dispose(); }
  }, Array.from(makePcm16Wav({ channels: 1, seconds: 0.6 })));
  expect(result.messages).toHaveLength(2);
  expect(result.messages[0]).toContain("does not advertise the sbc encoder/sbc decoder");
  expect(result.messages[1]).toContain("does not advertise the sbc encoder/sbc decoder");
  expect(result.sourceRead).toBe(false);
  expect(result.worker).toBeNull();
  expect(result.probeAfterRejection).not.toBeNull();
  expect(guard.disallowed).toEqual([]);
});

test("cancelling a new aptX stage clears the runtime and a retry succeeds", async ({ page, baseURL }) => {
  const guard = await host(page, baseURL!);
  const result = await page.evaluate(async (bytes) => {
    // @ts-expect-error Test-only route.
    const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");
    const engine = new BrowserPreparationEngine({ coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href });
    const file = new File([new Uint8Array(bytes)], "cancel-aptx.wav");
    const request = { version: 2, sampleRateMode: "native",
      a: [{ codecId: "mp2", bitrateKbps: 128 }, { codecId: "aptx", bitrateKbps: 352 }],
      b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] };
    const controller = new AbortController();
    let outcome = "resolved";
    try {
      await engine.prepare(file, request, { signal: controller.signal,
        onProgress: ({ message }: { message: string }) => {
          if (message.startsWith("Side A stage 2/2: decoding")) controller.abort();
        } });
    } catch (error) { outcome = error instanceof Error ? error.name : String(error); }
    const cleared = engine.worker === null;
    const retry = await engine.prepare(file, request);
    const a = Array.from(new Uint8Array(await engine.readAudio(retry.id, "a")));
    await engine.release(retry.id);
    return { outcome, cleared, delivered: retry.a.delivered, stages: retry.a.stages, a };
  }, Array.from(makePcm16Wav({ channels: 2, seconds: 0.6 })));
  expect(result.outcome).toBe("AbortError");
  expect(result.cleared).toBe(true);
  expect(result.delivered.sampleRate).toBe(48000);
  expect(result.delivered.channels).toBe(2);
  expect(new Uint8Array(result.a)[0]).toBe(0x52);
  expect(result.stages!.map((stage: { requested: { codecId: string } }) => stage.requested.codecId))
    .toEqual(["mp2", "aptx"]);
  expect(result.stages![1]!.encodedSampleRate).toBe(48000);
  expect(guard.disallowed).toEqual([]);
});

test("listed Vorbis encoder rejects unsupported high-rate configurations; AAC retains padding inside the expanded envelope", async ({ page, baseURL }) => {
  const guard = await host(page, baseURL!);
  const result = await page.evaluate(async ({ highRate, highRateMono, maximum, retryBytes }) => {
    // @ts-expect-error Test-only route.
    const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");
    const engine = new BrowserPreparationEngine({ coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href });
    const failures: string[] = [];
    try {
      const capabilities = await engine.capabilities();
      const cases: { bytes: number[]; bitrateKbps: number }[] = [
        { bytes: highRate, bitrateKbps: 128 },
        { bytes: highRate, bitrateKbps: 256 },
        { bytes: highRateMono, bitrateKbps: 128 },
      ];
      for (const item of cases) {
        try {
          await engine.prepare(new File([new Uint8Array(item.bytes)], "high-rate-vorbis.wav"), {
            version: 2, sampleRateMode: "native",
            a: [{ codecId: "ogg_vorbis", bitrateKbps: item.bitrateKbps }],
            b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] });
        } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      }
      const padded = await engine.prepare(new File([new Uint8Array(maximum)], "10s-aac.wav"), {
        version: 2, sampleRateMode: "native",
        a: [{ codecId: "aac", bitrateKbps: 128 }], b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
      });
      const padding = { a: padded.a.delivered, b: padded.b.delivered };
      await engine.release(padded.id);
      const retry = await engine.prepare(new File([new Uint8Array(retryBytes)], "48k-retry.wav"), {
        version: 2, sampleRateMode: "native", a: [{ codecId: "ogg_vorbis", bitrateKbps: 128 }],
        b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] });
      return { available: capabilities.codecs.find((codec: { codecId: string }) => codec.codecId === "ogg_vorbis").availability,
        failures, padding, retry: retry.a.delivered };
    } finally { await engine.dispose(); }
  }, { highRate: Array.from(makePcm16Wav({ channels: 2, sampleRate: 96000, seconds: 0.6 })),
    highRateMono: Array.from(makePcm16Wav({ channels: 1, sampleRate: 96000, seconds: 0.6 })),
    maximum: Array.from(makePcm16Wav({ channels: 1, sampleRate: 48000, seconds: 10 })),
    retryBytes: Array.from(makePcm16Wav({ channels: 2, sampleRate: 48000, seconds: 0.6 })) });
  expect(result.available).toBe("available");
  expect(result.failures).toHaveLength(3);
  expect(result.failures.every((message: string) => message.includes("encoder setup failed"))).toBe(true);
  expect(result.padding.a.frames).toBeGreaterThan(10 * 48000);
  expect(result.padding.a.frames).toBeLessThanOrEqual(10.5 * 48000);
  expect(result.padding.b.frames).toBe(10 * 48000);
  expect(result.retry.sampleRate).toBe(48000);
  expect(guard.disallowed).toEqual([]);
});
