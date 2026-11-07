import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreparedArtifact } from "@codec-abx/contracts";

import {
  LISTENING_DEFAULTS,
  preparedArtifactReusable,
  testPreparationSignature,
  type TestPreparationKey,
} from "../src/listening/model.js";

function eligibleArtifact(): PreparedArtifact {
  return {
    purpose: "diagnostic-only",
    engine: {
      location: "browser-local",
      preparationPolicy: "aligned-gain-matched-v1",
      engineId: "engine-ffmpeg-wasm",
      build: "test",
    },
    request: { preparationPolicy: "aligned-gain-matched-v1" },
    preparation: { policy: "aligned-gain-matched-v1" },
    validity: {
      policy: "delivered-validity-v2",
      preparationGate: { policy: "preparation-validity-v2" },
    },
    measurements: { delivered: { policy: "delivered-validity-v2" } },
  } as unknown as PreparedArtifact;
}

const KEY: TestPreparationKey = {
  sourceIdentity: "file:source.wav:1024:1",
  stagesA: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
  stagesB: [{ codecId: "opus", bitrateKbps: 128 }],
  rateMode: "native",
  calibrationEnabled: false,
};

test("the listening plan defaults calibration OFF and the primary action owns the opt-in", () => {
  assert.equal(LISTENING_DEFAULTS.calibrationEnabled, false);
  assert.equal(LISTENING_DEFAULTS.plannedTrials, 8);
  assert.equal(LISTENING_DEFAULTS.alpha, 0.05);
  assert.equal(LISTENING_DEFAULTS.labelMode, "blind_random");
});

test("the prepare-test signature changes with every captured input", () => {
  const base = testPreparationSignature(KEY);
  assert.equal(testPreparationSignature({ ...KEY }), base);
  assert.notEqual(testPreparationSignature({ ...KEY, sourceIdentity: "file:other.wav:1:2" }), base);
  assert.notEqual(testPreparationSignature({
    ...KEY,
    stagesA: [{ codecId: "opus", bitrateKbps: 128 }],
  }), base);
  assert.notEqual(testPreparationSignature({
    ...KEY,
    stagesB: [{ codecId: "opus", bitrateKbps: 96 }],
  }), base);
  assert.notEqual(testPreparationSignature({ ...KEY, rateMode: "force_48k" }), base);
  assert.notEqual(testPreparationSignature({ ...KEY, calibrationEnabled: true }), base);
});

test("a retained artifact is reused only for the same inputs and current eligibility", () => {
  const artifact = eligibleArtifact();
  const signature = testPreparationSignature(KEY);
  assert.equal(preparedArtifactReusable(artifact, signature, signature), true);
  assert.equal(preparedArtifactReusable(artifact, null, signature), false);
  assert.equal(preparedArtifactReusable(artifact, signature, `${signature} `), false);
  assert.equal(preparedArtifactReusable(null, signature, signature), false);

  const raw = {
    ...artifact,
    engine: { ...artifact.engine, preparationPolicy: "codec-probe-only" },
    request: {},
    preparation: undefined,
    validity: undefined,
  } as unknown as PreparedArtifact;
  assert.equal(preparedArtifactReusable(raw, signature, signature), false);

  const historical = {
    ...artifact,
    validity: { policy: "delivered-validity-v1" },
  } as unknown as PreparedArtifact;
  assert.equal(preparedArtifactReusable(historical, signature, signature), false);
});
