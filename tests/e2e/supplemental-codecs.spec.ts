import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import type { CodecId, CodecSelection, EngineCapabilities, PreparationRequest } from "@codec-abx/contracts";
import { expectedLdacContainerRate } from "../../packages/engine-browser/test/fixtures/ldac-rate-expectation.js";
import { guardNetwork, inspectWav, makePcm16Wav, sha256 } from "./fixtures.js";

// Compile the REAL adapter (including the supplemental LC3/LDAC runtime) once
// and serve it from the harness origin, mirroring codec-chains.spec.ts.
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
  directory = await mkdtemp(path.join(os.tmpdir(), "supplemental-codec-harness-"));
  await build({ configFile: false, root: process.cwd(), logLevel: "error",
    worker: { format: "es" },
    build: { target: "es2022", minify: false, outDir: directory, emptyOutDir: true,
      lib: { entry: path.join(process.cwd(), "packages/engine-browser/src/index.ts"),
        formats: ["es"], fileName: () => "supplemental-engine.js" },
      rollupOptions: { output: { entryFileNames: "supplemental-engine.js",
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
    const data = assets.get(url.pathname.replace(/^\/+/, "")) ?? byName.get(path.posix.basename(url.pathname));
    if (data) await route.fulfill({ contentType: "application/javascript", body: data });
    else await route.fallback();
  });
  await page.goto(`${origin}/supplemental-host`);
  return guard;
}

const noop: CodecSelection = { codecId: "noop_passthrough", bitrateKbps: 0 };

interface ChainCase {
  readonly stages: readonly CodecSelection[];
  readonly sourceRate: number;
  readonly channels: 1 | 2;
  /** Minimum clear-formula SNR (dB) between the codec output and the source. */
  readonly minSnrDb: number;
  /** Expected provenance encoder string fragment. */
  readonly encoderFragment?: string;
}
const lc: ChainCase = { stages: [{ codecId: "lc3", bitrateKbps: 96 }], sourceRate: 48000, channels: 2, minSnrDb: 18 };
const lcMonoHigh: ChainCase = { stages: [{ codecId: "lc3", bitrateKbps: 48 }], sourceRate: 48000, channels: 1, minSnrDb: 12 };
const lcNarrow: ChainCase = { stages: [{ codecId: "lc3", bitrateKbps: 32 }], sourceRate: 48000, channels: 1, minSnrDb: 8 };
const lc44: ChainCase = { stages: [{ codecId: "lc3", bitrateKbps: 96 }], sourceRate: 44100, channels: 2, minSnrDb: 15 };
const lc96: ChainCase = { stages: [{ codecId: "lc3", bitrateKbps: 160 }], sourceRate: 96000, channels: 2, minSnrDb: 18 };
const ld990: ChainCase = { stages: [{ codecId: "ldac", bitrateKbps: 990 }], sourceRate: 48000, channels: 2, minSnrDb: 35 };
const ld660Mono: ChainCase = { stages: [{ codecId: "ldac", bitrateKbps: 660 }], sourceRate: 48000, channels: 1, minSnrDb: 16 };
const ld990_44: ChainCase = { stages: [{ codecId: "ldac", bitrateKbps: 990 }], sourceRate: 44100, channels: 2, minSnrDb: 33 };
const ld330Narrow: ChainCase = { stages: [{ codecId: "ldac", bitrateKbps: 330 }], sourceRate: 48000, channels: 1, minSnrDb: 8 };
const mixed: ChainCase = {
  stages: [{ codecId: "lc3", bitrateKbps: 96 }, { codecId: "opus", bitrateKbps: 96 }],
  sourceRate: 48000, channels: 2, minSnrDb: 12,
};

const supplementalCases: readonly ChainCase[] = [lc, lcMonoHigh, lcNarrow, lc44, lc96, ld990, ld660Mono, ld990_44, ld330Narrow, mixed];

/**
 * Justified per-stage round-trip padding, in delivered frames at the session
 * rate; a codec without a documented entry refuses so a new chain codec can
 * never silently widen the envelope.
 *
 * - `noop_passthrough`: frame-exact PCM16 passthrough.
 * - `lc3`: the supplemental decode is bounded by the raw container's
 *   authoritative `nb_samples` and writes exactly the encoder input frames.
 * - `ldac`: ldac_helper decode skips the one 128-sample MDCT warm-up block and
 *   trims to the container header's unpadded sample count (mirrored
 *   engine-side), so the stage returns its exact input length.
 * - `opus`: at this engine's disclosed 10 ms internal configuration the
 *   libopus round trip can retain one internal frame block of codec padding
 *   (480 frames at 48 kHz) after the pre-skip trim, so one Opus stage adds at
 *   most that block to the delivered length.
 */
const CODEC_ROUND_TRIP_PADDING_FRAMES: Readonly<Partial<Record<CodecId, number>>> = {
  noop_passthrough: 0,
  lc3: 0,
  ldac: 0,
  opus: 480,
};
/**
 * Pre-existing restoration slack kept for the supplemental round trips: the
 * supplemental decode is sample-exact at its internal rate and the explicit
 * FFmpeg rate restoration has always been asserted within 128 frames (the
 * LDAC transport block size, comfortably covering resampler quantization).
 * Chain expectations add only the per-stage codec constants above on top.
 */
const RESTORATION_SLACK_FRAMES = 128;

test("capability report lists all eleven catalog codecs with the supplemental modules served", async ({ page, baseURL }) => {
  const guard = await host(page, baseURL!);
  const capabilities = await page.evaluate(async (): Promise<EngineCapabilities> => {
    // @ts-expect-error Test-only bundle served by the route above.
    const { BrowserPreparationEngine } = await import("/supplemental-engine.js");
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
      lc3WasmURL: new URL("/codec-assets/lc3_codec.wasm", location.href).href,
      ldacWasmURL: new URL("/codec-assets/ldac_codec.wasm", location.href).href,
    });
    const result = await engine.capabilities();
    await engine.dispose();
    return result;
  });
  expect(capabilities.engineId).toBe("engine-browser");
  expect(capabilities.build).toContain("supplemental: LC3 supplemental WASM (liblc3 1.1.3)");
  expect(capabilities.build).toContain("LDAC supplemental WASM");
  const byId = new Map(capabilities.codecs.map((codec) => [codec.codecId, codec] as const));
  expect(byId.get("lc3")?.availability).toBe("available");
  expect(byId.get("lc3")?.encoder).toBe("liblc3 1.1.3 (same-origin WASM)");
  expect(byId.get("lc3")?.decoder).toBe("liblc3 1.1.3 (same-origin WASM)");
  expect(byId.get("ldac")?.availability).toBe("available");
  expect(byId.get("ldac")?.encoder).toBe("ldac_wasm encode (AOSP libldac 2.00.02)");
  expect(byId.get("ldac")?.decoder).toBe("ldac_wasm decode (hegdi/libldacdec)");
  for (const codec of capabilities.codecs) {
    expect(codec.availability, `${codec.codecId} must all be available symmetrically`).toBe("available");
    expect(codec.reason).toBeNull();
  }
  expect(capabilities.codecs).toHaveLength(11);
  expect(guard.disallowed).toEqual([]);
});

test("supplemental codec requests without configured asset URLs refuse before source reads", async ({ page, baseURL }) => {
  const guard = await host(page, baseURL!);
  const result = await page.evaluate(async (bytes): Promise<{ refusals: string[]; sourceRead: boolean;
    lc3: { availability: string } | undefined; ldac: { availability: string } | undefined }> => {
    // Same core, deliberately NO supplemental URLs: an unconfigured module is
    // equivalent to a missing native helper — a refusal, never a substitution.
    // @ts-expect-error Test-only bundle served by the route above.
    const { BrowserPreparationEngine } = await import("/supplemental-engine.js");
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    let sourceRead = false;
    const committed = { size: bytes.byteLength, arrayBuffer: async () => { sourceRead = true; return bytes; } };
    const refusals: string[] = [];
    try {
      const capabilities = await engine.capabilities();
      const lc3: { availability: string } | undefined = capabilities.codecs.find((codec: { codecId: string; availability: string }) => codec.codecId === "lc3");
      const ldac: { availability: string } | undefined = capabilities.codecs.find((codec: { codecId: string; availability: string }) => codec.codecId === "ldac");
      for (const request of [
        { version: 2, sampleRateMode: "native",
          a: [{ codecId: "lc3", bitrateKbps: 96 }], b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] },
        { version: 2, sampleRateMode: "native",
          a: [{ codecId: "ldac", bitrateKbps: 330 }], b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }] },
      ] as PreparationRequest[]) {
        try { await engine.prepare(committed as unknown as File, request); }
        catch (error) { refusals.push(error instanceof Error ? error.message : String(error)); }
      }
      return { refusals, sourceRead, lc3: lc3, ldac: ldac };
    } finally { await engine.dispose(); }
  }, makePcm16Wav({ channels: 2, seconds: 0.6 }).buffer);
  expect(result.sourceRead).toBe(false);
  expect(result.refusals).toHaveLength(2);
  for (const message of result.refusals) {
    expect(message).toContain("supplemental-codec-unconfigured");
    expect(message).toContain("refuses before any source audio is read");
  }
  expect(result.lc3?.availability).toBe("unavailable");
  expect(result.ldac?.availability).toBe("unavailable");
  expect(guard.disallowed).toEqual([]);
});

for (const codecId of ["lc3", "ldac"] as const) {
  for (const missing of ["wasm", "glue", "html"] as const) {
    test(`${codecId} configured URLs with ${missing} asset failure refuse before source reads`, async ({ page, baseURL }) => {
      const guard = await host(page, baseURL!);
      const extension = missing === "glue" ? "js" : "wasm";
      await page.route(`**/codec-assets/${codecId}_codec.${extension}`, (route) => route.fulfill({
        status: missing === "html" ? 200 : 404,
        contentType: missing === "html" ? "text/html" : "text/plain",
        body: missing === "html" ? "<!doctype html><title>App fallback</title>" : "Missing codec asset",
      }));
      const result = await page.evaluate(async ({ codecId }) => {
        // @ts-expect-error Test-only bundle served by the route above.
        const { BrowserPreparationEngine } = await import("/supplemental-engine.js");
        const engine = new BrowserPreparationEngine({
          coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
          wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
          lc3WasmURL: new URL("/codec-assets/lc3_codec.wasm", location.href).href,
          ldacWasmURL: new URL("/codec-assets/ldac_codec.wasm", location.href).href,
        });
        let sourceRead = false;
        const source = { size: 1024, arrayBuffer: async () => {
          sourceRead = true;
          throw new Error("Unavailable codec must refuse before reading source");
        } };
        try {
          let refusal = "";
          try {
            await engine.prepare(source as unknown as File, {
              version: 2, sampleRateMode: "native",
              a: [{ codecId, bitrateKbps: codecId === "lc3" ? 96 : 330 }],
              b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
            });
          } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
          const capabilities: EngineCapabilities = await engine.capabilities();
          return { sourceRead, refusal, codecs: capabilities.codecs };
        } finally { await engine.dispose(); }
      }, { codecId });
      expect(result.sourceRead).toBe(false);
      expect(result.refusal).toContain("supplemental-codec-unconfigured");
      expect(result.refusal).toContain("before any source audio is read");
      const failed = result.codecs.find((codec) => codec.codecId === codecId);
      expect(failed?.availability).toBe("unavailable");
      expect(failed?.reason).toContain("supplemental-codec-unconfigured");
      const other = result.codecs.find((codec) => codec.codecId === (codecId === "lc3" ? "ldac" : "lc3"));
      expect(other?.availability).toBe("available");
      expect(guard.disallowed).toEqual([]);
    });
  }
}

for (const { stages, sourceRate, channels, minSnrDb } of supplementalCases) {
  const asked = stages[0]!;
  test(`real supplemental WASM ${asked.codecId} ${String(asked.bitrateKbps)} kbps at ${String(sourceRate)} Hz ` +
    `${String(channels)}ch round trips with ${String(minSnrDb)}+ dB against the source`, async ({ page, baseURL }) => {
    const guard = await host(page, baseURL!);
    const source = makePcm16Wav({ channels, sampleRate: sourceRate, seconds: 0.6 });
    const request: PreparationRequest = {
      version: 2, sampleRateMode: "native",
      a: [...stages], b: [noop],
    };
    const result = await page.evaluate(async ({ bytes, request }) => {
      // @ts-expect-error Test-only bundle served by the route above.
      const { BrowserPreparationEngine } = await import("/supplemental-engine.js");
      const engine = new BrowserPreparationEngine({
        coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
        lc3WasmURL: new URL("/codec-assets/lc3_codec.wasm", location.href).href,
        ldacWasmURL: new URL("/codec-assets/ldac_codec.wasm", location.href).href,
      });
      const progress: string[] = [];
      try {
        const artifact = await engine.prepare(new File([new Uint8Array(bytes)], "supplemental.wav"), request,
          { onProgress: ({ message }: { message: string }) => progress.push(message) });
        const a = Array.from(new Uint8Array(await engine.readAudio(artifact.id, "a")));
        const b = Array.from(new Uint8Array(await engine.readAudio(artifact.id, "b")));
        await engine.release(artifact.id);
        return { artifact, a, b, progress };
      } finally { await engine.dispose(); }
    }, { bytes: Array.from(source), request });

    const aBytes = new Uint8Array(result.a);
    const bBytes = new Uint8Array(result.b);
    const aFacts = inspectWav(aBytes);
    const bFacts = inspectWav(bBytes);
    const firstEvidence = result.artifact.a.stages?.at(0);
    const evidence = result.artifact.a.stages?.at(-1);
    const lastStage = stages.at(-1)!;
    // Per-stage provenance records each stage's own requested selection, and
    // the chain's top-level provenance names the final delivery codec: the
    // mixed LC3 -> Opus chain must expose Opus from its last recorded stage at
    // the top level, while the first supplemental stage identity stays pinned.
    expect(firstEvidence?.requested).toEqual(asked);
    expect(evidence?.requested).toEqual(lastStage);
    expect(result.artifact.a.requested).toEqual(lastStage);
    expect(firstEvidence?.encoder).toContain(
      asked.codecId === "lc3" ? "liblc3 1.1.3" : "AOSP libldac 2.00.02");
    expect(evidence?.encodedSampleRate).toBe(48000);
    // Delivered frame counts match the canonical input when the supplemental
    // round trip is sample-exact; chain padding stays inside the per-stage
    // codec envelope above otherwise.
    expect(aFacts.sampleRate).toBe(sourceRate);
    expect(aFacts.channels).toBe(channels);
    expect(bFacts.frames).toBe(Math.round(0.6 * sourceRate));
    const chainPaddingEnvelope = stages.reduce((total, stage) => {
      const documented = CODEC_ROUND_TRIP_PADDING_FRAMES[stage.codecId];
      if (documented === undefined) {
        throw new Error(`supplemental chain codec ${stage.codecId} has no documented ` +
          "round-trip padding ceiling; document it before extending this spec");
      }
      return total + documented;
    }, RESTORATION_SLACK_FRAMES);
    const frameDelta = aFacts.frames - bFacts.frames;
    // Padding can extend the output; it must not expand the truncation budget.
    expect(frameDelta).toBeGreaterThanOrEqual(-RESTORATION_SLACK_FRAMES);
    expect(frameDelta,
      `delivered chain padding must stay inside the documented envelope ` +
      `(frame delta ${String(Math.abs(aFacts.frames - bFacts.frames))}, ` +
      `envelope ${String(chainPaddingEnvelope)})`)
      .toBeLessThanOrEqual(chainPaddingEnvelope);
    expect(result.artifact.a.delivered.wavSha256).toBe(sha256(aBytes));
    expect(result.artifact.sourceSha256).toBe(sha256(source));
    // Honest notes/limitations should describe this supplemental tier.
    expect(result.artifact.disclosures.some((line: string) =>
      line.includes(asked.codecId === "lc3" ? "liblc3" : "AOSP libldac 2.00.02"))).toBe(true);
    if (asked.codecId === "ldac") {
      expect(result.artifact.disclosures.some((line: string) => line.includes("hegdi/libldacdec"))).toBe(true);
    }

    // Audio-correctness gate: same source, same layout, no pair correction —
    // a real lossy round trip must remain clearly related to its input.
    const snr = computeSnrDb(aBytes, bBytes);
    expect(Number.isFinite(snr), `SNR must be finite, got ${String(snr)}`).toBe(true);
    expect(snr).toBeGreaterThan(minSnrDb);
    // Actual measured bitrate lands within the encoder's own reporting. The
    // gate keys on the final recorded stage's selection (the stage whose
    // actualBitrateKbps is the evidence basis), never the first requested
    // stage.
    const lastBits = lastStage.bitrateKbps;
    expect(evidence?.actualBitrateKbps).not.toBeNull();
    const measured = evidence?.actualBitrateKbps as number;
    if (lastStage.codecId === "ldac") {
      // LDAC's measured basis is ldac-container-bytes-over-header-sample-
      // duration with the documented container overhead. Mono encodes use
      // libldac's half-stereo quality mode (165/330/495 kbps for 330/660/990
      // at 48 kHz), so the gate compares the documented full container model —
      // never the requested stereo number (the stale reason the mono cases
      // failed). This fixed 0.6 s fixture has exactly 28,800 internal input
      // frames, a multiple of the 128-frame LDAC block; an extra input frame
      // would add a whole record and must fail. Allow only 0.1 kbps rounding.
      const expected = expectedLdacContainerRate(48_000, channels,
        lastBits as 330 | 660 | 990, Math.round(0.6 * 48_000));
      expect(measured).toBe(Math.round(expected.measuredKbps * 10) / 10);
    } else {
      expect(Math.abs(measured - lastBits)).toBeLessThanOrEqual(Math.max(24, lastBits * 0.15));
    }
    expect(result.progress.some((line: string) => line.includes(
      asked.codecId === "lc3" ? "encoding LC3" : "encoding LDAC"))).toBe(true);
    expect(guard.disallowed).toEqual([]);
  });
}

function computeSnrDb(processed: Uint8Array, reference: Uint8Array): number {
  const a = dataBytes(processed);
  const b = dataBytes(reference);
  let signalPower = 0;
  let errorPower = 0;
  let nanOrInf = false;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const value = b[index]! / 32768;
    const error = (a[index]! - b[index]!) / 32768;
    signalPower += value * value;
    errorPower += error * error;
    if (!Number.isFinite(error) || !Number.isFinite(value)) nanOrInf = true;
  }
  if (nanOrInf) return -Infinity;
  if (errorPower === 0) return signalPower > 0 ? Infinity : 0;
  return 10 * Math.log10(signalPower / errorPower);
}

function dataBytes(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const out = new Int16Array(size / 2);
      for (let index = 0; index < out.length; index += 1) out[index] = view.getInt16(offset + 8 + index * 2, true);
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("host WAV has no data chunk");
}
