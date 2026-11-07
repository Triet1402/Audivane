import test from "node:test";
import assert from "node:assert/strict";
import { guardPreparedArtifact } from "../src/prepared-artifact.js";
import { publicNativeArtifact } from "./artifact-fixture.js";

test("public preparation guard rejects private fields at every nested DTO boundary", () => {
  const artifact = publicNativeArtifact();
  assert.doesNotThrow(() => guardPreparedArtifact(artifact));
  const paths = [[], ["request"], ["request", "a"], ["a"], ["a", "requested"], ["a", "delivered"],
    ["engine"], ["measurements"], ["measurements", "delivered"], ["measurements", "delivered", "a"],
    ["measurements", "delivered", "a", "integratedLufs"], ["measurements", "delivered", "alignment"],
    ["measurements", "delivered", "nullDepth"], ["preparation"], ["preparation", "loudness"],
    ["preparation", "serialization"], ["validity"], ["validity", "nullGate"],
    ["validity", "preparationGate"], ["validity", "preparationGate", "evidence"],
    ["validity", "preparationGate", "constants"],
    ["canary"], ["canary", "report"], ["canary", "audio"], ["canary", "audio", "pristine"]];
  for (const path of paths) {
    const copy = structuredClone(artifact);
    let target = copy as unknown as Record<string, unknown>;
    for (const key of path) target = target[key] as Record<string, unknown>;
    target.sourcePath = "/private/not-public.wav";
    assert.throws(() => guardPreparedArtifact(copy), path.join(".") || "root");
  }
});
test("desktop guard accepts only the actual shared native engine policy", () => {
  const base = publicNativeArtifact();
  // A policy outside the installed engine's supported set is rejected rather
  // than relabelled as the shared engine.
  assert.throws(() => guardPreparedArtifact({
    ...base,
    request: { ...base.request, preparationPolicy: "unknown-policy-v0" as never },
  }));
  assert.throws(() => guardPreparedArtifact({
    ...base,
    engine: { ...base.engine, engineId: "engine-native" },
  }));
  assert.throws(() => guardPreparedArtifact({
    ...base,
    measurements: { ...base.measurements, policy: "delivered-pcm-measurements-v1" },
  }));
  // Historical v1 validity is refused for production, as are forged/unknown v2
  // fields and a gate whose classification/status/disclosure do not agree.
  assert.throws(() => guardPreparedArtifact({
    ...base,
    validity: {
      policy: "delivered-validity-v1",
      nullGate: base.validity!.nullGate,
      notes: [],
    },
  }));
  assert.throws(() => guardPreparedArtifact({
    ...base,
    validity: { ...base.validity!, unexpected: true },
  }));
  assert.throws(() => guardPreparedArtifact({
    ...base,
    validity: {
      ...base.validity!,
      preparationGate: { ...base.validity!.preparationGate, unexpected: true },
    },
  }));
  assert.throws(() => guardPreparedArtifact({
    ...base,
    validity: {
      ...base.validity!,
      preparationGate: {
        ...base.validity!.preparationGate,
        status: "passed",
        classification: "globally-inverted",
      },
    },
  }));
});
test("public preparation guard refuses malformed requests, stages and measurements", () => {
  const base = publicNativeArtifact();
  const { delivered: _a, ...a } = base.a;
  const { delivered: _b, ...b } = base.b;
  const chain = { ...base, request: { ...base.request, version: 2 as const, a: [base.a.requested], b: [base.b.requested] },
    a: { ...base.a, stages: [{ stageIndex: 1, ...a }] },
    b: { ...base.b, stages: [{ stageIndex: 1, ...b }] } };
  assert.doesNotThrow(() => guardPreparedArtifact(chain));
  assert.throws(() => guardPreparedArtifact({ ...chain, a: { ...chain.a,
    stages: [{ ...chain.a.stages[0], sourcePath: "/private" }] } }));
  assert.throws(() => guardPreparedArtifact({ ...chain, a: { ...chain.a,
    stages: [{ ...chain.a.stages[0], stageIndex: 2 }] } }));
  assert.throws(() => guardPreparedArtifact({ ...base, request: { ...base.request, version: 3 } }));
  assert.throws(() => guardPreparedArtifact({ ...base, measurements: { ...base.measurements, alignmentConfidence: NaN } }));
});
