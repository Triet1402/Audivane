import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { TypeScriptNativePreparationEngine } from "@codec-abx/engine-native/typescript";
import { measurePair } from "@codec-abx/measurements";
import { buildCanaryPair } from "@codec-abx/preparation-policy";
import { DesktopRuntime } from "../apps/desktop/src/runtime.js";
import { WorkerDesktopRuntime } from "../apps/desktop/src/worker-runtime.js";
import type { PreparedArtifact, DesktopSource, PreparationRequest } from "@codec-abx/contracts";
export function signal(seconds: number) {
  const rate = 96000, frames = rate * seconds;
  const left = new Float64Array(frames), right = new Float64Array(frames);
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(6500 * Math.sin(2 * Math.PI * 440 * i / rate));
    left[i] = sample / 32768; right[i] = -sample / 32768;
    bytes.writeInt16LE(sample, 44 + i * 4); bytes.writeInt16LE(-sample, 46 + i * 4);
  }
  return { bytes, pcm: { sampleRate: rate, channels: [left, right] } };
}
export const nativeRequest: PreparationRequest = { version: 1, preparationPolicy: "aligned-gain-matched-v1", sampleRateMode: "native", canaryEnabled: true, a: { codecId: "noop_passthrough", bitrateKbps: 0 }, b: { codecId: "noop_passthrough", bitrateKbps: 0 } };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function profile(mode: "direct" | "worker" | "dsp", seconds: number, root: string, workerPath: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-profile-"));
  const source = path.join(directory, "signal.wav");
  const material = signal(seconds); await fs.writeFile(source, material.bytes);
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
  let previous = performance.now(), heartbeatMaxMs = 0, heartbeats = 0, peakRssBytes = process.memoryUsage().rss, peakChildren = 0;
  const children = new Set<number>();
  const runtime = mode === "dsp" ? null : mode === "direct" ? new DesktopRuntime({
    engine: new TypeScriptNativePreparationEngine({ repositoryRoot: root, tempRoot: directory, processObserver: event => { if (event.type === "spawn") children.add(event.pid); else children.delete(event.pid); peakChildren = Math.max(peakChildren, children.size); } }),
    pickSource: async () => source, progress: () => undefined,
  }) : new WorkerDesktopRuntime({ workerPath, engine: { repositoryRoot: root }, pickSource: async () => source, progress: () => undefined });
  const interval = setInterval(() => { const now = performance.now(); heartbeatMaxMs = Math.max(heartbeatMaxMs, now - previous); previous = now; heartbeats++; peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); if (runtime instanceof WorkerDesktopRuntime) peakChildren = Math.max(peakChildren, runtime.diagnostics().children); }, 10);
  try {
    await sleep(30);
    const start = performance.now(); let preparationMs: number | null = null, bindMs: number | null = null, pairMs: number | null = null, canaryMs: number | null = null;
    let scientific: unknown;
    if (mode === "dsp") {
      const beforePair = performance.now(); measurePair(material.pcm, material.pcm, { maxLagSamples: 9600, probeSamples: 240000 }); pairMs = performance.now() - beforePair;
      const beforeCanary = performance.now(); const canary = buildCanaryPair(material.pcm); canaryMs = performance.now() - beforeCanary;
      scientific = { usable: canary.report.usable };
    } else {
      const selected = await runtime!.invoke("pickSource", []) as DesktopSource;
      const preparationStart = performance.now();
      const artifact = await runtime!.invoke("prepare", [selected.id, nativeRequest, "profile_native_job_001"]) as PreparedArtifact;
      preparationMs = performance.now() - preparationStart;
      await runtime!.invoke("configure", [{ version: 1, plannedTrials: 2, alpha: .05, labelMode: "blind_random", calibrationEnabled: false }]);
      const beforeBind = performance.now(); await runtime!.invoke("bindPrepared", [artifact.id]); bindMs = performance.now() - beforeBind;
      scientific = { request: artifact.request, sourceSha256: artifact.sourceSha256, a: artifact.a.delivered, b: artifact.b.delivered, measurements: artifact.measurements, validity: artifact.validity, canary: artifact.canary };
      await runtime!.invoke("dispose", []); await runtime!.invoke("release", [artifact.id]);
    }
    const elapsedMs = performance.now() - start;
    await sleep(30);
    const cleanupStart = performance.now(); await runtime?.dispose(); const cleanupMs = performance.now() - cleanupStart;
    return { node: process.version, mode, seconds, sampleRate: 96000, channels: 2, canaryEnabled: true, elapsedMs, preparationMs, bindMs, pairMs, canaryMs, heartbeatMaxMs, eventLoopMaxMs: eventLoop.max / 1e6, heartbeats, finalRssBytes: process.memoryUsage().rss, sampledPeakRssBytes: peakRssBytes, maxRssKiB: process.resourceUsage().maxRSS, memoryScope: "entire Node process including all worker threads; excludes native FFmpeg/codec-helper child RSS", workersPeak: mode === "worker" ? 1 : 0, workersAfter: runtime instanceof WorkerDesktopRuntime ? runtime.diagnostics().workers : 0, nativeChildrenPeak: peakChildren, nativeChildrenAfter: runtime instanceof WorkerDesktopRuntime ? runtime.diagnostics().children : children.size, cleanupMs, scientific };
  } finally { clearInterval(interval); eventLoop.disable(); await runtime?.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}
export async function profileCancellation(seconds: number, root: string, workerPath: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-cancel-profile-"));
  const source = path.join(directory, "signal.wav"); await fs.writeFile(source, signal(seconds).bytes);
  let cancellation: Promise<unknown> | null = null, requestedAt = 0, confirmedAt = 0, phase: string | null = null;
  const jobId = "profile_cancel_job_001";
  const runtime = new WorkerDesktopRuntime({ workerPath, engine: { repositoryRoot: root }, pickSource: async () => source,
    progress: (_id, progress) => {
      if (!cancellation && progress.phase === "encoding") {
        phase = progress.phase; requestedAt = performance.now();
        cancellation = runtime.invoke("cancel", [jobId]).then(() => { confirmedAt = performance.now(); });
        void cancellation.catch(() => undefined);
      }
    } });
  try {
    const selected = await runtime.invoke("pickSource", []) as DesktopSource;
    let outcome = "unexpected-success";
    try { await runtime.invoke("prepare", [selected.id, nativeRequest, jobId]); }
    catch (error) { outcome = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown-error"; }
    await cancellation;
    const afterCancellation = runtime.diagnostics();
    const cleanupStart = performance.now(); await runtime.dispose();
    return { node: process.version, mode: "cancel", seconds, requestedPhase: phase, outcome, cancellationCleanupMs: confirmedAt - requestedAt, runtimeDisposeMs: performance.now() - cleanupStart,
      nativeChildrenAfterCancellation: afterCancellation.children, nativeChildrenAfterDispose: runtime.diagnostics().children, workersAfterDispose: runtime.diagnostics().workers,
      memoryScope: "entire Node process including worker; native child RSS excluded", rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS,
      limit: "Cancellation sampled at an asynchronous native execution phase; synchronous DSP remains bounded and cooperatively cancellable only between passes." };
  } finally { await runtime.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}
if (process.argv[2] === "--run") void (async () => {
  const mode = process.argv[3] as "direct" | "worker" | "dsp" | "cancel";
  if (!["direct", "worker", "dsp", "cancel"].includes(mode)) throw new Error("Expected direct, worker, dsp or cancel");
  const seconds = Number(process.argv[4]); if (seconds !== 1 && seconds !== 10) throw new Error("Expected 1 or 10 seconds");
  console.log(JSON.stringify(await (mode === "cancel" ? profileCancellation(seconds, process.argv[5]!, process.argv[6]!) : profile(mode, seconds, process.argv[5]!, process.argv[6]!)), null, 2));
})();
