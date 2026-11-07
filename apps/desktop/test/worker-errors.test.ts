import assert from "node:assert/strict";
import test from "node:test";
import { PreparationGateRefusalError, evaluatePreparationGate } from "@codec-abx/preparation-policy";
import { assessPairRelation } from "@codec-abx/measurements";
import { errorDTO, publicError } from "../src/worker-protocol.js";

test("desktop worker preserves the trusted preparation refusal and classification", () => {
  const samples = new Float64Array(2048).fill(0.1);
  const pcm = { sampleRate: 48000, channels: [samples] };
  const gate = evaluatePreparationGate(assessPairRelation(pcm, pcm));
  const error = publicError(new PreparationGateRefusalError(gate));
  errorDTO(error);
  assert.equal(error.code, "preparation-gate-failed");
  assert.match(error.message, /non-evidentiary/);
  assert.ok(error.reasons.includes("non-evidentiary"));
  assert.equal(error.uncertain, false);
  const untrusted = publicError(Object.assign(new Error("/private/source/file.wav"), { code: "untrusted-native-code" }));
  assert.equal(untrusted.code, "native-operation-failed");
  assert.doesNotMatch(untrusted.message, /private/);
});
