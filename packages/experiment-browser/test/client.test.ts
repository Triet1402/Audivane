import assert from "node:assert/strict";
import test from "node:test";

import { BrowserExperimentClient, ExperimentClientError } from "../src/index.js";
import type { ExperimentRequest } from "../src/protocol.js";
import {
  DEFAULT_PLAN,
  DEFAULT_RECEIPT,
  FakeExperimentWorker,
  HEX,
  makeArtifact,
  makeExport,
  makeSnapshot,
  makeWav,
  type ArtifactFixture,
} from "./fixtures.js";

function codeOf(error: unknown): string | null {
  return error instanceof ExperimentClientError ? error.code : null;
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<ExperimentClientError> {
  try {
    await operation;
  } catch (error) {
    assert.equal(codeOf(error), code);
    return error as ExperimentClientError;
  }
  assert.fail(`expected ${code}, but the operation resolved`);
}

function client(fake: FakeExperimentWorker, options: {
  readonly requestTimeoutMs?: number;
  readonly bindTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly disposeTimeoutMs?: number;
} = {}): BrowserExperimentClient {
  return new BrowserExperimentClient({
    workerFactory: () => fake,
    ...options,
  });
}

function readersFor(fixture: ArtifactFixture) {
  return {
    readAudio: async (_id: string, side: "a" | "b"): Promise<ArrayBuffer> =>
      (side === "a" ? fixture.a : fixture.b).buffer as ArrayBuffer,
    ...(fixture.canary === null
      ? {}
      : {
          readCanaryAudio: async (
            _id: string,
            side: "pristine" | "degraded",
          ): Promise<ArrayBuffer> =>
            (side === "pristine" ? fixture.canary!.pristine : fixture.canary!.degraded)
              .buffer as ArrayBuffer,
        }),
  };
}

test("configure freezes and copies input before the RPC boundary", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const plan = { ...DEFAULT_PLAN };
  const pending = subject.configure(plan);
  plan.plannedTrials = 999;
  const snapshot = await pending;
  assert.equal(snapshot.plan.plannedTrials, 5);
  const request = fake.requests[0];
  assert.equal(request?.operation, "configure");
  if (request?.operation !== "configure") assert.fail("configure request missing");
  assert.equal(request.plan.plannedTrials, 5);
  assert.equal(Object.isFrozen(request.plan), true);
  assert.equal(request.protocol, "codec-abx-experiment-rpc-v1");
  assert.equal(request.version, 1);
  assert.ok(request.requestId.length > 0);
});

test("malformed current response fails closed without resolving the caller", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  fake.handler = (request, worker) => {
    worker.emitMessage({
      protocol: "codec-abx-experiment-rpc-v1",
      version: 1,
      requestId: request.requestId,
      operation: "snapshot",
      ok: true,
      result: { ...makeSnapshot(), secretHex: HEX.a },
    });
  };
  const error = await expectCode(subject.snapshot(), "protocol-error");
  assert.match(error.message, /invalid result/i);
  // The malformed reply is request-scoped; the Worker is still usable.
  fake.handler = null;
  assert.equal((await subject.snapshot()).runId, "run-unit");
});

test("malformed uncorrelated and wrong-operation replies cannot corrupt pending state", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  fake.handler = () => undefined;
  const pending = subject.snapshot();
  fake.emitMessage({ protocol: "wrong", version: 1, requestId: "unknown" });
  const error = await expectCode(pending, "protocol-error");
  assert.match(error.message, /protocol/i);
  // Protocol violation is fatal and terminates the owned Worker.
  assert.equal(fake.terminated, true);
  await expectCode(subject.snapshot(), "worker-fatal");
});

test("an out-of-order reply resolves only its own request ID and duplicates are benign", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const held: ExperimentRequest[] = [];
  fake.handler = (request) => {
    if (request.operation === "snapshot") held.push(request);
  };
  const first = subject.snapshot();
  const second = subject.snapshot();
  await Promise.resolve();
  assert.equal(held.length, 2);
  fake.handler = null;
  fake.respond(held[1]!, makeSnapshot({ runId: "run-second" }));
  fake.respond(held[0]!, makeSnapshot({ runId: "run-first" }));
  assert.equal((await first).runId, "run-first");
  assert.equal((await second).runId, "run-second");
  // Duplicate/late reply after both settled is ignored.
  fake.respond(held[0]!, makeSnapshot({ runId: "run-late" }));
  assert.equal((await subject.snapshot()).runId, "run-unit");
});

test("a reply correlated to the wrong operation rejects only that request", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  fake.handler = (request, worker) => {
    worker.emitMessage({
      protocol: "codec-abx-experiment-rpc-v1",
      version: 1,
      requestId: request.requestId,
      operation: "answer",
      ok: true,
      result: DEFAULT_RECEIPT,
    });
  };
  await expectCode(subject.snapshot(), "protocol-error");
  fake.handler = null;
  assert.equal((await subject.snapshot()).runId, "run-unit");
});

test("delivered-audio reads use the long-track read deadline", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake, { requestTimeoutMs: 20, readTimeoutMs: 120 });
  fake.handler = () => undefined;
  let settled = false;
  const pending = subject.readAudio("unit-token", "A");
  pending.catch(() => { settled = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false, "read must not use the shorter control timeout");
  await expectCode(pending, "request-timeout");
});

test("late reply after a timeout is ignored and never resolves a later request", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake, { requestTimeoutMs: 20 });
  const held: ExperimentRequest[] = [];
  fake.handler = (request) => {
    if (request.operation === "snapshot") held.push(request);
  };
  await expectCode(subject.snapshot(), "request-timeout");
  fake.handler = null;
  fake.respond(held[0]!, makeSnapshot({ runId: "run-late" }));
  assert.equal((await subject.snapshot()).runId, "run-unit");
});

test("answer timeout is uncertain; retrying the same token returns the same receipt", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake, { requestTimeoutMs: 20 });
  let answers = 0;
  fake.handler = (request, worker) => {
    if (request.operation !== "answer") return;
    answers += 1;
    if (answers === 1) return; // accepted by the service, reply lost
    worker.respond(request, {
      ...DEFAULT_RECEIPT,
      token: request.token,
      answer: request.answer,
    });
  };
  const error = await expectCode(subject.answer("token-uncertain", "A"), "request-timeout");
  assert.equal(error.uncertain, true);
  const receipt = await subject.answer("token-uncertain", "A");
  assert.equal(receipt.token, "token-uncertain");
  assert.equal(receipt.answer, "A");
  assert.equal(fake.requests.filter((request) => request.operation === "answer").length, 2);
  assert.equal(fake.requests.some((request) => request.operation === "nextTrial"), false);
});

test("fatal Worker error rejects pending work, terminates and never redraws a run", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  fake.handler = () => undefined;
  const pending = subject.snapshot();
  fake.emitError();
  await expectCode(pending, "worker-fatal");
  assert.equal(fake.terminated, true);
  const after = fake.requests.length;
  await expectCode(subject.snapshot(), "worker-fatal");
  assert.equal(fake.requests.length, after);
});

test("Worker construction failure is coded and does not fall back", () => {
  assert.throws(
    () => new BrowserExperimentClient({
      workerFactory: () => { throw new Error("constructor exploded"); },
    }),
    (error: unknown) => codeOf(error) === "worker-start-failed",
  );
  assert.throws(
    () => new BrowserExperimentClient({
      workerFactory: () => new FakeExperimentWorker(),
      requestTimeoutMs: 1,
    }),
    (error: unknown) => codeOf(error) === "invalid-request",
  );
});

test("readAudio returns the exact bounded worker ArrayBuffer", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const bytes = makeWav({ seed: 3 });
  fake.handler = (request, worker) => {
    if (request.operation === "readAudio") worker.respond(request, bytes.buffer);
  };
  const result = await subject.readAudio("token-read", "X");
  assert.ok(result instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(result), bytes);
});

test("reset invalidates an in-flight read and discards its late bytes", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const held: ExperimentRequest[] = [];
  fake.handler = (request, worker) => {
    if (request.operation === "readAudio") {
      held.push(request);
      return;
    }
    if (request.operation === "reset") {
      worker.respond(request, makeSnapshot({ runId: "run-reset" }));
    }
  };
  const read = subject.readAudio("token-read", "A");
  const reset = await subject.reset();
  assert.equal(reset.runId, "run-reset");
  await expectCode(read, "stale-response");
  fake.handler = null;
  fake.respond(held[0]!, makeWav({ seed: 4 }).buffer);
  assert.equal((await subject.snapshot()).runId, "run-unit");
});

test("seal invalidates an in-flight read", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  fake.handler = (request, worker) => {
    if (request.operation === "seal") {
      worker.respond(request, makeSnapshot({ lifecycle: "sealed", sealedReason: "stop" }));
    }
  };
  const read = subject.readAudio("token-read", "B");
  await subject.seal("stop");
  await expectCode(read, "stale-response");
});

test("dispose is idempotent, requests service disposal and terminates after its bounded wait", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake, { disposeTimeoutMs: 100 });
  fake.handler = (request) => {
    if (request.operation === "snapshot") return;
    // Deliberately never answer dispose; the client must terminate by deadline.
  };
  const pending = subject.snapshot().catch((error: unknown) => error);
  const first = subject.dispose();
  const second = subject.dispose();
  assert.equal(first, second);
  await first;
  assert.equal(fake.terminated, true);
  assert.ok(fake.requests.some((request) => request.operation === "dispose"));
  const pendingError = await pending;
  assert.equal(codeOf(pendingError), "disposed");
  await subject.dispose();
});

test("export guards reject early secrets and non-terminal reveals", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  fake.handler = (request, worker) => {
    if (request.operation !== "export") return;
    worker.respond(request, makeExport({
      reveal: {
        commitment: HEX.c,
        secretHex: HEX.d,
        xSequence: [],
        redacted: false,
        verifiable: true,
      },
    }));
  };
  await expectCode(subject.export(), "protocol-error");
});

test("export accepts a terminal reveal only with answered audit rows", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const terminal = makeSnapshot({
    lifecycle: "completed",
    statistics: { ...makeSnapshot().statistics, scoredTrials: 1, correctTrials: 1 },
  });
  const row = {
    runId: terminal.runId,
    token: "answered-token",
    trialIndex: 1 as const,
    kind: "scored" as const,
    answer: "A" as const,
    correct: true,
    answeredAtUtc: "2026-01-01T00:00:00.000Z",
    xSource: "A" as const,
    answerSource: "A" as const,
    displayMapping: { A: "A" as const, B: "B" as const },
  };
  fake.handler = (request, worker) => {
    if (request.operation !== "export") return;
    worker.respond(request, makeExport({
      snapshot: terminal,
      trials: [row],
      reveal: {
        commitment: terminal.commitment,
        secretHex: HEX.d,
        xSequence: ["A"],
        redacted: false,
        verifiable: true,
      },
    }, terminal));
  };
  const exported = await subject.export();
  assert.equal(exported.reveal.secretHex, HEX.d);
  assert.equal(exported.trials.length, 1);
});

test("bindPrepared copies canonical bytes, includes canary and never detaches the engine buffers", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const fixture = makeArtifact({ canary: "usable" });
  const snapshot = await subject.bindPrepared(fixture.artifact, readersFor(fixture));
  assert.equal(snapshot.runId, "run-bound");
  const request = fake.requests.find((item) => item.operation === "bindPrepared");
  assert.ok(request && request.operation === "bindPrepared");
  assert.notEqual(request.a, fixture.a.buffer);
  assert.notEqual(request.b, fixture.b.buffer);
  assert.deepEqual(new Uint8Array(request.a), fixture.a);
  assert.deepEqual(new Uint8Array(request.b), fixture.b);
  assert.ok(request.canary !== null);
  assert.deepEqual(new Uint8Array(request.canary.pristine), fixture.canary!.pristine);
  assert.deepEqual(new Uint8Array(request.canary.degraded), fixture.canary!.degraded);
  assert.equal(Object.isFrozen(request.artifact), true);
  // The external owner's retained bytes are untouched.
  assert.equal(fixture.a.byteLength, makeWav({ seed: 0 }).byteLength);
  assert.equal(fixture.b.byteLength, makeWav({ seed: 1 }).byteLength);
  const transfer = fake.transfers[fake.requests.indexOf(request)] ?? [];
  assert.deepEqual(transfer, [
    request.a,
    request.b,
    request.canary.pristine,
    request.canary.degraded,
  ]);
});

test("bindPrepared does not read or transfer unusable/missing canary material", async () => {
  for (const kind of ["unusable", "none"] as const) {
    const fake = new FakeExperimentWorker();
    const subject = client(fake);
    const fixture = makeArtifact({ canary: kind });
    let canaryReads = 0;
    await subject.bindPrepared(fixture.artifact, {
      readAudio: async (_id, side) => (side === "a" ? fixture.a : fixture.b).buffer as ArrayBuffer,
      readCanaryAudio: async () => {
        canaryReads += 1;
        throw new Error("must not be called");
      },
    });
    const bind = fake.requests.find((item) => item.operation === "bindPrepared");
    assert.ok(bind && bind.operation === "bindPrepared");
    assert.equal(bind.canary, null);
    assert.equal(canaryReads, 0);
  }
});

test("bindPrepared fails closed for corrupt bytes and unusable readers before posting", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const fixture = makeArtifact();
  await expectCode(subject.bindPrepared(fixture.artifact, {
    readAudio: async () => new Uint8Array([1, 2, 3]).buffer,
  }), "artifact-bytes-mismatch");
  assert.equal(fake.requests.some((request) => request.operation === "bindPrepared"), false);

  await expectCode(subject.bindPrepared(fixture.artifact, {
    readAudio: async () => { throw new Error("reader exploded"); },
  }), "artifact-reader-unavailable");
  assert.equal(fake.requests.some((request) => request.operation === "bindPrepared"), false);

  const corruptCanary = makeArtifact({ canary: "usable" });
  await expectCode(subject.bindPrepared(corruptCanary.artifact, {
    readAudio: async (_id, side) => (side === "a" ? corruptCanary.a : corruptCanary.b).buffer as ArrayBuffer,
    readCanaryAudio: async () => new Uint8Array([9, 9]).buffer,
  }), "artifact-bytes-mismatch");
});

test("reset during bind reads discards copies and does not post a stale binding", async () => {
  const fake = new FakeExperimentWorker();
  const subject = client(fake);
  const fixture = makeArtifact();
  let releaseReads!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReads = resolve; });
  const binding = subject.bindPrepared(fixture.artifact, {
    readAudio: async (_id, side) => {
      await gate;
      return (side === "a" ? fixture.a : fixture.b).buffer as ArrayBuffer;
    },
  });
  const reset = await subject.reset();
  assert.equal(reset.runId, "run-reset");
  releaseReads();
  await expectCode(binding, "stale-response");
  assert.equal(fake.requests.some((request) => request.operation === "bindPrepared"), false);
  // Copies were discarded, not detached from the retained fixture buffers.
  assert.equal(fixture.a.byteLength, makeWav({ seed: 0 }).byteLength);
});

test("binding preflight reads time out and invalidate without waiting for readers", async () => {
  for (const action of ["timeout", "reset", "dispose"] as const) {
    const fake = new FakeExperimentWorker();
    const subject = client(fake, { bindTimeoutMs: 20, disposeTimeoutMs: 100 });
    const fixture = makeArtifact();
    const binding = subject.bindPrepared(fixture.artifact, {
      readAudio: async () => new Promise<ArrayBuffer>(() => undefined),
    });
    const error = expectCode(binding, action === "timeout" ? "request-timeout"
      : action === "reset" ? "stale-response" : "disposed");
    if (action === "reset") await subject.reset();
    if (action === "dispose") await subject.dispose();
    await Promise.race([error, new Promise((_, reject) => setTimeout(() => reject(new Error("bind remained stuck behind a reader")), 100))]);
    assert.equal(fake.requests.some((request) => request.operation === "bindPrepared"), false);
    await subject.dispose();
  }
});
