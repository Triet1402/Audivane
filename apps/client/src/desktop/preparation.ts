import {
  freezeRequest,
  type CanarySide,
  type DesktopBridge,
  type DesktopSource,
  type PreparedArtifact,
  type PreparationProgress,
  type PreparationRequest,
  type Side,
} from "@codec-abx/contracts";
import type { PreparationEngine, PrepareOptions } from "@codec-abx/preparation";

import { desktopError } from "./bridge.js";

type PreparationBridge = DesktopBridge["preparation"];

interface ActiveJob {
  readonly jobId: string;
  readonly controller: AbortController;
  /** Abort locally and ask main to cancel; resolves after main-owned cleanup. */
  readonly abort: () => Promise<void>;
  /** Settled view of the prepare promise; used by disposal. */
  readonly settled: Promise<void>;
}

function abortError(): DOMException {
  return new DOMException("Desktop preparation aborted", "AbortError");
}

function nextJobId(sequence: number): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `job_${cryptoApi.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 12);
  return `job_${Date.now().toString(36)}_${sequence.toString(36)}_${random}`;
}

function assertRequest(request: PreparationRequest): PreparationRequest {
  const frozen = freezeRequest(request);
  if (frozen.preparationPolicy !== "aligned-gain-matched-v1") {
    throw desktopError(
      "invalid-request",
      "Desktop preparation requires the explicit aligned-gain-matched-v1 policy",
    );
  }
  return frozen;
}

/**
 * Bounded renderer adapter over the fixed desktop preparation operations.
 *
 * It owns renderer-side job identity, one active job, progress scoping,
 * abort/cancellation reconciliation and exact-read pass-through. It never sees
 * a local source path, executable or IPC channel. Main remains the owner of the
 * source handle, artifact metadata, temporary files and child processes.
 */
export class DesktopPreparationEngine implements PreparationEngine<DesktopSource> {
  readonly #bridge: PreparationBridge;
  #sequence = 0;
  #active: ActiveJob | null = null;
  #disposed = false;
  #disposal: Promise<void> | null = null;
  readonly #artifacts = new Set<string>();
  readonly #releases = new Map<string, Promise<void>>();
  #cleanupFailure: unknown = null;

  constructor(bridge: PreparationBridge) {
    this.#bridge = bridge;
  }

  get activeJobId(): string | null {
    return this.#active?.jobId ?? null;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw desktopError("disposed", "The desktop preparation adapter has been disposed");
    }
    if (this.#cleanupFailure !== null) throw this.#cleanupFailure;
  }

  async capabilities() {
    this.#assertLive();
    const result = await this.#bridge.capabilities();
    this.#assertLive();
    return result;
  }

  /** OS dialog seam; only a handle, basename and size cross into the renderer. */
  async pickSource(): Promise<DesktopSource | null> {
    this.#assertLive();
    const result = await this.#bridge.pickSource();
    this.#assertLive();
    return result;
  }

  prepare(
    source: DesktopSource,
    request: PreparationRequest,
    options: PrepareOptions = {},
  ): Promise<PreparedArtifact> {
    try {
      this.#assertLive();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#active !== null) {
      return Promise.reject(desktopError(
        "job-conflict",
        "A desktop preparation is already in progress; wait for it or cancel it",
      ));
    }
    if (!source || typeof source.id !== "string" || source.id.length === 0) {
      return Promise.reject(desktopError("source-invalid", "Desktop source handle is invalid"));
    }
    let frozen: PreparationRequest;
    try {
      frozen = assertRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(abortError());

    const jobId = nextJobId(++this.#sequence);
    const controller = new AbortController();
    let cancellation: Promise<void> | null = null;
    let progressFailed = false;
    let progressError: unknown;
    let unsubscribe = (): void => undefined;

    const requestCancellation = (): Promise<void> => {
      if (!controller.signal.aborted) controller.abort();
      return this.#bridge.cancel(jobId);
    };
    const abort = (): Promise<void> => (cancellation ??= requestCancellation());

    const onExternalAbort = (): void => {
      // Keep the rejected cancellation promise for the preparation settlement;
      // event callbacks themselves must never create an unhandled rejection.
      void abort().catch(() => undefined);
    };

    // Defer the bridge call until ownership and callbacks are fully installed.
    const completion = Promise.resolve().then(async (): Promise<PreparedArtifact> => {
      let artifact: PreparedArtifact | null = null;
      try {
        if (controller.signal.aborted || this.#disposed) throw abortError();
        artifact = await this.#bridge.prepare(source.id, frozen, jobId);
        if (controller.signal.aborted || this.#disposed) {
          throw abortError();
        }
        this.#artifacts.add(artifact.id);
        return artifact;
      } catch (error) {
        if (controller.signal.aborted || this.#disposed) {
          // Both cleanup attempts must finish, including when one fails. A lost
          // cleanup acknowledgement must not become a successful AbortError.
          const cleanup = await Promise.allSettled([
            abort(), ...(artifact === null ? [] : [this.#bridge.release(artifact.id)]),
          ]);
          if (cleanup.some((result) => result.status === "rejected")) {
            this.#cleanupFailure = desktopError("cleanup-unconfirmed",
              "Desktop cleanup could not be confirmed. Close the app before retrying.", [], true);
            throw this.#cleanupFailure;
          }
          // The main job can settle (and leave its job table) before cancel is
          // received. Its prepare rejection still carries a real cleanup or
          // processing failure; a no-op cancel acknowledgement cannot erase it.
          const cancelled = error instanceof Error && error.name === "AbortError" ||
            error !== null && typeof error === "object" && "code" in error && error.code === "cancelled";
          if (!cancelled) {
            this.#cleanupFailure = error;
            throw error;
          }
          if (progressFailed) throw progressError;
          throw abortError();
        }
        throw error;
      }
    });
    const result = completion.finally(() => {
      options.signal?.removeEventListener("abort", onExternalAbort);
      unsubscribe();
      if (this.#active === owned) this.#active = null;
    });
    const owned: ActiveJob = { jobId, controller, abort,
      settled: result.then(() => undefined, () => undefined) };
    this.#active = owned;
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      unsubscribe = this.#bridge.onProgress((incomingJobId, progress: PreparationProgress) => {
        if (incomingJobId !== jobId || controller.signal.aborted || this.#disposed) return;
        try { options.onProgress?.(progress); }
        catch (error) {
          progressFailed = true;
          progressError = error;
          onExternalAbort();
        }
      });
    } catch (error) {
      progressFailed = true;
      progressError = error;
      onExternalAbort();
    }
    if (options.signal?.aborted) onExternalAbort();
    return result;
  }

  async readAudio(artifactId: string, side: Side): Promise<ArrayBuffer> {
    this.#assertLive();
    this.#assertOwned(artifactId);
    const bytes = await this.#bridge.readAudio(artifactId, side);
    this.#assertLive();
    this.#assertOwned(artifactId);
    return bytes;
  }

  async readCanaryAudio(artifactId: string, side: CanarySide): Promise<ArrayBuffer> {
    this.#assertLive();
    this.#assertOwned(artifactId);
    const bytes = await this.#bridge.readCanaryAudio(artifactId, side);
    this.#assertLive();
    this.#assertOwned(artifactId);
    return bytes;
  }

  #assertOwned(artifactId: string): void {
    if (!this.#artifacts.has(artifactId) || this.#releases.has(artifactId)) {
      throw desktopError("artifact-invalid", "Unknown or released desktop artifact");
    }
  }

  release(artifactId: string): Promise<void> {
    const existing = this.#releases.get(artifactId);
    if (existing) return existing;
    if (!this.#artifacts.has(artifactId)) return Promise.resolve();
    const release = this.#bridge.release(artifactId).then(() => {
      this.#artifacts.delete(artifactId);
    }).finally(() => this.#releases.delete(artifactId));
    this.#releases.set(artifactId, release);
    return release;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposed = true;
    const active = this.#active;
    this.#disposal = (async () => {
      if (active !== null) {
        await active.abort().catch(() => undefined);
        await active.settled;
      }
      const releases = await Promise.allSettled([...this.#artifacts].map((id) => this.release(id)));
      const failure = releases.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (this.#cleanupFailure !== null) throw this.#cleanupFailure;
    })();
    return this.#disposal;
  }
}
