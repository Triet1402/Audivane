import { assessPairRelation } from "@codec-abx/measurements";
import { AUDIO_MAX_DURATION_SECONDS } from "@codec-abx/contracts";
import { evaluatePreparationGate } from "@codec-abx/preparation-policy";

import { buildArtifact } from "../../../packages/experiment/test/fixtures.js";

const SAMPLE_RATE = 48_000;
const FRAMES = 4_800;

function deterministicPair(): { a: Float64Array; b: Float64Array } {
  const a = new Float64Array(FRAMES);
  let state = 0x1a2b3c4d;
  for (let index = 0; index < FRAMES; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    a[index] = (state / 0x1_0000_0000 - 0.5) * 0.4;
  }
  return { a, b: a.slice() };
}

function fixturePreparationGate() {
  const pair = deterministicPair();
  return evaluatePreparationGate(
    assessPairRelation(
      { sampleRate: SAMPLE_RATE, channels: [pair.a] },
      { sampleRate: SAMPLE_RATE, channels: [pair.b] },
      { maxLagSamples: Math.floor(0.1 * SAMPLE_RATE), probeSamples: 240_000 },
    ),
  );
}

// Public DTO fixture only; real native bytes are covered by worker-runtime tests.
export function publicNativeArtifact() {
  const artifact = structuredClone(buildArtifact({ id: "public_native_artifact_001", canary: true }).artifact);
  return {
    ...artifact,
    engine: {
      ...artifact.engine,
      engineId: "engine-native-typescript" as const,
      location: "desktop-native" as const,
      build: "TypeScript native codec executor; fixture build",
      maxDurationSeconds: AUDIO_MAX_DURATION_SECONDS,
      preparationPolicy: "aligned-gain-matched-v1" as const,
      supportedPreparationPolicies: ["aligned-gain-matched-v1"] as const,
      supportsCanaryMaterial: true,
    },
    measurements: { ...artifact.measurements, policy: "aligned-gain-matched-v1" as const },
    validity: {
      policy: "delivered-validity-v2" as const,
      nullGate: artifact.validity!.nullGate,
      preparationGate: fixturePreparationGate(),
      notes: [
        "Fixture delivered-validity-v2 report.",
        "Preparation validity is product-policy evidence, not ABX authority.",
      ],
    },
  };
}
