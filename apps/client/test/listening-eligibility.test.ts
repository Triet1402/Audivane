import assert from "node:assert/strict";
import test from "node:test";

import type { PreparedArtifact } from "@codec-abx/contracts";

import {
  isRawCodecProbeArtifact,
  listeningArtifactEligibility,
} from "../src/listening/model.js";

function artifact(options: {
  readonly location?: "browser-local" | "desktop-native";
  readonly enginePolicy?: "codec-probe-only" | "aligned-gain-matched-v1";
  readonly requestPolicy?: "codec-probe-only" | "aligned-gain-matched-v1";
  readonly preparation?: boolean;
  readonly validityPolicy?: "delivered-validity-v1" | "delivered-validity-v2";
} = {}): PreparedArtifact {
  const preparation = options.preparation === true ? { policy: "aligned-gain-matched-v1" } : undefined;
  const validity = options.validityPolicy === undefined
    ? undefined
    : { policy: options.validityPolicy };
  return {
    purpose: "diagnostic-only",
    engine: {
      location: options.location ?? "browser-local",
      preparationPolicy: options.enginePolicy ?? "codec-probe-only",
    },
    request: options.requestPolicy === undefined
      ? {}
      : { preparationPolicy: options.requestPolicy },
    ...(preparation === undefined ? {} : { preparation }),
    ...(validity === undefined ? {} : { validity }),
  } as unknown as PreparedArtifact;
}

test("a current raw browser probe is named as raw, not as a historical v1 artifact", () => {
  const raw = artifact();
  assert.equal(isRawCodecProbeArtifact(raw), true);
  const refusal = listeningArtifactEligibility(raw);
  assert.match(refusal ?? "", /ABX listening requires aligned, level-matched audio/);
  assert.match(refusal ?? "", /Select aligned \+ gain-matched preparation/);
  assert.doesNotMatch(refusal ?? "", /Historical delivered-validity-v1/);
});

test("genuine historical v1 refusal details remain intact", () => {
  const historical = artifact({
    enginePolicy: "aligned-gain-matched-v1",
    requestPolicy: "aligned-gain-matched-v1",
    preparation: true,
    validityPolicy: "delivered-validity-v1",
  });
  assert.equal(isRawCodecProbeArtifact(historical), false);
  const refusal = listeningArtifactEligibility(historical);
  assert.match(refusal ?? "", /Historical delivered-validity-v1 artifacts remain valid diagnostic data/);
  assert.match(refusal ?? "", /not authorized for scored listening/);
});

test("a missing validity report is distinct from both raw and historical artifacts", () => {
  const missing = artifact({
    enginePolicy: "aligned-gain-matched-v1",
    requestPolicy: "aligned-gain-matched-v1",
    preparation: true,
  });
  assert.equal(isRawCodecProbeArtifact(missing), false);
  const refusal = listeningArtifactEligibility(missing);
  assert.match(refusal ?? "", /no delivered-validity-v2 report/);
  assert.doesNotMatch(refusal ?? "", /Historical delivered-validity-v1/);
  assert.doesNotMatch(refusal ?? "", /raw codec-probe-only/);
});
