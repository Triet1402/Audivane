import { randomBytes } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AUDIO_MAX_INPUT_BYTES, type DesktopSource, type PreparedArtifact, type PreparationRequest, type PreparationProgress, type Side, type CanarySide, type ExperimentPlan, type DisplayAnswer, type PlaybackLabel } from "@codec-abx/contracts";
import type { PreparationEngine } from "@codec-abx/preparation";
import type { NativeCodecSource } from "@codec-abx/engine-native/typescript";
import { ExperimentService } from "@codec-abx/experiment";
import { fail, SOURCE_EXTENSION_PATTERN, type Operation } from "./boundary.js";

interface Job { readonly controller: AbortController; readonly completion: Promise<PreparedArtifact>; }
function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError" ||
    error !== null && typeof error === "object" && "code" in error && error.code === "cancelled";
}
export interface RuntimeOptions {
  readonly engine: PreparationEngine<NativeCodecSource>;
  readonly pickSource: () => Promise<string | null>;
  readonly progress: (jobId: string, progress: PreparationProgress) => void;
}
/** Each instance belongs to exactly one renderer lifetime. */
export class DesktopRuntime {
  private readonly sources = new Map<string, string>();
  private readonly artifacts = new Map<string, PreparedArtifact>();
  private readonly pins = new Map<string, number>();
  private readonly jobs = new Map<string, Job>();
  private readonly usedJobs = new Set<string>();
  private readonly releases = new Map<string, Promise<void>>();
  private service: ExperimentService | null = null;
  private bound: string | null = null;
  private generation = 0;
  private closed = false;
  private cleanup: Promise<void> | null = null;
  private capabilityProbe: ReturnType<PreparationEngine<NativeCodecSource>["capabilities"]> | null = null;
  constructor(private readonly options: RuntimeOptions) {}
  private assert(generation = this.generation): void { if (this.closed || generation !== this.generation) fail("disposed", "Desktop operation belongs to a closed renderer"); }
  private experiment(): ExperimentService { this.assert(); if (!this.service) fail("not-configured", "Configure a new experiment explicitly"); return this.service; }
  private pin(id: string, increment: number): void { const count = (this.pins.get(id) ?? 0) + increment; if (count > 0) this.pins.set(id, count); else this.pins.delete(id); }
  async pickSource(): Promise<DesktopSource | null> {
    this.assert(); const generation = this.generation;
    const selected = await this.options.pickSource(); this.assert(generation);
    if (!selected) return null;
    const sourcePath = await fs.realpath(selected); const stat = await fs.stat(sourcePath); this.assert(generation);
    if (!stat.isFile() || !SOURCE_EXTENSION_PATTERN.test(sourcePath) || stat.size <= 0 || stat.size > AUDIO_MAX_INPUT_BYTES) fail("source-invalid", "Select a supported local audio file up to 512 MiB");
    // A bounded source-handle table; selecting a replacement invalidates old handles.
    this.sources.clear(); const id = randomBytes(24).toString("base64url"); this.sources.set(id, sourcePath);
    return { id, name: path.basename(sourcePath), size: stat.size };
  }
  async prepare(sourceId: string, request: PreparationRequest, jobId: string): Promise<PreparedArtifact> {
    this.assert(); const source = this.sources.get(sourceId);
    if (!source) fail("source-invalid", "Select the source through the desktop dialog");
    if (this.jobs.size || this.usedJobs.has(jobId)) fail("job-conflict", "Use a fresh job ID and wait for the active job");
    if (this.artifacts.size >= 4 || this.usedJobs.size >= 4096) fail("resource-limit", "Release prepared artifacts or restart the application");
    const generation = this.generation; const controller = new AbortController(); this.usedJobs.add(jobId);
    // Defer engine invocation so ownership is installed before synchronous callbacks.
    const completion = Promise.resolve().then(() => this.options.engine.prepare({ path: source }, request, { signal: controller.signal, onProgress: progress => {
      if (!this.closed && generation === this.generation && !controller.signal.aborted) this.options.progress(jobId, progress);
    } })).then(async artifact => {
      if (this.closed || generation !== this.generation || controller.signal.aborted) { await this.options.engine.release(artifact.id); fail("cancelled", "Preparation cancelled"); }
      this.artifacts.set(artifact.id, structuredClone(artifact)); return structuredClone(artifact);
    });
    this.jobs.set(jobId, { controller, completion });
    try { return await completion; }
    catch (error) {
      if (controller.signal.aborted && !isCancellation(error)) {
        fail("cleanup-unconfirmed", "Native cancellation cleanup could not be confirmed. Close the app before retrying.");
      }
      throw error;
    } finally { this.jobs.delete(jobId); }
  }
  async cancel(jobId: string): Promise<void> {
    this.assert(); const job = this.jobs.get(jobId); if (!job) return;
    job.controller.abort();
    try { await job.completion; }
    catch (error) {
      if (!isCancellation(error)) fail("cleanup-unconfirmed", "Native cancellation cleanup could not be confirmed. Close the app before retrying.");
    }
  }
  async release(id: string): Promise<void> {
    this.assert(); if (this.pins.has(id)) fail("artifact-in-use", "Close the experiment before releasing its prepared artifact");
    const pending = this.releases.get(id); if (pending) return pending;
    if (!this.artifacts.has(id)) return;
    const release = this.options.engine.release(id).then(() => { this.artifacts.delete(id); })
      .finally(() => { this.releases.delete(id); });
    this.releases.set(id, release);
    return release;
  }
  async bind(id: string) {
    const service = this.experiment(); const generation = this.generation;
    const artifact = this.artifacts.get(id); if (!artifact || this.releases.has(id)) fail("artifact-invalid", "Unknown or released prepared artifact");
    this.pin(id, 1);
    try {
      const result = await service.bindPrepared(artifact, { readAudio: (artifactId, side) => this.options.engine.readAudio(artifactId, side), ...(this.options.engine.readCanaryAudio ? { readCanaryAudio: (artifactId: string, side: CanarySide) => this.options.engine.readCanaryAudio!(artifactId, side) } : {}) });
      this.assert(generation); if (this.service !== service) fail("disposed", "Experiment was closed");
      if (this.bound) this.pin(this.bound, -1); this.bound = id; this.pin(id, 1); return result;
    } finally { this.pin(id, -1); }
  }
  async disposeExperiment(): Promise<void> {
    this.assert(); const previous = this.service; this.service = null;
    const bound = this.bound; this.bound = null;
    try { await previous?.dispose(); } finally { if (bound) this.pin(bound, -1); }
  }
  async invoke(operation: Operation, a: unknown[]): Promise<unknown> {
    this.assert(); const generation = this.generation;
    let result: unknown;
    switch (operation) {
      case "pickSource": return this.pickSource();
      case "capabilities": {
        const probe = this.capabilityProbe ??= this.options.engine.capabilities();
        try { result = await probe; } finally { if (this.capabilityProbe === probe) this.capabilityProbe = null; }
        break;
      }
      case "prepare": return this.prepare(a[0] as string, a[1] as PreparationRequest, a[2] as string);
      case "cancel": return this.cancel(a[0] as string);
      case "release": return this.release(a[0] as string);
      case "readAudio": case "readCanaryAudio": {
        const id = a[0] as string;
        if (!this.artifacts.has(id) || this.releases.has(id)) fail("artifact-invalid", "Unknown or released prepared artifact");
        if (operation === "readAudio") result = await this.options.engine.readAudio(id, a[1] as Side);
        else { if (!this.options.engine.readCanaryAudio) fail("artifact-invalid", "Canary audio unavailable"); result = await this.options.engine.readCanaryAudio(id, a[1] as CanarySide); }
        break;
      }
      case "configure": {
        if (!this.service) this.service = new ExperimentService();
        result = await this.service.configure(a[0] as ExperimentPlan); break;
      }
      case "bindPrepared": return this.bind(a[0] as string);
      case "dispose": return this.disposeExperiment();
      case "snapshot": result = await this.experiment().snapshot(); break;
      case "nextTrial": result = await this.experiment().nextTrial(); break;
      case "answer": result = await this.experiment().answer(a[0] as string, a[1] as DisplayAnswer); break;
      case "trialAudio": result = await this.experiment().readAudio(a[0] as string, a[1] as PlaybackLabel); break;
      case "seal": result = await this.experiment().seal(a[0] as string | undefined); break;
      case "reset": result = await this.experiment().reset(); break;
      case "export": result = await this.experiment().export(); break;
      default: {
        const unhandled: never = operation;
        fail("invalid-request", `Unsupported desktop operation: ${String(unhandled)}`);
      }
    }
    this.assert(generation); return result;
  }
  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true; this.generation++; this.sources.clear();
    for (const job of this.jobs.values()) job.controller.abort();
    const service = this.service; this.service = null; this.bound = null;
    this.cleanup = (async () => {
      // Both cleanup branches must finish, even when one fails.
      const results = await Promise.allSettled([service?.dispose(), this.options.engine.dispose()]);
      await Promise.allSettled([...this.jobs.values()].map(job => job.completion));
      await Promise.allSettled([...this.releases.values()]);
      this.artifacts.clear(); this.pins.clear();
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })(); return this.cleanup;
  }
}
