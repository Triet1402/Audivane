import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_SOURCE_PADDING_SECONDS,
  AUDIO_MAX_DELIVERY_SECONDS,
  AUDIO_DECODE_SENTINEL_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_WAV_BYTES,
  freezeRequest,
  stagesForSide,
  type CodecId,
  type CodecSelection,
  type PreparationProgress,
  type PreparationRequest,
  type Side,
} from "@codec-abx/contracts";
import { SUPPORTED_SAMPLE_RATES, type PcmAudio } from "@codec-abx/measurements";

import { resolveNativeBinaries, type NativeBinaryOptions } from "./binaries.js";
import {
  probeNativeCodecCapabilities,
  type NativeCodecCapabilities,
} from "./capabilities.js";
import {
  nativeCodecEncodedChannels,
  nativeCodecInternalRate,
  nativeCodecPlan,
  NATIVE_LDAC_DECODER_DISCLOSURE,
  type NativeCodecPlan,
} from "./catalog.js";
import {
  readFloat64PcmChunks,
  pcmDurationSeconds,
  scanPcm,
  serializeFloat64Pcm,
  validatePcmLayout,
  NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE,
  NATIVE_CODEC_MAX_RETAINED_PCM_BYTES,
} from "./pcm.js";
import {
  acceptsProbedCodec,
  acceptsProbedContainer,
  resolveNativeSourceFormat,
  type NativeSourceFormat,
  type NativeSourceFormatId,
} from "./source-format.js";
import {
  NativeProcessCleanupError,
  NativeProcessManager,
  nativeAbortError,
  type NativeProcessObservation,
  type NativeProcessResult,
} from "./process.js";

/** Current local-audio envelope shared with the browser and desktop layers. */
export const NATIVE_CODEC_MAX_SOURCE_BYTES = AUDIO_MAX_INPUT_BYTES;
export const NATIVE_CODEC_MAX_DURATION_SECONDS = AUDIO_MAX_DURATION_SECONDS;
export { NATIVE_CODEC_MAX_RETAINED_PCM_BYTES };
/** Lossy stages are far smaller; this keeps a hard bound before reading one. */
export const NATIVE_CODEC_MAX_ENCODED_BYTES = AUDIO_MAX_INPUT_BYTES;

// Decoding/encoding long material is still bounded, but a cold container or
// slow disk must not be mistaken for a hang. Scale process deadlines with the
// audio envelope instead of retaining a fixed two-minute limit.
const COMMAND_TIMEOUT_MS = 120_000 + NATIVE_CODEC_MAX_DURATION_SECONDS * 2_000;
const PROBE_TIMEOUT_MS = 60_000;
const HELPER_TIMEOUT_MS = COMMAND_TIMEOUT_MS;
const DIAGNOSTIC_CHARS = 2_000;
const LDAC_HEADER_BYTES = 48;

export interface NativeCodecSource {
  /** Local control input only; never copied into public artifacts. */
  readonly path: string;
}

export interface NativeCodecExecutorOptions extends NativeBinaryOptions {
  /** Private temporary root; a new mkdtemp is created inside it per execution. */
  readonly tempRoot?: string;
  /** Runtime-private supervision hook for every directly spawned native process. */
  readonly processObserver?: (event: NativeProcessObservation) => void;
}

export interface NativeCodecExecuteOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PreparationProgress) => void;
}

export type NativeBitrateBasis =
  | "lossless-passthrough"
  | "encoded-container-bytes-over-decoded-stage-duration"
  | "fixed-rate-container-bytes-over-decoded-stage-duration"
  | "ldac-container-bytes-over-header-sample-duration";

export type NativeEncodedRateSource =
  | "bitstream-header"
  | "raw-encode-setting"
  | "ldac-container-header"
  | "lossless-passthrough";

export interface NativeCodecStageResult {
  readonly stageIndex: number;
  readonly requested: CodecSelection;
  readonly codecId: CodecId;
  readonly encoder: string;
  readonly decoder: string;
  readonly encodedSampleRate: number;
  readonly encodedSampleRateSource: NativeEncodedRateSource;
  readonly encodedChannels: 1 | 2;
  readonly actualBitrateKbps: number | null;
  readonly bitrateBasis: NativeBitrateBasis;
  readonly encodedBytes: number | null;
  /** libldac's own reported rate for the LDAC helper container, when present. */
  readonly codecReportedBitrateKbps: number | null;
  readonly inputFrames: number;
  readonly decodedFrames: number;
  /** Decoded duration at the session rate before any facade crop/gain. */
  readonly decodedDurationSeconds: number;
  readonly inputPeak: number;
  readonly inputSamplesOutsideUnitRange: number;
  /** Samples that a PCM16 helper boundary necessarily quantized/clamped. */
  readonly pcm16ClampedSamples: number;
  readonly notes: readonly string[];
}

export interface NativeCodecTrackResult {
  readonly side: Side;
  readonly requested: CodecSelection;
  readonly encoder: string;
  readonly decoder: string;
  readonly encodedSampleRate: number;
  readonly encodedChannels: 1 | 2;
  readonly actualBitrateKbps: number | null;
  readonly stages: readonly NativeCodecStageResult[];
  /** Planar Float64 PCM at the session rate/channels, before facade correction. */
  readonly pcm: PcmAudio;
}

export interface NativeCodecRunResult {
  readonly source: Readonly<{
    /** SHA-256 of the original compressed source bytes, before any decode. */
    readonly sha256: string;
    readonly bytes: number;
    readonly format: NativeSourceFormatId;
    readonly formatLabel: string;
    /** Original ffprobe container name, for example mov,mp4,m4a,3gp,3g2,mj2. */
    readonly container: string;
    /** Original ffprobe codec name, for example aac, mp3, vorbis or pcm_s16le. */
    readonly codec: string;
  }>;
  readonly session: Readonly<{
    readonly sampleRate: number;
    readonly channels: 1 | 2;
    readonly sourceSampleRate: number;
    readonly sourceChannels: 1 | 2;
    readonly sampleRateMode: "native" | "force_48k";
    readonly frames: number;
    readonly durationSeconds: number;
  }>;
  readonly a: NativeCodecTrackResult;
  readonly b: NativeCodecTrackResult;
  readonly disclosures: readonly string[];
  readonly elapsedMs: number;
}

export class NativeCodecCleanupError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "NativeCodecCleanupError";
    this.cause = cause;
  }
}

interface SourceProbe {
  readonly format: NativeSourceFormat;
  readonly container: string;
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly durationSeconds: number | null;
}

interface EncodedProbe {
  readonly sampleRate: number | null;
  readonly channels: 1 | 2 | null;
  readonly codecName: string | null;
}

interface LdacHeader {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly requestedBitrateKbps: number;
  readonly sampleCount: number;
  readonly frameCount: number;
  readonly actualBitrateKbps: number;
}

interface ActiveJob {
  readonly controller: AbortController;
  reason: unknown;
  tempDir: string | null;
  completion: Promise<NativeCodecRunResult> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "" || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function channelCount(value: unknown): 1 | 2 {
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  throw new Error(`Unsupported channel count ${String(value)}; mono or stereo only`);
}

function roundBitrateKbps(bytes: number, seconds: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Cannot measure actual bitrate from empty encoded bytes or duration");
  }
  const kbps = Math.round(((bytes * 8) / seconds / 1000) * 10) / 10;
  if (!Number.isFinite(kbps) || kbps <= 0) {
    throw new Error("Measured actual bitrate is not a finite positive value");
  }
  return kbps;
}

function disposedError(): Error {
  return new Error("Native codec executor has been disposed");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

/**
 * Direct native codec execution for the shared preparation layer.
 *
 * This is an internal boundary: it decodes a bounded local WAV, FLAC, MP3, AAC,
 * M4A/MP4, Ogg or Opus source with an explicit format demuxer, runs ordered
 * native encode/decode stages, and returns planar Float64 PCM plus truthful
 * source/stage provenance. It deliberately does not align, normalize, crop,
 * serialize PCM16, build canaries, score trials or expose source paths.
 */
export class NativeCodecExecutor {
  private readonly runner: NativeProcessManager;
  private readonly resolution: ReturnType<typeof resolveNativeBinaries>;
  private readonly tempRoot: string;

  private activeJob: ActiveJob | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private capabilityCache: NativeCodecCapabilities | null = null;
  private capabilityProbe: Promise<NativeCodecCapabilities> | null = null;
  private capabilityAbort: AbortController | null = null;

  constructor(options: NativeCodecExecutorOptions = {}) {
    this.resolution = resolveNativeBinaries(options);
    this.tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
    this.runner = new NativeProcessManager(options.processObserver, options.windowsProcessHost);
  }

  async capabilities(): Promise<NativeCodecCapabilities> {
    this.assertLive();
    if (this.capabilityCache) return this.capabilityCache;
    if (this.capabilityProbe) return this.capabilityProbe;
    const controller = new AbortController();
    this.capabilityAbort = controller;
    const probe = this.runCapabilityProbe(controller.signal);
    this.capabilityProbe = probe;
    try {
      const capabilities = await probe;
      this.assertLive();
      this.capabilityCache = capabilities;
      return capabilities;
    } finally {
      if (this.capabilityProbe === probe) {
        this.capabilityProbe = null; this.capabilityAbort = null;
      }
    }
  }

  async execute(
    source: NativeCodecSource,
    request: PreparationRequest,
    options: NativeCodecExecuteOptions = {},
  ): Promise<NativeCodecRunResult> {
    this.assertLive();
    if (this.activeJob) throw new Error("A native codec execution is already in progress");
    if (!source || typeof source.path !== "string" || source.path.length === 0) {
      throw new Error("Native codec source must contain a local file path");
    }
    const frozen = freezeRequest(request);
    if (options.signal?.aborted) throw nativeAbortError();

    const job: ActiveJob = {
      controller: new AbortController(),
      reason: null,
      tempDir: null,
      completion: null,
    };
    const onExternalAbort = (): void => this.cancelJob(job, nativeAbortError());
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    this.activeJob = job;
    const completion = this.run(job, path.resolve(source.path), frozen, options);
    job.completion = completion;
    try {
      return await completion;
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (this.activeJob === job) this.activeJob = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const job = this.activeJob;
    if (job) this.cancelJob(job, disposedError());
    this.capabilityAbort?.abort();
    const runnerDisposal = this.runner.dispose();
    const probe = this.capabilityProbe;
    this.disposal = (async () => {
      const results = await Promise.allSettled([
        job?.completion ?? Promise.resolve(),
        probe ?? Promise.resolve(),
        runnerDisposal,
      ]);
      this.capabilityCache = null;
      const failedCleanup = results.find(result => result.status === "rejected" &&
        (result.reason instanceof NativeCodecCleanupError || result.reason instanceof NativeProcessCleanupError));
      if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
    })();
    return this.disposal;
  }

  private assertLive(): void {
    if (this.disposed) throw disposedError();
  }

  private cancelJob(job: ActiveJob, reason: unknown): void {
    if (job.reason === null) job.reason = reason;
    job.controller.abort();
  }

  private throwIfCancelled(job: ActiveJob): void {
    if (job.reason !== null) throw job.reason;
    if (job.controller.signal.aborted) throw nativeAbortError();
  }

  private report(
    job: ActiveJob,
    options: NativeCodecExecuteOptions,
    progress: PreparationProgress,
  ): void {
    if (options.onProgress) {
      try {
        options.onProgress(progress);
      } catch (error: unknown) {
        this.cancelJob(job, error);
        throw error;
      }
    }
    this.throwIfCancelled(job);
  }

  private async runCapabilityProbe(signal: AbortSignal | undefined): Promise<NativeCodecCapabilities> {
    return probeNativeCodecCapabilities(
      this.runner,
      this.resolution,
      signal,
    );
  }

  private async getCapabilities(signal: AbortSignal): Promise<NativeCodecCapabilities> {
    if (this.capabilityCache) return this.capabilityCache;
    if (signal.aborted) throw nativeAbortError();
    // Cancelling a job that shares a still-running discovery cancels that
    // discovery for all waiters. No waiter reports success before cleanup.
    // Register before starting probes: the spawn observer may synchronously
    // signal a fatal ownership failure during the first process registration.
    const abort = () => this.capabilityAbort?.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { return await this.capabilities(); }
    finally { signal.removeEventListener("abort", abort); }
  }

  private requireCodecs(
    request: PreparationRequest,
    capabilities: NativeCodecCapabilities,
  ): void {
    const selections = [
      ...stagesForSide(request, "a"),
      ...stagesForSide(request, "b"),
    ];
    for (const selection of selections) {
      const capability = capabilities.codecs.find((entry) => entry.codecId === selection.codecId);
      if (!capability || capability.availability !== "available") {
        throw new Error(
          `Requested codec '${selection.codecId}' is unavailable: ` +
            (capability?.reason ?? "capability probe did not report this codec"),
        );
      }
    }
  }

  private async run(
    job: ActiveJob,
    sourcePath: string,
    request: PreparationRequest,
    options: NativeCodecExecuteOptions,
  ): Promise<NativeCodecRunResult> {
    const startedAt = performance.now();
    let primaryError: unknown = null;
    try {
      const result = await this.runCore(job, sourcePath, request, options, startedAt);
      return result;
    } catch (error: unknown) {
      primaryError = error;
      throw error;
    } finally {
      const tempDir = job.tempDir;
      job.tempDir = null;
      if (tempDir !== null) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanup: unknown) {
          const code = errorCode(cleanup);
          throw new NativeCodecCleanupError(
            "Native codec execution could not remove its private temporary directory" +
              (code ? ` (${code})` : ""),
            primaryError ?? cleanup,
          );
        }
      }
    }
  }

  private async runCore(
    job: ActiveJob,
    sourcePath: string,
    request: PreparationRequest,
    options: NativeCodecExecuteOptions,
    startedAt: number,
  ): Promise<NativeCodecRunResult> {
    const format = resolveNativeSourceFormat(sourcePath);
    if (format === null) {
      throw new Error(
        "Native codec source must be a supported local WAV, FLAC, MP3, AAC, M4A/MP4, " +
          "Ogg or Opus file",
      );
    }
    const extension = path.extname(sourcePath).toLowerCase();

    let stat;
    try {
      stat = await fs.stat(sourcePath);
    } catch {
      throw new Error("Native codec source file is not readable");
    }
    if (!stat.isFile()) throw new Error("Native codec source is not a regular file");
    if (stat.size <= 0) throw new Error("Native codec source is empty");
    if (stat.size > NATIVE_CODEC_MAX_SOURCE_BYTES) {
      throw new Error(
        `Native codec source exceeds the ${String(NATIVE_CODEC_MAX_SOURCE_BYTES)} byte bound`,
      );
    }
    this.throwIfCancelled(job);

    const capabilities = await this.getCapabilities(job.controller.signal);
    this.throwIfCancelled(job);
    this.requireCodecs(request, capabilities);

    let sourceBytes: Buffer;
    try {
      // A file can grow after stat. Read at most bound+1 bytes so rejection
      // does not first allocate an arbitrarily large replacement source.
      const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        // The pathname may have changed during discovery. Validate the opened
        // inode; O_NONBLOCK prevents a replacement FIFO from hanging open().
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size <= 0 || opened.size > NATIVE_CODEC_MAX_SOURCE_BYTES) {
          throw new Error("The opened source is not a bounded nonempty regular file");
        }
        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= NATIVE_CODEC_MAX_SOURCE_BYTES) {
          this.throwIfCancelled(job);
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, NATIVE_CODEC_MAX_SOURCE_BYTES + 1 - total));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
        }
        sourceBytes = Buffer.concat(chunks, total);
      } finally { await handle.close(); }
    } catch {
      this.throwIfCancelled(job);
      throw new Error("Native codec source file is not readable");
    }
    if (sourceBytes.byteLength > NATIVE_CODEC_MAX_SOURCE_BYTES) {
      throw new Error(
        `Native codec source exceeds the ${String(NATIVE_CODEC_MAX_SOURCE_BYTES)} byte bound`,
      );
    }
    this.throwIfCancelled(job);

    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    try {
      await fs.mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    } catch {
      throw new Error("Unable to create the private native codec temporary root");
    }
    let tempDir: string;
    try {
      tempDir = await fs.mkdtemp(path.join(this.tempRoot, "codec-abx-codecs-"));
    } catch {
      throw new Error("Unable to create a private native codec workspace");
    }
    job.tempDir = tempDir;
    this.throwIfCancelled(job);

    const snapshotPath = path.join(tempDir, `source${extension}`);
    let snapshotBytes: Buffer;
    try {
      await fs.writeFile(snapshotPath, sourceBytes, { flag: "wx", mode: 0o600 });
      snapshotBytes = await fs.readFile(snapshotPath);
    } catch {
      throw new Error("Unable to write or read the private source snapshot");
    }
    const snapshotSha256 = createHash("sha256").update(snapshotBytes).digest("hex");
    if (snapshotSha256 !== sourceSha256) {
      throw new Error("Private source snapshot bytes disagree with the selected source");
    }
    this.throwIfCancelled(job);

    this.report(job, options, {
      phase: "loading",
      message: "Source bytes privately snapshotted and hashed",
    });

    const sensitivePaths = [sourcePath, snapshotPath, tempDir];
    const probe = await this.probeSource(job, format, snapshotPath, sensitivePaths);
    this.throwIfCancelled(job);

    const sourceRate = probe.sampleRate;
    const targetRate = request.sampleRateMode === "force_48k" ? 48_000 : sourceRate;
    if (!SUPPORTED_SAMPLE_RATES.some((rate) => rate === targetRate)) {
      throw new Error(
        `Session rate ${String(targetRate)} is outside the supported 44.1/48/96 kHz domain; ` +
          "use force_48k or select a supported source rate",
      );
    }

    this.report(job, options, {
      phase: "probing",
      message: `Decoding source to ${String(targetRate)} Hz/${String(probe.channels)} channel Float64 PCM`,
    });
    const sourcePcm = await this.decodeSource(
      job,
      format,
      snapshotPath,
      tempDir,
      targetRate,
      probe.channels,
      sensitivePaths,
    );
    this.throwIfCancelled(job);

    const sideA = await this.runSide(job, "a", request, sourcePcm, targetRate, probe.channels, tempDir, sensitivePaths, options);
    this.throwIfCancelled(job);
    const sideB = await this.runSide(job, "b", request, sourcePcm, targetRate, probe.channels, tempDir, sensitivePaths, options);
    this.throwIfCancelled(job);

    const finalBytes = (sideA.pcm.channels[0]?.length ?? 0) * probe.channels * 8 +
      (sideB.pcm.channels[0]?.length ?? 0) * probe.channels * 8;
    if (finalBytes > NATIVE_CODEC_MAX_RETAINED_PCM_BYTES) {
      throw new Error(
        `Final decoded PCM (${String(finalBytes)} bytes) exceeds the ` +
          `${String(NATIVE_CODEC_MAX_RETAINED_PCM_BYTES)} byte retained bound`,
      );
    }

    const disclosures = this.buildDisclosures(probe, targetRate, sideA, sideB);
    disclosures.push(
      `Input-probe duration ${probe.durationSeconds === null ? "unavailable" : `${probe.durationSeconds.toFixed(6)} s`} ` +
      `is descriptive only; decoded source frames establish ${pcmDurationSeconds(sourcePcm).toFixed(6)} s. ` +
      `The ${String(NATIVE_CODEC_MAX_DURATION_SECONDS)} s source ceiling allows at most ` +
      `${String(AUDIO_MAX_SOURCE_PADDING_SECONDS)} s end padding; final delivery allows ` +
      `${String(AUDIO_MAX_DELIVERY_SECONDS - NATIVE_CODEC_MAX_DURATION_SECONDS)} s. ` +
      "These are refusal budgets, not crop windows or proof that extra samples are silence.",
    );
    this.report(job, options, {
      phase: "complete",
      message: "Native codec execution complete; no alignment, gain, trim or serialization applied",
    });

    return Object.freeze({
      source: Object.freeze({
        // Original compressed bytes are hashed before decoding; the hash never
        // describes an intermediate or decoded representation.
        sha256: sourceSha256,
        bytes: sourceBytes.byteLength,
        format: probe.format.id,
        formatLabel: probe.format.label,
        container: probe.container,
        codec: probe.codec,
      }),
      session: Object.freeze({
        sampleRate: targetRate,
        channels: probe.channels,
        sourceSampleRate: sourceRate,
        sourceChannels: probe.channels,
        sampleRateMode: request.sampleRateMode,
        frames: sourcePcm.channels[0]?.length ?? 0,
        durationSeconds: pcmDurationSeconds(sourcePcm),
      }),
      a: sideA,
      b: sideB,
      disclosures: Object.freeze(disclosures),
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  }

  private buildDisclosures(
    probe: SourceProbe,
    targetRate: number,
    sideA: NativeCodecTrackResult,
    sideB: NativeCodecTrackResult,
  ): string[] {
    const allStages = [...sideA.stages, ...sideB.stages];
    const originalCodec =
      `${probe.format.label} container ${probe.container}, codec ${probe.codec}, ` +
      `${String(probe.sampleRate)} Hz, ${String(probe.channels)} channel(s)`;
    const conversion = probe.sampleRate === targetRate
      ? `decoded explicitly with the ${probe.format.demuxer} demuxer`
      : `explicitly decoded and converted from ${String(probe.sampleRate)} Hz to ` +
        `${String(targetRate)} Hz with the ${probe.format.demuxer} demuxer`;
    const disclosures = new Set<string>([
      `Original source: ${originalCodec}; ${conversion} to Float64 PCM. The published ` +
        "source SHA-256 and byte count describe the original compressed bytes, not decoded audio.",
      "Codec execution was performed by direct native FFmpeg/ffprobe/helper processes; " +
        "no external interpreter, module, bridge or fallback was used.",
      "Only allowlisted local containers and explicit format demuxers are accepted; " +
        "playlists and network protocols are refused rather than autodetected.",
      "The requested bitrate is retained rather than substituted. Actual bitrate is measured from " +
        "the encoded container/header and its own pre-crop decoded stage duration; container " +
        "overhead and codec padding are included, and each stage records its measurement basis.",
      "Decoded codec-stage PCM is planar Float64 and is not clipped by the executor. Codec encoders " +
        "may quantize or clamp their own input; out-of-unit-range input samples are counted per stage.",
      "No hidden trim, padding, alignment, gain matching, PCM16 serialization, canary or scoring " +
        "is applied here. Codec padding may change frame count; a facade must enforce the final " +
        `0.4–${String(AUDIO_MAX_DELIVERY_SECONDS)} s listening bound including codec padding explicitly. ` +
        "Material beyond the bound is refused, never silently cropped.",
      "Native and WASM codec builds/outputs are not claimed equivalent.",
    ]);
    for (const stage of allStages) for (const note of stage.notes) disclosures.add(note);
    if (allStages.some((stage) => stage.codecId === "ldac")) {
      disclosures.add(NATIVE_LDAC_DECODER_DISCLOSURE);
    }
    return [...disclosures];
  }

  private async probeSource(
    job: ActiveJob,
    format: NativeSourceFormat,
    snapshotPath: string,
    sensitivePaths: readonly string[],
  ): Promise<SourceProbe> {
    const ffprobe = this.resolution.ffprobePath;
    if (ffprobe === null) throw new Error("ffprobe executable is unavailable");
    const result = await this.runOwned(job, [
      ffprobe,
      // Local files only; the demuxer is selected explicitly from the allowlist.
      "-protocol_whitelist", "file,pipe",
      "-f", format.demuxer,
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries",
      "stream=codec_type,codec_name,sample_rate,channels,duration:format=format_name,duration",
      "-of", "json",
      snapshotPath,
    ], "Source probe", PROBE_TIMEOUT_MS);
    if (result.code !== 0) {
      throw this.commandFailure("Source probe", result, sensitivePaths);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Source probe returned malformed JSON");
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.streams) || parsed.streams.length === 0) {
      throw new Error("Source contains no decodable audio stream");
    }
    const stream = parsed.streams[0];
    if (!isRecord(stream) || stream.codec_type !== "audio") {
      throw new Error("Source does not contain an audio stream");
    }
    const container = isRecord(parsed.format) && typeof parsed.format.format_name === "string"
      ? parsed.format.format_name.toLowerCase()
      : "";
    if (container.length === 0 || !acceptsProbedContainer(format, container)) {
      throw new Error(
        `Source container ${container || "<unknown>"} does not match the selected ` +
          `${format.label} extension and is not supported`,
      );
    }
    const codec = typeof stream.codec_name === "string"
      ? stream.codec_name.toLowerCase()
      : "";
    if (codec.length === 0 || !acceptsProbedCodec(format, codec)) {
      throw new Error(
        `Source codec ${codec || "<unknown>"} is not accepted for ${format.label}`,
      );
    }
    const sampleRate = finitePositive(parseNumber(stream.sample_rate));
    if (sampleRate === null || !Number.isInteger(sampleRate)) {
      throw new Error("Source probe did not establish a usable sample rate");
    }
    const channels = channelCount(stream.channels);
    const duration = parseNumber(stream.duration) ??
      (isRecord(parsed.format) ? parseNumber(parsed.format.duration) : null);
    // Container durations (especially ADTS AAC) can be estimates. The bounded
    // decode and its exact frame count decide whether the source fits.
    return { format, container, codec, sampleRate, channels, durationSeconds: duration };
  }

  private async decodeSource(
    job: ActiveJob,
    format: NativeSourceFormat,
    snapshotPath: string,
    tempDir: string,
    sampleRate: number,
    channels: 1 | 2,
    sensitivePaths: readonly string[],
  ): Promise<PcmAudio> {
    const output = path.join(tempDir, "source_decoded.f64");
    await this.ffmpeg(job, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-y",
      // Explicit demuxer: `.m4a` uses `mov`, `.opus` uses `ogg`, and a playlist
      // or network container can never be selected by content autodetection.
      "-f", format.demuxer,
      "-i", snapshotPath,
      "-map", "0:a:0", "-vn",
      "-ar", String(sampleRate), "-ac", String(channels),
      "-c:a", "pcm_f64le", "-f", "f64le",
      output,
    ], "Source decode", sensitivePaths);
    const pcm = await this.readPcmFile(job, output, sampleRate, channels, "Source decode", sensitivePaths);
    await fs.rm(output, { force: true }).catch(() => undefined);
    const duration = pcmDurationSeconds(pcm);
    if (duration > NATIVE_CODEC_MAX_DURATION_SECONDS + AUDIO_MAX_SOURCE_PADDING_SECONDS + 1e-9) {
      throw new Error(
        `Decoded source duration ${duration.toFixed(6)} s exceeds the ` +
          `${String(NATIVE_CODEC_MAX_DURATION_SECONDS)} s bound plus ${String(AUDIO_MAX_SOURCE_PADDING_SECONDS)} s end padding`,
      );
    }
    return pcm;
  }

  private async runSide(
    job: ActiveJob,
    side: Side,
    request: PreparationRequest,
    input: PcmAudio,
    targetRate: number,
    sessionChannels: 1 | 2,
    tempDir: string,
    sensitivePaths: readonly string[],
    options: NativeCodecExecuteOptions,
  ): Promise<NativeCodecTrackResult> {
    const selections = stagesForSide(request, side);
    if (selections.length < 1 || selections.length > 4) {
      throw new Error("Each pipeline requires one through four stages");
    }
    let current = input;
    const stages: NativeCodecStageResult[] = [];

    for (const [index, selection] of selections.entries()) {
      this.throwIfCancelled(job);
      const stageIndex = index + 1;
      const plan = nativeCodecPlan(selection.codecId);
      const label = `Side ${side.toUpperCase()} stage ${String(stageIndex)} ${selection.codecId}`;
      this.report(job, options, {
        phase: "encoding",
        message: `${label}: ${plan.kind === "noop"
          ? "Float64 passthrough"
          : `encoding with ${plan.encoder}`}`,
      });

      const scan = scanPcm(current, label);
      const inputFrames = current.channels[0]?.length ?? 0;
      const internalRate = nativeCodecInternalRate(selection.codecId, targetRate);
      const encodedChannels = nativeCodecEncodedChannels(selection.codecId, sessionChannels);

      if (plan.kind === "noop") {
        const duration = pcmDurationSeconds(current);
        const stage: NativeCodecStageResult = Object.freeze({
          stageIndex,
          requested: selection,
          codecId: selection.codecId,
          encoder: plan.encoder,
          decoder: plan.decoder,
          encodedSampleRate: targetRate,
          encodedSampleRateSource: "lossless-passthrough",
          encodedChannels: sessionChannels,
          actualBitrateKbps: null,
          bitrateBasis: "lossless-passthrough",
          encodedBytes: null,
          codecReportedBitrateKbps: null,
          inputFrames,
          decodedFrames: inputFrames,
          decodedDurationSeconds: duration,
          inputPeak: scan.peak,
          inputSamplesOutsideUnitRange: scan.samplesOutsideUnitRange,
          pcm16ClampedSamples: 0,
          notes: Object.freeze([
            `${label}: exact Float64 passthrough; no codec, container, resample or trim.`,
          ]),
        });
        stages.push(stage);
        this.report(job, options, {
          phase: "measuring",
          message: `${label}: passthrough layout unchanged`,
        });
        continue;
      }

      const inputPath = path.join(tempDir, `side_${side}_stage_${String(stageIndex)}_in.f64`);
      const encodedPath = path.join(tempDir, `side_${side}_stage_${String(stageIndex)}.${plan.extension}`);
      const decodedPath = path.join(tempDir, `side_${side}_stage_${String(stageIndex)}_decoded.f64`);
      let helperPcmIn: string | null = null;
      let helperPcmOut: string | null = null;

      try {
        try {
          await fs.writeFile(inputPath, serializeFloat64Pcm(current, label), {
            flag: "wx",
            mode: 0o600,
          });
        } catch {
          throw new Error(`${label} could not write its private Float64 stage input`);
        }
        this.throwIfCancelled(job);

        let encodedBytes: number;
        let encodedSampleRate: number;
        let encodedRateSource: NativeEncodedRateSource;
        let codecReportedBitrateKbps: number | null = null;
        let bitrateBasis: NativeBitrateBasis =
          "encoded-container-bytes-over-decoded-stage-duration";
        let pcm16ClampedSamples = 0;
        let headerDurationSeconds: number | null = null;
        let actualEncodedChannels = encodedChannels;

        if (plan.kind === "ldac-helper") {
          const helper = this.resolution.ldacHelperPath;
          if (helper === null) throw new Error("LDAC helper executable is unavailable");
          helperPcmIn = path.join(tempDir, `side_${side}_stage_${String(stageIndex)}_helper_in.pcm`);
          helperPcmOut = path.join(tempDir, `side_${side}_stage_${String(stageIndex)}_helper_out.pcm`);
          pcm16ClampedSamples = scan.samplesOutsideUnitRange;
          await this.ffmpeg(job, [
            "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "f64le", "-ar", String(targetRate), "-ac", String(sessionChannels),
            "-i", inputPath,
            "-vn",
            "-ar", String(internalRate), "-ac", String(encodedChannels),
            "-c:a", "pcm_s16le", "-f", "s16le",
            helperPcmIn,
          ], `${label} helper PCM conversion`, sensitivePaths);
          const helperInputBytes = await this.fileSize(
            helperPcmIn, `${label} helper PCM input`, sensitivePaths,
          );
          if (helperInputBytes > AUDIO_MAX_WAV_BYTES - 44) {
            throw new Error(`${label} helper PCM input exceeds the bounded file size`);
          }
          await this.runHelper(job, helper, [
            "encode",
            "--rate", String(internalRate),
            "--channels", String(encodedChannels),
            "--bitrate", String(selection.bitrateKbps),
            "--in", helperPcmIn,
            "--out", encodedPath,
          ], `${label} LDAC encode`, sensitivePaths);
          const header = await this.readLdacHeader(
            encodedPath, internalRate, encodedChannels, selection.bitrateKbps, sensitivePaths,
          );
          await this.runHelper(job, helper, [
            "decode",
            "--rate", String(internalRate),
            "--channels", String(encodedChannels),
            "--bitrate", String(selection.bitrateKbps),
            "--in", encodedPath,
            "--out", helperPcmOut,
          ], `${label} LDAC decode`, sensitivePaths);
          const helperOutputBytes = await this.fileSize(
            helperPcmOut, `${label} helper PCM output`, sensitivePaths,
          );
          if (helperOutputBytes > AUDIO_MAX_WAV_BYTES - 44) {
            throw new Error(`${label} helper PCM output exceeds the bounded file size`);
          }
          const expectedHelperBytes = header.sampleCount * header.channels * 2;
          if (!Number.isSafeInteger(expectedHelperBytes) || helperOutputBytes !== expectedHelperBytes) {
            throw new Error(
              `${label} helper decoded PCM length disagrees with its header sample count ` +
                `(${String(helperOutputBytes)} vs ${String(expectedHelperBytes)} bytes)`,
            );
          }
          encodedBytes = await this.encodedFileSize(encodedPath, `${label} encoded container`, sensitivePaths);
          encodedSampleRate = header.sampleRate;
          encodedRateSource = "ldac-container-header";
          codecReportedBitrateKbps = header.actualBitrateKbps;
          actualEncodedChannels = header.channels;
          bitrateBasis = "ldac-container-bytes-over-header-sample-duration";
          headerDurationSeconds = header.sampleCount / header.sampleRate;
          if (!(headerDurationSeconds > 0)) {
            throw new Error(`${label} LDAC header has no usable sample duration`);
          }
          await this.ffmpeg(job, [
            "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "s16le", "-ar", String(header.sampleRate), "-ac", String(header.channels),
            "-i", helperPcmOut,
            "-vn",
            "-ar", String(targetRate), "-ac", String(sessionChannels),
            "-c:a", "pcm_f64le", "-f", "f64le",
            decodedPath,
          ], `${label} LDAC decode rate restore`, sensitivePaths);
        } else {
          const muxer = plan.muxer;
          if (muxer === null) throw new Error(`${label} has no native container muxer`);
          await this.ffmpeg(job, [
            "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "f64le", "-ar", String(targetRate), "-ac", String(sessionChannels),
            "-i", inputPath,
            "-vn",
            "-ar", String(internalRate), "-ac", String(encodedChannels),
            "-c:a", plan.encoder,
            "-b:a", `${String(selection.bitrateKbps)}k`,
            ...plan.extraEncodeArgs,
            "-f", muxer,
            encodedPath,
          ], `${label} encode`, sensitivePaths);
          encodedBytes = await this.encodedFileSize(encodedPath, `${label} encoded container`, sensitivePaths);
          const encodedProbe = await this.probeEncoded(
            job,
            encodedPath,
            plan,
            sensitivePaths,
          );
          encodedSampleRate = encodedProbe?.sampleRate ?? internalRate;
          encodedRateSource = encodedProbe?.sampleRate === null ||
            encodedProbe === null
            ? "raw-encode-setting"
            : "bitstream-header";
          actualEncodedChannels = encodedProbe?.channels ?? encodedChannels;
          if (encodedSampleRate !== internalRate) {
            // Truthful, not silenced: the probed bitstream rate is reported and
            // the explicit decode output rate still restores the session rate.
            encodedRateSource = "bitstream-header";
          }
          const demuxer = plan.demuxer;
          await this.ffmpeg(job, [
            "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            ...(demuxer === null ? [] : ["-f", demuxer]),
            "-c:a", plan.decoder,
            "-i", encodedPath,
            "-vn",
            "-ar", String(targetRate), "-ac", String(sessionChannels),
            "-c:a", "pcm_f64le", "-f", "f64le",
            decodedPath,
          ], `${label} decode`, sensitivePaths);
          if (plan.fixedRate) {
            bitrateBasis = "fixed-rate-container-bytes-over-decoded-stage-duration";
          }
        }

        const decoded = await this.readPcmFile(
          job, decodedPath, targetRate, sessionChannels, `${label} decode`, sensitivePaths,
        );
        const decodedFrames = decoded.channels[0]?.length ?? 0;
        const decodedDurationSeconds = pcmDurationSeconds(decoded);
        if (!(decodedDurationSeconds > 0)) {
          throw new Error(`${label} produced no decodable audio duration`);
        }
        if (decodedDurationSeconds > AUDIO_MAX_DELIVERY_SECONDS + 1e-9) {
          throw new Error(
            `${label} decoded duration ${decodedDurationSeconds.toFixed(6)} s exceeds the ` +
              `${String(AUDIO_MAX_DELIVERY_SECONDS)} s bound including codec padding; no hidden trim is applied`,
          );
        }
        const bitrateDuration = headerDurationSeconds ?? decodedDurationSeconds;
        const actualBitrateKbps = roundBitrateKbps(encodedBytes, bitrateDuration);
        const notes: string[] = [
          `${label}: ${String(inputFrames)} input session frames; ${String(decodedFrames)} decoded ` +
            `session frames (${String(decodedFrames - inputFrames)} frame change from codec round trip). ` +
            "No codec-stage trim or PCM padding was applied.",
          `${label}: requested ${String(selection.bitrateKbps)} kbps retained; actual ` +
            `${String(actualBitrateKbps)} kbps measured from ${String(encodedBytes)} encoded bytes ` +
            `over ${bitrateDuration.toFixed(6)} s (${bitrateBasis}).`,
        ];
        if (internalRate !== targetRate) {
          notes.push(
            `${label}: encoded at internal ${String(internalRate)} Hz for a ` +
              `${String(targetRate)} Hz session; decode explicitly restored ${String(targetRate)} Hz.`,
          );
        }
        if (encodedChannels !== sessionChannels) {
          notes.push(
            `${label}: ${plan.encoder} accepts stereo only, so this mono session was carried as ` +
              "dual-mono inside the codec and restored to one channel after decode. " +
              "This layout adaptation is disclosed, not a codec substitution.",
          );
        }
        if (plan.fixedRate) {
          notes.push(
            `${label}: ${plan.encoder} is fixed-rate; requested ` +
              `${String(selection.bitrateKbps)} kbps is nominal.`,
          );
        }
        if (selection.codecId === "mp2") {
          notes.push(
            `${label}: MP2 used the real ${plan.encoder} encoder, not FFmpeg's built-in mp2 encoder.`,
          );
        }
        if (selection.codecId === "lc3") {
          notes.push(
            `${label}: LC3 used liblc3 at an explicit ${String(internalRate)} Hz / 10 ms ` +
              "configuration; the raw format has no rate header, so encoded rate is the explicit setting.",
          );
        }
        if (selection.codecId === "ldac") {
          notes.push(
            `${label}: LDAC helper container reported ${String(codecReportedBitrateKbps)} kbps; ` +
              `actual bitrate was recomputed from container bytes over the header's ` +
              `${bitrateDuration.toFixed(6)} s sample duration. ${NATIVE_LDAC_DECODER_DISCLOSURE}`,
          );
        }
        if (pcm16ClampedSamples > 0) {
          notes.push(
            `${label}: ${String(pcm16ClampedSamples)} input samples were outside [-1, 1] before the ` +
              "LDAC helper's required PCM16 boundary; that quantization/clamp is disclosed.",
          );
        }
        if (scan.samplesOutsideUnitRange > 0) {
          notes.push(
            `${label}: ${String(scan.samplesOutsideUnitRange)} encoder-input Float64 samples were ` +
              "outside [-1, 1]; the encoder's own conversion may clamp them.",
          );
        }

        const stage: NativeCodecStageResult = Object.freeze({
          stageIndex,
          requested: selection,
          codecId: selection.codecId,
          encoder: plan.encoder,
          decoder: plan.decoder,
          encodedSampleRate,
          encodedSampleRateSource: encodedRateSource,
          encodedChannels: actualEncodedChannels,
          actualBitrateKbps,
          bitrateBasis,
          encodedBytes,
          codecReportedBitrateKbps,
          inputFrames,
          decodedFrames,
          decodedDurationSeconds,
          inputPeak: scan.peak,
          inputSamplesOutsideUnitRange: scan.samplesOutsideUnitRange,
          pcm16ClampedSamples,
          notes: Object.freeze(notes),
        });
        stages.push(stage);
        current = decoded;
        this.report(job, options, {
          phase: "measuring",
          message: `${label}: decoded ${String(decodedFrames)} frames, ${String(actualBitrateKbps)} kbps actual`,
        });
      } finally {
        await Promise.all([
          fs.rm(inputPath, { force: true }).catch(() => undefined),
          fs.rm(encodedPath, { force: true }).catch(() => undefined),
          fs.rm(decodedPath, { force: true }).catch(() => undefined),
          ...(helperPcmIn === null ? [] : [fs.rm(helperPcmIn, { force: true }).catch(() => undefined)]),
          ...(helperPcmOut === null ? [] : [fs.rm(helperPcmOut, { force: true }).catch(() => undefined)]),
        ]);
      }
    }

    validatePcmLayout(current, targetRate, sessionChannels, `Side ${side.toUpperCase()}`);
    const finalStage = stages[stages.length - 1];
    if (!finalStage) throw new Error("Codec pipeline contains no stages");
    return Object.freeze({
      side,
      requested: finalStage.requested,
      encoder: finalStage.encoder,
      decoder: finalStage.decoder,
      encodedSampleRate: finalStage.encodedSampleRate,
      encodedChannels: finalStage.encodedChannels,
      actualBitrateKbps: finalStage.actualBitrateKbps,
      stages: Object.freeze(stages),
      pcm: current,
    });
  }

  private async probeEncoded(
    job: ActiveJob,
    encodedPath: string,
    plan: NativeCodecPlan,
    sensitivePaths: readonly string[],
  ): Promise<EncodedProbe | null> {
    if (!plan.bitstreamRate) return null;
    const ffprobe = this.resolution.ffprobePath;
    if (ffprobe === null) throw new Error("ffprobe executable is unavailable");
    const result = await this.runOwned(job, [
      ffprobe,
      "-protocol_whitelist", "file,pipe",
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate,channels,codec_name",
      "-of", "json",
      ...(plan.demuxer === null ? [] : ["-f", plan.demuxer]),
      encodedPath,
    ], `Encoded probe ${plan.codecId}`, PROBE_TIMEOUT_MS);
    if (result.code !== 0) {
      throw this.commandFailure(`Encoded probe ${plan.codecId}`, result, sensitivePaths);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Encoded probe ${plan.codecId} returned malformed JSON`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.streams) || parsed.streams.length === 0) {
      throw new Error(`Encoded probe ${plan.codecId} found no audio stream`);
    }
    const stream = parsed.streams[0];
    if (!isRecord(stream)) throw new Error(`Encoded probe ${plan.codecId} returned invalid stream data`);
    const rate = finitePositive(parseNumber(stream.sample_rate));
    let channels: 1 | 2 | null = null;
    try {
      if (stream.channels !== undefined) channels = channelCount(stream.channels);
    } catch {
      channels = null;
    }
    return {
      sampleRate: rate,
      channels,
      codecName: typeof stream.codec_name === "string" ? stream.codec_name : null,
    };
  }

  private async readPcmFile(
    job: ActiveJob,
    file: string,
    sampleRate: number,
    channels: 1 | 2,
    label: string,
    sensitivePaths: readonly string[],
  ): Promise<PcmAudio> {
    this.throwIfCancelled(job);
    const size = await this.fileSize(file, `${label} PCM`, sensitivePaths);
    if (size > NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE) {
      throw new Error(
        `${label} decoded PCM is ${String(size)} bytes, above the ` +
          `${String(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE)} byte per-side bound`,
      );
    }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(file, "r");
    } catch {
      throw new Error(`${label} decoded PCM is no longer readable`);
    }
    try {
      if ((await handle.stat()).size !== size) {
        throw new Error(`${label} decoded PCM changed during reading`);
      }
      return await readFloat64PcmChunks(size, async (offset, length) => {
        const chunk = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          this.throwIfCancelled(job);
          let bytesRead: number;
          try {
            ({ bytesRead } = await handle.read(chunk, filled, length - filled, offset + filled));
          } catch {
            throw new Error(`${label} decoded PCM is no longer readable`);
          }
          if (bytesRead === 0) throw new Error(`${label} decoded PCM ended during reading`);
          filled += bytesRead;
        }
        return chunk;
      }, sampleRate, channels, label, () => this.throwIfCancelled(job));
    } finally {
      await handle.close();
    }
  }

  private async encodedFileSize(file: string, label: string, sensitivePaths: readonly string[]): Promise<number> {
    const size = await this.fileSize(file, label, sensitivePaths);
    if (size > NATIVE_CODEC_MAX_ENCODED_BYTES) {
      throw new Error(
        `${label} is ${String(size)} bytes, above the ` +
          `${String(NATIVE_CODEC_MAX_ENCODED_BYTES)} byte stage bound`,
      );
    }
    return size;
  }

  private async fileSize(
    file: string,
    label: string,
    sensitivePaths: readonly string[] = [],
  ): Promise<number> {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size <= 0) throw new Error("not a non-empty regular file");
      return stat.size;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} is unavailable: ${this.sanitize(detail, sensitivePaths)}`);
    }
  }

  private async readLdacHeader(
    file: string,
    expectedRate: number,
    expectedChannels: 1 | 2,
    expectedBitrate: number,
    sensitivePaths: readonly string[],
  ): Promise<LdacHeader> {
    const size = await this.fileSize(file, "LDAC container", sensitivePaths);
    if (size < LDAC_HEADER_BYTES) throw new Error("LDAC container is shorter than its 48-byte header");
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(file, "r");
    } catch (error: unknown) {
      throw new Error(
        `LDAC container could not be opened: ${this.sanitize(String(error), sensitivePaths)}`,
      );
    }
    let header: Buffer;
    try {
      header = Buffer.alloc(LDAC_HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, LDAC_HEADER_BYTES, 0);
      if (bytesRead !== LDAC_HEADER_BYTES) throw new Error("LDAC container header is truncated");
    } catch (error: unknown) {
      throw new Error(
        `LDAC container header could not be read: ${this.sanitize(
          error instanceof Error ? error.message : String(error),
          sensitivePaths,
        )}`,
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (header.toString("ascii", 0, 4) !== "LDAC") {
      throw new Error("LDAC helper output has invalid container magic");
    }
    const version = header.readUInt16LE(4);
    const headerSize = header.readUInt16LE(6);
    if (version !== 1 || headerSize !== LDAC_HEADER_BYTES) {
      throw new Error(`Unsupported LDAC container version/header ${String(version)}/${String(headerSize)}`);
    }
    const sampleRate = header.readUInt32LE(8);
    const channels = channelCount(header.readUInt32LE(12));
    const requestedBitrateKbps = header.readUInt32LE(16);
    const frameCount = header.readUInt32LE(20);
    const sampleCountBig = header.readBigUInt64LE(24);
    const sampleCount = Number(sampleCountBig);
    const actualBitrateKbps = header.readUInt32LE(32);
    const flags = header.readUInt32LE(36);
    const reserved = header.readUInt32LE(44);
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
      throw new Error("LDAC container header has no safe positive sample count");
    }
    if (sampleRate !== expectedRate || channels !== expectedChannels ||
        requestedBitrateKbps !== expectedBitrate) {
      throw new Error(
        "LDAC helper container config disagrees with the requested encode " +
          `(rate ${String(sampleRate)}/${String(expectedRate)}, ` +
          `channels ${String(channels)}/${String(expectedChannels)}, ` +
          `bitrate ${String(requestedBitrateKbps)}/${String(expectedBitrate)})`,
      );
    }
    if (frameCount <= 0 || (flags & 1) !== 1 || reserved !== 0) {
      throw new Error("LDAC container header flags/frame count are invalid");
    }
    return {
      sampleRate,
      channels,
      requestedBitrateKbps,
      sampleCount,
      frameCount,
      actualBitrateKbps,
    };
  }

  private async runHelper(
    job: ActiveJob,
    helper: string,
    args: readonly string[],
    label: string,
    sensitivePaths: readonly string[],
  ): Promise<void> {
    const result = await this.runOwned(job, [helper, ...args], label, HELPER_TIMEOUT_MS);
    if (result.code !== 0) throw this.commandFailure(label, result, sensitivePaths);
  }

  private async ffmpeg(
    job: ActiveJob,
    args: readonly string[],
    label: string,
    sensitivePaths: readonly string[],
  ): Promise<void> {
    const ffmpeg = this.resolution.ffmpegPath;
    if (ffmpeg === null) throw new Error("FFmpeg executable is unavailable");
    // A compressed source can expand far beyond its declared duration, even
    // when metadata is forged. Bound raw Float64 output during decoding at both
    // the duration and byte level, rather than only checking afterwards. The
    // extra ten seconds are a refusal sentinel: the post-process duration check
    // rejects it, so a bounded prefix is never served as a full successful
    // decode. The byte bound includes that sentinel, so legitimate 1800 s
    // material is not truncated at the acceptance ceiling.
    const boundedArgs = args.at(-2) === "f64le"
      ? [
          ...args.slice(0, -1),
          "-t", String(NATIVE_CODEC_MAX_DURATION_SECONDS + AUDIO_DECODE_SENTINEL_SECONDS),
          "-fs", String(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE),
          args.at(-1)!,
        ]
      : args;
    const result = await this.runOwned(job, [ffmpeg, "-protocol_whitelist", "file,pipe", ...boundedArgs], label, COMMAND_TIMEOUT_MS);
    if (result.code !== 0) throw this.commandFailure(label, result, sensitivePaths);
  }

  private async runOwned(
    job: ActiveJob,
    argv: readonly string[],
    label: string,
    timeoutMs: number,
  ): Promise<NativeProcessResult> {
    const [file, ...args] = argv;
    if (!file) throw new Error(`${label} has no executable`);
    try {
      const result = await this.runner.run({
        file,
        args,
        label,
        signal: job.controller.signal,
        timeoutMs,
      });
      if (job.reason !== null) throw job.reason;
      return result;
    } catch (error: unknown) {
      if (error instanceof NativeProcessCleanupError) throw error;
      if (job.reason !== null) throw job.reason;
      throw error;
    }
  }

  private commandFailure(
    label: string,
    result: NativeProcessResult,
    sensitivePaths: readonly string[],
  ): Error {
    const combined = `${result.stderr}\n${result.stdout}`.trim();
    const sanitized = this.sanitize(combined, sensitivePaths);
    const detail = sanitized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(" | ")
      .slice(0, DIAGNOSTIC_CHARS);
    return new Error(
      `${label} failed with exit code ${String(result.code)}` +
        (detail ? `: ${detail}` : ""),
    );
  }

  private sanitize(text: string, sensitivePaths: readonly string[]): string {
    let output = text;
    for (const sensitive of sensitivePaths) {
      if (!sensitive) continue;
      output = output.split(sensitive).join("<private>");
      try {
        const base = path.basename(sensitive);
        if (base.length > 4) output = output.split(base).join("<private>");
      } catch {
        // Basename is only an extra redaction attempt.
      }
    }
    return output;
  }
}

/** Exported for tests/docs: modes are explicit and never inferred. */
export function nativeSessionFrameBound(sampleRate: number, channels: 1 | 2): number {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Session sample rate must be a positive integer");
  }
  return Math.floor(NATIVE_CODEC_MAX_PCM_BYTES_PER_SIDE / (channels * 8));
}
