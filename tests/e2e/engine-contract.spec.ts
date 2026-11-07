import { expect, test } from "@playwright/test";
import type { DeliveredPairMeasurements, PairPreparationReport, PreparedArtifact,
  SingleStagePreparationRequest } from "@codec-abx/contracts";
import {
  chooseWav,
  makePcm16Wav,
  openLab,
  pcmPayload,
  prepareDelivered,
  sha256,
} from "./fixtures.js";

function makeWavFromSamples(samples: Float64Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-32768, Math.min(32767,
      Math.round((samples[index] ?? 0) * 32767)));
    bytes.writeInt16LE(value, 44 + index * 2);
  }
  return new Uint8Array(bytes);
}

// This imports the real adapter through Vite's module server. Production UI
// behavior is covered separately; no test harness is shipped in the app bundle.
for (const canaryEnabled of [false, true]) {
  test(`engine rejects cancellation queued at ${canaryEnabled ? "canary" : "raw"} completion and releases retained bytes`, async ({ page, baseURL }) => {
    await openLab(page, new URL(baseURL!).origin);
    await chooseWav(page, "contract.wav", makePcm16Wav({ channels: 1, seconds: canaryEnabled ? 0.6 : 0.1 }));
    const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
    const result = await page.evaluate(async ({ url, canaryEnabled }) => {
      const { BrowserPreparationEngine } = await import(url);
      const engine = new BrowserPreparationEngine({
        coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
      });
      const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
      const request: SingleStagePreparationRequest = { version: 1, sampleRateMode: "native",
        ...(canaryEnabled ? { preparationPolicy: "aligned-gain-matched-v1", canaryEnabled: true } : {}),
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
      const controller = new AbortController();
      let outcome = "resolved";
      try {
        const artifact = await engine.prepare(file, request, {
          signal: controller.signal,
          onProgress: ({ phase }: { phase: string }) => {
            if (phase === "complete") queueMicrotask(() => controller.abort());
          },
        });
        await engine.release(artifact.id);
      } catch (error) {
        outcome = error instanceof Error ? error.name : String(error);
      }
      const retry = await engine.prepare(file, request);
      const first = await engine.readAudio(retry.id, "a");
      new Uint8Array(first).fill(0);
      const independent = new Uint8Array(await engine.readAudio(retry.id, "a"))[0] === 0x52;
      await engine.release(retry.id);
      await engine.release(retry.id);
      let staleRejected = false;
      try { await engine.readAudio(retry.id, "a"); } catch { staleRejected = true; }
      if (canaryEnabled) {
        let canaryStale = false;
        try { await engine.readCanaryAudio(retry.id, "pristine"); } catch { canaryStale = true; }
        staleRejected &&= canaryStale;
      }
      await engine.dispose();
      return { outcome, independent, staleRejected };
    }, { url: moduleURL, canaryEnabled });
    expect(result).toEqual({ outcome: "AbortError", independent: true, staleRejected: true });
  });
}

test("abort queued at measurement startup never creates a late worker and permits retry", async ({ page, baseURL }) => {
  await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "startup-abort.wav", makePcm16Wav({ channels: 1, seconds: 0.1 }));
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
  const result = await page.evaluate(async (url) => {
    const OriginalWorker = Worker;
    let created = 0;
    let terminated = 0;
    class TrackedWorker extends OriginalWorker {
      constructor(script: string | URL, options?: WorkerOptions) {
        super(script, options);
        if (options?.name === "codec-abx-measurements") {
          created += 1;
          const terminate = this.terminate.bind(this);
          this.terminate = () => { terminated += 1; terminate(); };
        }
      }
    }
    window.Worker = TrackedWorker;
    const { BrowserPreparationEngine } = await import(url);
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    try {
      const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
      const request = { version: 1, sampleRateMode: "native",
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
      const controller = new AbortController();
      let outcome = "resolved";
      try {
        await engine.prepare(file, request, {
          signal: controller.signal,
          onProgress: ({ message }: { message: string }) => {
            if (message.startsWith("Starting the dedicated measurement")) {
              queueMicrotask(() => controller.abort());
            }
          },
        });
      } catch (error) { outcome = error instanceof Error ? error.name : String(error); }
      const createdAfterAbort = created;
      const retry = await engine.prepare(file, request);
      await engine.release(retry.id);
      return { outcome, createdAfterAbort, created, terminated };
    } finally {
      await engine.dispose();
      window.Worker = OriginalWorker;
    }
  }, moduleURL);
  expect(result).toEqual({ outcome: "AbortError", createdAfterAbort: 0, created: 1, terminated: 1 });
});

for (const action of ["dispose", "progress-throw"] as const) {
  test(`${action} during measurement terminates its worker and settles preparation`, async ({ page, baseURL }) => {
    await openLab(page, new URL(baseURL!).origin);
    await chooseWav(page, "measurement-lifecycle.wav", makePcm16Wav({ channels: 2, seconds: 0.5 }));
    const result = await page.evaluate(async ({ url, action }) => {
      const OriginalWorker = Worker;
      let created = 0;
      let terminated = 0;
      class TrackedWorker extends OriginalWorker {
        constructor(script: string | URL, options?: WorkerOptions) {
          super(script, options);
          if (options?.name === "codec-abx-measurements") {
            created += 1;
            const terminate = this.terminate.bind(this);
            this.terminate = () => { terminated += 1; terminate(); };
          }
        }
      }
      window.Worker = TrackedWorker;
      const { BrowserPreparationEngine } = await import(url);
      const engine = new BrowserPreparationEngine({
        coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
      });
      try {
        const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
        const request = { version: 1, sampleRateMode: "native",
          a: { codecId: "noop_passthrough", bitrateKbps: 0 },
          b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
        let disposal: Promise<void> | null = null;
        let failure = "resolved";
        try {
          await engine.prepare(file, request, {
            onProgress: ({ message }: { message: string }) => {
              if (!message.startsWith("Measurement worker is computing")) return;
              if (action === "dispose") disposal = engine.dispose();
              else throw new Error("measurement progress failed");
            },
          });
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        await disposal;
        let followup = "resolved";
        try {
          const retry = await engine.prepare(file, request);
          await engine.release(retry.id);
        } catch (error) { followup = error instanceof Error ? error.message : String(error); }
        return { failure, followup, created, terminated };
      } finally {
        await engine.dispose();
        window.Worker = OriginalWorker;
      }
    }, { url: `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`, action });
    expect(result.failure).toMatch(action === "dispose" ? /disposed/ : /measurement progress failed/);
    expect(result.followup).toBe(action === "dispose" ? "Browser preparation engine has been disposed" : "resolved");
    expect(result.created).toBe(action === "dispose" ? 1 : 2);
    expect(result.terminated).toBe(result.created);
  });
}

test("prepared cancellation queued at worker startup never creates a late worker and permits retry", async ({ page, baseURL }) => {
  await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "prepared-startup-abort.wav", makePcm16Wav({ channels: 1, seconds: 0.6 }));
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
  const result = await page.evaluate(async (url) => {
    const OriginalWorker = Worker;
    let created = 0;
    let terminated = 0;
    class TrackedWorker extends OriginalWorker {
      constructor(script: string | URL, options?: WorkerOptions) {
        super(script, options);
        if (options?.name === "codec-abx-measurements") {
          created += 1;
          const terminate = this.terminate.bind(this);
          this.terminate = () => { terminated += 1; terminate(); };
        }
      }
    }
    window.Worker = TrackedWorker;
    const { BrowserPreparationEngine } = await import(url);
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    try {
      const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
      const request = { version: 1, preparationPolicy: "aligned-gain-matched-v1",
        sampleRateMode: "native",
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
      const controller = new AbortController();
      let outcome = "resolved";
      try {
        await engine.prepare(file, request, {
          signal: controller.signal,
          onProgress: ({ message }: { message: string }) => {
            if (message.startsWith("Starting the dedicated preparation")) {
              queueMicrotask(() => controller.abort());
            }
          },
        });
      } catch (error) { outcome = error instanceof Error ? error.name : String(error); }
      const createdAfterAbort = created;
      const retry = await engine.prepare(file, request);
      const prepared = retry.preparation?.policy ?? null;
      await engine.release(retry.id);
      return { outcome, createdAfterAbort, created, terminated, prepared };
    } finally {
      await engine.dispose();
      window.Worker = OriginalWorker;
    }
  }, moduleURL);
  expect(result).toEqual({
    outcome: "AbortError",
    createdAfterAbort: 0,
    created: 1,
    terminated: 1,
    prepared: "aligned-gain-matched-v1",
  });
});

for (const action of ["dispose", "progress-throw"] as const) {
  test(`${action} during corrected preparation terminates its worker and settles the job`, async ({ page, baseURL }) => {
    await openLab(page, new URL(baseURL!).origin);
    await chooseWav(page, "prepared-lifecycle.wav", makePcm16Wav({ channels: 2, seconds: 0.6 }));
    const result = await page.evaluate(async ({ url, action }) => {
      const OriginalWorker = Worker;
      let created = 0;
      let terminated = 0;
      class TrackedWorker extends OriginalWorker {
        constructor(script: string | URL, options?: WorkerOptions) {
          super(script, options);
          if (options?.name === "codec-abx-measurements") {
            created += 1;
            const terminate = this.terminate.bind(this);
            this.terminate = () => { terminated += 1; terminate(); };
          }
        }
      }
      window.Worker = TrackedWorker;
      const { BrowserPreparationEngine } = await import(url);
      const engine = new BrowserPreparationEngine({
        coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
      });
      try {
        const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
        const request = { version: 1, preparationPolicy: "aligned-gain-matched-v1",
          sampleRateMode: "native",
          a: { codecId: "noop_passthrough", bitrateKbps: 0 },
          b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
        let disposal: Promise<void> | null = null;
        let failure = "resolved";
        try {
          await engine.prepare(file, request, {
            onProgress: ({ message }: { message: string }) => {
              if (!message.startsWith("Preparation worker is computing")) return;
              if (action === "dispose") disposal = engine.dispose();
              else throw new Error("preparation progress failed");
            },
          });
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        await disposal;
        let followup = "resolved";
        try {
          const retry = await engine.prepare(file, request);
          await engine.release(retry.id);
        } catch (error) { followup = error instanceof Error ? error.message : String(error); }
        return { failure, followup, created, terminated };
      } finally {
        await engine.dispose();
        window.Worker = OriginalWorker;
      }
    }, { url: `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`, action });
    expect(result.failure).toMatch(action === "dispose" ? /disposed/ : /preparation progress failed/);
    expect(result.followup).toBe(action === "dispose" ?
      "Browser preparation engine has been disposed" : "resolved");
    expect(result.created).toBe(action === "dispose" ? 1 : 2);
    expect(result.terminated).toBe(result.created);
  });
}

test("direct controlled worker fixture exercises nonzero lag crop and common trim against the shared TypeScript policy", async ({ page, baseURL }) => {
  await openLab(page, new URL(baseURL!).origin);
  const rate = 48000;
  const frames = Math.round(1.2 * rate);
  const source = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    source[frame] = 0.02 * Math.sin((2 * Math.PI * 440 * frame) / rate) +
      0.015 * Math.sin((2 * Math.PI * 1234 * frame) / rate);
  }
  source[16000] = 0.9;
  source[16001] = -0.85;
  const delayed = new Float64Array(frames);
  for (let frame = 57; frame < frames; frame += 1) {
    delayed[frame] = (source[frame - 57] ?? 0) * 0.5;
  }
  const aBytes = makeWavFromSamples(source, rate);
  const bBytes = makeWavFromSamples(delayed, rate);
  const reference = await prepareDelivered(aBytes, bBytes);
  expect(reference.report.alignment.lagSamples).toBe(57);
  expect(reference.report.alignment.startFrameB).toBe(57);
  expect(reference.report.alignment.outputFrames).toBe(frames - 57);
  expect(reference.report.loudness.commonTrimDb).toBeGreaterThan(0);

  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/measurement-worker.ts`;
  const result = await page.evaluate(async ({ url, wavURL, exportURL, a, b }) => {
    const { parsePcm16Wav, wavDescription } = await import(wavURL) as
      typeof import("../../packages/engine-browser/src/wav.js");
    const { buildDiagnosticExport } = await import(exportURL) as
      typeof import("../../apps/client/src/diagnostics.js");
    const decode = (base64: string): Uint8Array => Uint8Array.from(
      atob(base64), (character) => character.charCodeAt(0),
    );
    const digest = async (bytes: Uint8Array): Promise<string> => {
      const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise<{
        report: PairPreparationReport;
        delivered: DeliveredPairMeasurements;
        aPcmSha: string;
        bPcmSha: string;
        aLayout: { sampleRate: number; channels: number; frames: number };
        bLayout: { sampleRate: number; channels: number; frames: number };
        exported: Record<string, unknown>;
      }>((resolve, reject) => {
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          reject(new Error(event.message || "direct worker load failed"));
        });
        worker.addEventListener("messageerror", () => {
          reject(new Error("direct worker message could not be deserialized"));
        });
        worker.addEventListener("message", (event) => {
          const data = event.data as {
            type?: string;
            id?: string;
            message?: string;
            report?: PairPreparationReport;
            delivered?: DeliveredPairMeasurements;
            a?: ArrayBuffer;
            b?: ArrayBuffer;
          };
          if (data.type === "started") return;
          if (data.type === "error") {
            reject(new Error(data.message ?? "direct worker failed"));
            return;
          }
          if (data.type !== "prepare-result") return;
          void (async () => {
            if (!data.report || !data.delivered ||
                !(data.a instanceof ArrayBuffer) || !(data.b instanceof ArrayBuffer)) {
              throw new Error("test: malformed preparation worker result");
            }
            const aResult = new Uint8Array(data.a);
            const bResult = new Uint8Array(data.b);
            const aFacts = parsePcm16Wav(aResult);
            const bFacts = parsePcm16Wav(bResult);
            const aDelivered = wavDescription(aResult, await digest(aResult));
            const bDelivered = wavDescription(bResult, await digest(bResult));
            // Controlled decoded pair: this DTO exercises the real export
            // function without claiming it came from a codec-stage run.
            const artifact: PreparedArtifact = {
              id: "controlled-worker-crop", request,
              engine: { engineId: "controlled-worker-fixture", location: "browser-local",
                build: "controlled decoded PCM fixture", codecs: [], channels: [1],
                maxInputBytes: 16 * 1024 * 1024, maxDurationSeconds: 10,
                preparationPolicy: "aligned-gain-matched-v1", limitations: ["Test fixture"] },
              sourceSha256: await digest(decode(a)),
              a: { requested: request.a, encoder: "controlled-pcm", decoder: "controlled-pcm",
                actualBitrateKbps: null, encodedSampleRate: null, delivered: aDelivered },
              b: { requested: request.b, encoder: "controlled-pcm", decoder: "controlled-pcm",
                actualBitrateKbps: null, encodedSampleRate: null, delivered: bDelivered },
              elapsedMs: 0, preparation: data.report,
              measurements: { policy: "delivered-pcm-measurements-v1", delivered: data.delivered,
                alignmentLagSamples: data.delivered.alignment.lagSamples,
                alignmentConfidence: data.delivered.alignment.confidence,
                loudnessDeltaDb: null, nullDepthDb: null, notes: [] },
              disclosures: ["Controlled decoded pair, not a codec-stage artifact"],
              purpose: "diagnostic-only",
            };
            return {
              report: data.report, delivered: data.delivered,
              aPcmSha: await digest(aResult.subarray(aFacts.dataOffset, aFacts.dataOffset + aFacts.dataSize)),
              bPcmSha: await digest(bResult.subarray(bFacts.dataOffset, bFacts.dataOffset + bFacts.dataSize)),
              aLayout: { sampleRate: aFacts.sampleRate, channels: aFacts.channels, frames: aFacts.frames },
              bLayout: { sampleRate: bFacts.sampleRate, channels: bFacts.channels, frames: bFacts.frames },
              exported: buildDiagnosticExport(artifact, "2026-10-28T00:00:00Z"),
            };
          })().then(resolve, reject);
        });
        const aCopy = decode(a);
        const bCopy = decode(b);
        const request: SingleStagePreparationRequest = { version: 1, sampleRateMode: "native",
          preparationPolicy: "aligned-gain-matched-v1",
          a: { codecId: "noop_passthrough", bitrateKbps: 0 },
          b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
        worker.postMessage({
          type: "prepare",
          id: "controlled-worker-crop",
          a: aCopy.buffer,
          b: bCopy.buffer,
          request,
        }, [aCopy.buffer, bCopy.buffer]);
      });
    } finally {
      worker.terminate();
    }
  }, {
    url: moduleURL,
    wavURL: `/@fs/${process.cwd()}/packages/engine-browser/src/wav.ts`,
    exportURL: `/@fs/${process.cwd()}/apps/client/src/diagnostics.ts`,
    a: Buffer.from(aBytes).toString("base64"),
    b: Buffer.from(bBytes).toString("base64"),
  });

  expect(result.report).toMatchObject({
    policy: "aligned-gain-matched-v1",
    alignment: {
      lagSamples: reference.report.alignment.lagSamples,
      status: reference.report.alignment.status,
      startFrameB: reference.report.alignment.startFrameB,
      outputFrames: reference.report.alignment.outputFrames,
    },
  });
  expect(result.aPcmSha).toBe(sha256(pcmPayload(reference.aPrepared)));
  expect(result.bPcmSha).toBe(sha256(pcmPayload(reference.bPrepared)));
  expect(result.aLayout).toEqual({ sampleRate: rate, channels: 1, frames: frames - 57 });
  expect(result.bLayout).toEqual(result.aLayout);
  expect(result.exported.scientificStatus).toMatchObject({
    preparationPolicyExecuted: true, alignmentApplied: true, tailCropApplied: true,
    commonPeakTrimApplied: true, normalizationApplied: true, gainMatchingApplied: true,
    scoredAbxRun: false, canaryGates: false,
  });
  expect(result.exported.appliedOperations).toEqual({
    policy: "aligned-gain-matched-v1", appliedLagSamples: 57,
    alignmentStatus: result.report.alignment.status,
    alignmentConfidence: result.report.alignment.confidence,
    inputFramesA: frames, inputFramesB: frames,
    startFrameA: 0, startFrameB: 57, outputFrames: frames - 57,
    gainADb: result.report.loudness.gainADb, gainBDb: result.report.loudness.gainBDb,
    commonTrimDb: result.report.loudness.commonTrimDb,
  });
  expect(result.exported.preparation).toEqual(result.report);
  expect(result.exported.deliveredMeasurements).toEqual(result.delivered);
});

test("browser rejects an unsupported policy before source read or worker creation", async ({ page, baseURL }) => {
  await openLab(page, new URL(baseURL!).origin);
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
  const result = await page.evaluate(async (url) => {
    const OriginalWorker = Worker;
    let created = 0;
    class TrackedWorker extends OriginalWorker {
      constructor(script: string | URL, options?: WorkerOptions) {
        super(script, options);
        created += 1;
      }
    }
    window.Worker = TrackedWorker;
    const { BrowserPreparationEngine } = await import(url);
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    let sourceRead = false;
    const source = {
      size: 44,
      arrayBuffer: () => {
        sourceRead = true;
        return Promise.resolve(new ArrayBuffer(44));
      },
    } as unknown as File;
    let message = "resolved";
    try {
      await engine.prepare(source, {
        version: 1,
        preparationPolicy: "unknown-policy-v0",
        sampleRateMode: "native",
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    await engine.dispose();
    window.Worker = OriginalWorker;
    return { message, sourceRead, created };
  }, moduleURL);
  expect(result.message).toMatch(/unsupported preparation policy/i);
  expect(result.sourceRead).toBe(false);
  expect(result.created).toBe(0);
});

test("browser rejects canary opt-in before source read for raw and unsupported policies", async ({
  page,
  baseURL,
}) => {
  await openLab(page, new URL(baseURL!).origin);
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
  const result = await page.evaluate(async (url) => {
    const OriginalWorker = Worker;
    let created = 0;
    class TrackedWorker extends OriginalWorker {
      constructor(script: string | URL, options?: WorkerOptions) {
        super(script, options);
        created += 1;
      }
    }
    window.Worker = TrackedWorker;
    const { BrowserPreparationEngine } = await import(url);
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    let sourceRead = false;
    const source = {
      size: 44,
      arrayBuffer: () => {
        sourceRead = true;
        return Promise.resolve(new ArrayBuffer(44));
      },
    } as unknown as File;
    const messages: string[] = [];
    for (const request of [
      {
        version: 1, canaryEnabled: true, sampleRateMode: "native",
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 },
      },
      {
        version: 1, canaryEnabled: true, preparationPolicy: "unknown-policy-v0",
        sampleRateMode: "native",
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 },
      },
    ]) {
      try {
        await engine.prepare(source, request as never);
        messages.push("resolved");
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    await engine.dispose();
    window.Worker = OriginalWorker;
    return { messages, sourceRead, created };
  }, moduleURL);
  expect(result.messages[0]).toContain("Canary material requires");
  expect(result.messages[1]).toMatch(/unsupported preparation policy/i);
  expect(result.sourceRead).toBe(false);
  expect(result.created).toBe(0);
});

test("canary handles are conditional, copy-owned, unusable when absent, and cleared with the artifact", async ({
  page,
  baseURL,
}) => {
  await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "canary-contract.wav", makePcm16Wav({ channels: 1, seconds: 0.6 }));
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
  const result = await page.evaluate(async (url) => {
    const { BrowserPreparationEngine } = await import(url);
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
    const baseRequest = {
      version: 1 as const, preparationPolicy: "aligned-gain-matched-v1" as const,
      sampleRateMode: "native" as const,
      a: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
      b: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
    };
    const digest = async (bytes: Uint8Array): Promise<string> => {
      const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const disabled = await engine.prepare(file, baseRequest);
    let disabledCanaryRead = "resolved";
    try { await engine.readCanaryAudio(disabled.id, "pristine"); }
    catch (error) { disabledCanaryRead = error instanceof Error ? error.message : String(error); }
    await engine.release(disabled.id);
    let releasedCanaryRead = "resolved";
    try { await engine.readCanaryAudio(disabled.id, "degraded"); }
    catch (error) { releasedCanaryRead = error instanceof Error ? error.message : String(error); }

    const enabled = await engine.prepare(file, { ...baseRequest, canaryEnabled: true });
    if (!enabled.canary?.audio) throw new Error("test: canary material was not usable");
    const pristine = new Uint8Array(await engine.readCanaryAudio(enabled.id, "pristine"));
    const originalHash = await digest(pristine);
    pristine.fill(0);
    const independent = new Uint8Array(await engine.readCanaryAudio(enabled.id, "pristine"));
    const independentHash = await digest(independent);
    const degraded = new Uint8Array(await engine.readCanaryAudio(enabled.id, "degraded"));
    const degradedHash = await digest(degraded);
    const declaredHashes = {
      pristine: enabled.canary.audio.pristine.wavSha256,
      degraded: enabled.canary.audio.degraded.wavSha256,
    };
    await engine.release(enabled.id);
    let releasedAudioRead = "resolved";
    try { await engine.readAudio(enabled.id, "a"); }
    catch (error) { releasedAudioRead = error instanceof Error ? error.message : String(error); }
    let releasedMaterialRead = "resolved";
    try { await engine.readCanaryAudio(enabled.id, "pristine"); }
    catch (error) { releasedMaterialRead = error instanceof Error ? error.message : String(error); }

    const disposedArtifact = await engine.prepare(file, { ...baseRequest, canaryEnabled: true });
    await engine.dispose();
    let disposedAudioRead = "resolved";
    try { await engine.readAudio(disposedArtifact.id, "a"); }
    catch (error) { disposedAudioRead = error instanceof Error ? error.message : String(error); }
    let disposedMaterialRead = "resolved";
    try { await engine.readCanaryAudio(disposedArtifact.id, "degraded"); }
    catch (error) { disposedMaterialRead = error instanceof Error ? error.message : String(error); }

    return {
      disabledReport: disabled.canary ?? null,
      disabledCanaryRead,
      releasedCanaryRead,
      originalHash,
      independentHash,
      degradedHash,
      declaredHashes,
      releasedAudioRead,
      releasedMaterialRead,
      disposedAudioRead,
      disposedMaterialRead,
    };
  }, moduleURL);
  expect(result.disabledReport).toBeNull();
  expect(result.disabledCanaryRead).toContain("Unknown");
  expect(result.releasedCanaryRead).toContain("Unknown or released");
  expect(result.independentHash).toBe(result.originalHash);
  expect(result.independentHash).toBe(result.declaredHashes.pristine);
  expect(result.degradedHash).toBe(result.declaredHashes.degraded);
  expect(result.releasedAudioRead).toContain("Unknown or released");
  expect(result.releasedMaterialRead).toContain("Unknown or released");
  expect(result.disposedAudioRead).toContain("Unknown or released");
  expect(result.disposedMaterialRead).toContain("Unknown or released");
});

test("unusable canary material is represented honestly at the module boundary without served bytes", async ({
  page,
  baseURL,
}) => {
  await openLab(page, new URL(baseURL!).origin);
  const fixture = makePcm16Wav({ sampleRate: 44100, channels: 1, seconds: 0.5, amplitude: 0 });
  const result = await page.evaluate(async ({ validationURL, policyURL, wavURL, exportURL, a }) => {
    const { assertCanaryMaterial } = await import(validationURL) as
      typeof import("../../packages/engine-browser/src/result-validation.js");
    const { buildCanaryPair } = await import(policyURL) as
      typeof import("../../packages/preparation-policy/src/index.js");
    const { parsePcm16Wav } = await import(wavURL) as
      typeof import("../../packages/engine-browser/src/wav.js");
    const { buildDiagnosticExport } = await import(exportURL) as
      typeof import("../../apps/client/src/diagnostics.js");
    const decode = (base64: string): Uint8Array => Uint8Array.from(
      atob(base64), (character) => character.charCodeAt(0),
    );
    const aBytes = decode(a);
    const facts = parsePcm16Wav(aBytes);
    const silence = {
      sampleRate: facts.sampleRate,
      channels: [new Float64Array(facts.frames)],
    };
    const material = buildCanaryPair(silence);
    const validated = await assertCanaryMaterial(
      { report: material.report, pristine: null, degraded: null },
      aBytes,
      facts,
    );
    let withBytes = "resolved";
    try {
      await assertCanaryMaterial({
        report: material.report,
        pristine: material.pristineWav.buffer,
        degraded: material.degradedWav.buffer,
      }, aBytes, facts);
    } catch (error) {
      withBytes = error instanceof Error ? error.message : String(error);
    }
    if (!validated) throw new Error("test: missing unusable material report");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", aBytes as BufferSource))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const request: SingleStagePreparationRequest = {
      version: 1, sampleRateMode: "native", preparationPolicy: "aligned-gain-matched-v1",
      canaryEnabled: true,
      a: { codecId: "noop_passthrough", bitrateKbps: 0 },
      b: { codecId: "noop_passthrough", bitrateKbps: 0 },
    };
    const delivered = { sampleRate: facts.sampleRate, channels: facts.channels,
      frames: facts.frames, wavSha256: hash };
    // Controlled DTO for serializer semantics only. This is not a claim that
    // the prepared policy accepted silence or that a codec session succeeded.
    const controlled: PreparedArtifact = {
      id: "controlled-unusable-material", request,
      engine: { engineId: "controlled-module-fixture", location: "browser-local",
        build: "unusable material export fixture", codecs: [], channels: [1],
        maxInputBytes: 16 * 1024 * 1024, maxDurationSeconds: 10,
        preparationPolicy: "aligned-gain-matched-v1", limitations: ["Controlled DTO"] },
      sourceSha256: hash,
      a: { requested: request.a, encoder: "controlled-pcm", decoder: "controlled-pcm",
        actualBitrateKbps: null, encodedSampleRate: null, delivered },
      b: { requested: request.b, encoder: "controlled-pcm", decoder: "controlled-pcm",
        actualBitrateKbps: null, encodedSampleRate: null, delivered },
      elapsedMs: 0,
      measurements: { policy: "delivered-pcm-measurements-v1", alignmentLagSamples: null,
        alignmentConfidence: null, loudnessDeltaDb: null, nullDepthDb: null, notes: [] },
      canary: { report: validated.report, audio: validated.audio },
      disclosures: ["Controlled module-boundary material; not a preparation of silence"],
      purpose: "diagnostic-only",
    };
    const exported = buildDiagnosticExport(controlled, "2026-10-28T00:00:00Z");
    return {
      status: material.report.status,
      usable: material.report.usable,
      report: validated?.report ?? null,
      audio: validated?.audio ?? null,
      bytes: validated?.bytes ?? null,
      withBytes,
      scientificStatus: exported.scientificStatus,
    };
  }, {
    validationURL: `/@fs/${process.cwd()}/packages/engine-browser/src/result-validation.ts`,
    policyURL: `/@fs/${process.cwd()}/packages/preparation-policy/src/index.ts`,
    wavURL: `/@fs/${process.cwd()}/packages/engine-browser/src/wav.ts`,
    exportURL: `/@fs/${process.cwd()}/apps/client/src/diagnostics.ts`,
    a: Buffer.from(fixture).toString("base64"),
  });
  expect(result.status).toBe("not-usable");
  expect(result.usable).toBe(false);
  expect(result.report).toMatchObject({
    policy: "delivered-canary-v1",
    status: "not-usable",
    usable: false,
    frequencyGrid: "numpy-rfftfreq-v1",
  });
  expect(result.audio).toBeNull();
  expect(result.bytes).toBeNull();
  expect(result.withBytes).toContain("must not retain or serve WAV bytes");
  expect(result.scientificStatus).toMatchObject({
    canaryMaterialGenerated: true, canaryMaterialChecked: true,
    canaryMaterialUsable: false, canaryAudioRetained: false,
    listenerCalibrationRun: false, canaryGates: false, scoredAbxRun: false,
  });
});

test("browser preparation preflight refuses an unrelated pair without publishing audio", async ({ page, baseURL }) => {
  await openLab(page, new URL(baseURL!).origin);
  const rate = 48000;
  const frames = 28800;
  const a = Float64Array.from({ length: frames }, (_, frame) => 0.2 * Math.sin(2 * Math.PI * 440 * frame / rate));
  const b = Float64Array.from({ length: frames }, (_, frame) => 0.17 * Math.sin(2 * Math.PI * 913 * frame / rate + 0.4));
  const result = await page.evaluate(async ({ url, a, b }) => {
    const decode = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0)).buffer;
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise<{ type: string; code?: string; message?: string; hasAudio: boolean }>((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = event => {
          const message = event.data;
          if (message.type === "started" || message.type === "stage") return;
          resolve({ type: message.type, code: message.code, message: message.message,
            hasAudio: message.a instanceof ArrayBuffer || message.b instanceof ArrayBuffer });
        };
        worker.postMessage({ type: "prepare", id: "unrelated-preflight", a: decode(a), b: decode(b),
          request: { version: 1, sampleRateMode: "native", preparationPolicy: "aligned-gain-matched-v1",
            a: { codecId: "noop_passthrough", bitrateKbps: 0 },
            b: { codecId: "noop_passthrough", bitrateKbps: 0 } } });
      });
    } finally { worker.terminate(); }
  }, { url: `/@fs/${process.cwd()}/packages/engine-browser/src/measurement-worker.ts`,
    a: Buffer.from(makeWavFromSamples(a, rate)).toString("base64"),
    b: Buffer.from(makeWavFromSamples(b, rate)).toString("base64") });
  expect(result.type).toBe("error");
  expect(result.code).toBe("preparation-gate-failed");
  expect(result.message).toContain("weak-or-unrelated");
  expect(result.hasAudio).toBe(false);
});

test("controlled identical configuration with a non-null pair publishes a failed diagnostic null decision", async ({
  page,
  baseURL,
}) => {
  await openLab(page, new URL(baseURL!).origin);
  const rate = 48000;
  const frames = Math.round(0.6 * rate);
  const aSignal = new Float64Array(frames);
  const bSignal = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    aSignal[frame] = 0.2 * Math.sin((2 * Math.PI * 440 * frame) / rate);
    // Keep strong shared content so preparation suitability passes while the
    // independently added tone still makes the identical-pipeline null fail.
    bSignal[frame] = 0.17 * Math.sin((2 * Math.PI * 440 * frame) / rate) +
      0.005 * Math.sin((2 * Math.PI * 913 * frame) / rate + 0.4);
  }
  const aBytes = makeWavFromSamples(aSignal, rate);
  const bBytes = makeWavFromSamples(bSignal, rate);
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/measurement-worker.ts`;
  const result = await page.evaluate(async ({ url, exportURL, a, b }) => {
    const { buildDiagnosticExport } = await import(exportURL) as
      typeof import("../../apps/client/src/diagnostics.js");
    const decode = (base64: string): Uint8Array => Uint8Array.from(
      atob(base64), (character) => character.charCodeAt(0),
    );
    const digest = async (bytes: Uint8Array): Promise<string> => {
      const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise<{
        validity: {
          policy: string;
          nullGate: { status: string; reason: string; expectedIdentical: boolean };
          preparationGate: { status: string; classification: string; disclosure: string | null };
        };
        delivered: DeliveredPairMeasurements;
        exported: Record<string, unknown>;
        aHash: string;
        bHash: string;
      }>((resolve, reject) => {
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          reject(new Error(event.message || "direct worker load failed"));
        });
        worker.addEventListener("message", (event) => {
          const data = event.data as {
            type?: string;
            id?: string;
            message?: string;
            report?: PairPreparationReport;
            delivered?: DeliveredPairMeasurements;
            validity?: {
              policy: string;
              nullGate: { status: string; reason: string; expectedIdentical: boolean };
              preparationGate: { status: string; classification: string; disclosure: string | null };
            };
            a?: ArrayBuffer;
            b?: ArrayBuffer;
          };
          if (data.type === "started" || data.type === "stage") return;
          if (data.type === "error") {
            reject(new Error(data.message ?? "direct worker failed"));
            return;
          }
          if (data.type !== "prepare-result") return;
          void (async () => {
            if (!data.report || !data.delivered || !data.validity ||
                !(data.a instanceof ArrayBuffer) || !(data.b instanceof ArrayBuffer)) {
              throw new Error("test: malformed preparation worker result");
            }
            const aResult = new Uint8Array(data.a);
            const bResult = new Uint8Array(data.b);
            const aHash = await digest(aResult);
            const bHash = await digest(bResult);
            const request: SingleStagePreparationRequest = { version: 1, sampleRateMode: "native",
              preparationPolicy: "aligned-gain-matched-v1",
              a: { codecId: "noop_passthrough", bitrateKbps: 0 },
              b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
            const artifact: PreparedArtifact = {
              id: "controlled-bad-pair", request,
              engine: { engineId: "controlled-worker-fixture", location: "browser-local",
                build: "controlled decoded PCM fixture", codecs: [], channels: [1],
                maxInputBytes: 16 * 1024 * 1024, maxDurationSeconds: 10,
                preparationPolicy: "aligned-gain-matched-v1", limitations: ["Test fixture"] },
              sourceSha256: await digest(decode(a)),
              a: { requested: request.a, encoder: "controlled-pcm", decoder: "controlled-pcm",
                actualBitrateKbps: null, encodedSampleRate: null,
                delivered: { sampleRate: data.delivered.a.sampleRate, channels: 1,
                  frames: data.delivered.a.frames, wavSha256: aHash } },
              b: { requested: request.b, encoder: "controlled-pcm", decoder: "controlled-pcm",
                actualBitrateKbps: null, encodedSampleRate: null,
                delivered: { sampleRate: data.delivered.b.sampleRate, channels: 1,
                  frames: data.delivered.b.frames, wavSha256: bHash } },
              elapsedMs: 0, preparation: data.report, validity: data.validity as never,
              measurements: { policy: "delivered-pcm-measurements-v1",
                delivered: data.delivered,
                alignmentLagSamples: data.delivered.alignment.lagSamples,
                alignmentConfidence: data.delivered.alignment.confidence,
                loudnessDeltaDb: null, nullDepthDb: null, notes: [] },
              disclosures: ["Controlled decoded pair, not a codec-stage artifact"],
              purpose: "diagnostic-only",
            };
            return {
              validity: data.validity,
              delivered: data.delivered,
              exported: buildDiagnosticExport(artifact, "2026-10-28T00:00:00Z"),
              aHash,
              bHash,
            };
          })().then(resolve, reject);
        });
        const aCopy = decode(a);
        const bCopy = decode(b);
        const request: SingleStagePreparationRequest = { version: 1, sampleRateMode: "native",
          preparationPolicy: "aligned-gain-matched-v1",
          a: { codecId: "noop_passthrough", bitrateKbps: 0 },
          b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
        worker.postMessage({ type: "prepare", id: "controlled-bad-pair",
          a: aCopy.buffer, b: bCopy.buffer, request },
        [aCopy.buffer, bCopy.buffer]);
      });
    } finally {
      worker.terminate();
    }
  }, {
    url: moduleURL,
    exportURL: `/@fs/${process.cwd()}/apps/client/src/diagnostics.ts`,
    a: Buffer.from(aBytes).toString("base64"),
    b: Buffer.from(bBytes).toString("base64"),
  });
  expect(result.validity.policy).toBe("delivered-validity-v2");
  expect(result.validity.nullGate.expectedIdentical).toBe(true);
  expect(result.validity.nullGate.status).toBe("failed");
  expect(result.validity.nullGate.reason).toContain("did NOT null");
  expect(result.validity.preparationGate.status).toBe("passed");
  expect(result.validity.preparationGate.classification).toMatch(/^same-polarity-(unique|periodic-ambiguous)$/);
  expect(result.exported.scientificStatus).toMatchObject({
    nullGateEvaluated: true,
    nullGateStatus: "failed",
    canaryMaterialChecked: false,
    canaryMaterialGenerated: false,
    canaryMaterialUsable: false,
    listenerCalibrationRun: false,
    scoringRun: false,
    canaryGates: false,
    scoredAbxRun: false,
  });
  expect(result.exported.validity).toEqual(result.validity);
  expect(result.exported.canary).toBeNull();
  const serialized = JSON.stringify(result.exported);
  expect(serialized).not.toContain("Infinity");
  expect(serialized).not.toContain("NaN");
  expect(serialized).not.toContain("\"validABX\":true");
});

for (const action of ["dispose", "progress-throw"] as const) {
  test(`${action} during canary generation terminates its worker and settles the job`, async ({
    page,
    baseURL,
  }) => {
    await openLab(page, new URL(baseURL!).origin);
    await chooseWav(page, "canary-lifecycle.wav", makePcm16Wav({ channels: 1, seconds: 0.6 }));
    const result = await page.evaluate(async ({ url, action }) => {
      const OriginalWorker = Worker;
      let created = 0;
      let terminated = 0;
      class TrackedWorker extends OriginalWorker {
        constructor(script: string | URL, options?: WorkerOptions) {
          super(script, options);
          if (options?.name === "codec-abx-measurements") {
            created += 1;
            const terminate = this.terminate.bind(this);
            this.terminate = () => { terminated += 1; terminate(); };
          }
        }
      }
      window.Worker = TrackedWorker;
      const { BrowserPreparationEngine } = await import(url);
      const engine = new BrowserPreparationEngine({
        coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
      });
      try {
        const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
        const request = { version: 1 as const,
          preparationPolicy: "aligned-gain-matched-v1" as const,
          canaryEnabled: true as const, sampleRateMode: "native" as const,
          a: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
          b: { codecId: "noop_passthrough" as const, bitrateKbps: 0 } };
        let disposal: Promise<void> | null = null;
        let failure = "resolved";
        try {
          await engine.prepare(file, request, {
            onProgress: ({ message }: { message: string }) => {
              if (!message.startsWith("Canary material is being generated")) return;
              if (action === "dispose") disposal = engine.dispose();
              else throw new Error("canary progress failed");
            },
          });
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        await disposal;
        let followup = "resolved";
        try {
          const retry = await engine.prepare(file, request);
          await engine.release(retry.id);
        } catch (error) { followup = error instanceof Error ? error.message : String(error); }
        return { failure, followup, created, terminated };
      } finally {
        await engine.dispose();
        window.Worker = OriginalWorker;
      }
    }, { url: `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`, action });
    expect(result.failure).toMatch(action === "dispose" ? /disposed/ : /canary progress failed/);
    expect(result.followup).toBe(action === "dispose" ?
      "Browser preparation engine has been disposed" : "resolved");
    expect(result.created).toBe(action === "dispose" ? 1 : 2);
    expect(result.terminated).toBe(result.created);
  });
}

test("abort during asynchronous canary hashing never publishes a late artifact and permits retry", async ({ page, baseURL }) => {
  await openLab(page, new URL(baseURL!).origin);
  await chooseWav(page, "canary-hash-abort.wav", makePcm16Wav({ channels: 1, seconds: 0.6 }));
  const moduleURL = `/@fs/${process.cwd()}/packages/engine-browser/src/index.ts`;
  const result = await page.evaluate(async (url) => {
    const OriginalWorker = window.Worker;
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let created = 0;
    let terminated = 0;
    let cancelledId = "";
    let blockValidation = false;
    let releaseHash = (): void => {};
    let notifyHashStart = (): void => {};
    const hashGate = new Promise<void>(resolve => { releaseHash = resolve; });
    const hashStarted = new Promise<void>(resolve => { notifyHashStart = resolve; });
    const pendingHashes: Promise<ArrayBuffer>[] = [];
    class TrackedWorker extends OriginalWorker {
      constructor(script: string | URL, options?: WorkerOptions) {
        super(script, options);
        if (options?.name !== "codec-abx-measurements") return;
        created += 1;
        const terminate = this.terminate.bind(this);
        this.terminate = () => { terminated += 1; terminate(); };
        // Set the gate before the engine handles the real worker response.
        super.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as { type?: string; id?: string; canary?: unknown };
          if (data.type === "prepare-result" && data.canary) {
            cancelledId = data.id ?? "";
            blockValidation = true;
          }
        });
      }
    }
    window.Worker = TrackedWorker;
    crypto.subtle.digest = (algorithm, bytes) => {
      if (!blockValidation) return originalDigest(algorithm, bytes);
      const pending = hashGate.then(() => originalDigest(algorithm, bytes));
      pendingHashes.push(pending);
      notifyHashStart();
      return pending;
    };
    const { BrowserPreparationEngine } = await import(url) as
      typeof import("../../packages/engine-browser/src/index.js");
    const engine = new BrowserPreparationEngine({
      coreURL: new URL("/codec-assets/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/codec-assets/ffmpeg-core.wasm", location.href).href,
    });
    try {
      const file = (document.querySelector("#source-file") as HTMLInputElement).files![0]!;
      const request: SingleStagePreparationRequest = { version: 1, sampleRateMode: "native",
        preparationPolicy: "aligned-gain-matched-v1", canaryEnabled: true,
        a: { codecId: "noop_passthrough", bitrateKbps: 0 },
        b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
      const controller = new AbortController();
      const pending = engine.prepare(file, request, { signal: controller.signal }).then(
        () => "resolved", error => error instanceof Error ? error.name : String(error),
      );
      await Promise.race([hashStarted, pending.then(value => {
        throw new Error(`test: preparation settled before canary validation (${value})`);
      })]);
      controller.abort();
      const outcome = await pending;
      const terminatedAtRejection = terminated;
      const hashCount = pendingHashes.length;
      releaseHash();
      await Promise.allSettled(pendingHashes);
      // Late hash completion must not insert either A/B or canary ownership.
      let staleAudio = false;
      let staleCanary = false;
      try { await engine.readAudio(cancelledId, "a"); } catch { staleAudio = true; }
      try { await engine.readCanaryAudio(cancelledId, "pristine"); } catch { staleCanary = true; }
      crypto.subtle.digest = originalDigest;
      blockValidation = false;
      const retry = await engine.prepare(file, request);
      const retryCanary = new Uint8Array(await engine.readCanaryAudio(retry.id, "degraded"))[0] === 0x52;
      await engine.release(retry.id);
      return { outcome, terminatedAtRejection, hashCount, staleAudio, staleCanary,
        retryCanary, created, terminated };
    } finally {
      releaseHash();
      crypto.subtle.digest = originalDigest;
      await engine.dispose();
      window.Worker = OriginalWorker;
    }
  }, moduleURL);
  expect(result).toEqual({ outcome: "AbortError", terminatedAtRejection: 1, hashCount: 2,
    staleAudio: true, staleCanary: true, retryCanary: true, created: 2, terminated: 2 });
});
