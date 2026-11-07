import type { PreparationProgress, PreparationRequest } from "@codec-abx/contracts";

export type PreparationStatus =
  | "idle"
  | "preparing"
  | "cancelling"
  | "complete"
  | "cancelled"
  | "error";

export type PreparationErrorPhase = "prepare" | "release";

export interface PreparationLifecycleState<Source, Artifact extends { readonly id: string }> {
  readonly source: Source | null;
  readonly status: PreparationStatus;
  readonly progress: PreparationProgress | null;
  readonly artifact: Artifact | null;
  /** Reset owns a transition until release and state cleanup settle. */
  readonly resetting: boolean;
  /** Source selection owns a release transition until it settles. */
  readonly changingSource: boolean;
}

export interface PreparationPrepareOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PreparationProgress) => void;
}

/**
 * Settled result of one explicit preparation run. Errors are returned as an
 * outcome as well as reported through `onError`, so a caller can present the
 * failure next to the action it triggered without guessing from state.
 */
export type PreparationOutcome<Artifact> =
  | { readonly status: "complete"; readonly artifact: Artifact }
  | { readonly status: "cancelled" }
  | { readonly status: "error"; readonly error: unknown };

export interface PreparationLifecycleDeps<Source, Artifact extends { readonly id: string }> {
  prepare(
    source: Source,
    request: PreparationRequest,
    options: PreparationPrepareOptions,
  ): Promise<Artifact>;
  release(artifactId: string): Promise<void>;
  /** Listening runs keep the prepared artifact and its release locked. */
  isLocked(): boolean;
  /** Clear published sample URLs before a release attempt, including a failed one. */
  onArtifactDiscarded?(): void;
  onError?(error: unknown, phase: PreparationErrorPhase): void;
}

function initialState<Source, Artifact extends { readonly id: string }>():
PreparationLifecycleState<Source, Artifact> {
  return Object.freeze({
    source: null,
    status: "idle",
    progress: null,
    artifact: null,
    resetting: false,
    changingSource: false,
  });
}

/**
 * Owns the renderer preparation lifecycle: retained artifact ownership, run
 * identity, cancellation and reset transitions.
 *
 * A release clears published artifact state only after the engine confirms it.
 * On failure the artifact (or a late stale artifact) stays owned and is retried
 * by the next explicit start/reset/choose-source transition. Sample URLs are
 * revoked before the attempt so a failed cleanup never leaves stale audio on
 * screen, and every failure is reported instead of being presented as success.
 */
export class PreparationLifecycle<Source, Artifact extends { readonly id: string }> {
  readonly #deps: PreparationLifecycleDeps<Source, Artifact>;
  #state = initialState<Source, Artifact>();
  readonly #listeners = new Set<(state: PreparationLifecycleState<Source, Artifact>) => void>();
  #runId = 0;
  #controller: AbortController | null = null;
  #preparePromise: Promise<PreparationOutcome<Artifact>> | null = null;
  #releasePromise: Promise<void> | null = null;
  readonly #orphans = new Set<string>();
  #disposed = false;

  constructor(deps: PreparationLifecycleDeps<Source, Artifact>) {
    this.#deps = deps;
  }

  get state(): PreparationLifecycleState<Source, Artifact> {
    return this.#state;
  }

  /** Completed material is reusable by its listening owner, even while locked. */
  get completedArtifact(): Artifact | null {
    return !this.#disposed && !this.#busy() &&
      this.#state.status === "complete" ? this.#state.artifact : null;
  }

  /** Cleanup ownership can outlive permission to publish diagnostic audio. */
  get readableArtifact(): Artifact | null {
    return this.#deps.isLocked() ? null : this.completedArtifact;
  }

  subscribe(listener: (state: PreparationLifecycleState<Source, Artifact>) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(patch: Partial<PreparationLifecycleState<Source, Artifact>>): void {
    if (this.#disposed) return;
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of [...this.#listeners]) listener(this.#state);
  }

  #report(error: unknown, phase: PreparationErrorPhase): void {
    if (!this.#disposed) this.#deps.onError?.(error, phase);
  }

  #busy(): boolean {
    return this.#state.status === "preparing" ||
      this.#state.status === "cancelling" ||
      this.#state.resetting ||
      this.#state.changingSource;
  }

  #invalidateRun(): void {
    this.#runId += 1;
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
  }

  /**
   * Retry owned releases. The current retained artifact is cleared only after
   * its release succeeds; failed stale results stay in an explicit retry set.
   */
  #releasePending(): Promise<void> {
    if (this.#releasePromise !== null) return this.#releasePromise;
    const promise = this.#performRelease().finally(() => {
      if (this.#releasePromise === promise) this.#releasePromise = null;
    });
    this.#releasePromise = promise;
    return promise;
  }

  async #performRelease(): Promise<void> {
    const artifact = this.#state.artifact;
    const ids = [...(artifact === null ? [] : [artifact.id]), ...this.#orphans];
    if (ids.length === 0) return;
    if (artifact !== null) this.#deps.onArtifactDiscarded?.();
    const failures: unknown[] = [];
    for (const id of new Set(ids)) {
      try {
        await this.#deps.release(id);
        this.#orphans.delete(id);
        if (artifact !== null && artifact.id === id && this.#state.artifact === artifact) {
          this.#emit({ artifact: null });
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const reasons = failures.map((error) => error instanceof Error ? error.message : String(error));
      throw new AggregateError(failures, `Multiple artifact releases were not confirmed: ${reasons.join("; ")}`);
    }
  }

  async chooseSource(source: Source): Promise<boolean> {
    if (this.#disposed || this.#deps.isLocked() || this.#busy()) return false;
    // Invalidate any completed/cancelled run identity before awaiting cleanup.
    this.#invalidateRun();
    this.#emit({ changingSource: true, progress: null });
    try {
      await this.#releasePending();
    } catch (error) {
      if (!this.#disposed) {
        this.#emit({ changingSource: false, status: "error", progress: null });
        this.#report(error, "release");
      }
      return false;
    }
    if (this.#disposed) return false;
    this.#emit({
      source,
      status: "idle",
      progress: null,
      changingSource: false,
      artifact: null,
    });
    return true;
  }

  beginPrepare(request: PreparationRequest, initialProgress: PreparationProgress): boolean {
    return this.#startPrepare(request, initialProgress) !== null;
  }

  /**
   * Start one preparation and await its settled outcome. This is the focused
   * wrapper used by explicit combined flows; it preserves the same release
   * custody, cancellation and late-result rules as `beginPrepare`.
   */
  async prepareAndWait(
    request: PreparationRequest,
    initialProgress: PreparationProgress,
  ): Promise<PreparationOutcome<Artifact> | null> {
    const run = this.#startPrepare(request, initialProgress);
    return run === null ? null : await run;
  }

  #startPrepare(
    request: PreparationRequest,
    initialProgress: PreparationProgress,
  ): Promise<PreparationOutcome<Artifact>> | null {
    const source = this.#state.source;
    if (source === null || this.#disposed || this.#deps.isLocked() || this.#busy()) return null;
    const runId = ++this.#runId;
    const controller = new AbortController();
    this.#controller = controller;
    this.#emit({ status: "preparing", progress: initialProgress });

    const promise = (async (): Promise<PreparationOutcome<Artifact>> => {
      try {
        // Release is part of preparation: a failure must settle this run and
        // keep the old artifact retryable instead of escaping as an unhandled
        // rejection with the UI stuck in "preparing".
        try {
          await this.#releasePending();
        } catch (error) {
          if (runId === this.#runId && !this.#disposed) {
            this.#emit({ status: "error", progress: null });
            this.#report(error, "release");
          }
          return { status: "error", error };
        }
        if (runId !== this.#runId || this.#disposed) return { status: "cancelled" };
        if (controller.signal.aborted) {
          this.#emit({ status: "cancelled", progress: null });
          return { status: "cancelled" };
        }

        const result = await this.#deps.prepare(source, request, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (runId === this.#runId && !this.#disposed) this.#emit({ progress });
          },
        });
        const stale = runId !== this.#runId || this.#disposed;
        const cancelled = !stale && controller.signal.aborted;
        if (stale || cancelled) {
          // A late success is never published. If its release fails, retain the
          // exact artifact ID for a later explicit cleanup rather than claiming
          // that the run was discarded or cancelled cleanly.
          let cleanupError: unknown = null;
          try {
            await this.#deps.release(result.id);
          } catch (error) {
            cleanupError = error;
            this.#orphans.add(result.id);
            this.#report(error, "release");
          }
          if (cancelled && !this.#disposed) {
            this.#emit(cleanupError === null
              ? { status: "cancelled", progress: null }
              : { status: "error", progress: null });
          }
          return cleanupError === null
            ? { status: "cancelled" }
            : { status: "error", error: cleanupError };
        }
        this.#emit({ artifact: result, status: "complete" });
        return { status: "complete", artifact: result };
      } catch (error) {
        if (runId !== this.#runId || this.#disposed) return { status: "cancelled" };
        if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
          this.#emit({ status: "cancelled", progress: null });
          return { status: "cancelled" };
        }
        this.#emit({ status: "error" });
        this.#report(error, "prepare");
        return { status: "error", error };
      } finally {
        if (runId === this.#runId) {
          this.#preparePromise = null;
          if (this.#controller === controller) this.#controller = null;
        }
      }
    })();
    this.#preparePromise = promise;
    return promise;
  }

  cancelPrepare(): boolean {
    if (this.#disposed || this.#state.resetting || this.#state.status !== "preparing") return false;
    this.#emit({ status: "cancelling" });
    this.#controller?.abort();
    return true;
  }

  /**
   * Abort and join an active preparation, release retained artifacts, then
   * clear source/result state. Failure keeps the source and artifact for retry.
   */
  async reset(): Promise<boolean> {
    if (this.#disposed || this.#deps.isLocked() || this.#state.resetting ||
      this.#state.changingSource) return false;
    this.#emit({ resetting: true });
    this.#invalidateRun();
    const pending = this.#preparePromise;
    if (pending) await pending.catch(() => undefined);
    try {
      await this.#releasePending();
    } catch (error) {
      if (!this.#disposed) {
        this.#emit({ resetting: false, status: "error" });
        this.#report(error, "release");
      }
      return false;
    }
    if (this.#disposed) return false;
    this.#emit({
      source: null,
      artifact: null,
      status: "idle",
      progress: null,
      resetting: false,
      changingSource: false,
    });
    return true;
  }

  /**
   * Stop publishing state and join in-flight preparation. The engine's own
   * dispose still owns the final artifact release so teardown failures reach the
   * caller instead of being reported as successful cleanup.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#invalidateRun();
    this.#listeners.clear();
    const pending = this.#preparePromise;
    if (pending) await pending.catch(() => undefined);
  }
}
