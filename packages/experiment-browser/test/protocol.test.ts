import assert from "node:assert/strict";
import test from "node:test";

import { ExperimentClientError } from "../src/errors.js";
import {
  EXPERIMENT_PROTOCOL,
  EXPERIMENT_PROTOCOL_VERSION,
  guardExport,
  guardSafeError,
  guardSnapshot,
  parseExperimentRequest,
} from "../src/protocol.js";
import {
  HEX,
  makeArtifact,
  makeExport,
  makeSnapshot,
  makeWav,
} from "./fixtures.js";

function protocolCode(error: unknown): string | null {
  return error instanceof ExperimentClientError ? error.code : null;
}

function expectProtocol(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => protocolCode(error) === "protocol-error");
}

const base = {
  protocol: EXPERIMENT_PROTOCOL,
  version: EXPERIMENT_PROTOCOL_VERSION,
  requestId: "request-1",
};

test("worker requests use an explicit operation allowlist and strict keys", () => {
  const snapshot = parseExperimentRequest({ ...base, operation: "snapshot" });
  assert.equal(snapshot.operation, "snapshot");
  expectProtocol(() => parseExperimentRequest({ ...base, operation: "eval" }));
  expectProtocol(() => parseExperimentRequest({ ...base, protocol: "other", operation: "snapshot" }));
  expectProtocol(() => parseExperimentRequest({ ...base, version: 2, operation: "snapshot" }));
  expectProtocol(() => parseExperimentRequest({
    ...base,
    operation: "snapshot",
    token: "extra",
  }));
  expectProtocol(() => parseExperimentRequest({
    ...base,
    operation: "answer",
    token: "token",
    answer: "X",
  }));
  expectProtocol(() => parseExperimentRequest({
    ...base,
    operation: "readAudio",
    token: "token",
    label: "C",
  }));
});

test("snapshot guards propagate exact preparation gate fields and refuse forged ambiguity", () => {
  const ambiguous = makeSnapshot({
    gates: {
      nullStatus: "not-applicable",
      preparationStatus: "passed",
      preparationClassification: "same-polarity-periodic-ambiguous",
      preparationReason: "periodic evidence",
      preparationDisclosure: "no unique lag: multiple near-best peaks",
      calibrationStatus: "not-configured",
      reasons: [],
    },
  });
  assert.equal(guardSnapshot(ambiguous).gates.preparationStatus, "passed");
  assert.match(
    guardSnapshot(ambiguous).gates.preparationDisclosure ?? "",
    /no unique lag/,
  );
  expectProtocol(() => guardSnapshot({
    ...ambiguous,
    gates: { ...ambiguous.gates, preparationDisclosure: null },
  }));
  expectProtocol(() => guardSnapshot({
    ...ambiguous,
    gates: { ...ambiguous.gates, preparationGateEvidence: {} },
  }));
  expectProtocol(() => guardSnapshot({
    ...ambiguous,
    gates: { ...ambiguous.gates, preparationClassification: null },
  }));
  const measured = makeSnapshot({
    gates: {
      nullStatus: "not-measured",
      preparationStatus: "failed",
      preparationClassification: "weak-or-unrelated",
      preparationReason: "weak same-polarity evidence",
      preparationDisclosure: null,
      calibrationStatus: "not-configured",
      reasons: ["weak same-polarity evidence"],
    },
  });
  assert.equal(guardSnapshot(measured).gates.preparationClassification, "weak-or-unrelated");
  expectProtocol(() => guardSnapshot({
    ...measured,
    gates: { ...measured.gates, preparationStatus: "passed" },
  }));
  expectProtocol(() => guardSnapshot({
    ...measured,
    gates: { ...measured.gates, preparationClassification: "same-polarity-unique" },
  }));
  expectProtocol(() => guardSnapshot({
    ...measured,
    gates: { ...measured.gates, preparationReason: null },
  }));
});

test("bind requests accept only bounded typed binary copies", () => {
  const fixture = makeArtifact({ canary: "usable" });
  const a = makeWav({ seed: 0 }).buffer as ArrayBuffer;
  const b = makeWav({ seed: 1 }).buffer as ArrayBuffer;
  const pristine = makeWav({ seed: 0 }).buffer as ArrayBuffer;
  const degraded = makeWav({ seed: 2 }).buffer as ArrayBuffer;
  const parsed = parseExperimentRequest({
    ...base,
    operation: "bindPrepared",
    artifact: fixture.artifact,
    a,
    b,
    canary: { pristine, degraded },
  });
  assert.equal(parsed.operation, "bindPrepared");
  if (parsed.operation !== "bindPrepared") assert.fail("bind request missing");
  assert.equal(parsed.a, a);
  assert.equal(parsed.b, b);
  expectProtocol(() => parseExperimentRequest({
    ...base,
    operation: "bindPrepared",
    artifact: fixture.artifact,
    a: "not binary",
    b,
    canary: null,
  }));
  expectProtocol(() => parseExperimentRequest({
    ...base,
    operation: "bindPrepared",
    artifact: fixture.artifact,
    a,
    b,
    canary: { pristine, degraded, extra: degraded },
  }));
});

test("public response guards reject private fields and unsafe errors", () => {
  expectProtocol(() => guardSnapshot({ ...makeSnapshot(), secretHex: HEX.a }));
  expectProtocol(() => guardSnapshot({
    ...makeSnapshot(),
    pendingTrial: { ...makeSnapshot().pendingTrial, xSource: "A" },
  }));
  expectProtocol(() => guardExport(makeExport({
    reveal: {
      commitment: HEX.c,
      secretHex: HEX.d,
      xSequence: [],
      redacted: false,
      verifiable: true,
    },
  })));
  assert.equal(guardSafeError({
    code: "artifact-bytes-mismatch",
    message: "safe",
    reasons: ["safe reason"],
  }).code, "artifact-bytes-mismatch");
  expectProtocol(() => guardSafeError({
    code: "worker-fatal",
    message: "unsafe",
    reasons: [],
  }));
  expectProtocol(() => guardSafeError({
    code: "invalid-state",
    message: "unsafe",
    reasons: [],
    stack: "private",
  }));
});

test("exports cannot invent answered rows when there is no pending trial", () => {
  const snapshot = makeSnapshot({ pendingTrial: null });
  const row = {
    runId: snapshot.runId, token: "future-secret", trialIndex: 1,
    kind: "scored" as const, answer: "A" as const, correct: true,
    answeredAtUtc: "2026-01-01T00:00:00.000Z", xSource: "A" as const,
    answerSource: "A" as const, displayMapping: { A: "A" as const, B: "B" as const },
  };
  expectProtocol(() => guardExport(makeExport({ snapshot, trials: [row], reveal: {
    commitment: snapshot.commitment, secretHex: null, xSequence: ["A"],
    redacted: true, verifiable: false,
  } }, snapshot)));
  expectProtocol(() => guardExport(makeExport({ reveal: {
    commitment: HEX.f, secretHex: null, xSequence: [], redacted: true, verifiable: false,
  } }, snapshot)));
});

test("snapshot/export DTOs preserve complete v2 arrays without aliases and reject stage side channels", () => {
  const chain = { version: 2 as const, preparationPolicy: "aligned-gain-matched-v1" as const, canaryEnabled: false,
    sampleRateMode: "native" as const,
    a: [{codecId: "opus" as const, bitrateKbps: 16}, {codecId: "aac" as const, bitrateKbps: 128}],
    b: [{codecId: "aac" as const, bitrateKbps: 128}] };
  const prepared = {artifactId: "artifact-chain", aWavSha256: HEX.a, bWavSha256: HEX.b, sourceSha256: HEX.c,
    engineId: "engine-browser", engineBuild: "test", preparationLocation: "browser-local" as const, request: chain};
  const snapshot = makeSnapshot({prepared});
  const guarded = guardSnapshot(snapshot);
  assert.deepEqual(guarded.prepared!.request, chain);
  assert.ok(Array.isArray(guarded.prepared!.request.a));
  assert.notEqual(guarded.prepared!.request.a, chain.a);
  chain.a[0]!.bitrateKbps = 24;
  assert.equal((guarded.prepared!.request.a as readonly {bitrateKbps: number}[])[0]!.bitrateKbps, 16);
  const exported = guardExport(makeExport({}, snapshot));
  assert.deepEqual(exported.snapshot.prepared!.request, chain);
  for (const a of [[], Array(2), [, chain.a[0]], [chain.a[0], ,], [{codecId: "opus", bitrateKbps: 100}], [{codecId: "opus", bitrateKbps: 16, xSource: "A"}], {0: chain.a[0]}]) {
    expectProtocol(() => guardSnapshot({...snapshot, prepared: {...prepared, request: {...chain, a}}}));
    expectProtocol(() => guardSnapshot({...snapshot, prepared: {...prepared, request: {...chain, b: a}}}));
  }
  expectProtocol(() => guardSnapshot({...snapshot, prepared: {...prepared, request: {...chain, finalA: chain.a[1]}}}));
  expectProtocol(() => guardSnapshot({...snapshot, futureAssignments: ["A"]}));
});
