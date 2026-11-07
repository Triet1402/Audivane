/** Public preload surface. No local filesystem paths or pending assignments. */
import type { CanarySide, EngineCapabilities, PreparedArtifact, PreparationProgress,
  PreparationRequest, Side } from "./index.js";
import type { ExperimentClient, ExperimentSnapshot } from "./experiment.js";

export interface DesktopSource {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

export interface DesktopRuntimeFailure {
  readonly code: "worker-fatal" | "protocol-error" | "disposed";
  readonly message: string;
  readonly reasons: readonly string[];
  readonly uncertain: boolean;
}

export interface DesktopExperimentBridge extends ExperimentClient {
  /** Proactive runtime failure notification; no pending assignment data. */
  onFatal?(listener: (failure: DesktopRuntimeFailure) => void): () => void;
  /** Resolves metadata and readers from main-owned artifacts only. */
  bindPrepared(artifactId: string): Promise<ExperimentSnapshot>;
}

export interface DesktopBridge {
  readonly version: 1;
  readonly preparation: {
    pickSource(): Promise<DesktopSource | null>;
    capabilities(): Promise<EngineCapabilities>;
    prepare(sourceId: string, request: PreparationRequest, jobId: string): Promise<PreparedArtifact>;
    /** Resolves after the cancelled job's owned resources have been cleaned up. */
    cancel(jobId: string): Promise<void>;
    readAudio(artifactId: string, side: Side): Promise<ArrayBuffer>;
    readCanaryAudio(artifactId: string, side: CanarySide): Promise<ArrayBuffer>;
    release(artifactId: string): Promise<void>;
    onProgress(listener: (jobId: string, progress: PreparationProgress) => void): () => void;
  };
  /** Dispose ends the current service; configure explicitly creates the next one. */
  readonly experiment: DesktopExperimentBridge;
}
