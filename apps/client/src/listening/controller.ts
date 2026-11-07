import {
  requestsEqual,
  type AnswerReceipt,
  type DesktopRuntimeFailure,
  type DisplayAnswer,
  type ExperimentClient,
  type ExperimentExport,
  type ExperimentLifecycle,
  type ExperimentPlan,
  type ExperimentSnapshot,
  type PlaybackLabel,
  type PlaybackSnapshot,
  type PreparedArtifact,
  type PublicTrial,
  type Side,
  type TrialPlayer,
} from "@codec-abx/contracts";

import { buildListeningExport, type ListeningExport } from "./export.js";
import {
  isTrialCurrent,
  listeningArtifactEligibility,
} from "./model.js";
import { trialStartGateBlocker } from "./readiness.js";

export interface ListeningReaders {
  readAudio(artifactId: string, side: Side): Promise<ArrayBuffer>;
  readCanaryAudio?(artifactId: string, side: "pristine" | "degraded"): Promise<ArrayBuffer>;
}

/** Runtime-only binding is intentionally absent from the public ExperimentClient. */
export interface ListeningClient extends ExperimentClient {
  /**
   * Optional proactive runtime failure notification. The browser Worker client
   * omits it; the desktop adapter delegates to the main-owned runtime. A fatal
   * event can arrive while no request is active, including during playback.
   */
  onFatal?(listener: (failure: DesktopRuntimeFailure) => void): () => void;
  bindPrepared(artifact: PreparedArtifact, readers: ListeningReaders): Promise<ExperimentSnapshot>;
}

export interface ListeningControllerDeps {
  createClient(): ListeningClient;
  createPlayer(): TrialPlayer;
}

export type ListeningSession =
  | "idle"
  | "configuring"
  | "configured"
  | "running"
  | "completed"
  | "sealed"
  | "void"
  | "fatal"
  | "closing";

export type ListeningBusy =
  | null
  | "configure"
  | "start"
  | "next"
  | "answer"
  | "load"
  | "reset"
  | "seal"
  | "export"
  | "close";

export type ListeningRetry = "none" | "prepare" | "start" | "load" | "answer" | "next" | "reset";

export interface ListeningIssue {
  readonly code: string | null;
  readonly message: string;
  readonly reasons: readonly string[];
  readonly uncertain: boolean;
  readonly retry: ListeningRetry;
}

export interface ListeningState {
  readonly session: ListeningSession;
  readonly busy: ListeningBusy;
  readonly snapshot: ExperimentSnapshot | null;
  readonly trial: PublicTrial | null;
  readonly playback: PlaybackSnapshot | null;
  readonly feedback: AnswerReceipt | null;
  readonly answered: boolean;
  readonly pendingAnswer: DisplayAnswer | null;
  readonly error: ListeningIssue | null;
  readonly notice: string | null;
  readonly planLocked: boolean;
  readonly canExport: boolean;
  /** A route change/loss after plan lock blocks continuation until Reset. */
  readonly outputBlocked: boolean;
}

const INITIAL_STATE: ListeningState = Object.freeze({
  session: "idle",
  busy: null,
  snapshot: null,
  trial: null,
  playback: null,
  feedback: null,
  answered: false,
  pendingAnswer: null,
  error: null,
  notice: null,
  planLocked: false,
  canExport: false,
  outputBlocked: false,
});

type Listener = (state: ListeningState) => void;

interface ErrorInfo {
  readonly code: string | null;
  readonly message: string;
  readonly reasons: readonly string[];
  readonly uncertain: boolean;
}

function errorInfo(error: unknown): ErrorInfo {
  if (error !== null && typeof error === "object") {
    const value = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly reasons?: unknown;
      readonly uncertain?: unknown;
    };
    return {
      code: typeof value.code === "string" ? value.code : null,
      message: typeof value.message === "string" && value.message.length > 0
        ? value.message
        : "The listening operation failed.",
      reasons: Array.isArray(value.reasons)
        ? value.reasons.filter((item): item is string => typeof item === "string")
        : [],
      uncertain: value.uncertain === true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: null, message, reasons: [], uncertain: false };
}

function isFatalCode(code: string | null): boolean {
  return code === "worker-fatal" || code === "disposed" ||
    code === "worker-start-failed" || code === "protocol-error";
}

function lifecycleSession(lifecycle: ExperimentLifecycle): ListeningSession {
  switch (lifecycle) {
    case "configured": return "configured";
    case "running": return "running";
    case "completed": return "completed";
    case "sealed": return "sealed";
    case "void": return "void";
  }
}

function preparedMatches(snapshot: ExperimentSnapshot, artifact: PreparedArtifact): boolean {
  const prepared = snapshot.prepared;
  return prepared !== null && prepared.artifactId === artifact.id &&
    prepared.sourceSha256 === artifact.sourceSha256 &&
    prepared.aWavSha256 === artifact.a.delivered.wavSha256 &&
    prepared.bWavSha256 === artifact.b.delivered.wavSha256 &&
    prepared.engineId === artifact.engine.engineId && prepared.engineBuild === artifact.engine.build &&
    prepared.preparationLocation === artifact.engine.location &&
    // Full frozen request identity, including every stage in order, policy,
    // opt-in and rate mode. Comparing only the final stage would let a
    // different chain prefix reuse a stale binding.
    requestsEqual(prepared.request, artifact.request);
}

function sameOutput(
  a: PlaybackSnapshot["output"],
  b: PlaybackSnapshot["output"],
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.support === b.support && a.canRequest === b.canRequest &&
    a.pending === b.pending && a.requestedDeviceId === b.requestedDeviceId &&
    a.selectedDeviceId === b.selectedDeviceId && a.observedDeviceId === b.observedDeviceId &&
    a.change === b.change && a.error === b.error &&
    a.devices.length === b.devices.length &&
    a.devices.every((device, index) =>
      device.deviceId === b.devices[index]?.deviceId &&
      device.label === b.devices[index]?.label);
}

function samePlayback(a: PlaybackSnapshot | null, b: PlaybackSnapshot): boolean {
  if (a === null) return false;
  return a.phase === b.phase && a.playing === b.playing && a.selected === b.selected &&
    a.positionSeconds === b.positionSeconds && a.durationSeconds === b.durationSeconds &&
    a.loop.enabled === b.loop.enabled && a.loop.startSeconds === b.loop.startSeconds &&
    a.loop.endSeconds === b.loop.endSeconds && a.deliveredSampleRate === b.deliveredSampleRate &&
    a.outputSampleRate === b.outputSampleRate && a.channels === b.channels &&
    a.error === b.error && a.trial?.token === b.trial?.token &&
    a.selectionRequired === b.selectionRequired &&
    a.carryingPreviousTrial === b.carryingPreviousTrial &&
    sameOutput(a.output, b.output);
}

function freezeMetadata<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeMetadata(child, seen);
    Object.freeze(value);
  }
  return value;
}

/**
 * Browser-local listening state machine.
 *
 * It owns no DOM and imports no runtime service, numerics or assignment code.
 * The UI injects the Worker-backed client and Web Audio player; tests inject
 * structural fakes. Every accepted answer is bound to the current public token.
 */
export class ListeningController {
  readonly #deps: ListeningControllerDeps;
  readonly #listeners = new Set<Listener>();

  #state: ListeningState = INITIAL_STATE;
  #client: ListeningClient | null = null;
  #player: TrialPlayer | null = null;
  #unsubscribePlayer: (() => void) | null = null;
  #unsubscribeFatal: (() => void) | null = null;
  #artifact: PreparedArtifact | null = null;
  #boundIdentity: string | null = null;

  #generation = 0;
  #disposed = false;
  #disposal: Promise<void> | null = null;
  #preAnswerPlayIntent = false;
  #restorePlayIntent = false;
  /** The current pending load belongs to a confirmed-answer continuation. */
  #pendingContinuation = false;
  #bindingNotice: string | null = null;
  #bindingUnconfirmed = false;
  #unconfirmedIdentity: string | null = null;
  #outputBlocked = false;

  constructor(deps: ListeningControllerDeps) {
    this.#deps = deps;
  }

  get state(): ListeningState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(patch: Partial<ListeningState>): void {
    if (this.#disposed) return;
    const next: ListeningState = Object.freeze({ ...this.#state, ...patch });
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch {
        // Subscriber isolation is owned by the controller.
      }
    }
  }

  #issue(
    error: unknown,
    retry: ListeningRetry,
    overrides: Partial<ListeningIssue> = {},
    patch: Partial<ListeningState> = {},
  ): void {
    const info = errorInfo(error);
    const fatal = isFatalCode(info.code) || overrides.code === "worker-fatal";
    if (fatal) this.#player?.reset();
    this.#emit({
      ...patch,
      busy: null,
      error: {
        code: overrides.code ?? info.code,
        message: overrides.message ?? info.message,
        reasons: overrides.reasons ?? info.reasons,
        uncertain: overrides.uncertain ?? info.uncertain,
        retry,
      },
      ...(fatal ? { session: "fatal" as const, canExport: false } : {}),
    });
  }

  #ensureClient(): ListeningClient | null {
    if (this.#client !== null) return this.#client;
    try {
      const client = this.#deps.createClient();
      this.#client = client;
      if (typeof client.onFatal === "function") {
        try {
          // Subscribed once per created client. A fatal event is authoritative
          // even when no request is in flight (for example during playback).
          this.#unsubscribeFatal = client.onFatal((failure) => {
            this.#handleFatal(failure);
          });
        } catch {
          // A client that cannot register its optional fatal channel still
          // reports failures through rejected operations. Browser clients omit
          // the channel entirely, so this is not a fallback engine.
        }
      }
      return client;
    } catch (error) {
      this.#issue(error, "prepare", {
        code: "worker-start-failed",
        message:
          "The experiment runtime could not be started. No fallback service exists in this renderer.",
        reasons: [],
        uncertain: false,
      }, { session: "fatal", canExport: false });
      return null;
    }
  }

  /**
   * Authoritative idle-fatal handling. Audio stops synchronously, late and
   * queued command results are invalidated by the generation bump, and export
   * or answers stay blocked. No replacement run or automatic restart occurs.
   */
  #handleFatal(failure: DesktopRuntimeFailure): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#preAnswerPlayIntent = false;
    this.#restorePlayIntent = false;
    this.#pendingContinuation = false;
    this.#bindingUnconfirmed = false;
    this.#unconfirmedIdentity = null;
    this.#outputBlocked = false;
    this.#player?.reset();
    const playback = this.#player?.snapshot() ?? null;
    this.#emit({
      session: "fatal",
      busy: null,
      trial: null,
      playback,
      feedback: null,
      answered: false,
      pendingAnswer: null,
      canExport: false,
      outputBlocked: false,
      planLocked: this.#state.planLocked,
      error: {
        code: failure.code,
        message: failure.message,
        reasons: [...failure.reasons],
        uncertain: failure.uncertain,
        retry: "none",
      },
      notice:
        "The experiment runtime stopped unexpectedly. Playback was stopped, pending commands were invalidated, " +
        "and answers/exports are unavailable. Close this run and restart the application; no run is recreated automatically.",
    });
  }

  #ensurePlayer(): TrialPlayer | null {
    if (this.#player !== null) return this.#player;
    try {
      const player = this.#deps.createPlayer();
      this.#player = player;
      this.#unsubscribePlayer = player.subscribe((snapshot) => {
        if (this.#disposed) return;
        this.#handlePlaybackSnapshot(player, snapshot);
      });
      return player;
    } catch (error) {
      this.#issue(error, "none", {
        code: "audio-unavailable",
        message: "The Web Audio trial player could not be created.",
        reasons: [],
        uncertain: false,
      });
      return null;
    }
  }

  /**
   * A locked listening run treats any unsolicited output-route change as a
   * calibration-changing event. Pause immediately, expose the change, and block
   * Play/Next/answer until Reset. Never select a fallback or resume.
   */
  #handlePlaybackSnapshot(player: TrialPlayer, snapshot: PlaybackSnapshot): void {
    const change = snapshot.output?.change ?? "none";
    if (
      change !== "none" &&
      this.#state.planLocked &&
      !this.#outputBlocked
    ) {
      this.#outputBlocked = true;
      try {
        player.pause();
      } catch {
        // The player already paused on its own sink-change path.
      }
      const paused = player.snapshot();
      this.#issue(
        {
          code: "output-route-changed",
          message:
            "The browser-reported output route changed after this plan locked. Playback was paused and " +
            "Play, Next and answers are blocked. Reset the run explicitly; no fallback device or automatic " +
            "resume is used, and the existing calibration cannot be assumed valid.",
          reasons: [
            change === "lost"
              ? "The selected output device is no longer available."
              : "The active output route differs from the route at selection time.",
          ],
          uncertain: false,
        },
        "reset",
        {},
        { playback: paused, outputBlocked: true },
      );
      return;
    }
    this.#emit({ playback: snapshot });
  }

  #outputChangeAllowed(): boolean {
    return !this.#disposed && !this.#outputBlocked && !this.#state.planLocked &&
      this.#state.busy === null && !this.#outputOperationPending();
  }

  async refreshOutputDevices(): Promise<void> {
    if (this.#disposed || this.#state.busy !== null) return;
    const player = this.#ensurePlayer();
    if (player === null || typeof player.refreshOutputDevices !== "function") return;
    const generation = this.#generation;
    try {
      const snapshot = await player.refreshOutputDevices();
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#publishAudioState(snapshot, "Output devices could not be refreshed.");
    } catch (error) {
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#issue(error, "none", {}, { playback: player.snapshot() });
    }
  }

  async selectOutputDevice(deviceId: string): Promise<void> {
    if (!this.#outputChangeAllowed()) {
      if (this.#state.planLocked) {
        this.#issue(
          {
            code: "output-locked",
            message:
              "Output changes are locked after the first staged trial. Reset the listening run to change the route.",
          },
          "reset",
        );
      }
      return;
    }
    const player = this.#ensurePlayer();
    if (player === null || typeof player.selectOutputDevice !== "function") {
      this.#issue(
        {
          code: "output-unsupported",
          message: "This player cannot select an output device; the default output remains usable.",
        },
        "none",
      );
      return;
    }
    const generation = this.#generation;
    try {
      const snapshot = await player.selectOutputDevice(deviceId);
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#publishOutputState(snapshot);
    } catch (error) {
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#issue(error, "none", {}, { playback: player.snapshot() });
    }
  }

  async requestOutputDevice(): Promise<void> {
    if (!this.#outputChangeAllowed()) {
      if (this.#state.planLocked) {
        this.#issue(
          {
            code: "output-locked",
            message:
              "Output changes are locked after the first staged trial. Reset the listening run to change the route.",
          },
          "reset",
        );
      }
      return;
    }
    const player = this.#ensurePlayer();
    if (player === null || typeof player.requestOutputDevice !== "function") {
      this.#issue(
        {
          code: "output-chooser-unavailable",
          message: "This player has no explicit output-device chooser.",
        },
        "none",
      );
      return;
    }
    const generation = this.#generation;
    try {
      const snapshot = await player.requestOutputDevice();
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#publishOutputState(snapshot);
    } catch (error) {
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#issue(error, "none", {}, { playback: player.snapshot() });
    }
  }

  #publishOutputState(snapshot: PlaybackSnapshot): void {
    const outputError = snapshot.output?.error ?? null;
    if (outputError !== null) {
      this.#issue(
        { code: "output-selection-failed", message: outputError },
        "none",
        {},
        { playback: snapshot },
      );
      return;
    }
    const output = snapshot.output;
    if (!output || output.pending !== null || output.requestedDeviceId === null ||
        output.selectedDeviceId !== output.requestedDeviceId) {
      this.#emit({ playback: snapshot, notice: "Output selection has not been confirmed." });
      return;
    }
    this.#emit({
      playback: snapshot,
      error: null,
      notice: "Output device selection was applied and playback remains paused.",
    });
  }

  #publishAudioState(playback: PlaybackSnapshot, fallback: string): void {
    this.#emit({
      playback,
      ...(playback.error === null && !this.#outputBlocked ? { error: null } : {}),
    });
    // Resume failures keep verified buffers ready for a user-gesture retry.
    // They are distinct from an atomic load failure, but must still be visible.
    if (playback.phase === "error" || playback.error !== null) {
      this.#issue({ code: "audio-unavailable", message: playback.error ?? fallback }, "none", {
        reasons: ["Use Play to retry audio. If the context is closed, Close this session before starting a new one."],
      }, { playback });
    }
  }

  async prepareSession(
    plan: ExperimentPlan,
    artifact: PreparedArtifact,
    readers: ListeningReaders,
  ): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.busy !== null) return;
    if (this.#state.planLocked) {
      this.#issue(
        { code: "config-locked", message: "Reset the listening run before changing its plan." },
        "reset",
      );
      return;
    }
    const ineligible = listeningArtifactEligibility(artifact);
    if (ineligible !== null) {
      this.#emit({
        error: {
          code: "artifact-invalid",
          message: ineligible,
          reasons: [],
          uncertain: false,
          retry: "none",
        },
        busy: null,
      });
      return;
    }
    // The Worker takes a separate binding snapshot. Keep this captured metadata
    // for identity reconciliation/export so caller mutation cannot relabel it.
    artifact = freezeMetadata(structuredClone(artifact));
    plan = freezeMetadata(structuredClone(plan));
    readers = Object.freeze({
      readAudio: readers.readAudio.bind(readers),
      ...(readers.readCanaryAudio ? { readCanaryAudio: readers.readCanaryAudio.bind(readers) } : {}),
    });
    const client = this.#ensureClient();
    if (client === null) return;
    const player = this.#ensurePlayer();
    if (player === null) return;

    const generation = ++this.#generation;
    this.#pendingContinuation = false;
    this.#bindingNotice = null;
    this.#emit({
      session: "configuring",
      busy: "configure",
      error: null,
      notice: "Configuring the local experiment and verifying the prepared pair…",
      feedback: null,
      answered: false,
      pendingAnswer: null,
    });

    let configured: ExperimentSnapshot | null = null;
    try {
      configured = await client.configure(plan);
      if (generation !== this.#generation || this.#disposed) return;
      const snapshot = await this.#bindIfNeeded(client, artifact, readers, generation, configured);
      if (snapshot === null || generation !== this.#generation || this.#disposed) return;
      this.#artifact = artifact;
      const bindingNotice = this.#bindingNotice;
      this.#bindingNotice = null;
      this.#emit({
        session: lifecycleSession(snapshot.lifecycle),
        busy: null,
        snapshot,
        trial: null,
        playback: player.snapshot(),
        feedback: null,
        answered: false,
        pendingAnswer: null,
        error: null,
        planLocked: snapshot.lockedAtUtc !== null,
        canExport: true,
        notice: bindingNotice ??
          "Plan and prepared pair are verified. Review the commitment and gate status, then start trial 1 explicitly.",
      });
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      const info = errorInfo(error);
      const fatal = isFatalCode(info.code);
      const hasBoundPair = this.#state.snapshot?.prepared !== null &&
        this.#state.snapshot?.prepared !== undefined;
      this.#emit({
        session: fatal
          ? "fatal"
          : configured !== null || this.#state.snapshot !== null
            ? "configured"
            : "idle",
        busy: null,
        canExport: !fatal && hasBoundPair,
        snapshot: configured ?? this.#state.snapshot,
        error: {
          code: info.code,
          message: info.message,
          reasons: info.reasons,
          uncertain: info.uncertain,
          retry: "prepare",
        },
      });
    }
  }

  async #bindIfNeeded(
    client: ListeningClient,
    artifact: PreparedArtifact,
    readers: ListeningReaders,
    generation: number,
    configured: ExperimentSnapshot,
  ): Promise<ExperimentSnapshot | null> {
    const identity = JSON.stringify(artifact);
    if (this.#bindingUnconfirmed) {
      if (this.#unconfirmedIdentity !== identity) {
        throw Object.assign(new Error("Reset or Close before changing metadata for an unconfirmed binding."), { code: "artifact-invalid" });
      }
      const live = await this.#safeSnapshot(client);
      if (generation !== this.#generation || this.#disposed) return null;
      if (live !== null && preparedMatches(live, artifact)) {
        this.#bindingUnconfirmed = false;
        this.#unconfirmedIdentity = null;
        this.#boundIdentity = identity;
        return live;
      }
      throw Object.assign(new Error(
        "The earlier bind is still unconfirmed. Check again, or Reset/Close this run before another binding. No second bind was sent.",
      ), { code: "request-timeout" });
    }
    if (
      this.#boundIdentity === identity &&
      configured.prepared !== null &&
      preparedMatches(configured, artifact)
    ) {
      return configured;
    }
    try {
      const snapshot = await client.bindPrepared(artifact, readers);
      if (generation !== this.#generation || this.#disposed) return null;
      this.#boundIdentity = identity;
      return snapshot;
    } catch (error) {
      const info = errorInfo(error);
      // A timed-out bind may already have committed. Reconcile prepared
      // identity/hashes before any rebinding or staging; never silently rebind.
      if (info.code === "request-timeout") {
        this.#bindingUnconfirmed = true;
        this.#unconfirmedIdentity = identity;
        const reconciled = await this.#safeSnapshot(client);
        if (generation !== this.#generation || this.#disposed) return null;
        if (reconciled !== null && preparedMatches(reconciled, artifact)) {
          this.#bindingUnconfirmed = false;
          this.#unconfirmedIdentity = null;
          this.#boundIdentity = identity;
          this.#bindingNotice =
            "The bind reply timed out, but the live snapshot confirms the exact prepared pair was committed. No second bind was sent.";
          return reconciled;
        }
        throw Object.assign(
          new Error(
            "The prepared bind timed out and its outcome could not be confirmed. " +
            "Do not start a trial or send another bind; retry the explicit check first.",
          ),
          {
            code: "request-timeout",
            reasons: [
              reconciled === null
                ? "The snapshot could not be read after the bind timeout."
                : "The snapshot does not show the requested prepared pair.",
            ],
          },
        );
      }
      throw error;
    }
  }

  async #safeSnapshot(client: ListeningClient): Promise<ExperimentSnapshot | null> {
    try {
      return await client.snapshot();
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    const client = this.#client;
    const player = this.#player;
    const snapshot = this.#state.snapshot;
    if (this.#disposed || this.#state.busy !== null || this.#outputBlocked || this.#outputOperationPending() || this.#state.error?.retry === "prepare" || client === null || player === null ||
        snapshot === null || snapshot.lifecycle !== "configured" || snapshot.lockedAtUtc !== null) {
      return;
    }
    const gateBlocker = trialStartGateBlocker(snapshot, this.#artifact);
    if (gateBlocker !== null) {
      this.#issue(gateBlocker, "prepare", { uncertain: false });
      return;
    }

    const generation = ++this.#generation;
    this.#preAnswerPlayIntent = false;
    this.#restorePlayIntent = false;
    this.#pendingContinuation = false;
    this.#emit({
      busy: "start",
      error: null,
      notice: "Staging the first trial; playback starts paused.",
      feedback: null,
      answered: false,
      pendingAnswer: null,
    });
    try {
      const trial = await client.nextTrial();
      if (generation !== this.#generation || this.#disposed) return;
      const latest = await this.#latestSnapshotFor(client, trial, generation);
      if (latest === null) return;
      await this.#stageTrial(client, player, trial, latest, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      const recovered = await this.#reconcilePending(client, generation);
      if (generation !== this.#generation || this.#disposed) return;
      if (recovered !== null) {
        const latest = await this.#latestSnapshotFor(client, recovered, generation);
        if (latest === null) return;
        await this.#stageTrial(client, player, recovered, latest, generation);
        return;
      }
      const snap = await this.#safeSnapshot(client);
      if (generation !== this.#generation || this.#disposed) return;
      this.#issue(error, errorInfo(error).code === "request-timeout" ? "start" : "prepare", {}, {
        snapshot: snap ?? this.#state.snapshot,
        session: snap ? lifecycleSession(snap.lifecycle) : this.#state.session,
        planLocked: snap?.lockedAtUtc !== null && snap !== null,
      });
    }
  }

  async #reconcilePending(
    client: ListeningClient,
    generation: number,
  ): Promise<PublicTrial | null> {
    const snapshot = await this.#safeSnapshot(client);
    if (generation !== this.#generation || this.#disposed || snapshot === null) return null;
    return snapshot.pendingTrial;
  }

  async #latestSnapshotFor(
    client: ListeningClient,
    trial: PublicTrial,
    generation: number,
    retry: ListeningRetry = "start",
  ): Promise<ExperimentSnapshot | null> {
    const snapshot = await this.#safeSnapshot(client);
    if (generation !== this.#generation || this.#disposed) return null;
    if (
      snapshot === null || snapshot.runId !== trial.runId ||
      snapshot.pendingTrial === null || snapshot.pendingTrial.token !== trial.token
    ) {
      this.#issue(
        {
          code: "stale-response",
          message:
            "The staged trial could not be reconciled with a live snapshot. No partial trial is enabled.",
        },
        retry,
        {},
        { snapshot: snapshot ?? this.#state.snapshot },
      );
      return null;
    }
    return snapshot;
  }

  async #stageTrial(
    client: ListeningClient,
    player: TrialPlayer,
    trial: PublicTrial,
    snapshot: ExperimentSnapshot,
    generation: number,
    continuation = false,
  ): Promise<void> {
    this.#pendingContinuation = continuation;
    this.#emit({
      busy: continuation ? "next" : "start",
      trial,
      snapshot,
      session: lifecycleSession(snapshot.lifecycle),
      planLocked: snapshot.lockedAtUtc !== null,
      canExport: true,
      error: null,
      answered: false,
      feedback: null,
      pendingAnswer: null,
      notice: continuation
        ? "Loading the next A/B/X set while the current audio keeps its clock."
        : trial.kind === "calibration"
          ? "Calibration trial staged. Its X is private; playback starts paused."
          : "Scored trial staged; playback starts paused.",
    });
    let playback: PlaybackSnapshot;
    try {
      playback = await player.loadTrial(
        trial,
        client.readAudio.bind(client),
        continuation ? { carryPrevious: true } : undefined,
      );
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      this.#issue(error, "load", {}, { trial, playback: player.snapshot() });
      return;
    }
    if (generation !== this.#generation || this.#disposed) return;
    const settledOutput = await this.#settleLoadedOutput(player, trial, generation);
    if (settledOutput === null || generation !== this.#generation || this.#disposed) return;
    playback = settledOutput;
    if (this.#outputBlocked) {
      this.#emit({ busy: null, trial, playback });
      return;
    }
    if (
      playback.trial === null || playback.trial.token !== trial.token ||
      playback.trial.runId !== trial.runId
    ) {
      this.#issue(
        {
          code: "stale-response",
          message: "A superseded trial load completed; it was not published.",
        },
        "load",
        {},
        { playback, trial },
      );
      return;
    }
    if (playback.phase === "error") {
      this.#emit({
        busy: null,
        trial,
        playback,
        answered: false,
        feedback: null,
        error: {
          code: "load-failed",
          message: continuation
            ? "The next A/B/X set failed to load atomically. No partial set was published and answers stay disabled. " +
              "The previous trial is retained only as retired monitoring; retry this same pending token or end the test."
            : "The current A/B/X set failed to load atomically. No old or partial audio remains. " +
              "Retry this same pending token.",
          reasons: playback.error === null ? [] : [playback.error],
          uncertain: false,
          retry: "load",
        },
      });
      return;
    }
    if (playback.phase !== "ready") {
      this.#issue(
        {
          code: "invalid-state",
          message: "The player did not publish a complete A/B/X set for this token.",
        },
        "load",
        {},
        { playback, trial },
      );
      return;
    }
    this.#pendingContinuation = false;
    this.#emit({
      busy: null,
      session: this.#state.snapshot === null
        ? this.#state.session
        : lifecycleSession(this.#state.snapshot.lifecycle),
      trial,
      playback,
      answered: false,
      feedback: null,
      pendingAnswer: null,
      error: null,
      notice: continuation
        ? playback.selectionRequired === true
          ? playback.carryingPreviousTrial === true
            ? "Previous trial audio is still playing. Choose A, B or X for the new trial to switch at the shared position."
            : "Choose A, B or X to hear the new trial."
          : null
        : null,
    });
    if (playback.error !== null) {
      this.#restorePlayIntent = false;
      this.#publishAudioState(playback, "Playback resume failed.");
      return;
    }
    if (continuation) {
      // Continuation never starts or resumes the new token on its own; the
      // retired graph keeps its clock and the listener must pick a label.
      this.#restorePlayIntent = false;
      return;
    }
    const restore = this.#restorePlayIntent;
    this.#restorePlayIntent = false;
    if (restore && !this.#outputBlocked && !this.#outputOperationPending()) {
      try {
        const next = await player.play();
        if (generation === this.#generation && !this.#disposed) {
          this.#publishAudioState(next, "Playback resume failed.");
        }
      } catch (error) {
        if (generation === this.#generation && !this.#disposed) {
          this.#issue(error, "none", {}, { playback: player.snapshot() });
        }
      }
    }
  }

  async retryLoad(): Promise<void> {
    const client = this.#client;
    const player = this.#player;
    const trial = this.#state.trial;
    if (this.#disposed || this.#state.busy !== null || this.#outputBlocked || this.#outputOperationPending() || client === null || player === null ||
        trial === null || this.#state.playback?.phase !== "error") {
      return;
    }
    const generation = ++this.#generation;
    const continuation = this.#pendingContinuation;
    this.#emit({ busy: "load", error: null, notice: "Retrying the same pending trial…" });
    let playback: PlaybackSnapshot;
    try {
      playback = await player.loadTrial(
        trial,
        client.readAudio.bind(client),
        continuation ? { carryPrevious: true } : undefined,
      );
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      this.#issue(error, "load", {}, { playback: player.snapshot() });
      return;
    }
    if (generation !== this.#generation || this.#disposed) return;
    const settledOutput = await this.#settleLoadedOutput(player, trial, generation);
    if (settledOutput === null || generation !== this.#generation || this.#disposed) return;
    playback = settledOutput;
    this.#emit({ playback });
    if (playback.phase === "error" || playback.trial?.token !== trial.token) {
      this.#emit({
        busy: null,
        error: {
          code: playback.phase === "error" ? "load-failed" : "stale-response",
          message: playback.phase === "error"
            ? continuation
              ? "The retried next A/B/X set still failed to load. No partial set was published and answers stay disabled; " +
                "retry this same pending token or end the test."
              : "The retried A/B/X set still failed to load. No partial audio was published."
            : "The retry result did not match the pending token.",
          reasons: playback.error === null ? [] : [playback.error],
          uncertain: false,
          retry: "load",
        },
      });
      return;
    }
    this.#pendingContinuation = false;
    this.#emit({
      busy: null,
      error: null,
      notice: continuation && playback.selectionRequired === true
        ? playback.carryingPreviousTrial === true
          ? "Previous trial audio is still playing. Choose A, B or X for the new trial to switch at the shared position."
          : "Choose A, B or X to hear the new trial."
        : null,
    });
    if (playback.error !== null) {
      this.#restorePlayIntent = false;
      this.#publishAudioState(playback, "Playback resume failed.");
      return;
    }
    if (continuation) {
      this.#restorePlayIntent = false;
      return;
    }
    if (this.#restorePlayIntent && !this.#outputBlocked && !this.#outputOperationPending()) {
      this.#restorePlayIntent = false;
      try {
        const next = await player.play();
        if (generation === this.#generation && !this.#disposed) {
          this.#publishAudioState(next, "Playback resume failed.");
        }
      } catch (error) {
        if (generation === this.#generation && !this.#disposed) {
          this.#issue(error, "none", {}, { playback: player.snapshot() });
        }
      }
    }
  }

  async next(): Promise<void> {
    const client = this.#client;
    const player = this.#player;
    const trial = this.#state.trial;
    const snapshot = this.#state.snapshot;
    if (this.#disposed || this.#state.busy !== null || this.#outputBlocked || this.#outputOperationPending() ||
        client === null || player === null ||
        trial === null || !this.#state.answered || snapshot === null ||
        snapshot.lifecycle !== "running") {
      return;
    }
    const oldToken = trial.token;
    const runId = trial.runId;
    const generation = ++this.#generation;
    this.#pendingContinuation = true;
    this.#restorePlayIntent = false;
    this.#emit({ busy: "next", error: null, notice: "Advancing explicitly to the next trial…" });
    let nextTrialValue: PublicTrial;
    try {
      nextTrialValue = await client.nextTrial();
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      const reconciled = await this.#reconcilePending(client, generation);
      if (generation !== this.#generation || this.#disposed) return;
      if (reconciled !== null && reconciled.runId === runId && reconciled.token !== oldToken) {
        const latest = await this.#latestSnapshotFor(client, reconciled, generation, "next");
        if (latest === null) return;
        await this.#stageTrial(client, player, reconciled, latest, generation, true);
        return;
      }
      const snap = await this.#safeSnapshot(client);
      if (generation !== this.#generation || this.#disposed) return;
      const info = errorInfo(error);
      this.#issue(error, info.code === "request-timeout" ? "next" : "none", {}, {
        snapshot: snap ?? this.#state.snapshot,
        session: snap ? lifecycleSession(snap.lifecycle) : this.#state.session,
      });
      return;
    }
    if (generation !== this.#generation || this.#disposed) return;
    if (nextTrialValue.token === oldToken) {
      this.#issue(
        {
          code: "stale-response",
          message: "The service returned the already-answered token; no new trial was loaded.",
        },
        "next",
      );
      return;
    }
    const latest = await this.#latestSnapshotFor(client, nextTrialValue, generation, "next");
    if (latest === null) return;
    await this.#stageTrial(client, player, nextTrialValue, latest, generation, true);
  }

  async answer(label: DisplayAnswer): Promise<void> {
    if (this.#state.pendingAnswer !== null) return;
    return this.#submitAnswer(label, false);
  }

  async #submitAnswer(label: DisplayAnswer, retry: boolean): Promise<void> {
    const client = this.#client;
    const player = this.#player;
    const trial = this.#state.trial;
    const snapshot = this.#state.snapshot;
    if (this.#disposed || this.#state.busy !== null || this.#outputBlocked || this.#outputOperationPending() ||
        client === null || player === null ||
        trial === null || snapshot === null || this.#state.answered ||
        snapshot.lifecycle !== "running" ||
        this.#state.playback === null || this.#state.playback.phase !== "ready" ||
        // A staged continuation has no authoritative current-trial mapping
        // until the listener explicitly picks A, B or X.
        this.#state.playback.selectionRequired === true) {
      return;
    }
    if (!isTrialCurrent(trial, snapshot.runId, this.#state.playback.trial?.token ?? "", trial.runId)) {
      this.#issue(
        { code: "stale-token", message: "Only the fully loaded current token can be answered." },
        "load",
      );
      return;
    }
    if (label !== "A" && label !== "B") return;

    const generation = ++this.#generation;
    // Routine submission never pauses: the immutable sounding graph and its
    // clock keep running while the answer is in flight. A paused trial stays
    // paused because there is no graph to continue.
    if (!retry) this.#preAnswerPlayIntent = this.#state.playback.playing;
    this.#emit({
      busy: "answer",
      pendingAnswer: label,
      error: null,
      notice: null,
    });

    let receipt: AnswerReceipt;
    try {
      receipt = await client.answer(trial.token, label);
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      await this.#handleAnswerError(client, error, trial, label, generation);
      return;
    }
    if (generation !== this.#generation || this.#disposed) return;
    await this.#acceptReceipt(client, receipt, trial, label, generation);
  }

  async #acceptReceipt(
    client: ListeningClient,
    receipt: AnswerReceipt,
    trial: PublicTrial,
    label: DisplayAnswer,
    generation: number,
  ): Promise<void> {
    if (
      receipt.runId !== trial.runId || receipt.token !== trial.token ||
      receipt.answer !== label
    ) {
      this.#issue(
        {
          code: "stale-response",
          message: "The answer receipt did not describe the current token and answer.",
        },
        "none",
        {},
        { pendingAnswer: label },
      );
      return;
    }
    let snapshot: ExperimentSnapshot | null = null;
    let snapshotError: unknown = null;
    try {
      snapshot = await client.snapshot();
    } catch (error) {
      snapshotError = error;
    }
    if (generation !== this.#generation || this.#disposed) return;
    if (snapshotError !== null && isFatalCode(errorInfo(snapshotError).code)) {
      this.#issue(snapshotError, "none", {
        message:
          "The answer was accepted, but the experiment runtime failed before the run snapshot could be read. " +
          "This run is unavailable and no export is claimed to exist.",
      }, {
        feedback: receipt,
        answered: true,
        pendingAnswer: label,
        trial,
      });
      return;
    }
    const sameRun = snapshot !== null && snapshot.runId === trial.runId;
    const terminal = sameRun && snapshot !== null && snapshot.lifecycle !== "running";
    const player = this.#player;
    let stopped: PlaybackSnapshot | null = null;
    if (terminal && player !== null) {
      // Completion/void is terminal: stop and retire any sounding or staged
      // audio rather than leaving the last trial playing after the run ends.
      try {
        stopped = player.pause();
      } catch {
        stopped = null;
      }
    }
    this.#emit({
      feedback: receipt,
      answered: true,
      busy: null,
      pendingAnswer: label,
      error: null,
      playback: stopped ?? this.#state.playback,
      snapshot: sameRun ? snapshot : this.#state.snapshot,
      session: sameRun && snapshot !== null
        ? lifecycleSession(snapshot.lifecycle)
        : this.#state.session,
      planLocked: sameRun && snapshot !== null
        ? snapshot.lockedAtUtc !== null
        : this.#state.planLocked,
      canExport: sameRun ? true : this.#state.canExport,
      notice: sameRun && snapshot !== null && snapshot.lifecycle === "completed"
        ? "Pre-registered N reached. No further trial is offered."
        : sameRun && snapshot !== null && snapshot.lifecycle === "void"
          ? "Calibration failed; this run is terminal void and accepts no scored trials."
          : null,
    });
    if (!terminal && sameRun && snapshot !== null && snapshot.lifecycle === "running" && player !== null) {
      await this.#autoAdvanceAfterAnswer(client, player, trial, label, generation);
    }
  }

  /**
   * Advance only after an exactly-once accepted receipt. The sounding graph is
   * retained while the next token and all three buffers are fetched; a failed
   * continuation keeps only that retired sound and exposes explicit retry.
   */
  async #autoAdvanceAfterAnswer(
    client: ListeningClient,
    player: TrialPlayer,
    answeredTrial: PublicTrial,
    label: DisplayAnswer,
    generation: number,
  ): Promise<void> {
    if (generation !== this.#generation || this.#disposed) return;
    if (this.#outputBlocked) return;
    // A device-change refresh may have started during answer submission. Let it
    // settle (bounded) before drawing the next token so enumeration cannot race
    // the continuation load.
    const settled = await this.#settleLoadedOutput(player, answeredTrial, generation);
    if (settled === null || generation !== this.#generation || this.#disposed) return;
    const advanceGeneration = ++this.#generation;
    this.#pendingContinuation = true;
    this.#emit({
      busy: "next",
      error: null,
      notice: "Answer saved. Staging the next trial without stopping the current graph.",
    });
    let nextTrialValue: PublicTrial;
    try {
      nextTrialValue = await client.nextTrial();
    } catch (error) {
      if (advanceGeneration !== this.#generation || this.#disposed) return;
      const reconciled = await this.#reconcilePending(client, advanceGeneration);
      if (advanceGeneration !== this.#generation || this.#disposed) return;
      if (reconciled !== null && reconciled.runId === answeredTrial.runId &&
          reconciled.token !== answeredTrial.token) {
        const latest = await this.#latestSnapshotFor(client, reconciled, advanceGeneration, "next");
        if (latest === null) return;
        await this.#stageTrial(client, player, reconciled, latest, advanceGeneration, true);
        return;
      }
      const snap = await this.#safeSnapshot(client);
      if (advanceGeneration !== this.#generation || this.#disposed) return;
      this.#issue(error, "next", {}, {
        trial: answeredTrial,
        pendingAnswer: label,
        playback: player.snapshot(),
        snapshot: snap ?? this.#state.snapshot,
        session: snap ? lifecycleSession(snap.lifecycle) : this.#state.session,
      });
      return;
    }
    if (advanceGeneration !== this.#generation || this.#disposed) return;
    if (nextTrialValue.token === answeredTrial.token) {
      this.#issue(
        {
          code: "stale-response",
          message: "The service returned the already-answered token; no new trial was loaded.",
        },
        "next",
        {},
        { trial: answeredTrial, pendingAnswer: label, playback: player.snapshot() },
      );
      return;
    }
    const latest = await this.#latestSnapshotFor(client, nextTrialValue, advanceGeneration, "next");
    if (latest === null) return;
    await this.#stageTrial(client, player, nextTrialValue, latest, advanceGeneration, true);
  }

  async #handleAnswerError(
    client: ListeningClient,
    error: unknown,
    trial: PublicTrial,
    label: DisplayAnswer,
    generation: number,
  ): Promise<void> {
    const info = errorInfo(error);
    const uncertain = info.uncertain || info.code === "request-timeout";
    if (uncertain || info.code === "stale-token") {
      const snapshot = await this.#safeSnapshot(client);
      if (generation !== this.#generation || this.#disposed) return;
      if (snapshot !== null && snapshot.runId === trial.runId) {
        const last = snapshot.lastAnswer;
        if (last !== null && last.token === trial.token && last.answer === label &&
            last.runId === trial.runId) {
          await this.#acceptReceipt(client, last, trial, label, generation);
          if (generation === this.#generation && !this.#disposed) {
            this.#emit({
              notice:
                "The answer reply was uncertain, but lastAnswer on the live snapshot confirms it was accepted exactly once. No new token was requested.",
            });
          }
          return;
        }
        if (snapshot.pendingTrial !== null && snapshot.pendingTrial.token === trial.token) {
          // Same token + same answer is idempotent in the runtime. Retry only
          // this receipt lookup; never redraw or advance.
          try {
            const retried = await client.answer(trial.token, label);
            if (generation !== this.#generation || this.#disposed) return;
            await this.#acceptReceipt(client, retried, trial, label, generation);
            if (generation === this.#generation && !this.#disposed) {
              this.#emit({
                notice:
                  "The same pending token and answer were retried idempotently after an uncertain reply.",
              });
            }
            return;
          } catch (retryError) {
            if (generation !== this.#generation || this.#disposed) return;
            const retryInfo = errorInfo(retryError);
            this.#issue(retryError, "answer", {
              code: retryInfo.code ?? info.code,
              message:
                "The answer may or may not have been accepted, and the same-token retry also failed. " +
                "Do not answer a different token or advance. Retry the exact same label, or reset explicitly.",
              reasons: [...retryInfo.reasons, ...info.reasons],
              uncertain: true,
            }, { trial, pendingAnswer: label, snapshot, session: lifecycleSession(snapshot.lifecycle) });
            return;
          }
        }
        this.#issue(
          {
            code: info.code,
            message:
              "The answer outcome is uncertain and the live snapshot shows no matching receipt or pending token. " +
              "No new token was requested. Reset explicitly if the run is no longer usable.",
            reasons: info.reasons,
            uncertain: true,
          },
          "answer",
          {},
          { trial, pendingAnswer: label, snapshot, session: lifecycleSession(snapshot.lifecycle) },
        );
        return;
      }
    }
    const snapshot = await this.#safeSnapshot(client);
    if (generation !== this.#generation || this.#disposed) return;
    this.#issue(error, "answer", {}, {
      trial,
      pendingAnswer: label,
      snapshot: snapshot ?? this.#state.snapshot,
      session: snapshot ? lifecycleSession(snapshot.lifecycle) : this.#state.session,
    });
  }

  async retryAnswer(): Promise<void> {
    const label = this.#state.pendingAnswer;
    if (label === null) return;
    await this.#submitAnswer(label, true);
  }

  async #settleLoadedOutput(player: TrialPlayer, trial: PublicTrial, generation: number): Promise<PlaybackSnapshot | null> {
    if (this.#outputOperationPending()) {
      this.#emit({ notice: "Waiting for output discovery before enabling this staged token…" });
      const ready = await new Promise<boolean>(resolve => {
        let finished = false;
        let unsubscribe = () => {};
        const finish = (value: boolean) => {
          if (finished) return;
          finished = true; clearTimeout(timer); unsubscribe(); resolve(value);
        };
        const timer = setTimeout(() => finish(false), 5_000);
        unsubscribe = player.subscribe(() => {
          if (generation !== this.#generation || this.#disposed || this.#outputBlocked) finish(false);
          else if (player.snapshot().output?.pending == null) finish(true);
        });
        if (finished) unsubscribe();
      });
      if (generation !== this.#generation || this.#disposed) return null;
      if (!ready && !this.#outputBlocked) {
        this.#outputBlocked = true;
        this.#issue({ code: "output-setup-timeout", message:
          "Output discovery did not settle for the staged token. Reset explicitly before continuing; no new trial was drawn." },
          "reset", {}, { playback: player.snapshot(), trial, outputBlocked: true });
        return null;
      }
    }
    if (this.#outputBlocked) {
      this.#emit({ busy: null, trial, playback: player.snapshot() });
      return null;
    }
    return player.snapshot();
  }

  #outputOperationPending(): boolean {
    return this.#player?.snapshot().output?.pending != null;
  }

  #canControlPlayback(): boolean {
    const playback = this.#state.playback;
    return !this.#disposed && !this.#outputBlocked && !this.#outputOperationPending() && this.#state.busy === null &&
      playback !== null &&
      this.#state.pendingAnswer === null &&
      playback.phase === "ready" && !this.#state.answered &&
      this.#state.snapshot?.lifecycle === "running";
  }

  async play(): Promise<void> {
    const player = this.#player;
    if (!this.#canControlPlayback() || player === null) return;
    // A staged continuation has no authoritative current-trial label yet;
    // starting it would mislabel the retired or unselected audio.
    if (this.#state.playback?.selectionRequired === true) return;
    const generation = this.#generation;
    // Call play() directly from the click path before any await so a suspended
    // AudioContext resume remains a user-gesture request. No autoplay flags.
    const playing = player.play();
    try {
      const snapshot = await playing;
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#publishAudioState(snapshot, "Playback could not start.");
    } catch (error) {
      if (this.#disposed || generation !== this.#generation || player !== this.#player) return;
      this.#issue(error, "none", {}, { playback: player.snapshot() });
    }
  }

  pause(): void {
    const player = this.#player;
    const playback = this.#state.playback;
    const busy = this.#state.busy;
    // Pause must remain available while an answer, continuation or retry load
    // is in flight. Stopping the sounding graph does not cancel the pending
    // operation or its token/receipt state; a confirmed continuation simply
    // stages paused and still requires an explicit pick.
    const interruptible = busy === null || busy === "answer" || busy === "next" ||
      busy === "load";
    if (this.#disposed || this.#outputBlocked || !interruptible ||
        this.#state.snapshot?.lifecycle !== "running" ||
        player === null || playback === null || !playback.playing) {
      return;
    }
    this.#emit({ playback: player.pause() });
  }

  select(label: PlaybackLabel): void {
    const player = this.#player;
    if (!this.#canControlPlayback() || player === null) return;
    if (label !== "A" && label !== "B" && label !== "X") return;
    try {
      this.#publishAudioState(player.select(label), "Audio playback is unavailable.");
    } catch (error) {
      this.#issue(error, "none");
    }
  }

  seek(positionSeconds: number): void {
    const player = this.#player;
    if (!this.#canControlPlayback() || player === null) return;
    try {
      this.#publishAudioState(player.seek(positionSeconds), "Audio playback is unavailable.");
    } catch (error) {
      this.#issue(error, "none");
    }
  }

  setLoop(loop: { readonly enabled: boolean; readonly startSeconds: number; readonly endSeconds: number }): void {
    const player = this.#player;
    if (!this.#canControlPlayback() || player === null) return;
    try {
      this.#publishAudioState(player.setLoop(loop), "Audio playback is unavailable.");
    } catch (error) {
      this.#issue(error, "none");
    }
  }

  async reset(): Promise<void> {
    const client = this.#client;
    const player = this.#player;
    if (this.#disposed || (client === null && player === null)) return;
    const generation = ++this.#generation;
    this.#preAnswerPlayIntent = false;
    this.#restorePlayIntent = false;
    this.#pendingContinuation = false;
    this.#outputBlocked = false;
    const playback = player?.snapshot() ?? null;
    player?.reset();
    this.#emit({
      session: "configuring",
      busy: "reset",
      trial: null,
      playback: player?.snapshot() ?? playback,
      feedback: null,
      answered: false,
      pendingAnswer: null,
      error: null,
      outputBlocked: false,
      notice: "Stopping audio immediately and resetting the experiment run…",
    });
    if (client === null) {
      this.#emit({
        session: "idle",
        busy: null,
        trial: null,
        playback: null,
        snapshot: null,
        planLocked: false,
        canExport: false,
        outputBlocked: false,
        notice: "Player reset. No experiment run was active.",
      });
      return;
    }
    try {
      const snapshot = await client.reset();
      if (generation !== this.#generation || this.#disposed) return;
      // This explicit reset accepts the route observed by the time the new run
      // is confirmed. Events during the await belonged to the retiring run.
      // Clear the player's route marker and the private/public block together.
      if (player?.snapshot().output?.change && player.snapshot().output?.change !== "none") player.reset();
      this.#outputBlocked = false;
      this.#bindingUnconfirmed = false;
      this.#unconfirmedIdentity = null;
      this.#emit({
        session: lifecycleSession(snapshot.lifecycle),
        busy: null,
        snapshot,
        trial: null,
        playback: player?.snapshot() ?? null,
        feedback: null,
        answered: false,
        pendingAnswer: null,
        error: null,
        planLocked: snapshot.lockedAtUtc !== null,
        canExport: this.#artifact !== null && preparedMatches(snapshot, this.#artifact),
        outputBlocked: false,
        notice:
          "Run reset: answers, feedback, plan lock and any output-route block are cleared. The verified prepared pair and gate facts are retained; staging again is explicit.",
      });
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      this.#issue(error, "reset", {}, { playback: player?.snapshot() ?? null });
    }
  }

  async seal(): Promise<void> {
    if (this.#disposed) return;
    // End must stop audible transport promptly even if an answer/next/load is
    // still in flight. If the seal cannot run yet, the caller can close the
    // session; that path invalidates the pending operation and releases audio.
    this.pause();
    const client = this.#client;
    const player = this.#player;
    const snapshot = this.#state.snapshot;
    if (this.#state.busy !== null || client === null || snapshot === null ||
        (snapshot.lifecycle !== "running" && snapshot.lifecycle !== "configured")) {
      return;
    }
    const generation = ++this.#generation;
    player?.pause();
    this.#emit({
      busy: "seal",
      playback: player?.snapshot() ?? this.#state.playback,
      error: null,
      notice: "Sealing this run. Sealing is auditable but is not a final result.",
    });
    try {
      const sealed = await client.seal("sealed explicitly by the listener before completion");
      if (generation !== this.#generation || this.#disposed) return;
      this.#emit({
        busy: null,
        snapshot: sealed,
        session: lifecycleSession(sealed.lifecycle),
        planLocked: sealed.lockedAtUtc !== null,
        canExport: true,
        answered: false,
        notice:
          "Run sealed. No final verdict is claimed and no further answers/trials are accepted. The export is still verifiable.",
      });
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      this.#issue(error, "none");
    }
  }

  async exportPayload(): Promise<ListeningExport | null> {
    const client = this.#client;
    const artifact = this.#artifact;
    if (this.#disposed || this.#state.busy !== null || client === null || artifact === null ||
        !this.#state.canExport || this.#state.session === "fatal") {
      return null;
    }
    const generation = ++this.#generation;
    this.#emit({ busy: "export", error: null });
    try {
      const exported: ExperimentExport = await client.export();
      if (generation !== this.#generation || this.#disposed) return null;
      const payload = buildListeningExport({
        artifact,
        experiment: exported,
        playback: this.#state.playback,
        exportedAt: new Date().toISOString(),
      });
      this.#emit({
        busy: null,
        snapshot: exported.snapshot,
        session: lifecycleSession(exported.snapshot.lifecycle),
        planLocked: exported.snapshot.lockedAtUtc !== null,
        notice: exported.reveal.redacted
          ? "Export is redacted while the run is not terminal. Only already-answered rows are present."
          : "Terminal export includes the runtime reveal and remains auditable with local custody limits.",
      });
      return payload;
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return null;
      this.#issue(error, "none");
      return null;
    }
  }

  syncPlayback(): void {
    if (this.#disposed || this.#player === null) return;
    const next = this.#player.snapshot();
    if (!samePlayback(this.#state.playback, next)) {
      this.#emit({ playback: next });
    }
  }

  /** Explicit release of the Worker/player, keeping the prepared engine artifact. */
  async closeSession(): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.busy === "close") return;
    if (this.#client === null && this.#player === null && this.#state.session === "idle") return;
    const generation = ++this.#generation;
    const player = this.#player;
    const client = this.#client;
    const unsubscribe = this.#unsubscribePlayer;
    const unsubscribeFatal = this.#unsubscribeFatal;
    this.#player = null;
    this.#client = null;
    this.#unsubscribePlayer = null;
    this.#unsubscribeFatal = null;
    this.#artifact = null;
    this.#boundIdentity = null;
    this.#bindingUnconfirmed = false;
    this.#unconfirmedIdentity = null;
    this.#pendingContinuation = false;
    this.#outputBlocked = false;
    player?.reset();
    unsubscribe?.();
    unsubscribeFatal?.();
    this.#emit({
      session: "closing",
      busy: "close",
      trial: null,
      playback: null,
      feedback: null,
      answered: false,
      pendingAnswer: null,
      error: null,
      outputBlocked: false,
      notice: "Closing the listening runtime and Web Audio player…",
      canExport: false,
    });
    try {
      if (player) await player.dispose();
    } catch {
      // Disposal is best effort; references are already dropped.
    }
    try {
      if (client) await client.dispose();
    } catch {
      // The client is idempotent and reports termination requests only.
    }
    if (this.#disposed || generation !== this.#generation) return;
    this.#emit({
      session: "idle",
      busy: null,
      snapshot: null,
      trial: null,
      playback: null,
      feedback: null,
      answered: false,
      pendingAnswer: null,
      error: null,
      notice: "Listening run closed and its local resources released. The prepared diagnostic artifact is untouched.",
      planLocked: false,
      canExport: false,
      outputBlocked: false,
    });
  }

  dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposed = true;
    this.#generation += 1;
    const player = this.#player;
    const client = this.#client;
    const unsubscribe = this.#unsubscribePlayer;
    const unsubscribeFatal = this.#unsubscribeFatal;
    this.#player = null;
    this.#client = null;
    this.#unsubscribePlayer = null;
    this.#unsubscribeFatal = null;
    player?.reset();
    unsubscribe?.();
    unsubscribeFatal?.();
    this.#disposal = (async () => {
      try {
        if (player) await player.dispose();
      } catch {
        // Continue releasing the experiment even if audio teardown fails.
      }
      try {
        if (client) await client.dispose();
      } catch {
        // The renderer lifetime also has an independent main-side cleanup path.
      }
    })();
    return this.#disposal;
  }
}
