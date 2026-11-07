import assert from "node:assert/strict";
import test from "node:test";

import type { ExperimentPlan } from "@codec-abx/contracts";

import { ExperimentService, ExperimentServiceError } from "../src/index.js";
import {
  buildArtifact,
  deterministicOptions,
  makeReaders,
  sine,
  type BuiltArtifact,
} from "./fixtures.js";

const PLAN: ExperimentPlan = Object.freeze({
  version: 1,
  plannedTrials: 8,
  alpha: 0.05,
  labelMode: "fixed",
  calibrationEnabled: false,
});

function service(): ExperimentService {
  return new ExperimentService(deterministicOptions());
}

async function configured(built: BuiltArtifact): Promise<ExperimentService> {
  const instance = service();
  await instance.configure(PLAN);
  await instance.bindPrepared(built.artifact, makeReaders(built));
  return instance;
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<ExperimentServiceError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ExperimentServiceError, `expected service error, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected operation to reject with ${code}`);
}

test("genuine v2 gate is recomputed from served bytes and retains periodic ambiguity", async () => {
  const built = buildArtifact();
  assert.equal(built.validity.policy, "delivered-validity-v2");
  assert.equal(built.validity.preparationGate.status, "passed");
  assert.equal(
    built.validity.preparationGate.classification,
    "same-polarity-periodic-ambiguous",
  );
  assert.match(built.validity.preparationGate.disclosure ?? "", /no unique lag/);
  assert.ok(built.validity.preparationGate.notes.some((note) => note.includes("no unique lag")));

  const instance = await configured(built);
  const snapshot = await instance.snapshot();
  assert.equal(snapshot.gates.preparationStatus, "passed");
  assert.equal(
    snapshot.gates.preparationClassification,
    "same-polarity-periodic-ambiguous",
  );
  assert.match(snapshot.gates.preparationDisclosure ?? "", /no unique lag/);
  assert.equal(snapshot.gates.preparationReason, built.validity.preparationGate.reason);
  assert.equal((await instance.nextTrial()).trialIndex, 1);
  await instance.dispose();
});

test("a failed preparation gate blocks every trial with a stable code", async () => {
  const built = buildArtifact({ a: sine(440), b: sine(660) });
  assert.equal(built.validity.nullGate.status, "not-applicable");
  if (built.validity.policy !== "delivered-validity-v2") {
    throw new Error("fixture v2 expected");
  }
  assert.equal(built.validity.preparationGate.status, "failed");
  assert.equal(built.validity.preparationGate.classification, "weak-or-unrelated");
  const instance = await configured(built);

  const snapshot = await instance.snapshot();
  assert.equal(snapshot.gates.nullStatus, "not-applicable");
  assert.equal(snapshot.gates.preparationStatus, "failed");
  assert.equal(snapshot.gates.preparationClassification, "weak-or-unrelated");
  assert.match(snapshot.gates.preparationReason ?? "", /weak|unrelated|correlation/i);
  assert.equal(snapshot.gates.preparationDisclosure, null);
  assert.ok(snapshot.gates.reasons.includes(snapshot.gates.preparationReason!));

  const error = await expectCode(instance.nextTrial(), "preparation-gate-failed");
  assert.ok(error.reasons.length > 0);
  assert.equal((await instance.snapshot()).pendingTrial, null);
  const exported = await instance.export();
  assert.equal(exported.reveal.redacted, true);
  assert.equal(exported.reveal.secretHex, null);
  await instance.dispose();
});

test("historical delivered-validity-v1 is schema-valid but never authorized or upgraded", async () => {
  const genuine = buildArtifact();
  const historical = structuredClone(genuine.artifact);
  (historical as { validity: unknown }).validity = {
    policy: "delivered-validity-v1",
    nullGate: genuine.validity.nullGate,
    notes: genuine.validity.notes,
  };
  const instance = service();
  await instance.configure(PLAN);
  const error = await expectCode(
    instance.bindPrepared(historical, makeReaders(genuine)),
    "artifact-invalid",
  );
  assert.match(error.message, /delivered-validity-v1|not authorized/i);
  assert.equal((await instance.snapshot()).prepared, null);
  await instance.dispose();
});

test("forged gate decisions, evidence, constants, disclosures and unknown fields are refused", async () => {
  const genuine = buildArtifact();
  assert.equal(genuine.validity.policy, "delivered-validity-v2");

  const forgeries: readonly ((gate: Record<string, unknown>) => void)[] = [
    (gate) => { gate.status = "failed"; },
    (gate) => { gate.classification = "weak-or-unrelated"; },
    (gate) => { gate.disclosure = null; },
    (gate) => { gate.reason = "forged pass"; },
    (gate) => { (gate.evidence as Record<string, unknown>).sameConfidence = 0.999999; },
    (gate) => { (gate.evidence as Record<string, unknown>).chosenLagSamples = 99; },
    (gate) => { (gate.constants as Record<string, unknown>).sameMinConfidence = 0.1; },
    (gate) => { (gate.notes as string[]).push("forged note"); },
    (gate) => { gate.unknownField = true; },
  ];

  for (const forge of forgeries) {
    const artifact = structuredClone(genuine.artifact);
    if (artifact.validity?.policy !== "delivered-validity-v2") {
      throw new Error("fixture v2 expected");
    }
    forge(artifact.validity.preparationGate as unknown as Record<string, unknown>);
    const instance = service();
    await instance.configure(PLAN);
    await expectCode(
      instance.bindPrepared(artifact, makeReaders(genuine)),
      "artifact-invalid",
    );
    await instance.dispose();
  }
});

test("a genuine gate transplanted across different served bytes is refused", async () => {
  const genuine = buildArtifact();
  const unrelated = buildArtifact({ a: sine(440), b: sine(660) });
  assert.equal(unrelated.validity.policy, "delivered-validity-v2");
  if (genuine.validity.policy !== "delivered-validity-v2") {
    throw new Error("fixture v2 expected");
  }
  const transplanted = structuredClone(genuine.artifact);
  (transplanted as { validity: unknown }).validity = {
    ...genuine.validity,
    preparationGate: structuredClone(unrelated.validity.preparationGate),
  };
  const instance = service();
  await instance.configure(PLAN);
  await expectCode(
    instance.bindPrepared(transplanted, makeReaders(genuine)),
    "artifact-invalid",
  );
  await instance.dispose();
});

test("tampered served bytes are refused before any gate decision can be trusted", async () => {
  for (const side of ["a", "b"] as const) {
    const built = buildArtifact();
    const instance = service();
    await instance.configure(PLAN);
    await expectCode(
      instance.bindPrepared(built.artifact, makeReaders(built, { corrupt: side })),
      "artifact-bytes-mismatch",
    );
    assert.equal((await instance.snapshot()).prepared, null);
    await instance.dispose();
  }
});
