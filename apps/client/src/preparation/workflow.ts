import type {
  CodecSelection,
  ExperimentPlan,
  PreparedArtifact,
  PreparationProgress,
  PreparationRequest,
  SampleRateMode,
} from "@codec-abx/contracts";

import type { ListeningController, ListeningReaders } from "../listening/controller.js";
import {
  preparedArtifactReusable,
  testPreparationSignature,
} from "../listening/model.js";
import {
  PreparationLifecycle,
  type PreparationErrorPhase,
  type PreparationPrepareOptions,
} from "./lifecycle.js";

/** Policy selected in the advanced manual preparation form. */
export type DiagnosticPreparationPolicy =
  | "codec-probe-only"
  | "aligned-gain-matched-v1";

/**
 * Every input the primary prepare-test action captures before it starts work.
 *
 * The caller reads these once per explicit command; the workflow snapshots them
 * for the whole run, so a later form edit cannot relabel a prepared pair.
 * `diagnosticPolicy` belongs to the advanced manual path only: the primary
 * action always requests aligned preparation.
 */
export interface PrepareTestInputs {
  readonly sourceIdentity: string;
  readonly stagesA: readonly CodecSelection[];
  readonly stagesB: readonly CodecSelection[];
  readonly rateMode: SampleRateMode;
  readonly calibrationEnabled: boolean;
  readonly diagnosticPolicy: DiagnosticPreparationPolicy;
}

export type PrepareTestPhase =
  | "idle"
  | "preparing"
  | "binding"
  | "staging"
  | "ready"
  | "cancelled"
  | "error";

export interface PrepareTestWorkflowState {
  readonly phase: PrepareTestPhase;
  /** Preparation, exact-byte binding or paused staging currently owns the action. */
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
}

export type PrepareTestRequestMode = "prepare-test" | "diagnostic-artifacts";

/** The preparation engine operations this workflow sequences (adapter-owned). */
export interface PrepareTestEngine<Source, Artifact extends PreparedArtifact> {
  prepare(
    source: Source,
    request: PreparationRequest,
    options: PreparationPrepareOptions,
  ): Promise<Artifact>;
  release(artifactId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface PrepareTestWorkflowDeps<Source, Artifact extends PreparedArtifact> {
  /** Runtime label only: start messages and the raw/browser readiness conflict. */
  readonly desktop: boolean;
  readonly engine: PrepareTestEngine<Source, Artifact>;
  /** The listening collaborator; the workflow never merges its run state. */
  readonly controller: ListeningController;
  readonly readers: ListeningReaders;
  /** A listening run owns the retained artifact and its release lock. */
  readonly isListeningLocked: () => boolean;
  /** Clear published diagnostic output before any release attempt. */
  readonly onArtifactDiscarded?: () => void;
  readonly buildRequest: (
    inputs: PrepareTestInputs,
    mode: PrepareTestRequestMode,
  ) => PreparationRequest;
  /** The shared, page-level error notice. `null` clears it. */
  readonly publishError: (message: string | null) => void;
  readonly reportCleanupFailure: (message: string) => void;
}

type StatePatch = {
  readonly phase?: PrepareTestPhase;
  readonly message?: string | null;
  readonly error?: string | null;
};

const INITIAL_STATE: PrepareTestWorkflowState = Object.freeze({
  phase: "idle",
  busy: false,
  message: null,
  error: null,
});

function busyPhase(phase: PrepareTestPhase): boolean {
  return phase === "preparing" || phase === "binding" || phase === "staging";
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Snapshot the captured inputs so the run identity cannot follow later edits.
 */
function captureInputs(inputs: PrepareTestInputs): PrepareTestInputs {
  const stages = (stages: readonly CodecSelection[]): readonly CodecSelection[] =>
    Object.freeze(stages.map((stage) => Object.freeze({
      codecId: stage.codecId,
      bitrateKbps: stage.bitrateKbps,
    })));
  return Object.freeze({
    sourceIdentity: inputs.sourceIdentity,
    stagesA: stages(inputs.stagesA),
    stagesB: stages(inputs.stagesB),
    rateMode: inputs.rateMode,
    calibrationEnabled: inputs.calibrationEnabled,
    diagnosticPolicy: inputs.diagnosticPolicy,
  });
}

/**
 * One explicit prepare-test workflow: aligned preparation, exact-byte bind and
 * paused trial-1 staging.
 *
 * This module owns the sequence and its races so React only renders state and
 * submits current form values:
 *
 * - Input identity is captured at command entry; same-input completion is
 *   remembered and reused, any source/codec/rate/opt-in change invalidates it.
 * - The retained artifact stays with {@link PreparationLifecycle}; reuse asks
 *   that owner for publishable completed material, so cleanup-only ownership
 *   after a failed release can never be reused.
 * - Cancellation invalidates the run first, then cancels preparation or closes
 *   the listening session. Late preparation, bind and stage results are never
 *   published; the controller invalidates old operations when Cancel closes the
 *   session, so an old completion cannot close a replacement run.
 * - A configured binding refusal is reported without staging; running the same
 *   captured inputs again retries the bind against the retained pair.
 * - `prepareDiagnostic` retains the advanced manual path: it releases the old
 *   artifact, prepares, and registers the pair only when that request was
 *   aligned. It never creates a listening session.
 * - `dispose` attempts every cleanup owner in order: listening controller,
 *   preparation lifecycle, preparation engine. Failures are reported, never
 *   presented as completed cleanup.
 *
 * The listening controller stays the owner of plan/run/playback state; this
 * workflow only calls `prepareSession`, `start` and `closeSession` in sequence.
 * It never plays audio: staging leaves the first trial paused.
 */
export class PrepareTestWorkflow<
  Source,
  Artifact extends PreparedArtifact,
> {
  readonly lifecycle: PreparationLifecycle<Source, Artifact>;

  readonly #deps: PrepareTestWorkflowDeps<Source, Artifact>;
  readonly #listeners = new Set<(state: PrepareTestWorkflowState) => void>();
  #state = INITIAL_STATE;
  #preparedSignature: string | null = null;
  #runId = 0;
  #inFlight = false;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(deps: PrepareTestWorkflowDeps<Source, Artifact>) {
    this.#deps = deps;
    this.lifecycle = new PreparationLifecycle<Source, Artifact>({
      prepare: (source, request, options) => deps.engine.prepare(source, request, options),
      release: (artifactId) => deps.engine.release(artifactId),
      isLocked: () => deps.isListeningLocked(),
      ...(deps.onArtifactDiscarded === undefined
        ? {}
        : { onArtifactDiscarded: () => deps.onArtifactDiscarded?.() }),
      onError: (error, phase) => this.#reportPreparationFailure(error, phase),
    });
  }

  get state(): PrepareTestWorkflowState {
    return this.#state;
  }

  subscribe(listener: (state: PrepareTestWorkflowState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Whether the retained pair can be rebound for exactly these inputs without
   * re-encoding. A cleanup-only artifact, an unregistered completion, a raw or
   * historical artifact, or any changed input answers `false`.
   */
  isPairReady(inputs: PrepareTestInputs): boolean {
    if (this.#disposed) return false;
    return preparedArtifactReusable(
      this.lifecycle.completedArtifact,
      this.#preparedSignature,
      testPreparationSignature(inputs),
    );
  }

  /** Adopt a source and release the previous artifact through the lifecycle. */
  async chooseSource(source: Source): Promise<boolean> {
    const state = this.lifecycle.state;
    if (this.#disposed || this.#inFlight || this.#deps.isListeningLocked() ||
      state.status === "preparing" || state.status === "cancelling" ||
      state.resetting || state.changingSource) return false;
    this.#invalidateRun();
    this.#deps.publishError(null);
    const adopted = await this.lifecycle.chooseSource(source);
    if (adopted) {
      this.#setPreparedSignature(null);
      this.#emit({ phase: "idle", message: null, error: null });
    }
    return adopted;
  }

  /** Release retained material and clear source/result state. */
  async reset(): Promise<boolean> {
    if (this.#disposed) return false;
    if (this.lifecycle.state.resetting || this.#deps.isListeningLocked()) return false;
    this.#invalidateRun();
    this.#deps.publishError(null);
    const cleared = await this.lifecycle.reset();
    if (cleared && !this.#disposed) {
      this.#setPreparedSignature(null);
      this.#emit({ phase: "idle", message: null, error: null });
    } else if (!this.#disposed && this.lifecycle.state.status === "error") {
      this.#emit({
        phase: "error",
        message: "Reset could not release retained material. Retry Reset to finish cleanup.",
        error: null,
      });
    }
    return cleared;
  }

  /**
   * The advanced manual preparation path: prepare and measure only. It never
   * binds a plan, stages a trial or plays audio.
   */
  async prepareDiagnostic(inputs: PrepareTestInputs): Promise<void> {
    if (this.#disposed || this.#inFlight) return;
    if (this.#deps.controller.state.session !== "idle") return;
    if (this.lifecycle.state.source === null) return;
    if (inputs.diagnosticPolicy === "codec-probe-only" &&
      inputs.calibrationEnabled && !this.#deps.desktop) {
      return;
    }
    const captured = captureInputs(inputs);
    this.#deps.publishError(null);
    this.#emit({ phase: "idle", message: null, error: null });
    const request = this.#deps.buildRequest(captured, "diagnostic-artifacts");
    const outcome = await this.lifecycle.prepareAndWait(
      request,
      this.#progress("diagnostic-artifacts"),
    );
    if (this.#disposed || outcome === null || outcome.status !== "complete") return;
    this.#setPreparedSignature(
      request.preparationPolicy === "aligned-gain-matched-v1"
        ? testPreparationSignature(captured)
        : null,
    );
  }

  /**
   * The single combined action: prepare (or reuse), verify/bind the exact pair,
   * then stage trial 1 paused. No effect calls this; only an explicit command.
   */
  async prepareTest(inputs: PrepareTestInputs, plan: ExperimentPlan): Promise<void> {
    if (this.#disposed || this.#inFlight) return;
    if (this.lifecycle.state.resetting || this.lifecycle.state.changingSource) return;
    if (this.lifecycle.state.source === null) return;
    // A configured run may be retried before its first trial; a running or
    // terminal run must be reset/closed explicitly instead.
    const listening = this.#deps.controller.state;
    if (listening.busy !== null ||
      (listening.session !== "idle" && listening.session !== "configured")) {
      return;
    }
    if (this.#deps.controller.state.planLocked) return;

    const captured = captureInputs(inputs);
    const capturedPlan = Object.freeze(structuredClone(plan));
    const signature = testPreparationSignature(captured);
    const runId = ++this.#runId;
    this.#inFlight = true;
    this.#deps.publishError(null);
    this.#emit({ phase: "preparing", message: "Preparing aligned test audio…", error: null });

    try {
      let current = this.lifecycle.completedArtifact;
      const reusable = preparedArtifactReusable(
        current,
        this.#preparedSignature,
        signature,
      );
      if (!reusable) {
        const outcome = await this.lifecycle.prepareAndWait(
          this.#deps.buildRequest(captured, "prepare-test"),
          this.#progress("prepare-test"),
        );
        if (this.#stale(runId)) return;
        if (outcome === null) {
          this.#emit({
            phase: "error",
            message: "A preparation is already running.",
            error: "Wait for the current preparation to finish or cancel it.",
          });
          return;
        }
        if (outcome.status === "cancelled") {
          this.#emit({
            phase: "cancelled",
            message: "Test preparation was cancelled. No trial was staged.",
            error: null,
          });
          return;
        }
        if (outcome.status === "error") {
          this.#emit({
            phase: "error",
            message: "Test preparation failed. No trial was staged.",
            error: errorMessage(outcome.error),
          });
          return;
        }
        current = outcome.artifact;
        // Register the completed pair before binding: an explicit retry after a
        // refused binding must reuse these exact bytes, not re-encode.
        this.#setPreparedSignature(signature);
      }
      if (current === null) {
        this.#emit({
          phase: "error",
          message: "No prepared artifact is available.",
          error: "Prepare the test again.",
        });
        return;
      }

      this.#emit({
        phase: "binding",
        message: "Verifying and binding the prepared pair…",
        error: null,
      });
      if (this.#stale(runId)) return;
      await this.#deps.controller.prepareSession(capturedPlan, current, this.#deps.readers);
      if (this.#stale(runId)) return;
      const bound = this.#deps.controller.state;
      if (bound.snapshot === null || bound.session === "idle" ||
        bound.session === "fatal" || bound.error !== null) {
        this.#emit({
          phase: "error",
          message: "The prepared pair could not be verified and bound. No trial was staged. " +
            "Review the listening error below.",
          error: null,
        });
        return;
      }

      this.#emit({ phase: "staging", message: "Staging trial 1 paused…", error: null });
      if (this.#stale(runId)) return;
      await this.#deps.controller.start();
      if (this.#stale(runId)) return;
      if (this.#deps.controller.state.trial === null) {
        this.#emit({
          phase: "error",
          message: "Trial 1 was not staged. Review the listening status below; no playback started.",
          error: null,
        });
        return;
      }
      this.#emit({
        phase: "ready",
        message: "Trial 1 is paused. Press Play when ready.",
        error: null,
      });
    } catch (reason: unknown) {
      if (!this.#stale(runId)) {
        this.#emit({
          phase: "error",
          message: "Test setup stopped before staging.",
          error: errorMessage(reason),
        });
      }
    } finally {
      if (runId === this.#runId) this.#inFlight = false;
    }
  }

  /**
   * Cancel an in-flight combined setup or the advanced manual preparation.
   * The run identity changes first so every late result is dropped; a session
   * is closed here. The controller invalidates its pending operations; stale
   * completions must not close a replacement session created after cancellation.
   */
  async cancel(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#inFlight && this.lifecycle.state.status !== "preparing") return;
    const wasInFlight = this.#inFlight;
    this.#invalidateRun();
    if (this.lifecycle.state.status === "preparing") this.lifecycle.cancelPrepare();
    if (this.#deps.controller.state.session !== "idle") {
      await this.#deps.controller.closeSession();
    }
    if (wasInFlight) {
      this.#emit({
        phase: "cancelled",
        message: "Test preparation was cancelled. No trial was staged.",
        error: null,
      });
    }
  }

  /**
   * Attempt every cleanup owner in order even when an earlier one fails.
   * Controller disposal precedes the lifecycle join and engine disposal so the
   * listening Worker/player stops before retained material is released.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#invalidateRun();
    this.#listeners.clear();
    this.#disposePromise = Promise.resolve().then(() => this.#disposeOwners());
    return this.#disposePromise;
  }

  async #disposeOwners(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#deps.controller.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.lifecycle.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#deps.engine.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      this.#deps.reportCleanupFailure(failures.map(errorMessage).join("; "));
    }
  }

  #emit(patch: StatePatch): void {
    if (this.#disposed) return;
    const next = { ...this.#state, ...patch };
    this.#state = Object.freeze({
      phase: next.phase,
      busy: busyPhase(next.phase),
      message: next.message,
      error: next.error,
    });
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state);
      } catch {
        // Subscriber isolation is owned by the workflow.
      }
    }
  }

  #setPreparedSignature(signature: string | null): void {
    this.#preparedSignature = signature;
    // Publish even when the identity is unchanged: `isPairReady` also consults
    // the lifecycle owner, and a view may have rendered during a failed release.
    this.#emit({});
  }

  #invalidateRun(): void {
    this.#runId += 1;
    this.#inFlight = false;
  }

  #stale(runId: number): boolean {
    return this.#disposed || runId !== this.#runId;
  }

  #reportPreparationFailure(error: unknown, phase: PreparationErrorPhase): void {
    if (this.#disposed) return;
    this.#deps.publishError(phase === "release"
      ? "Artifact release was not confirmed; the retained artifact stays owned for retry: " +
        errorMessage(error)
      : errorMessage(error));
  }

  #progress(mode: PrepareTestRequestMode): PreparationProgress {
    return {
      phase: "loading",
      message: this.#deps.desktop
        ? "Starting native desktop preparation via the main process’s private worker"
        : mode === "prepare-test"
          ? "Starting browser-local aligned preparation"
          : "Starting browser-local preparation",
    };
  }
}
