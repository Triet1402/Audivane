import assert from "node:assert/strict";
import test from "node:test";
import { freezeRequest, finalSelectionForSide } from "../src/index.js";

test("preparation snapshots reject unsupported work and isolate caller mutation", () => {
  const original = { version: 1, sampleRateMode: "native",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "opus", bitrateKbps: 128 } };
  const frozen = freezeRequest(original);
  original.b.bitrateKbps = 64;
  assert.equal(finalSelectionForSide(frozen, "b").bitrateKbps, 128);
  assert.ok(Object.isFrozen(frozen.b));
  const selected = freezeRequest({ ...original, preparationPolicy: "aligned-gain-matched-v1" });
  assert.equal(selected.preparationPolicy, "aligned-gain-matched-v1");
  assert.ok(Object.isFrozen(selected));
  assert.equal(freezeRequest({ ...original, canaryEnabled: true }).canaryEnabled, true);
  assert.equal(freezeRequest({ ...original, canaryEnabled: false }).canaryEnabled, false);
  for (const invalid of [null, { ...original, version: 2 },
    { ...original, preparationPolicy: "invented-policy" },
    { ...original, canaryEnabled: "true" },
    { ...original, a: { codecId: "sim_ldac", bitrateKbps: 990 } },
    { ...original, b: { codecId: "opus", bitrateKbps: NaN } },
    { ...original, a: { codecId: "noop_passthrough", bitrateKbps: 128 } }]) {
    assert.throws(() => freezeRequest(invalid));
  }
});

test("ordered chains freeze every stage and reject malformed or aliased requests", () => {
  const stages = [{ codecId: "opus", bitrateKbps: 16 }, { codecId: "aac", bitrateKbps: 128 }];
  const raw = { version: 2, sampleRateMode: "native", a: stages, b: stages };
  const frozen = freezeRequest(raw);
  assert.equal(frozen.version, 2);
  if (frozen.version !== 2) throw new Error("expected chain");
  assert.notEqual(frozen.a, frozen.b);
  assert.notEqual(frozen.a[0], stages[0]);
  stages[0]!.bitrateKbps = 24;
  assert.equal(frozen.a[0]!.bitrateKbps, 16);
  assert.ok(Object.isFrozen(frozen.a));
  assert.ok(Object.isFrozen(frozen.a[0]));
  for (const invalid of [[], Array(2), [, stages[0]], [stages[0], ,], [...stages, ...stages, stages[0]], { ...stages }, [{ codecId: "sim_aptx", bitrateKbps: 352 }]]) {
    assert.throws(() => freezeRequest({ ...raw, a: invalid }));
    assert.throws(() => freezeRequest({ ...raw, b: invalid }));
  }
  assert.throws(() => freezeRequest({ ...raw, finalA: stages[1] }));
  assert.throws(() => freezeRequest({ ...raw, a: [{ ...stages[0], alias: "opus" }] }));
});
