import type { EngineCapabilities, PreparedArtifact, PreparationProgress,
  PreparationRequest, Side, CanarySide } from "@codec-abx/contracts";

export interface PrepareOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PreparationProgress) => void;
}

/**
 * Local source types stay inside adapters: a File in-browser, a path on desktop.
 * No audio data is sent over JSON. One active job per engine instance initially.
 * Reject concurrent work. An aborted prepare rejects only AFTER owned workers,
 * subprocesses and partial outputs have been cleaned up. Release is idempotent.
 * The caller owns and releases each successful artifact. Unknown/released IDs
 * fail closed. Capabilities are observations of this build, never fallback rules.
 */
export interface PreparationEngine<Source> {
  capabilities(): Promise<EngineCapabilities>;
  prepare(source: Source, request: PreparationRequest,
    options?: PrepareOptions): Promise<PreparedArtifact>;
  /** Bounded spike only: future large-file playback should use streams/handles. */
  readAudio(artifactId: string, side: Side): Promise<ArrayBuffer>;
  /** Only adapters advertising canary material implement this. Same ownership as readAudio. */
  readCanaryAudio?(artifactId: string, side: CanarySide): Promise<ArrayBuffer>;
  release(artifactId: string): Promise<void>;
  /** Cancel an active job, await cleanup and release all artifacts. Idempotent. */
  dispose(): Promise<void>;
}
