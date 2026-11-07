import test from "node:test";
import assert from "node:assert/strict";
import { boundedWorkers } from "../../../tools/verification/workers.js";
test("browser worker budget reserves CPUs, bounds WASM memory and caps large hosts", () => {
  assert.equal(boundedWorkers(48, 124 * 2 ** 30), 8);
  assert.equal(boundedWorkers(8, 4 * 2 ** 30), 2);
  assert.equal(boundedWorkers(4, 32 * 2 ** 30), 2);
  assert.equal(boundedWorkers(1, 1 * 2 ** 30), 1);
});
