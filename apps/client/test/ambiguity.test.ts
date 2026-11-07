import assert from "node:assert/strict";
import test from "node:test";
import { producerAmbiguityDisclosures } from "../src/diagnostics.js";

test("producer ambiguity excludes unconditional policy descriptions for unique pairs", () => {
  const boilerplate = "Periodic/ambiguous preflight passes carry an explicit no-unique-lag disclosure.";
  assert.deepEqual(producerAmbiguityDisclosures([boilerplate, "Original source: WAV, 48000 Hz, 2 channels."]), []);
  const actual = "no unique lag: 2 distinct positive local peaks support several delays.";
  const polarity = "polarity ambiguous: the inverted hypothesis is stronger within the product margin.";
  assert.deepEqual(producerAmbiguityDisclosures([boilerplate, actual, polarity]), [actual, polarity]);
});
