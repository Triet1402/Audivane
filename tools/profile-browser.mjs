#!/usr/bin/env node
/**
 * Real-browser performance profile for the local WASM codec chain.
 *
 * This tool builds the actual browser preparation engine and its real workers
 * into a temporary directory, serves it from a local same-origin HTTP server,
 * and drives it with Chromium. It records elapsed/progress timings, worker
 * lifecycles, release/after-release facts, renderer main-thread heartbeat gaps
 * and Chromium JS heap/CDP metrics. It does not upload audio and uses no CDN.
 *
 *   node tools/profile-browser.mjs
 *
 * Results are written under build/browser-performance/ (git-ignored):
 *   browser-performance.json
 *   browser-performance.csv
 *
 * The WASM working memory may not shrink to its pre-cold value after release;
 * that is reported as observed, not as a guaranteed memory bound.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "vite";
import { assertBrowserProfile } from "./verification/profile-acceptance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.CODEC_ABX_BROWSER_PROFILE_DIR ?? path.join(root, "build/browser-performance");

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".json", "application/json"],
]);

async function buildHarness(directory) {
  await build({
    configFile: false,
    root,
    logLevel: "error",
    worker: { format: "es" },
    build: {
      target: "es2022",
      minify: false,
      outDir: directory,
      emptyOutDir: true,
      lib: {
        entry: path.join(root, "packages/engine-browser/src/index.ts"),
        formats: ["es"],
        fileName: () => "codec-chain-engine.js",
      },
      rollupOptions: {
        output: {
          entryFileNames: "codec-chain-engine.js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
  const assets = path.join(root, "apps/client/public/codec-assets");
  await mkdir(path.join(directory, "codec-assets"), { recursive: true });
  for (const name of await readdir(assets)) {
    await copyFile(path.join(assets, name), path.join(directory, "codec-assets", name));
  }
}

async function serve(directory) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/host") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Codec ABX browser profile</title><main id=host></main>");
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) {
        response.writeHead(400);
        response.end("bad path");
        return;
      }
      const data = await readFile(path.join(directory, relative));
      response.writeHead(200, {
        "content-type": MIME.get(path.extname(relative)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("profile server did not bind");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function initPage(page) {
  await page.evaluate(async () => {
    const counts = { created: [], terminated: [], active: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class TrackedWorker extends NativeWorker {
      #label;
      constructor(url, options) {
        super(url, options);
        this.#label = String(url);
        counts.created.push(this.#label);
        counts.active += 1;
      }
      terminate() {
        counts.terminated.push(this.#label);
        counts.active = Math.max(0, counts.active - 1);
        return super.terminate();
      }
    };

    const gaps = [];
    let last = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 10);

    const { BrowserPreparationEngine } = await import("/codec-chain-engine.js");

    const makeWav = (sampleRate, channels, seconds) => {
      const frames = Math.round(sampleRate * seconds);
      const dataSize = frames * channels * 2;
      const bytes = new Uint8Array(44 + dataSize);
      const view = new DataView(bytes.buffer);
      const ascii = (offset, value) => {
        for (let index = 0; index < value.length; index += 1) {
          bytes[offset + index] = value.charCodeAt(index);
        }
      };
      ascii(0, "RIFF");
      view.setUint32(4, 36 + dataSize, true);
      ascii(8, "WAVE");
      ascii(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, channels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * channels * 2, true);
      view.setUint16(32, channels * 2, true);
      view.setUint16(34, 16, true);
      ascii(36, "data");
      view.setUint32(40, dataSize, true);
      for (let frame = 0; frame < frames; frame += 1) {
        const left = Math.round(6500 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
        const right = -left; // exact anti-phase stereo grid
        view.setInt16(44 + (frame * channels) * 2, left, true);
        view.setInt16(44 + (frame * channels + 1) * 2, right, true);
      }
      return { bytes, frames };
    };

    const state = { engine: null };
    const memfs = { reads: [], removed: [] };

    const instrument = (engine) => {
      const originalRead = engine.readOwnedFile.bind(engine);
      engine.readOwnedFile = async (...args) => {
        const value = await originalRead(...args);
        memfs.reads.push(String(args[1]));
        return value;
      };
      const originalRemove = engine.removeStageFile.bind(engine);
      engine.removeStageFile = async (...args) => {
        await originalRemove(...args);
        memfs.removed.push(String(args[2]));
      };
    };

    const heap = () => {
      const memory = performance.memory;
      return memory === undefined
        ? null
        : {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          };
    };

    const noop = { codecId: "noop_passthrough", bitrateKbps: 0 };
    const opus = { codecId: "opus", bitrateKbps: 96 };
    const rawRequest = { version: 2, sampleRateMode: "native", a: [noop], b: [opus] };
    const preparedRequest = {
      version: 2,
      sampleRateMode: "native",
      preparationPolicy: "aligned-gain-matched-v1",
      canaryEnabled: true,
      a: [noop],
      b: [opus],
    };

    window.__codecAbxBrowserPerf = {
      counts,
      gaps,
      state,
      memfs,
      heap,
      async createEngine() {
        const engine = new BrowserPreparationEngine({
          coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
          wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
        });
        instrument(engine);
        const capabilities = await engine.capabilities();
        state.engine = engine;
        return {
          engineId: capabilities.engineId,
          build: capabilities.build,
          location: capabilities.location,
          maxStagesPerSide: capabilities.maxStagesPerSide,
          available: capabilities.codecs
            .filter((codec) => codec.availability === "available")
            .map((codec) => codec.codecId),
          unavailable: capabilities.codecs
            .filter((codec) => codec.availability !== "available")
            .map((codec) => ({ codecId: codec.codecId, availability: codec.availability, reason: codec.reason })),
        };
      },
      async run({ label, seconds, prepared = false, cancelAt = null }) {
        const engine = state.engine;
        if (engine === null) throw new Error("profile engine not created");
        const gapStart = gaps.length;
        const { bytes, frames } = makeWav(96_000, 2, seconds);
        const file = new File([bytes], `profile-${seconds}s.wav`, { type: "audio/wav" });
        const progress = [];
        const start = performance.now();
        const controller = new AbortController();
        let abortedAt = null;
        let artifact = null;
        let error = null;
        let readAfterRelease = null;
        const beforeMemfs = { reads: memfs.reads.length, removed: memfs.removed.length };
        const heapBefore = heap();
        try {
          artifact = await engine.prepare(file, prepared ? preparedRequest : rawRequest, {
            signal: controller.signal,
            onProgress: (event) => {
              progress.push({
                atMs: performance.now() - start,
                phase: event.phase,
                message: event.message,
              });
              if (cancelAt !== null && abortedAt === null && event.message.includes(cancelAt)) {
                abortedAt = performance.now();
                controller.abort();
              }
            },
          });
        } catch (reason) {
          error = {
            name: reason instanceof Error ? reason.name : "unknown",
            message: reason instanceof Error ? reason.message : String(reason),
          };
        }
        const elapsedMs = performance.now() - start;
        const cancelledLatencyMs = abortedAt === null ? null : performance.now() - abortedAt;
        const jobGaps = gaps.slice(gapStart);
        const maxHeartbeatGapMs = jobGaps.length === 0 ? null : Math.max(...jobGaps);
        let artifactMapSize = null;
        let workerPresent = null;
        let delivered = null;
        if (artifact !== null) {
          const audio = new Uint8Array(await engine.readAudio(artifact.id, "a"));
          const digest = await crypto.subtle.digest("SHA-256", audio);
          const wavSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
          if (wavSha256 !== artifact.a.delivered.wavSha256) throw new Error("Served audio hash disagrees with artifact");
          delivered = {
            bytes: audio.byteLength,
            wavSha256,
            shaPrefix: wavSha256.slice(0, 8),
            aStages: artifact.a.stages?.length ?? null,
            bStages: artifact.b.stages?.length ?? null,
            aRequested: artifact.a.requested,
            aActualBitrateKbps: artifact.a.actualBitrateKbps,
            aEncodedSampleRate: artifact.a.encodedSampleRate,
            bActualBitrateKbps: artifact.b.actualBitrateKbps,
            bEncodedSampleRate: artifact.b.encodedSampleRate,
            measuredPolicy: artifact.measurements.delivered?.policy ?? artifact.measurements.policy,
          };
          await engine.release(artifact.id);
          try {
            await engine.readAudio(artifact.id, "a");
            readAfterRelease = "unexpectedly-readable";
          } catch (reason) {
            readAfterRelease = reason instanceof Error ? reason.message : String(reason);
          }
          artifactMapSize = engine.artifacts?.size ?? null;
          workerPresent = engine.worker !== null && engine.worker !== undefined;
        }
        return {
          label,
          input: { seconds, sampleRate: 96_000, channels: 2, frames },
          prepared,
          cancelAt,
          elapsedMs,
          cancelledLatencyMs,
          maxHeartbeatGapMs,
          progress,
          error,
          delivered,
          readAfterRelease,
          artifactMapSize,
          workerPresent,
          heapBefore,
          heapAfter: heap(),
          memfsReads: memfs.reads.length - beforeMemfs.reads,
          memfsRemoved: memfs.removed.length - beforeMemfs.removed,
          workers: {
            created: counts.created.length,
            terminated: counts.terminated.length,
            active: counts.active,
          },
        };
      },
      async dispose() {
        const engine = state.engine;
        state.engine = null;
        if (engine !== null) await engine.dispose();
        clearInterval(heartbeat);
        const sorted = [...gaps].sort((a, b) => a - b);
        return {
          heartbeatGapsMs: {
            samples: gaps.length,
            max: sorted.at(-1) ?? null,
            p95: sorted.length === 0 ? null : sorted[Math.floor(sorted.length * 0.95)] ?? null,
          },
          workers: { created: counts.created.length, terminated: counts.terminated.length, active: counts.active },
          heapAfterDispose: heap(),
          memfs: { reads: memfs.reads.length, removed: memfs.removed.length },
        };
      },
    };
  });
}

async function metrics(session) {
  const { metrics: values } = await session.send("Performance.getMetrics");
  const pick = (name) => values.find((entry) => entry.name === name)?.value ?? null;
  const { usedSize, totalSize } = await session.send("Runtime.getHeapUsage");
  return {
    cdp: {
      JSHeapUsedSize: pick("JSHeapUsedSize"),
      JSHeapTotalSize: pick("JSHeapTotalSize"),
      Documents: pick("Documents"),
      Nodes: pick("Nodes"),
      Frames: pick("Frames"),
      LayoutCount: pick("LayoutCount"),
      RecalcStyleCount: pick("RecalcStyleCount"),
      TaskDuration: pick("TaskDuration"),
      ScriptDuration: pick("ScriptDuration"),
    },
    runtimeHeapUsage: { usedSize, totalSize },
  };
}

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codec-abx-browser-profile-"));
  let server = null;
  let browser = null;
  try {
    await buildHarness(directory);
    const served = await serve(directory);
    server = served.server;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.tracing.stop().catch(() => undefined);
    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    await session.send("Runtime.enable");
    let processInfo = null;
    try {
      processInfo = await session.send("SystemInfo.getProcessInfo");
    } catch {
      processInfo = { supported: false };
    }

    await page.goto(`${served.origin}/host`);
    await initPage(page);

    const rows = [];
    const scenario = async (config) => {
      const before = await metrics(session);
      const row = await page.evaluate((value) => window.__codecAbxBrowserPerf.run(value), config);
      const after = await metrics(session);
      rows.push({
        ...row,
        cdpBefore: before,
        cdpAfter: after,
        cdpDelta: {
          JSHeapUsedSize: after.cdp.JSHeapUsedSize !== null && before.cdp.JSHeapUsedSize !== null
            ? after.cdp.JSHeapUsedSize - before.cdp.JSHeapUsedSize
            : null,
        },
      });
      return row;
    };

    const capabilities = await page.evaluate(() => window.__codecAbxBrowserPerf.createEngine());

    await scenario({ label: "cold-1s-raw-noop-opus", seconds: 1 });
    await scenario({ label: "warm-1s-raw-noop-opus", seconds: 1 });
    await scenario({ label: "warm-1s-prepared-canary", seconds: 1, prepared: true });
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      await scenario({ label: `repeat-${repeat}-1s-raw-noop-opus`, seconds: 1 });
    }
    await scenario({ label: "warm-10s-raw-noop-opus", seconds: 10 });
    await scenario({ label: "warm-10s-prepared-canary", seconds: 10, prepared: true });

    // Cancellation at an intermediate codec stage on the real chain. Abort is
    // requested from the real progress callback, then cleanup latency measured.
    await page.evaluate(() => {
      const perf = window.__codecAbxBrowserPerf;
      perf.runChainCancel = async () => {
        const engine = perf.state.engine;
        const gapStart = perf.gaps.length;
        const start = performance.now();
        const progress = [];
        const controller = new AbortController();
        let abortedAt = null;
        let error = null;
        // Build the request and source inline here.
        const sampleRate = 96_000, channels = 2, seconds = 10;
        const frames = Math.round(sampleRate * seconds);
        const dataSize = frames * channels * 2;
        const wav = new Uint8Array(44 + dataSize);
        const view = new DataView(wav.buffer);
        const ascii = (offset, value) => { for (let i = 0; i < value.length; i += 1) wav[offset + i] = value.charCodeAt(i); };
        ascii(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); ascii(8, "WAVE");
        ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
        view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, dataSize, true);
        for (let frame = 0; frame < frames; frame += 1) {
          const left = Math.round(6500 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
          view.setInt16(44 + (frame * channels) * 2, left, true);
          view.setInt16(44 + (frame * channels + 1) * 2, -left, true);
        }
        const request = {
          version: 2, sampleRateMode: "native",
          a: [{ codecId: "opus", bitrateKbps: 96 }, { codecId: "mp3", bitrateKbps: 128 }],
          b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
        };
        try {
          await engine.prepare(new File([wav], "cancel-chain.wav"), request, {
            signal: controller.signal,
            onProgress: (event) => {
              progress.push({ atMs: performance.now() - start, phase: event.phase, message: event.message });
              if (abortedAt === null && event.message.startsWith("Side A stage 2/2:")) {
                abortedAt = performance.now();
                controller.abort();
              }
            },
          });
        } catch (reason) {
          error = { name: reason instanceof Error ? reason.name : "unknown", message: reason instanceof Error ? reason.message : String(reason) };
        }
        const elapsedMs = performance.now() - start;
        const jobGaps = perf.gaps.slice(gapStart);
        return {
          label: "cancel-10s-intermediate-stage",
          input: { seconds, sampleRate, channels, frames },
          elapsedMs,
          cancelledLatencyMs: abortedAt === null ? null : performance.now() - abortedAt,
          maxHeartbeatGapMs: jobGaps.length === 0 ? null : Math.max(...jobGaps),
          progress,
          error,
          workers: {
            created: perf.counts.created.length,
            terminated: perf.counts.terminated.length,
            active: perf.counts.active,
          },
          heapAfter: perf.heap(),
        };
      };
    });
    const beforeCancel = await metrics(session);
    const cancel = await page.evaluate(() => window.__codecAbxBrowserPerf.runChainCancel());
    const afterCancel = await metrics(session);
    rows.push({ ...cancel, cdpBefore: beforeCancel, cdpAfter: afterCancel, cdpDelta: { JSHeapUsedSize: null } });

    // Verify the same engine still prepares a fresh job after cancellation.
    const afterCancelRun = await scenario({ label: "retry-after-cancel-1s-raw", seconds: 1 });
    const shutdown = await page.evaluate(() => window.__codecAbxBrowserPerf.dispose());

    const report = {
      schema: "codec-abx-browser-performance-v1",
      generatedAt: new Date().toISOString(),
      method:
        "Vite-built real @codec-abx/engine-browser library and real module workers, served same-origin by a " +
        "local Node HTTP server and driven in headless Chromium via Playwright. Audio is generated in the page " +
        "and never uploaded. Each job prepares, reads delivered bytes, releases and re-reads by artifact id.",
      environment: {
        node: process.version,
        playwright: "1.64.1",
        chromium: browser.version(),
        platform: `${process.platform} ${process.arch}`,
      },
      fixture: {
        format: "PCM16 WAV",
        sampleRate: 96_000,
        channels: 2,
        grid: "left=round(6500*sin(2*pi*440*f/96000))/32768, right=exact negative",
        requests: {
          raw: "version 2, Side A [noop_passthrough 0], Side B [opus 96]",
          preparedCanary: "version 2 aligned-gain-matched-v1 canary enabled, same stages",
          cancel: "version 2 Side A [opus 96, mp3 128], Side B [noop]",
        },
      },
      capabilities,
      rows,
      shutdown,
      afterCancelRun: {
        label: afterCancelRun.label,
        error: afterCancelRun.error,
        elapsedMs: afterCancelRun.elapsedMs,
      },
      limits: [
        "One observation per row on this host; these are not performance guarantees or CI thresholds.",
        "Elapsed times include worker startup and the delivered-pair measurement for prepared runs; they are not pure DSP throughput.",
        "Chromium JS heap is renderer JavaScript memory from performance.memory and CDP Performance.getMetrics, not process RSS. " +
        "performance.memory may be coarse/quantized on this build; CDP Runtime.getHeapUsage is the more precise field. Process RSS is not reported by these CDP APIs.",
        "release() removes the artifact from the engine's owned map; V8/WASM high-water memory may not return to the cold value.",
        "The heartbeat is a 10 ms main-renderer timer. A long gap indicates main-thread blocking, not worker throughput.",
        "Cancellation is cooperative between real codec operations; it is not a hard real-time guarantee.",
      ],
      processInfo,
      pageErrors: errors,
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "browser-performance.json"), `${JSON.stringify(report, null, 2)}\n`);
    const csvHeader = [
      "label", "seconds", "prepared", "elapsedMs", "cancelledLatencyMs", "maxHeartbeatGapMs", "error",
      "workersCreated", "workersTerminated", "workersActive", "memfsReads", "memfsRemoved",
      "readAfterRelease", "artifactMapSize", "workerPresent",
      "cdpJsHeapUsedAfter", "chromeUsedHeapAfter",
    ];
    const csvRows = rows.map((row) => [
      row.label,
      row.input?.seconds ?? "",
      row.prepared === undefined ? "" : row.prepared,
      row.elapsedMs?.toFixed(3) ?? "",
      row.cancelledLatencyMs?.toFixed(3) ?? "",
      row.maxHeartbeatGapMs?.toFixed(3) ?? "",
      row.error?.message ?? "",
      row.workers?.created ?? "",
      row.workers?.terminated ?? "",
      row.workers?.active ?? "",
      row.memfsReads ?? "",
      row.memfsRemoved ?? "",
      row.readAfterRelease ?? "",
      row.artifactMapSize ?? "",
      row.workerPresent ?? "",
      row.cdpAfter?.cdp?.JSHeapUsedSize ?? "",
      row.heapAfter?.usedJSHeapSize ?? "",
    ]);
    await writeFile(path.join(outDir, "browser-performance.csv"), [csvHeader, ...csvRows]
      .map((cells) => cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\n") + "\n");

    console.log(JSON.stringify({
      output: path.join(outDir, "browser-performance.json"),
      capabilities,
      shutdown,
      rows: rows.map((row) => ({
        label: row.label,
        elapsedMs: Math.round(row.elapsedMs),
        cancelledLatencyMs: row.cancelledLatencyMs === null ? null : Math.round(row.cancelledLatencyMs),
        maxHeartbeatGapMs: row.maxHeartbeatGapMs === null ? null : Math.round(row.maxHeartbeatGapMs),
        error: row.error?.message ?? null,
        workers: row.workers,
        readAfterRelease: row.readAfterRelease,
      })),
      pageErrors: errors,
    }, null, 2));
    // Keep diagnostic JSON/CSV even on failure, but never turn a failed profile
    // workload into a successful full-verification phase.
    assertBrowserProfile(report);
    console.log("Browser profile acceptance passed");
  } finally {
    await browser?.close().catch(() => undefined);
    server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
