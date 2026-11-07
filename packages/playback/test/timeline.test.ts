import assert from "node:assert/strict";
import test from "node:test";

import type { PlaybackLoop } from "@codec-abx/contracts";

import {
  MIN_LOOP_SECONDS,
  advancePosition,
  clampLoop,
  clampPosition,
  positionForLoop,
  validateLoop,
} from "../src/timeline.js";

function loop(startSeconds: number, endSeconds: number): PlaybackLoop {
  return { enabled: true, startSeconds, endSeconds };
}

test("nonloop positions clamp to the clip bounds", () => {
  assert.equal(clampPosition(-1, 2), 0);
  assert.equal(clampPosition(1.5, 2), 1.5);
  assert.equal(clampPosition(3, 2), 2);
  assert.equal(clampPosition(Number.NaN, 2), 0);
});

test("loop positions wrap exactly at [start, end)", () => {
  const region = loop(0.2, 0.5);
  assert.equal(positionForLoop(0.2, region, 1), 0.2);
  assert.equal(positionForLoop(0.499, region, 1), 0.499);
  assert.equal(positionForLoop(0.5, region, 1), 0.2);
  assert.ok(Math.abs(positionForLoop(0.8, region, 1) - 0.2) < 1e-12);
  assert.ok(Math.abs(positionForLoop(0.1, region, 1) - 0.4) < 1e-12);
});

test("advancePosition is shared across a loop and stops at a nonloop end", () => {
  const region = loop(0.2, 0.5);
  assert.ok(Math.abs(advancePosition(0.2, 0.31, region, 1) - 0.21) < 1e-12);
  const disabled: PlaybackLoop = { enabled: false, startSeconds: 0, endSeconds: 1 };
  assert.equal(advancePosition(0.8, 0.5, disabled, 1), 1);
});

test("clampLoop preserves enabled intent when the new clip is long enough", () => {
  assert.deepEqual(clampLoop(loop(0.2, 0.8), 1), loop(0.2, 0.8));
  assert.deepEqual(clampLoop(loop(0.2, 0.8), 0.5), loop(0.2, 0.5));
  assert.deepEqual(clampLoop(loop(0.48, 0.9), 0.5), loop(0.48, 0.5));
  assert.deepEqual(clampLoop(loop(0.2, 0.8), 0.005), {
    enabled: false,
    startSeconds: 0,
    endSeconds: 0.005,
  });
  assert.deepEqual(
    clampLoop({ enabled: false, startSeconds: 9, endSeconds: 12 }, 0.5),
    { enabled: false, startSeconds: 0, endSeconds: 0.5 },
  );
});

test("validateLoop refuses malformed, negative, nonfinite and sub-10 ms loops", () => {
  assert.deepEqual(validateLoop(loop(0.1, 0.2), 1), loop(0.1, 0.2));
  assert.deepEqual(validateLoop({ enabled: false, startSeconds: 0, endSeconds: 0 }, 1), {
    enabled: false,
    startSeconds: 0,
    endSeconds: 1,
  });
  for (const bad of [
    loop(-0.1, 0.2),
    loop(Number.NaN, 0.2),
    loop(0.2, 0.2),
    loop(0.2, 0.209),
    loop(1.1, 1.2),
  ]) {
    assert.throws(() => validateLoop(bad, 1));
  }
});
