import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_CANARY_EXCERPT_SECONDS, type LevelMeasurement, type PreparationRequest } from "@codec-abx/contracts";
import { assessPairRelation, decodePcm16 } from "@codec-abx/measurements";
import {
  buildCanaryExcerptPair,
  buildCanaryPair,
  evaluateNullGate,
  evaluatePreparationGate,
} from "@codec-abx/preparation-policy";

import { assertCanaryMaterial, assertValidityReport } from "../src/result-validation.js";
import { parsePcm16Wav } from "../src/wav.js";

const RATE = 48_000;
const FRAMES = Math.round(0.6 * RATE);

function pair(): { a: Float64Array; b: Float64Array } {
  const a = new Float64Array(FRAMES);
  let state = 0x5555_aaaa;
  for (let index = 0; index < FRAMES; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    a[index] = (state / 0x1_0000_0000 - 0.5) * 0.4;
  }
  return { a, b: a.slice() };
}

const REQUEST: PreparationRequest = {
  version: 1,
  sampleRateMode: "native",
  a: { codecId: "noop_passthrough", bitrateKbps: 0 },
  b: { codecId: "noop_passthrough", bitrateKbps: 0 },
};
const DEPTH: LevelMeasurement = {
  status: "negative-infinity",
  value: null,
  reason: "exact digital null",
};

function reports() {
  const pcm = pair();
  const relation = assessPairRelation(
    { sampleRate: RATE, channels: [pcm.a] },
    { sampleRate: RATE, channels: [pcm.b] },
    { maxLagSamples: Math.floor(0.1 * RATE), probeSamples: 240_000 },
  );
  const gate = evaluatePreparationGate(relation);
  assert.equal(gate.status, "passed");
  const validity = {
    policy: "delivered-validity-v2" as const,
    nullGate: evaluateNullGate(REQUEST, DEPTH),
    preparationGate: gate,
    notes: ["Fixture v2 validity."],
  };
  return { relation, validity };
}

test("valid v2 validity is re-derived from final relation evidence", () => {
  const { relation, validity } = reports();
  const accepted = assertValidityReport(
    structuredClone(validity),
    REQUEST,
    DEPTH,
    relation,
  );
  assert.equal(accepted.policy, "delivered-validity-v2");
  assert.deepEqual(accepted.preparationGate, validity.preparationGate);
});

test("worker protocol rejects v1, forged, missing and unknown v2 fields", () => {
  const { relation, validity } = reports();
  assert.throws(
    () => assertValidityReport({ ...validity, policy: "delivered-validity-v1" },
      REQUEST, DEPTH, relation),
    /delivered-validity-v2/,
  );
  assert.throws(
    () => assertValidityReport({ ...validity, extra: true }, REQUEST, DEPTH, relation),
    /exactly/,
  );
  const { notes: _notes, ...missingNotes } = validity;
  assert.throws(
    () => assertValidityReport(missingNotes, REQUEST, DEPTH, relation),
    /exactly/,
  );
  const forgedGate = structuredClone(validity);
  (forgedGate.preparationGate as unknown as {
    evidence: { sameConfidence: number };
  }).evidence.sameConfidence += 0.1;
  assert.throws(
    () => assertValidityReport(forgedGate, REQUEST, DEPTH, relation),
    /preparation gate/,
  );
  const unknownGate = structuredClone(validity);
  (unknownGate.preparationGate as unknown as Record<string, unknown>).extra = true;
  assert.throws(
    () => assertValidityReport(unknownGate, REQUEST, DEPTH, relation),
    /exactly/,
  );
});

function longWav(seconds: number): Uint8Array {
  const sampleRate = 48_000;
  const frames = Math.round(seconds * sampleRate);
  const dataSize = frames * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.writeInt16LE(
      Math.round(12_000 * Math.sin((2 * Math.PI * 437.3 * frame) / sampleRate)),
      44 + frame * 2,
    );
  }
  return new Uint8Array(bytes);
}

function decoded(bytes: Uint8Array) {
  const facts = parsePcm16Wav(bytes);
  return decodePcm16(bytes, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
}

function canaryMaterial(material: ReturnType<typeof buildCanaryPair>) {
  return {
    report: material.report,
    pristine: material.pristineWav.buffer.slice(
      material.pristineWav.byteOffset,
      material.pristineWav.byteOffset + material.pristineWav.byteLength,
    ),
    degraded: material.degradedWav.buffer.slice(
      material.degradedWav.byteOffset,
      material.degradedWav.byteOffset + material.degradedWav.byteLength,
    ),
  };
}

test("long-track canary authority accepts only the exact FIRST Side A prefix", async () => {
  const finalA = longWav(12);
  const facts = parsePcm16Wav(finalA);
  const excerptFrames = AUDIO_CANARY_EXCERPT_SECONDS * facts.sampleRate;
  const prefix = buildCanaryExcerptPair(decoded(finalA));
  assert.equal(prefix.report.frames, excerptFrames);
  const accepted = await assertCanaryMaterial(canaryMaterial(prefix), finalA, facts);
  assert.equal(accepted?.report.frames, excerptFrames);
  assert.equal(accepted?.bytes?.pristine.byteLength, prefix.pristineWav.byteLength);

  const pcm = decoded(finalA);
  const suffix = buildCanaryPair({
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => channel.subarray(channel.length - excerptFrames)),
  });
  assert.equal(suffix.report.frames, excerptFrames);
  await assert.rejects(
    assertCanaryMaterial(canaryMaterial(suffix), finalA, facts),
    /FIRST delivered Side A prefix/,
  );
});
