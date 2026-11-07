import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreparationProgress, PreparationRequest } from "@codec-abx/contracts";

import {
  PreparationLifecycle,
  type PreparationErrorPhase,
  type PreparationLifecycleState,
} from "../src/preparation/lifecycle.js";

type Source = string;
type Artifact = { readonly id: string };

const REQUEST = {
  version: 1,
  sampleRateMode: "native",
  preparationPolicy: "aligned-gain-matched-v1",
  a: { codecId: "noop_passthrough", bitrateKbps: 0 },
  b: { codecId: "opus", bitrateKbps: 128 },
} as unknown as PreparationRequest;

const PROGRESS: PreparationProgress = { phase: "loading", message: "Starting" };

function waitFor(
  lifecycle: PreparationLifecycle<Source, Artifact>,
  predicate: (state: PreparationLifecycleState<Source, Artifact>) => boolean,
): Promise<PreparationLifecycleState<Source, Artifact>> {
  return new Promise((resolve) => {
    const check = (): void => {
      const state = lifecycle.state;
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = lifecycle.subscribe(check);
    check();
  });
}

async function preparedLifecycle(
  release: (artifactId: string) => Promise<void>,
  errors: { error: unknown; phase: PreparationErrorPhase }[],
): Promise<{ lifecycle: PreparationLifecycle<Source, Artifact>; prepareCalls: () => number }> {
  let calls = 0;
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: async () => ({ id: `artifact-${++calls}` }),
    release,
    isLocked: () => false,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  await waitFor(lifecycle, (state) => state.status === "complete");
  return { lifecycle, prepareCalls: () => calls };
}

test("a prepare release failure settles in error and retains retryable ownership", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  let failNextRelease = false;
  let calls = 0;
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: async () => ({ id: `artifact-${++calls}` }),
    release: async () => {
      if (failNextRelease) {
        failNextRelease = false;
        throw new Error("release acknowledgement missing");
      }
    },
    isLocked: () => false,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  await waitFor(lifecycle, (state) => state.status === "complete");
  assert.equal(lifecycle.state.artifact?.id, "artifact-1");

  failNextRelease = true;
  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  const failed = await waitFor(lifecycle, (state) => state.status === "error");
  assert.equal(failed.artifact?.id, "artifact-1");
  assert.equal(calls, 1, "a new preparation must not start while the old artifact is retained");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "release");

  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  const retried = await waitFor(lifecycle, (state) => state.status === "complete");
  assert.equal(retried.artifact?.id, "artifact-2");
  assert.equal(calls, 2);
});

test("reset release failure settles the reset control, surfaces it and retains source/artifact", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  let failNextRelease = false;
  const { lifecycle } = await preparedLifecycle(async () => {
    if (failNextRelease) {
      failNextRelease = false;
      throw new Error("release still owned");
    }
  }, errors);

  failNextRelease = true;
  assert.equal(await lifecycle.reset(), false);
  const failed = lifecycle.state;
  assert.equal(failed.resetting, false);
  assert.equal(failed.status, "error");
  assert.equal(failed.source, "source.wav");
  assert.equal(failed.artifact?.id, "artifact-1");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "release");

  assert.equal(await lifecycle.reset(), true);
  assert.equal(lifecycle.state.status, "idle");
  assert.equal(lifecycle.state.source, null);
  assert.equal(lifecycle.state.artifact, null);
});

test("source change waits for release and keeps the old source when release fails", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  let failNextRelease = false;
  const { lifecycle } = await preparedLifecycle(async () => {
    if (failNextRelease) {
      failNextRelease = false;
      throw new Error("release not confirmed");
    }
  }, errors);

  failNextRelease = true;
  assert.equal(await lifecycle.chooseSource("other.wav"), false);
  assert.equal(lifecycle.state.source, "source.wav");
  assert.equal(lifecycle.state.artifact?.id, "artifact-1");
  assert.equal(lifecycle.state.status, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "release");

  assert.equal(await lifecycle.chooseSource("other.wav"), true);
  assert.equal(lifecycle.state.source, "other.wav");
  assert.equal(lifecycle.state.artifact, null);
  assert.equal(lifecycle.state.status, "idle");
});

test("a late cancelled result is never published and its failed release remains retryable", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  const releases: string[] = [];
  let resolvePrepare = (_artifact: Artifact): void => undefined;
  let markPrepareStarted = (): void => undefined;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  let failFirstRelease = true;
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: () => new Promise<Artifact>((resolve) => {
      resolvePrepare = resolve;
      markPrepareStarted();
    }),
    release: async (artifactId) => {
      releases.push(artifactId);
      if (failFirstRelease) {
        failFirstRelease = false;
        throw new Error("late release failed");
      }
    },
    isLocked: () => false,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  await prepareStarted;

  const resetting = lifecycle.reset();
  resolvePrepare({ id: "late-artifact" });
  assert.equal(await resetting, true);
  assert.equal(lifecycle.state.status, "idle");
  assert.equal(lifecycle.state.artifact, null);
  assert.deepEqual(releases, ["late-artifact", "late-artifact"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "release");
});

test("a late success after Cancel is not published and failed cleanup is not reported as cancelled", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  let resolvePrepare = (_artifact: Artifact): void => undefined;
  let markPrepareStarted = (): void => undefined;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: () => new Promise<Artifact>((resolve) => {
      markPrepareStarted();
      resolvePrepare = resolve;
    }),
    release: async () => {
      throw new Error("cancel cleanup unconfirmed");
    },
    isLocked: () => false,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  await prepareStarted;
  assert.equal(lifecycle.cancelPrepare(), true);
  resolvePrepare({ id: "late-cancel-success" });
  const failed = await waitFor(lifecycle, (state) => state.status === "error");
  assert.equal(failed.artifact, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "release");
});

test("cancellation cleanup failure is an error, not a false cancelled status", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  let markPrepareStarted = (): void => undefined;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: async (_source, _request, options) => new Promise<Artifact>((_resolve, reject) => {
      markPrepareStarted();
      options.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("cleanup could not be confirmed"), {
          code: "cleanup-unconfirmed",
        }));
      }, { once: true });
    }),
    release: async () => undefined,
    isLocked: () => false,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  assert.equal(lifecycle.beginPrepare(REQUEST, PROGRESS), true);
  await prepareStarted;
  assert.equal(lifecycle.cancelPrepare(), true);
  assert.equal(lifecycle.state.status, "cancelling");
  const failed = await waitFor(lifecycle, (state) => state.status === "error");
  assert.equal(failed.artifact, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "prepare");
});

test("retained cleanup ownership cannot authorize diagnostic reads or late publication", { timeout: 2_000 }, async () => {
  let rejectRelease = (_error: Error): void => undefined;
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  const { lifecycle } = await preparedLifecycle(() => new Promise<void>((_resolve, reject) => {
    rejectRelease = reject;
  }), errors);
  const artifact = lifecycle.state.artifact;
  assert.equal(lifecycle.readableArtifact, artifact);
  assert.equal(lifecycle.completedArtifact, artifact);
  const resetting = lifecycle.reset();
  assert.equal(lifecycle.readableArtifact, null, "release must immediately invalidate a pending read's publication check");
  assert.equal(lifecycle.completedArtifact, null, "pending release also blocks listening reuse");
  rejectRelease(new Error("release unconfirmed"));
  assert.equal(await resetting, false);
  assert.equal(lifecycle.state.artifact, artifact, "keep ownership for cleanup retry");
  assert.equal(lifecycle.readableArtifact, null, "ownership after failed release is not permission to publish audio");
  assert.equal(lifecycle.completedArtifact, null, "cleanup-only ownership cannot authorize listening reuse");
});

test("prepareAndWait resolves the exact prepared artifact for explicit combined flows", { timeout: 2_000 }, async () => {
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: async () => ({ id: "artifact-await" }),
    release: async () => undefined,
    isLocked: () => false,
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  const outcome = await lifecycle.prepareAndWait(REQUEST, PROGRESS);
  assert.equal(outcome?.status, "complete");
  assert.equal(outcome?.status === "complete" ? outcome.artifact.id : null, "artifact-await");
  assert.equal(lifecycle.state.status, "complete");
  assert.equal(lifecycle.state.artifact?.id, "artifact-await");
});

test("prepareAndWait returns a cancelled outcome without publishing a late artifact", { timeout: 2_000 }, async () => {
  let markPrepareStarted = (): void => undefined;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  let resolvePrepare = (_artifact: Artifact): void => undefined;
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: () => new Promise<Artifact>((resolve) => {
      resolvePrepare = resolve;
      markPrepareStarted();
    }),
    release: async () => undefined,
    isLocked: () => false,
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  const waiting = lifecycle.prepareAndWait(REQUEST, PROGRESS);
  await prepareStarted;
  assert.equal(lifecycle.cancelPrepare(), true);
  resolvePrepare({ id: "late-await-artifact" });
  const outcome = await waiting;
  assert.equal(outcome?.status, "cancelled");
  assert.equal(lifecycle.state.status, "cancelled");
  assert.equal(lifecycle.state.artifact, null);
});

test("prepareAndWait returns the preparation error after reporting it", { timeout: 2_000 }, async () => {
  const errors: { error: unknown; phase: PreparationErrorPhase }[] = [];
  const lifecycle = new PreparationLifecycle<Source, Artifact>({
    prepare: async () => {
      throw new Error("prepare exploded");
    },
    release: async () => undefined,
    isLocked: () => false,
    onError: (error, phase) => errors.push({ error, phase }),
  });
  assert.equal(await lifecycle.chooseSource("source.wav"), true);
  const outcome = await lifecycle.prepareAndWait(REQUEST, PROGRESS);
  assert.equal(outcome?.status, "error");
  assert.match(
    outcome?.status === "error" && outcome.error instanceof Error
      ? outcome.error.message
      : "",
    /prepare exploded/,
  );
  assert.equal(lifecycle.state.status, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "prepare");
});
