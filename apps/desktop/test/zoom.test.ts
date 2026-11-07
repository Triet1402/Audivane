import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  ZOOM_FACTORS,
  ZOOM_STATE_VERSION,
  normalizeZoomFactor,
  parseZoomState,
  readZoomState,
  serializeZoomState,
  writeZoomState,
  zoomActionForKey,
  zoomFactorForAction,
  type ZoomKeyInput,
} from "../src/zoom.js";

const key = (overrides: Partial<ZoomKeyInput>): ZoomKeyInput => ({
  type: "keyDown", key: "=", code: "Equal", control: false, meta: false, alt: false, ...overrides,
});

test("zoom policy clamps and snaps every value onto the bounded usable ladder", () => {
  assert.equal(MIN_ZOOM_FACTOR, 0.8);
  assert.equal(MAX_ZOOM_FACTOR, 2);
  assert.equal(DEFAULT_ZOOM_FACTOR, 1);
  assert.deepEqual([...ZOOM_FACTORS], [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(normalizeZoomFactor(invalid), 1);
  assert.equal(normalizeZoomFactor(-2), 0.8);
  assert.equal(normalizeZoomFactor(0.5), 0.8);
  assert.equal(normalizeZoomFactor(0.84), 0.8);
  assert.equal(normalizeZoomFactor(0.86), 0.9);
  assert.equal(normalizeZoomFactor(1.13), 1.1);
  assert.equal(normalizeZoomFactor(1.24), 1.25);
  assert.equal(normalizeZoomFactor(1.9), 2);
  assert.equal(normalizeZoomFactor(50), 2);
});

test("zoom actions step within bounds and Actual Size always returns to 100%", () => {
  assert.equal(zoomFactorForAction(1, "in"), 1.1);
  assert.equal(zoomFactorForAction(1.25, "out"), 1.1);
  assert.equal(zoomFactorForAction(1.13, "in"), 1.25);
  assert.equal(zoomFactorForAction(1.13, "out"), 1);
  assert.equal(zoomFactorForAction(50, "in"), 2);
  assert.equal(zoomFactorForAction(-1, "out"), 0.8);
  assert.equal(zoomFactorForAction(0.8, "out"), 0.8);
  assert.equal(zoomFactorForAction(2, "in"), 2);
  assert.equal(zoomFactorForAction(0.8, "reset"), 1);
  assert.equal(zoomFactorForAction(2, "reset"), 1);
});

test("persisted zoom parsing rejects malformed or unknown state and bounds usable values", () => {
  assert.equal(parseZoomState(undefined), 1);
  assert.equal(parseZoomState(null), 1);
  assert.equal(parseZoomState(""), 1);
  assert.equal(parseZoomState("{"), 1);
  assert.equal(parseZoomState("[]"), 1);
  assert.equal(parseZoomState("null"), 1);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION })), 1);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION + 1, zoomFactor: 1.25 })), 1);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: "1.5" })), 1);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: true })), 1);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: null })), 1);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: 0.5 })), 0.8);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: 50 })), 2);
  assert.equal(parseZoomState(JSON.stringify({ version: ZOOM_STATE_VERSION, zoomFactor: 1.13 })), 1.1);
  assert.equal(parseZoomState(serializeZoomState(1.25)), 1.25);
  assert.deepEqual(JSON.parse(serializeZoomState(1.25)), { version: ZOOM_STATE_VERSION, zoomFactor: 1.25 });
});

test("local zoom persistence round-trips and never breaks startup on missing or corrupt files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-zoom-"));
  const file = path.join(directory, "nested", "zoom.json");
  try {
    assert.equal(readZoomState(file), 1);
    writeZoomState(file, 1.25);
    assert.equal(readZoomState(file), 1.25);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: ZOOM_STATE_VERSION, zoomFactor: 1.25 });
    await fs.writeFile(file, "not json");
    assert.equal(readZoomState(file), 1);
    await fs.writeFile(file, JSON.stringify({ version: 99, zoomFactor: 0.1 }));
    assert.equal(readZoomState(file), 1);
    writeZoomState(file, 50);
    assert.equal(readZoomState(file), 2);
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["zoom.json"], "temporary writes are replaced, not left behind");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("zoom shortcuts use the platform primary modifier and accept equals, shifted plus and numpad variants", () => {
  assert.equal(zoomActionForKey(key({ control: true }), "linux"), "in");
  assert.equal(zoomActionForKey(key({ control: true, shift: true }), "linux"), "in");
  assert.equal(zoomActionForKey(key({ control: true, key: "+", code: "Equal" }), "linux"), "in");
  assert.equal(zoomActionForKey(key({ control: true, key: "+", code: "NumpadAdd" }), "linux"), "in");
  assert.equal(zoomActionForKey(key({ control: true, code: "NumpadAdd" }), "linux"), "in");
  assert.equal(zoomActionForKey(key({ control: true, key: "-" }), "linux"), "out");
  assert.equal(zoomActionForKey(key({ control: true, key: "_" }), "linux"), "out");
  assert.equal(zoomActionForKey(key({ control: true, key: "-", code: "NumpadSubtract" }), "linux"), "out");
  assert.equal(zoomActionForKey(key({ control: true, key: "0", code: "Numpad0" }), "linux"), "reset");
  assert.equal(zoomActionForKey(key({ control: true, key: "0", code: "Digit0" }), "linux"), "reset");
  assert.equal(zoomActionForKey(key({ meta: true, key: "+", code: "Equal" }), "darwin"), "in");
  assert.equal(zoomActionForKey(key({ meta: true, key: "-" }), "darwin"), "out");
  assert.equal(zoomActionForKey(key({ meta: true, key: "0" }), "darwin"), "reset");
  for (const [rejected, platform] of [
    [key({ control: false }), "linux"],
    [key({ control: true, alt: true }), "linux"],
    [key({ control: true, meta: true }), "linux"],
    [key({ control: true, key: "r" }), "linux"],
    [key({ control: true, key: "0", type: "keyUp" }), "linux"],
    [key({ meta: true, control: true }), "darwin"],
    [key({ meta: true, alt: true }), "darwin"],
    [key({ meta: true }), "linux"],
    [key({ control: true }), "darwin"],
  ] as const) assert.equal(zoomActionForKey(rejected, platform), null);
});
