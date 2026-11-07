import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToRuntime } from "node:timers/promises";

import {
  AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_MAX_RETAINED_BYTES,
  freezeRequest,
  type CanarySide,
  type DeliveredValidityV2,
  type EngineCapabilities,
  type PreparedArtifact,
  type PreparationProgress,
  type PreparationRequest,
  type Side,
} from "@codec-abx/contracts";
import {
  SUPPORTED_SAMPLE_RATES,
  assessPairRelation,
  decodePcm16,
  measurePair,
  type PairMeasurementOptions,
  type PcmAudio,
} from "@codec-abx/measurements";
import {
  PREPARATION_MIN_SECONDS,
  PREPARATION_PROBE_SAMPLES,
  assertPreparationGatePassed,
  evaluateNullGate,
  evaluatePreparationGate,
  preparePair,
} from "@codec-abx/preparation-policy";
import type { PreparationEngine, PrepareOptions } from "@codec-abx/preparation";

import {
  NativeCodecCleanupError,
  NativeCodecExecutor,
  type NativeCodecExecutorOptions,
  type NativeCodecRunResult,
  type NativeCodecSource,
} from "./executor.js";
import type { NativeCodecCapabilities } from "./capabilities.js";
import { NativeProcessCleanupError } from "./process.js";
import {
  buildMeasurementNotes,
  buildNativeSharedCapabilities,
  buildPreparationDisclosures,
  buildRetainedCanary,
  buildTrackProvenance,
  errorMessage,
  NATIVE_SHARED_POLICY,
  type RetainedCanaryMaterial,
} from "./preparation-evidence.js";
import {
  copyArrayBuffer,
  parseCanonicalPcm16Wav,
  type CanonicalPcm16WavFacts,
} from "./preparation-wav.js";

/** Final listening/delivery bounds enforced by this facade. */
export const NATIVE_PREPARATION_MIN_SECONDS = PREPARATION_MIN_SECONDS;
export const NATIVE_PREPARATION_MAX_SECONDS = AUDIO_MAX_DELIVERY_SECONDS;
/** Two full deliveries plus the independently bounded calibration material. */
export const NATIVE_PREPARATION_MAX_RETAINED_BYTES = AUDIO_MAX_RETAINED_BYTES;
export const NATIVE_PREPARATION_POLICY = NATIVE_SHARED_POLICY;

/** Narrow executor surface the facade needs; production uses NativeCodecExecutor. */
export interface NativePreparationExecutor {
  execute(
    source: NativeCodecSource,
    request: PreparationRequest,
    options?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: PreparationProgress) => void },
  ): Promise<NativeCodecRunResult>;
  capabilities(): Promise<NativeCodecCapabilities>;
  dispose(): Promise<void>;
}

export interface TypeScriptNativePreparationEngineOptions
  extends NativeCodecExecutorOptions {
  /**
   * Test-only seam for a decoded-pair executor. Production omits this and the
   * facade owns a real NativeCodecExecutor.
   */
  readonly codecExecutor?: NativePreparationExecutor;
}

interface PreparationJob {
  readonly id: string;
  readonly request: PreparationRequest;
  readonly sourcePath: string;
  readonly signal: AbortSignal | null;
  readonly onProgress: ((progress: PreparationProgress) => void) | null;
  readonly controller: AbortController;
  onExternalAbort: (() => void) | null;
  cancelError: unknown;
  completion: Promise<PreparedArtifact> | null;
}

interface OwnedArtifact {
  readonly a: Uint8Array;
  readonly b: Uint8Array;
  readonly canary: Readonly<Record<CanarySide, Uint8Array>> | null;
}

function abortError(): Error {
  return new DOMException("Preparation aborted", "AbortError");
}

function disposedError(): Error {
  return new Error("TypeScript native preparation engine has been disposed");
}

function isCleanupError(error: unknown): boolean {
  return error instanceof NativeCodecCleanupError ||
    error instanceof NativeProcessCleanupError ||
    (error instanceof Error &&
      (error.name === "NativeCodecCleanupError" || error.name === "NativeProcessCleanupError"));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function copySourcePath(source: NativeCodecSource): string {
  if (!source || typeof source !== "object" || typeof source.path !== "string" ||
      source.path.length === 0) {
    throw new Error("Native source must contain a non-empty local file path");
  }
  return source.path;
}

function requestWithExplicitPolicy(value: PreparationRequest): PreparationRequest {
  return Object.freeze({
    ...value,
    preparationPolicy: NATIVE_SHARED_POLICY,
  });
}

/**
 * Native preparation facade.
 *
 * It owns one bounded job at a time, delegates direct native codec execution to
 * `NativeCodecExecutor`, then applies the shared `aligned-gain-matched-v1`
 * correction exactly once to the final decoded pair. Public provenance and
 * measurements describe the exact canonical PCM16 WAV bytes retained for
 * serving. No external import, interpreter or fallback is present in this graph.
 */
export class TypeScriptNativePreparationEngine implements PreparationEngine<NativeCodecSource> {
  private readonly executor: NativePreparationExecutor;
  private readonly artifacts = new Map<string, OwnedArtifact>();
  private activeJob: PreparationJob | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: TypeScriptNativePreparationEngineOptions = {}) {
    this.executor = options.codecExecutor ?? new NativeCodecExecutor(options);
  }

  async capabilities(): Promise<EngineCapabilities> {
    if (this.disposed) throw disposedError();
    try {
      const probe = await this.executor.capabilities();
      if (this.disposed) throw disposedError();
      return buildNativeSharedCapabilities(probe, null);
    } catch (error: unknown) {
      if (isCleanupError(error) || this.disposed) throw error;
      return buildNativeSharedCapabilities(null, errorMessage(error));
    }
  }

  async prepare(
    source: NativeCodecSource,
    request: PreparationRequest,
    options: PrepareOptions = {},
  ): Promise<PreparedArtifact> {
    if (this.disposed) throw disposedError();
    if (this.activeJob !== null) {
      throw new Error("A TypeScript native preparation is already in progress");
    }
    const externalSignal = options.signal ?? null;
    if (externalSignal?.aborted) throw abortError();

    // Freeze every caller-controlled value before any await or filesystem work.
    const frozen = freezeRequest(request);
    const policy = frozen.preparationPolicy ?? NATIVE_SHARED_POLICY;
    if (policy !== NATIVE_SHARED_POLICY) {
      throw new Error(
        `TypeScript native preparation supports ${NATIVE_SHARED_POLICY} only; ` +
          `policy ${String(policy)} is refused before source reads, probes, workers or subprocesses`,
      );
    }
    const normalized = requestWithExplicitPolicy(frozen);
    // Re-validate the explicit public request copy rather than trusting a spread.
    freezeRequest(normalized);
    const sourcePath = copySourcePath(source);
    const onProgress = options.onProgress ?? null;

    const job: PreparationJob = {
      id: randomBytes(24).toString("base64url"),
      request: normalized,
      sourcePath,
      signal: externalSignal,
      onProgress,
      controller: new AbortController(),
      onExternalAbort: null,
      cancelError: null,
      completion: null,
    };
    if (externalSignal) {
      const onAbort = (): void => {
        this.cancelJob(job, abortError());
      };
      job.onExternalAbort = onAbort;
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
    this.activeJob = job;
    const completion = this.run(job);
    job.completion = completion;
    try {
      return await completion;
    } finally {
      if (job.onExternalAbort && job.signal) {
        job.signal.removeEventListener("abort", job.onExternalAbort);
      }
      if (this.activeJob === job) this.activeJob = null;
    }
  }

  async readAudio(artifactId: string, side: Side): Promise<ArrayBuffer> {
    if (this.disposed) throw new Error("Unknown or released TypeScript native artifact");
    const entry = this.artifacts.get(artifactId);
    if (!entry) throw new Error("Unknown or released TypeScript native artifact");
    if (side !== "a" && side !== "b") throw new Error("Unknown artifact side");
    return copyArrayBuffer(side === "a" ? entry.a : entry.b);
  }

  async readCanaryAudio(artifactId: string, side: CanarySide): Promise<ArrayBuffer> {
    if (this.disposed) throw new Error("Unknown or released TypeScript native artifact");
    const entry = this.artifacts.get(artifactId);
    if (!entry) throw new Error("Unknown or released TypeScript native artifact");
    if (side !== "pristine" && side !== "degraded") throw new Error("Unknown canary side");
    if (!entry.canary) {
      throw new Error("TypeScript native artifact has no retained usable canary material");
    }
    return copyArrayBuffer(entry.canary[side]);
  }

  async release(artifactId: string): Promise<void> {
    if (typeof artifactId !== "string") return;
    this.artifacts.delete(artifactId);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = this.performDispose();
    return this.disposal;
  }

  private async performDispose(): Promise<void> {
    const job = this.activeJob;
    if (job) this.cancelJob(job, disposedError());
    let jobError: unknown = null;
    if (job?.completion) {
      try {
        await job.completion;
      } catch (error: unknown) {
        jobError = error;
      }
    }
    let executorError: unknown = null;
    try {
      await this.executor.dispose();
    } catch (error: unknown) {
      executorError = error;
    }
    this.artifacts.clear();
    // Cleanup failures are never misreported as successful disposal.
    if (executorError !== null) throw executorError;
    if (isCleanupError(jobError)) throw jobError;
  }

  private cancelJob(job: PreparationJob, reason: unknown): void {
    if (job.cancelError === null) job.cancelError = reason;
    if (!job.controller.signal.aborted) job.controller.abort();
  }

  private async checkpoint(job: PreparationJob): Promise<void> {
    await yieldToRuntime();
    if (this.disposed && job.cancelError === null) {
      this.cancelJob(job, disposedError());
    }
    if (job.cancelError !== null) throw job.cancelError;
    if (job.controller.signal.aborted) throw abortError();
  }

  private report(job: PreparationJob, progress: PreparationProgress): void {
    if (job.cancelError !== null) throw job.cancelError;
    if (job.onProgress === null) return;
    try {
      job.onProgress(progress);
    } catch (error: unknown) {
      this.cancelJob(job, error);
      throw error;
    }
    // A callback may abort its own signal without throwing.
    if (job.cancelError !== null) throw job.cancelError;
  }

  private async run(job: PreparationJob): Promise<PreparedArtifact> {
    const startedAt = performance.now();
    try {
      await this.checkpoint(job);

      // The callback is captured before any await; the executor's intermediate
      // "complete" event is not a final facade completion and is suppressed.
      const native = await this.executor.execute(
        { path: job.sourcePath },
        job.request,
        {
          signal: job.controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "complete") return;
            this.report(job, progress);
          },
        },
      );
      await this.checkpoint(job);

      if (!SUPPORTED_SAMPLE_RATES.some((rate) => rate === native.session.sampleRate)) {
        throw new Error(
          `Native session rate ${String(native.session.sampleRate)} is outside the shared 44.1/48/96 kHz domain`,
        );
      }
      const framesA = native.a.pcm.channels[0]?.length ?? 0;
      const framesB = native.b.pcm.channels[0]?.length ?? 0;
      if (framesA <= 0 || framesB <= 0) {
        throw new Error("Native codec pair contains no decoded frames");
      }
      const maxLagSamples = Math.floor(0.1 * native.session.sampleRate);
      if (Math.min(framesA, framesB) >
          NATIVE_PREPARATION_MAX_SECONDS * native.session.sampleRate + maxLagSamples) {
        throw new Error(
          `Native decoded pair cannot fit the ${String(NATIVE_PREPARATION_MAX_SECONDS)} s final ` +
            "listening bound even after the frozen maximum alignment crop; no hidden trim is applied",
        );
      }

      const relationOptions: PairMeasurementOptions = {
        maxLagSamples,
        probeSamples: PREPARATION_PROBE_SAMPLES,
      };
      this.report(job, {
        phase: "measuring",
        message: "Evaluating preparation-validity-v2 on the decoded codec-stage pair before correction",
      });
      await this.checkpoint(job);
      // Preflight relation is measured on the exact decoded final codec-stage
      // pair, before any crop/gain/serialization. A failed gate refuses before
      // v1 preparation and never publishes an artifact.
      const preflightGate = evaluatePreparationGate(
        assessPairRelation(native.a.pcm, native.b.pcm, relationOptions),
      );
      assertPreparationGatePassed(preflightGate);
      await this.checkpoint(job);

      this.report(job, {
        phase: "preparing",
        message: `Applying ${NATIVE_SHARED_POLICY} once to the final decoded native pair`,
      });
      await this.checkpoint(job);

      // Pure synchronous shared DSP. There is no mid-call interrupt claim; the
      // next checkpoint observes abort/dispose after this pass.
      const prepared = preparePair(native.a.pcm, native.b.pcm);
      await this.checkpoint(job);

      const aBytes = prepared.aWav;
      const bBytes = prepared.bWav;
      const aFacts = parseCanonicalPcm16Wav(aBytes);
      const bFacts = parseCanonicalPcm16Wav(bBytes);
      if (aFacts.sampleRate !== native.session.sampleRate ||
          bFacts.sampleRate !== aFacts.sampleRate ||
          aFacts.channels !== native.session.channels ||
          bFacts.channels !== aFacts.channels) {
        throw new Error("Prepared final WAV layout disagrees with the decoded native session");
      }
      if (aFacts.frames !== bFacts.frames ||
          aFacts.frames !== prepared.report.alignment.outputFrames) {
        throw new Error("Prepared final WAV frame counts disagree with the applied report");
      }
      const duration = aFacts.durationSeconds;
      if (duration < NATIVE_PREPARATION_MIN_SECONDS - 1e-12 ||
          duration > NATIVE_PREPARATION_MAX_SECONDS + 1e-12) {
        throw new Error(
          `Prepared final duration ${duration.toFixed(6)} s is outside the ` +
            `${String(NATIVE_PREPARATION_MIN_SECONDS)}–${String(NATIVE_PREPARATION_MAX_SECONDS)} s ` +
            "listening envelope; no hidden trim is applied",
        );
      }
      if (aBytes.byteLength + bBytes.byteLength > NATIVE_PREPARATION_MAX_RETAINED_BYTES) {
        throw new Error(
          `Prepared final WAV pair exceeds the ${String(NATIVE_PREPARATION_MAX_RETAINED_BYTES)} byte retained bound`,
        );
      }
      const aPcm = decodeFinal(aBytes, aFacts);
      const bPcm = decodeFinal(bBytes, bFacts);
      this.report(job, {
        phase: "measuring",
        message: "Measuring the exact final canonical PCM16 delivery and null gate",
      });
      await this.checkpoint(job);

      // Delivery measurement is intentionally recomputed from the parsed final
      // bytes. It is a delivery check, not independent scientific validation.
      const measured = measurePair(aPcm, bPcm, {
        maxLagSamples: prepared.report.alignment.maxLagSamples,
        probeSamples: prepared.report.alignment.probeSamples,
      });
      const delivered = { ...measured, notes: [
        "Measurements describe final serialized PCM16 after aligned-gain-matched-v1 preparation.",
        "Reported lag is residual; applied head/tail crops, independent gains and common sample-peak trim are in the preparation report.",
        "Measurement adds no further correction. It does not establish audibility or certify a listening run.",
      ] };
      await this.checkpoint(job);
      if (delivered.a.frames !== aFacts.frames || delivered.b.frames !== bFacts.frames ||
          delivered.a.sampleRate !== aFacts.sampleRate ||
          delivered.b.sampleRate !== bFacts.sampleRate ||
          delivered.a.channels !== aFacts.channels ||
          delivered.b.channels !== bFacts.channels) {
        throw new Error("Final delivered measurement disagrees with the exact served WAV layout");
      }

      const nativeCapabilities = await this.executor.capabilities();
      await this.checkpoint(job);
      const engine = buildNativeSharedCapabilities(nativeCapabilities, null);

      let canary: RetainedCanaryMaterial | undefined;
      if (job.request.canaryEnabled === true) {
        this.report(job, {
          phase: "preparing",
          message: "Generating diagnostic canary material from the final served Side A",
        });
        await this.checkpoint(job);
        canary = buildRetainedCanary(aPcm, aBytes, aFacts);
        await this.checkpoint(job);
        const retained = aBytes.byteLength + bBytes.byteLength +
          (canary.bytes === null
            ? 0
            : canary.bytes.pristine.byteLength + canary.bytes.degraded.byteLength);
        if (retained > NATIVE_PREPARATION_MAX_RETAINED_BYTES) {
          throw new Error(
            `Pair plus retained canary exceeds the ${String(NATIVE_PREPARATION_MAX_RETAINED_BYTES)} byte bound`,
          );
        }
      }

      // Re-evaluate the frozen preparation gate on the exact final serialized
      // PCM16 pair. A preflight ambiguity disclosure is retained even if the
      // cropped delivery happens to appear uniquely aligned afterwards.
      const finalGate = evaluatePreparationGate(
        assessPairRelation(aPcm, bPcm, relationOptions),
      );
      await this.checkpoint(job);

      const validity: DeliveredValidityV2 = Object.freeze({
        policy: "delivered-validity-v2",
        nullGate: evaluateNullGate(job.request, delivered.nullDepth.depthDb),
        preparationGate: finalGate,
        notes: Object.freeze([
          "Evaluated the frozen identical-pipeline null gate on the exact final delivered " +
            "PCM16 pair. This is a diagnostic delivered-audio check, not experiment authority.",
          `Preparation-validity-v1 preflight on the decoded codec-stage pair classified ` +
            `${preflightGate.classification}; the exact final serialized pair classified ` +
            `${finalGate.classification}. Neither certifies audibility or a valid ABX run.`,
          ...(preflightGate.disclosure === null ? [] : [preflightGate.disclosure]),
          ...(finalGate.disclosure === null ||
              finalGate.disclosure === preflightGate.disclosure
            ? []
            : [finalGate.disclosure]),
        ]),
      });

      const artifact: PreparedArtifact = {
        id: job.id,
        // The normalized request names the policy that actually ran.
        request: job.request,
        engine,
        sourceSha256: native.source.sha256,
        a: buildTrackProvenance(job.request, "a", native.a, aBytes, aFacts),
        b: buildTrackProvenance(job.request, "b", native.b, bBytes, bFacts),
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        measurements: {
          policy: NATIVE_SHARED_POLICY,
          alignmentLagSamples: delivered.alignment.lagSamples,
          alignmentConfidence: delivered.alignment.confidence,
          loudnessDeltaDb:
            delivered.loudnessDeltaDb.status === "finite"
              ? delivered.loudnessDeltaDb.value
              : null,
          nullDepthDb:
            delivered.nullDepth.depthDb.status === "finite"
              ? delivered.nullDepth.depthDb.value
              : null,
          notes: buildMeasurementNotes(delivered, prepared.report),
          delivered,
        },
        preparation: prepared.report,
        validity,
        ...(canary === undefined
          ? {}
          : { canary: { report: canary.report, audio: canary.audio } }),
        disclosures: buildPreparationDisclosures(
          native,
          canary,
          preflightGate,
        ),
        purpose: "diagnostic-only" as const,
      };
      const frozenArtifact = deepFreeze(artifact);

      // A throwing final listener or abort during this yield prevents publication.
      this.report(job, {
        phase: "complete",
        message: "TypeScript native shared preparation complete",
      });
      await this.checkpoint(job);
      if (job.cancelError !== null || this.disposed) {
        throw job.cancelError ?? disposedError();
      }

      this.artifacts.set(frozenArtifact.id, {
        a: aBytes,
        b: bBytes,
        canary: canary?.bytes ?? null,
      });
      return frozenArtifact;
    } catch (error: unknown) {
      if (isCleanupError(error)) throw error;
      if (job.cancelError !== null) throw job.cancelError;
      throw error;
    }
  }
}

function decodeFinal(bytes: Uint8Array, facts: CanonicalPcm16WavFacts): PcmAudio {
  return decodePcm16(bytes, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
}
