import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveOwnedProcess, procStatHasLiveOwnedMember } from "../src/typescript/process-group.js";

test("zombie-only groups are stopped while runnable/stopped descendants remain owned", () => {
  const zombie = "52 (name with ) parentheses) Z 1 50 50 0";
  const dead = "53 (dead) X 1 50 50 0";
  const running = "54 (encoder) R 1 50 50 0";
  const stopped = "55 (encoder) T 1 50 50 0";
  assert.equal([zombie, dead].some(stat => procStatHasLiveOwnedMember(stat, 50, true)), false);
  assert.equal([zombie, running].some(stat => procStatHasLiveOwnedMember(stat, 50, true)), true);
  assert.equal(procStatHasLiveOwnedMember(stopped, 50, true), true);
  assert.equal(procStatHasLiveOwnedMember(running, 51, true), false);
  assert.equal(procStatHasLiveOwnedMember(running, 50, false), false);
  assert.equal(procStatHasLiveOwnedMember(running, 54, false), true);
  assert.equal(procStatHasLiveOwnedMember("2 (kthreadd) S 0 0 0", 50, true), false);
  assert.throws(() => procStatHasLiveOwnedMember("invalid process stat", 50, true));
});

test("OS inspection recognizes a real live process and rejects unsafe PID inputs", async () => {
  assert.equal(await hasLiveOwnedProcess(process.pid, false), true);
  assert.equal(await hasLiveOwnedProcess(2_000_000_000, false), false);
  await assert.rejects(hasLiveOwnedProcess(0, true), /Invalid owned native PID/);
});
