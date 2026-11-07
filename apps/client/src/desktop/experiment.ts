import type {
  AnswerReceipt,
  DesktopExperimentBridge,
  DesktopRuntimeFailure,
  DisplayAnswer,
  ExperimentExport,
  ExperimentPlan,
  ExperimentSnapshot,
  PlaybackLabel,
  PreparedArtifact,
  PublicTrial,
} from "@codec-abx/contracts";

import type { ListeningClient, ListeningReaders } from "../listening/controller.js";
import { desktopError } from "./bridge.js";

/**
 * Renderer adapter for the main-owned experiment service.
 *
 * Main resolves artifact metadata and audio readers by ID; the renderer never
 * supplies private readers or pending assignments. `bindPrepared` therefore
 * ignores the controller's reader callbacks while the controller still keeps
 * its own request/identity reconciliation against the returned snapshot.
 */
export class DesktopExperimentClient implements ListeningClient {
  readonly #bridge: DesktopExperimentBridge;
  #disposed = false;
  #disposal: Promise<void> | null = null;

  constructor(bridge: DesktopExperimentBridge) {
    this.#bridge = bridge;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw desktopError("disposed", "The desktop experiment client has been disposed");
    }
  }

  /**
   * Delegates the main-owned runtime's optional fatal notification. The
   * preload exposes a version-gated channel; a disposed adapter returns a
   * no-op unsubscribe so callers never crash.
   */
  onFatal(listener: (failure: DesktopRuntimeFailure) => void): () => void {
    if (this.#disposed) return () => undefined;
    const subscribe = this.#bridge.onFatal;
    if (typeof subscribe !== "function") return () => undefined;
    return subscribe.call(this.#bridge, listener);
  }

  async configure(plan: ExperimentPlan): Promise<ExperimentSnapshot> {
    this.#assertLive();
    return await this.#bridge.configure(plan);
  }

  async snapshot(): Promise<ExperimentSnapshot> {
    this.#assertLive();
    return await this.#bridge.snapshot();
  }

  async bindPrepared(
    artifact: PreparedArtifact,
    _readers: ListeningReaders,
  ): Promise<ExperimentSnapshot> {
    this.#assertLive();
    if (!artifact || typeof artifact.id !== "string" || artifact.id.length === 0) {
      throw desktopError("artifact-invalid", "Desktop artifact handle is invalid");
    }
    // Readers come from main-owned artifact bytes, never from the renderer.
    return await this.#bridge.bindPrepared(artifact.id);
  }

  async nextTrial(): Promise<PublicTrial> {
    this.#assertLive();
    return await this.#bridge.nextTrial();
  }

  async answer(token: string, answer: DisplayAnswer): Promise<AnswerReceipt> {
    this.#assertLive();
    return await this.#bridge.answer(token, answer);
  }

  async readAudio(token: string, label: PlaybackLabel): Promise<ArrayBuffer> {
    this.#assertLive();
    return await this.#bridge.readAudio(token, label);
  }

  async seal(reason?: string): Promise<ExperimentSnapshot> {
    this.#assertLive();
    return typeof reason === "string"
      ? await this.#bridge.seal(reason)
      : await this.#bridge.seal();
  }

  async reset(): Promise<ExperimentSnapshot> {
    this.#assertLive();
    return await this.#bridge.reset();
  }

  async export(): Promise<ExperimentExport> {
    this.#assertLive();
    return await this.#bridge.export();
  }

  /** Ends main's current service; a later configure creates the next one. */
  dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposed = true;
    this.#disposal = this.#bridge.dispose().catch((error: unknown) => {
      // A lost renderer/transport already invalidates the run; disposal remains
      // idempotent and the controller drops its reference either way.
      if (error !== null && typeof error === "object") return;
      throw error;
    });
    return this.#disposal;
  }
}
