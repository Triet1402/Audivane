import type {
  CanarySide,
  DesktopSource,
  EngineCapabilities,
  PreparedArtifact,
  PreparationRequest,
  Side,
} from "@codec-abx/contracts";
import type { PrepareOptions } from "@codec-abx/preparation";
import { BrowserPreparationEngine } from "@codec-abx/engine-browser";
import { BrowserExperimentClient } from "@codec-abx/experiment-browser";

import type { ListeningClient } from "./listening/controller.js";
import { getDesktopBridge } from "./desktop/bridge.js";
import { DesktopExperimentClient } from "./desktop/experiment.js";
import { DesktopPreparationEngine } from "./desktop/preparation.js";

export type ClientRuntimeKind = "browser" | "desktop";

/** A File stays in this tab; a desktop source is only a main-owned handle. */
export type ClientSource =
  | { readonly kind: "file"; readonly file: File }
  | { readonly kind: "desktop"; readonly source: DesktopSource };

export interface ClientPreparationEngine {
  readonly kind: ClientRuntimeKind;
  pickSource(): Promise<ClientSource | null>;
  capabilities(): Promise<EngineCapabilities>;
  prepare(
    source: ClientSource,
    request: PreparationRequest,
    options?: PrepareOptions,
  ): Promise<PreparedArtifact>;
  readAudio(artifactId: string, side: Side): Promise<ArrayBuffer>;
  readCanaryAudio?(artifactId: string, side: CanarySide): Promise<ArrayBuffer>;
  release(artifactId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface ClientRuntime {
  readonly kind: ClientRuntimeKind;
  readonly preparation: ClientPreparationEngine;
  createListeningClient(): ListeningClient;
}

export function sourceName(source: ClientSource | null): string | null {
  if (source === null) return null;
  return source.kind === "file" ? source.file.name : source.source.name;
}

export function sourceSize(source: ClientSource | null): number | null {
  if (source === null) return null;
  return source.kind === "file" ? source.file.size : source.source.size;
}

function createBrowserRuntime(): ClientRuntime {
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  const engine = new BrowserPreparationEngine({
    coreURL: new URL("codec-assets/ffmpeg-core.js", base).href,
    wasmURL: new URL("codec-assets/ffmpeg-core.wasm", base).href,
    lc3WasmURL: new URL("codec-assets/lc3_codec.wasm", base).href,
    ldacWasmURL: new URL("codec-assets/ldac_codec.wasm", base).href,
  });
  return {
    kind: "browser",
    preparation: {
      kind: "browser",
      pickSource: () => Promise.resolve(null),
      capabilities: () => engine.capabilities(),
      prepare: (source, request, options) => {
        if (source.kind !== "file") {
          return Promise.reject(new Error("The browser build accepts a local File source only"));
        }
        return engine.prepare(source.file, request, options);
      },
      readAudio: (artifactId, side) => engine.readAudio(artifactId, side),
      ...(engine.readCanaryAudio
        ? {
            readCanaryAudio: (artifactId: string, side: CanarySide) =>
              engine.readCanaryAudio!(artifactId, side),
          }
        : {}),
      release: (artifactId) => engine.release(artifactId),
      dispose: () => engine.dispose(),
    },
    createListeningClient: () => new BrowserExperimentClient(),
  };
}

function createDesktopRuntime(bridge: NonNullable<ReturnType<typeof getDesktopBridge>>): ClientRuntime {
  const preparation = new DesktopPreparationEngine(bridge.preparation);
  const experiment = bridge.experiment;
  return {
    kind: "desktop",
    preparation: {
      kind: "desktop",
      pickSource: async () => {
        const source = await preparation.pickSource();
        return source === null ? null : { kind: "desktop", source };
      },
      capabilities: () => preparation.capabilities(),
      prepare: (source, request, options) => {
        if (source.kind !== "desktop") {
          return Promise.reject(new Error("The desktop build requires an OS-dialog source handle"));
        }
        return preparation.prepare(source.source, request, options);
      },
      readAudio: (artifactId, side) => preparation.readAudio(artifactId, side),
      readCanaryAudio: (artifactId, side) => preparation.readCanaryAudio(artifactId, side),
      release: (artifactId) => preparation.release(artifactId),
      dispose: () => preparation.dispose(),
    },
    // Every new listening run gets a fresh adapter over the same versioned
    // bridge; disposing one ends main's service and configure creates the next.
    createListeningClient: () => new DesktopExperimentClient(experiment),
  };
}

/**
 * Select the runtime once per mounted application. Plain web keeps the raw
 * browser default and never constructs the desktop adapter; Electron uses the
 * native TypeScript shared-preparation path and never instantiates
 * the browser preparation engine or experiment Worker.
 */
export function detectClientRuntime(): ClientRuntime {
  const bridge = getDesktopBridge();
  return bridge === null ? createBrowserRuntime() : createDesktopRuntime(bridge);
}
