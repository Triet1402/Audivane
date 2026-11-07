/**
 * Dedicated experiment module Worker.
 *
 * The real runtime service is constructed here with cryptographic defaults and
 * owns the secret, pending assignments, display mappings and receipt cache. The
 * renderer only exchanges strict public DTOs plus transferred audio copies.
 */
import { ExperimentService, ExperimentServiceError } from "@codec-abx/experiment";
import type { CanarySide, PreparedArtifact, Side } from "@codec-abx/contracts";

import {
  errorResponse,
  parseExperimentRequest,
  successResponse,
  type ExperimentOperation,
  type ExperimentRequest,
  type ExperimentResponse,
  type SafeErrorPayload,
} from "./protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: ExperimentResponse, transfer?: Transferable[]): void;
}

interface OwnedBinding {
  readonly artifactId: string;
  readonly a: ArrayBuffer;
  readonly b: ArrayBuffer;
  readonly canary: { readonly pristine: ArrayBuffer; readonly degraded: ArrayBuffer } | null;
}

interface Completed {
  readonly result: unknown;
  readonly transfer?: Transferable[];
}

const scope = self as unknown as WorkerScope;
const service = new ExperimentService();

let owned: OwnedBinding | null = null;
let bindingTail: Promise<void> = Promise.resolve();
let generation = 0;

function releaseBinding(binding: OwnedBinding | null): void {
  if (!binding) return;
  for (const buffer of [
    binding.a,
    binding.b,
    ...(binding.canary ? [binding.canary.pristine, binding.canary.degraded] : []),
  ]) {
    try {
      new Uint8Array(buffer).fill(0);
    } catch {
      // A detached/released buffer is already unusable; dropping the reference
      // is the only remaining obligation.
    }
  }
}

function artifactReaders(artifact: PreparedArtifact, binding: OwnedBinding) {
  const sideBuffer = (side: Side): ArrayBuffer => {
    if (artifact.id !== binding.artifactId) {
      throw new Error("Binding identity changed");
    }
    return side === "a" ? binding.a : binding.b;
  };
  const canaryBuffer = (side: CanarySide): ArrayBuffer => {
    if (artifact.id !== binding.artifactId || binding.canary === null) {
      throw new Error("Canary binding is unavailable");
    }
    return side === "pristine" ? binding.canary.pristine : binding.canary.degraded;
  };
  return {
    // Exact copies: the service independently verifies layout and SHA-256 on
    // the bytes it receives, and never sees the binding buffer itself.
    readAudio: async (artifactId: string, side: Side): Promise<ArrayBuffer> => {
      if (artifactId !== artifact.id) throw new Error("Unknown binding identity");
      return sideBuffer(side).slice(0);
    },
    ...(binding.canary === null
      ? {}
      : {
          readCanaryAudio: async (
            artifactId: string,
            side: CanarySide,
          ): Promise<ArrayBuffer> => {
            if (artifactId !== artifact.id) throw new Error("Unknown binding identity");
            return canaryBuffer(side).slice(0);
          },
        }),
  };
}

async function bindPrepared(
  request: Extract<ExperimentRequest, { operation: "bindPrepared" }>,
): Promise<Completed> {
  const submittedGeneration = generation;
  // Worker-level binding state is committed serially. The service itself also
  // serializes and atomically replaces its verified binding only on success.
  const previous = bindingTail;
  let release!: () => void;
  bindingTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const candidate: OwnedBinding = {
    artifactId: request.artifact.id,
    a: request.a,
    b: request.b,
    canary: request.canary,
  };
  try {
    if (submittedGeneration !== generation) {
      throw new ExperimentServiceError("stale-token", "The run changed while this binding was queued");
    }
    const snapshot = await service.bindPrepared(
      request.artifact,
      artifactReaders(request.artifact, candidate),
    );
    if (submittedGeneration !== generation) {
      throw new ExperimentServiceError("stale-token", "The run changed while this binding was verified");
    }
    const old = owned;
    owned = candidate;
    releaseBinding(old);
    return { result: snapshot };
  } catch (error) {
    releaseBinding(candidate);
    throw error;
  } finally {
    release();
  }
}

async function execute(request: ExperimentRequest): Promise<Completed> {
  switch (request.operation) {
    case "configure":
      return { result: await service.configure(request.plan) };
    case "snapshot":
      return { result: await service.snapshot() };
    case "nextTrial":
      return { result: await service.nextTrial() };
    case "answer":
      return { result: await service.answer(request.token, request.answer) };
    case "readAudio": {
      const value = await service.readAudio(request.token, request.label);
      // The worker hands over its own transferred copy; the service response is
      // never mutated or detached.
      const copy = new Uint8Array(value.slice(0)).buffer as ArrayBuffer;
      return { result: copy, transfer: [copy] };
    }
    case "seal":
      generation += 1;
      return {
        result: await service.seal(request.reason),
      };
    case "reset":
      generation += 1;
      return { result: await service.reset() };
    case "export":
      return { result: await service.export() };
    case "dispose":
      generation += 1;
      await service.dispose();
      releaseBinding(owned);
      owned = null;
      return { result: null };
    case "bindPrepared":
      return bindPrepared(request);
  }
}

function safeError(error: unknown): SafeErrorPayload {
  if (error instanceof ExperimentServiceError) {
    return {
      code: error.code,
      message: error.message.slice(0, 1024),
      reasons: error.reasons.slice(0, 32).map((reason) => reason.slice(0, 1024)),
    };
  }
  if (error instanceof Error && error.name === "ExperimentClientError" &&
      error.message.length > 0 && error.message.length <= 1024) {
    return {
      code: "protocol-error",
      message: error.message,
      reasons: [],
    };
  }
  // Unknown internal failures never serialize a stack, private path, assignment
  // or raw reader error to the renderer.
  return {
    code: "invalid-state",
    message: "The experiment worker could not complete the request",
    reasons: [],
  };
}

function correlate(value: unknown): { requestId: string; operation: ExperimentOperation } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0 ||
      raw.requestId.length > 128) {
    return null;
  }
  if (typeof raw.operation !== "string") return null;
  const operations = new Set<ExperimentOperation>([
    "configure",
    "snapshot",
    "nextTrial",
    "answer",
    "readAudio",
    "seal",
    "reset",
    "export",
    "dispose",
    "bindPrepared",
  ]);
  if (!operations.has(raw.operation as ExperimentOperation)) return null;
  return {
    requestId: raw.requestId,
    operation: raw.operation as ExperimentOperation,
  };
}

scope.onmessage = (event: MessageEvent<unknown>): void => {
  void (async () => {
    let request: ExperimentRequest;
    try {
      request = parseExperimentRequest(event.data);
    } catch (error) {
      const ref = correlate(event.data);
      if (ref === null) return;
      scope.postMessage(errorResponse(ref.requestId, ref.operation, {
        code: "protocol-error",
        message: "The experiment worker rejected a malformed request",
        reasons: [],
      }));
      return;
    }
    try {
      const completed = await execute(request);
      scope.postMessage(
        successResponse(request, completed.result),
        completed.transfer ?? [],
      );
    } catch (error) {
      scope.postMessage(
        errorResponse(request.requestId, request.operation, safeError(error)),
      );
    }
  })();
};
