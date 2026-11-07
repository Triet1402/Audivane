import assert from "node:assert/strict";
import test from "node:test";
import type { ExperimentSnapshot } from "@codec-abx/contracts";
import { buildArtifact, deferred } from "../../experiment/test/fixtures.js";
import type { ExperimentOperation, ExperimentResponse } from "../src/protocol.js";
import { DEFAULT_PLAN } from "./fixtures.js";

test("the real worker handler invalidates queued binding across Reset", async () => {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (response: ExperimentResponse) => void } = {
    onmessage: null,
    postMessage: (response) => {
      const promise = pending.get(response.requestId);
      pending.delete(response.requestId);
      if (response.ok) promise?.resolve(response.result);
      else promise?.reject(response.error);
    },
  };
  const globals = globalThis as { self?: unknown };
  const previous = globals.self;
  globals.self = scope;
  let sequence = 0;
  const send = (operation: ExperimentOperation, payload: Record<string, unknown> = {}): Promise<unknown> => {
    const requestId = String(++sequence);
    const result = new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); });
    scope.onmessage?.({ data: { protocol: "codec-abx-experiment-rpc-v1", version: 1, requestId, operation, ...payload } } as MessageEvent);
    return result;
  };
  const originalDigest = crypto.subtle.digest;
  const gate = deferred();
  const started = deferred();
  try {
    // The production module runs unchanged; only its host message boundary is simulated.
    await import("../src/experiment-worker.js");
    const originalRun = await send("configure", { plan: DEFAULT_PLAN }) as ExperimentSnapshot;
    let first = true;
    Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (first) { first = false; started.resolve(); await gate.promise; }
      return originalDigest.call(crypto.subtle, algorithm, data);
    } });
    const built = buildArtifact();
    const payload = { artifact: built.artifact, a: built.bytes.a.slice().buffer, b: built.bytes.b.slice().buffer, canary: null };
    const firstBind = send("bindPrepared", structuredClone(payload));
    const failedFirst = assert.rejects(firstBind, (error: unknown) => (error as { code: string }).code === "stale-token");
    await started.promise;
    const queuedBind = send("bindPrepared", structuredClone(payload));
    const failedQueued = assert.rejects(queuedBind, (error: unknown) => (error as { code: string }).code === "stale-token");
    const reset = await send("reset") as ExperimentSnapshot;
    assert.notEqual(reset.runId, originalRun.runId);
    gate.resolve();
    await Promise.all([failedFirst, failedQueued]);
    const snapshot = await send("snapshot") as ExperimentSnapshot;
    assert.equal(snapshot.prepared, null, "old queued binding must not change the replacement run");
    await send("dispose");
  } finally {
    gate.resolve();
    Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: originalDigest });
    if (previous === undefined) delete globals.self;
    else globals.self = previous;
  }
});
