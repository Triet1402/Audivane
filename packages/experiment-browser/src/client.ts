/**
 * Renderer-side experiment client.
 *
 * One client owns one module Worker and one runtime service instance. The
 * renderer imports no service, numerics or private assignments; it exchanges
 * strict public DTOs and transferred binary copies only.
 */
import type {
  AnswerReceipt,
  CanarySide,
  DisplayAnswer,
  ExperimentClient,
  ExperimentExport,
  ExperimentPlan,
  ExperimentSnapshot,
  PlaybackLabel,
  PreparedArtifact,
  PublicTrial,
  Side,
} from "@codec-abx/contracts";
import { AUDIO_MAX_DURATION_SECONDS } from "@codec-abx/contracts";

import {
  ExperimentClientError,
  clientError,
} from "./errors.js";
import {
  guardEmptyResult,
  guardExport,
  guardPublicTrial,
  guardReadAudio,
  guardReceipt,
  guardSafeError,
  guardSnapshot,
  parseResponseBase,
  type ExperimentOperation,
  type ExperimentRequest,
  type SafeErrorPayload,
} from "./protocol.js";
import { MAX_RETAINED_BYTES, readCanonicalWav } from "./wav.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Scale the long-track IPC waits with the accepted duration instead of keeping
// the former ten-minute/256 MiB assumptions. Binding copies and verifies two
// bounded deliveries; reading returns one exact copy.
const DEFAULT_BIND_TIMEOUT_MS = AUDIO_MAX_DURATION_SECONDS * 1_000;
const DEFAULT_READ_TIMEOUT_MS = AUDIO_MAX_DURATION_SECONDS * 500;
const DEFAULT_DISPOSE_TIMEOUT_MS = 1_000;
const MIN_REQUEST_TIMEOUT_MS = 10;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_LONG_TIMEOUT_MS = 30 * 60_000;
const MIN_DISPOSE_TIMEOUT_MS = 100;
const MAX_DISPOSE_TIMEOUT_MS = 10_000;

/** Minimal structural Worker seam used by the default factory and tests. */
export interface ExperimentWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  terminate(): void;
}

export interface BrowserExperimentClientOptions {
  /** Internal test seam. Production callers should omit it. */
  readonly workerFactory?: () => ExperimentWorkerLike;
  /** Bounded control-request timeout; defaults to 30 s. */
  readonly requestTimeoutMs?: number;
  /** Long-track binding timeout; defaults to 30 min. */
  readonly bindTimeoutMs?: number;
  /** Long-track delivered-audio read timeout; defaults to 15 min. */
  readonly readTimeoutMs?: number;
  /** Bounded service-dispose wait before terminating; defaults to 1 s. */
  readonly disposeTimeoutMs?: number;
}

/** Runtime-only reader shape; never part of a public experiment DTO. */
export interface PreparedArtifactReaders {
  readAudio(artifactId: string, side: Side): Promise<ArrayBuffer>;
  readCanaryAudio?(artifactId: string, side: CanarySide): Promise<ArrayBuffer>;
}

interface PendingRequest {
  readonly operation: ExperimentOperation;
  readonly generation: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ExperimentClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedMs(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) ||
      Math.round(value) !== value || value < minimum || value > maximum) {
    throw clientError("invalid-request", `${label} must be an integer in [${String(minimum)}, ${String(maximum)}] ms`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

function takePlan(plan: ExperimentPlan): ExperimentPlan {
  let copy: ExperimentPlan;
  try {
    copy = structuredClone(plan);
  } catch {
    throw clientError("invalid-request", "Experiment plan must be cloneable public data");
  }
  return deepFreeze(copy);
}

function takeArtifact(artifact: PreparedArtifact): PreparedArtifact {
  let copy: PreparedArtifact;
  try {
    copy = structuredClone(artifact);
  } catch {
    throw clientError("artifact-invalid", "Prepared artifact metadata must be cloneable public data");
  }
  return deepFreeze(copy);
}

function discard(bytes: Uint8Array | null): void {
  if (bytes === null) return;
  try {
    bytes.fill(0);
  } catch {
    // Detached buffers have already released their storage.
  }
}

function canaryRequested(artifact: PreparedArtifact): boolean {
  const canary = artifact.canary;
  if (canary === undefined || canary === null) return false;
  if (canary.report?.usable !== true) return false;
  return canary.audio !== null && canary.audio !== undefined;
}

function nextRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Same-origin bundled module Worker. Construction failure is fatal: there is no
 * CDN, blob, inline or service-in-renderer fallback.
 */
export function createExperimentWorker(): ExperimentWorkerLike {
  if (typeof Worker === "undefined") {
    throw clientError("worker-start-failed", "This environment cannot start the experiment Worker");
  }
  try {
    return new Worker(
      new URL("./experiment-worker.ts", import.meta.url),
      { type: "module", name: "codec-abx-experiment" },
    ) as unknown as ExperimentWorkerLike;
  } catch {
    throw clientError("worker-start-failed", "The experiment Worker could not be started");
  }
}

export class BrowserExperimentClient implements ExperimentClient {
  readonly #worker: ExperimentWorkerLike;
  readonly #requestTimeoutMs: number;
  readonly #bindTimeoutMs: number;
  readonly #readTimeoutMs: number;
  readonly #disposeTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #copyReads = new Set<(error: ExperimentClientError) => void>();

  #generation = 0;
  #disposed = false;
  #fatal = false;
  #terminated = false;
  #disposal: Promise<void> | null = null;

  constructor(options: BrowserExperimentClientOptions = {}) {
    this.#requestTimeoutMs = boundedMs(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#bindTimeoutMs = boundedMs(
      options.bindTimeoutMs,
      DEFAULT_BIND_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_LONG_TIMEOUT_MS,
      "bindTimeoutMs",
    );
    this.#readTimeoutMs = boundedMs(
      options.readTimeoutMs,
      DEFAULT_READ_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_LONG_TIMEOUT_MS,
      "readTimeoutMs",
    );
    this.#disposeTimeoutMs = boundedMs(
      options.disposeTimeoutMs,
      DEFAULT_DISPOSE_TIMEOUT_MS,
      MIN_DISPOSE_TIMEOUT_MS,
      MAX_DISPOSE_TIMEOUT_MS,
      "disposeTimeoutMs",
    );
    try {
      this.#worker = (options.workerFactory ?? createExperimentWorker)();
    } catch (error) {
      if (error instanceof ExperimentClientError) throw error;
      throw clientError("worker-start-failed", "The experiment Worker could not be started");
    }
    this.#worker.addEventListener("message", this.#onMessage as (event: unknown) => void);
    this.#worker.addEventListener("error", this.#onError as (event: unknown) => void);
    this.#worker.addEventListener("messageerror", this.#onError as (event: unknown) => void);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw clientError("disposed", "The experiment client has been disposed");
    }
    if (this.#fatal) {
      throw clientError("worker-fatal", "The experiment Worker is no longer usable");
    }
  }

  #rejectEntry(
    requestId: string,
    error: ExperimentClientError,
  ): void {
    const entry = this.#pending.get(requestId);
    if (!entry) return;
    this.#pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  #invalidatePending(
    code: "stale-response" | "disposed" | "worker-fatal" | "protocol-error",
    message: string,
  ): void {
    for (const cancel of [...this.#copyReads]) cancel(clientError(code, message));
    for (const [requestId, entry] of [...this.#pending]) {
      this.#pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(clientError(code, message));
    }
  }

  #timeoutFor(operation: ExperimentOperation): number {
    if (operation === "bindPrepared") return this.#bindTimeoutMs;
    if (operation === "readAudio") return this.#readTimeoutMs;
    // `answer` keeps the bounded control deadline and its uncertain retry text.
    return this.#requestTimeoutMs;
  }

  /** Reader preflight is bounded/cancellable even before an RPC exists. */
  #waitForReaders<T>(read: Promise<T>, generation: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (value: T | undefined, error?: ExperimentClientError): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#copyReads.delete(cancel);
        if (error) reject(error);
        else resolve(value as T);
      };
      const cancel = (error: ExperimentClientError): void => finish(undefined, error);
      const timer = setTimeout(() => cancel(clientError(
        "request-timeout", "Prepared audio readers timed out before binding was submitted",
      )), this.#bindTimeoutMs);
      this.#copyReads.add(cancel);
      read.then((value) => finish(value), () => cancel(clientError(
        "artifact-reader-unavailable", "The prepared audio reader failed",
      )));
      if (this.#disposed) cancel(clientError("disposed", "The experiment client was disposed during binding"));
      else if (this.#fatal) cancel(clientError("worker-fatal", "The experiment Worker failed during binding"));
      else if (generation !== this.#generation) cancel(clientError("stale-response", "The run changed during binding"));
    });
  }

  #onTimeout(requestId: string): void {
    const entry = this.#pending.get(requestId);
    if (!entry) return;
    this.#pending.delete(requestId);
    entry.reject(clientError(
      "request-timeout",
      entry.operation === "answer"
        ? "The answer request timed out; it may already have been accepted. Retry the same token/answer or inspect snapshot.lastAnswer/pendingTrial."
        : "The experiment request timed out",
      [],
      entry.operation === "answer",
    ));
  }

  #request(
    operation: ExperimentOperation,
    payload: Record<string, unknown>,
    transfer: Transferable[],
    generation: number,
  ): Promise<unknown> {
    if (this.#disposed) {
      return Promise.reject(clientError("disposed", "The experiment client has been disposed"));
    }
    if (this.#fatal) {
      return Promise.reject(clientError("worker-fatal", "The experiment Worker is no longer usable"));
    }
    if (generation !== this.#generation) {
      return Promise.reject(clientError(
        "stale-response",
        "The run was invalidated before this request could be submitted",
      ));
    }
    const requestId = nextRequestId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#onTimeout(requestId),
        this.#timeoutFor(operation),
      );
      this.#pending.set(requestId, { operation, generation, resolve, reject, timer });
      const request = {
        protocol: "codec-abx-experiment-rpc-v1",
        version: 1,
        requestId,
        operation,
        ...payload,
      } as ExperimentRequest;
      try {
        this.#worker.postMessage(request, transfer);
      } catch {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(clientError("invalid-request", "The experiment request could not be submitted"));
      }
    });
  }

  #onMessage = (event: { data?: unknown }): void => {
    if (this.#terminated) return;
    const data = event?.data;
    const rawRequestId = isRecord(data) && typeof data.requestId === "string"
      ? data.requestId
      : null;
    let base: ReturnType<typeof parseResponseBase>;
    try {
      base = parseResponseBase(data);
    } catch {
      if (rawRequestId !== null && this.#pending.has(rawRequestId)) {
        this.#rejectEntry(
          rawRequestId,
          clientError("protocol-error", "The experiment Worker returned a malformed response"),
        );
        return;
      }
      this.#failProtocol();
      return;
    }
    const entry = this.#pending.get(base.requestId);
    // A structurally valid reply for an unknown request is a benign late or
    // duplicate reply (for example after a timeout); it cannot resolve anything.
    if (!entry) return;
    if (base.operation !== entry.operation) {
      this.#rejectEntry(
        base.requestId,
        clientError("protocol-error", "The experiment Worker correlated a reply to the wrong operation"),
      );
      return;
    }
    if (!base.ok) {
      let error: SafeErrorPayload;
      try {
        error = guardSafeError(base.raw.error);
      } catch {
        this.#rejectEntry(
          base.requestId,
          clientError("protocol-error", "The experiment Worker returned an unsafe error payload"),
        );
        return;
      }
      this.#rejectEntry(
        base.requestId,
        clientError(error.code, error.message, error.reasons),
      );
      return;
    }
    let value: unknown;
    try {
      value = this.#guardResult(entry.operation, base.raw.result);
    } catch {
      this.#rejectEntry(
        base.requestId,
        clientError("protocol-error", "The experiment Worker returned an invalid result"),
      );
      return;
    }
    this.#pending.delete(base.requestId);
    clearTimeout(entry.timer);
    if (entry.generation !== this.#generation) {
      if (value instanceof ArrayBuffer) {
        try {
          new Uint8Array(value).fill(0);
        } catch {
          // Detached worker buffers are already unusable.
        }
      }
      entry.reject(clientError(
        "stale-response",
        "The run was invalidated before this response completed",
      ));
      return;
    }
    entry.resolve(value);
  };

  #guardResult(operation: ExperimentOperation, value: unknown): unknown {
    switch (operation) {
      case "configure":
      case "snapshot":
      case "seal":
      case "reset":
      case "bindPrepared":
        return guardSnapshot(value);
      case "nextTrial":
        return guardPublicTrial(value);
      case "answer":
        return guardReceipt(value);
      case "readAudio":
        return guardReadAudio(value);
      case "export":
        return guardExport(value);
      case "dispose":
        return guardEmptyResult(value);
    }
  }

  #onError = (event: { preventDefault?: () => void }): void => {
    try {
      event.preventDefault?.();
    } catch {
      // Some WorkerLike fakes do not implement preventDefault.
    }
    this.#failFatal();
  };

  #failProtocol(): void {
    this.#failFatal("protocol-error", "The experiment Worker violated the RPC protocol");
  }

  #failFatal(
    code: "worker-fatal" | "protocol-error" = "worker-fatal",
    message = "The experiment Worker failed; this run is no longer usable",
  ): void {
    if (this.#terminated || this.#fatal) return;
    this.#fatal = true;
    this.#generation += 1;
    this.#invalidatePending(code, message);
    this.#terminate();
  }

  #terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    try {
      this.#worker.removeEventListener("message", this.#onMessage as (event: unknown) => void);
      this.#worker.removeEventListener("error", this.#onError as (event: unknown) => void);
      this.#worker.removeEventListener("messageerror", this.#onError as (event: unknown) => void);
    } catch {
      // Listener removal is best-effort; terminating ends delivery anyway.
    }
    try {
      this.#worker.terminate();
    } catch {
      // Worker.terminate() has no awaitable join and may already have completed.
    }
  }

  async configure(plan: ExperimentPlan): Promise<ExperimentSnapshot> {
    this.#assertUsable();
    const input = takePlan(plan);
    return await this.#request(
      "configure",
      { plan: input },
      [],
      this.#generation,
    ) as ExperimentSnapshot;
  }

  async snapshot(): Promise<ExperimentSnapshot> {
    this.#assertUsable();
    return await this.#request("snapshot", {}, [], this.#generation) as ExperimentSnapshot;
  }

  async nextTrial(): Promise<PublicTrial> {
    this.#assertUsable();
    return await this.#request("nextTrial", {}, [], this.#generation) as PublicTrial;
  }

  async answer(token: string, answer: DisplayAnswer): Promise<AnswerReceipt> {
    this.#assertUsable();
    return await this.#request(
      "answer",
      { token, answer },
      [],
      this.#generation,
    ) as AnswerReceipt;
  }

  async readAudio(token: string, label: PlaybackLabel): Promise<ArrayBuffer> {
    this.#assertUsable();
    return await this.#request(
      "readAudio",
      { token, label },
      [],
      this.#generation,
    ) as ArrayBuffer;
  }

  async seal(reason?: string): Promise<ExperimentSnapshot> {
    this.#assertUsable();
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#invalidatePending(
      "stale-response",
      "The run was sealed before this request completed",
    );
    return await this.#request(
      "seal",
      typeof reason === "string" ? { reason } : {},
      [],
      generation,
    ) as ExperimentSnapshot;
  }

  async reset(): Promise<ExperimentSnapshot> {
    this.#assertUsable();
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#invalidatePending(
      "stale-response",
      "The run was reset before this request completed",
    );
    return await this.#request("reset", {}, [], generation) as ExperimentSnapshot;
  }

  async export(): Promise<ExperimentExport> {
    this.#assertUsable();
    return await this.#request("export", {}, [], this.#generation) as ExperimentExport;
  }

  /**
   * Runtime-only artifact binding. Metadata and reader methods are captured
   * before the first await; exact bounded bytes are copied into the Worker and
   * the external artifact owner keeps its own retained buffers untouched.
   */
  async bindPrepared(
    artifact: PreparedArtifact,
    readers: PreparedArtifactReaders,
  ): Promise<ExperimentSnapshot> {
    this.#assertUsable();
    const generation = this.#generation;
    const metadata = takeArtifact(artifact);
    if (!readers || typeof readers.readAudio !== "function") {
      throw clientError(
        "artifact-reader-unavailable",
        "Prepared artifact has no audio reader",
      );
    }
    const readAudio = readers.readAudio.bind(readers);
    const readCanary = typeof readers.readCanaryAudio === "function"
      ? readers.readCanaryAudio.bind(readers)
      : null;
    const wantsCanary = canaryRequested(metadata) && readCanary !== null;

    let aBytes: Uint8Array | null = null;
    let bBytes: Uint8Array | null = null;
    let pristine: Uint8Array | null = null;
    let degraded: Uint8Array | null = null;
    try {
      let aValue: unknown;
      let bValue: unknown;
      try {
        [aValue, bValue] = await this.#waitForReaders(Promise.all([
          readAudio(metadata.id, "a"),
          readAudio(metadata.id, "b"),
        ]), generation);
      } catch (error) {
        if (error instanceof ExperimentClientError) throw error;
        throw clientError(
          "artifact-reader-unavailable",
          "The prepared audio reader failed",
        );
      }
      aBytes = readCanonicalWav(aValue, "Prepared Side A").bytes;
      bBytes = readCanonicalWav(bValue, "Prepared Side B").bytes;

      if (wantsCanary && readCanary !== null) {
        let pristineValue: unknown;
        let degradedValue: unknown;
        try {
          [pristineValue, degradedValue] = await this.#waitForReaders(Promise.all([
            readCanary(metadata.id, "pristine"),
            readCanary(metadata.id, "degraded"),
          ]), generation);
        } catch (error) {
          if (error instanceof ExperimentClientError && error.code !== "artifact-reader-unavailable") throw error;
          // A missing/failed canary reader keeps calibration requested but
          // unavailable; it never silently disables the blocking gate.
          pristineValue = null;
          degradedValue = null;
        }
        if (pristineValue !== null && degradedValue !== null) {
          // Corrupt retained bytes are not downgraded to "unavailable".
          pristine = readCanonicalWav(pristineValue, "Prepared canary pristine").bytes;
          degraded = readCanonicalWav(degradedValue, "Prepared canary degraded").bytes;
        }
      }

      if (aBytes.byteLength + bBytes.byteLength +
          (pristine?.byteLength ?? 0) + (degraded?.byteLength ?? 0) > MAX_RETAINED_BYTES) {
        throw clientError("artifact-invalid", "Prepared binding exceeds the retained byte bound");
      }
      if (this.#disposed) {
        throw clientError("disposed", "The experiment client was disposed during binding");
      }
      if (this.#fatal) {
        throw clientError("worker-fatal", "The experiment Worker failed during binding");
      }
      if (generation !== this.#generation) {
        throw clientError(
          "stale-response",
          "The run was invalidated while prepared copies were being read",
        );
      }

      const canary = pristine !== null && degraded !== null
        ? {
            pristine: pristine.buffer as ArrayBuffer,
            degraded: degraded.buffer as ArrayBuffer,
          }
        : null;
      const a = aBytes.buffer as ArrayBuffer;
      const b = bBytes.buffer as ArrayBuffer;
      const transfer: Transferable[] = [a, b];
      if (canary) transfer.push(canary.pristine, canary.degraded);
      const completion = this.#request(
        "bindPrepared",
        { artifact: metadata, a, b, canary },
        transfer,
        generation,
      );
      // The posted message owns these copies (or the post failed after the
      // attempt). Clear local references; never zero a buffer that may be in
      // the Worker's hands.
      aBytes = null;
      bBytes = null;
      pristine = null;
      degraded = null;
      return await completion as ExperimentSnapshot;
    } finally {
      discard(aBytes);
      discard(bBytes);
      discard(pristine);
      discard(degraded);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposal = this.#performDispose();
    return this.#disposal;
  }

  async #performDispose(): Promise<void> {
    this.#disposed = true;
    this.#generation += 1;
    this.#invalidatePending("disposed", "The experiment client was disposed");
    if (!this.#fatal && !this.#terminated) {
      await this.#requestServiceDispose();
    }
    this.#terminate();
  }

  #requestServiceDispose(): Promise<void> {
    return new Promise<void>((resolve) => {
      const requestId = nextRequestId();
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        const entry = this.#pending.get(requestId);
        if (entry) clearTimeout(entry.timer);
        this.#pending.delete(requestId);
        resolve();
      };
      const deadline = setTimeout(finish, this.#disposeTimeoutMs);
      this.#pending.set(requestId, {
        operation: "dispose",
        generation: this.#generation,
        resolve: finish,
        reject: finish,
        timer: deadline,
      });
      try {
        this.#worker.postMessage({
          protocol: "codec-abx-experiment-rpc-v1",
          version: 1,
          requestId,
          operation: "dispose",
        } satisfies ExperimentRequest);
      } catch {
        finish();
      }
    });
  }
}
