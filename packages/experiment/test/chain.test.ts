import assert from "node:assert/strict";
import test from "node:test";
import { finalSelectionForSide, type ChainPreparationRequest, type PreparedArtifact } from "@codec-abx/contracts";
import { ExperimentService } from "../src/index.js";
import { validatePreparedArtifact } from "../src/runtime/validation.js";
import { buildArtifact, makeReaders, sine } from "./fixtures.js";

const opus = { codecId: "opus" as const, bitrateKbps: 128 };
const aac = { codecId: "aac" as const, bitrateKbps: 128 };
function chain(): ChainPreparationRequest {
  return {version: 2, preparationPolicy: "aligned-gain-matched-v1", sampleRateMode: "native", canaryEnabled: false,
    a: [{...opus}, {...aac}], b: [{...aac}, {...aac}]};
}
const plan = {version: 1 as const, plannedTrials: 8, alpha: .05, labelMode: "blind_random" as const, calibrationEnabled: false};

test("binding ordered chains requires complete stage provenance and a consistent final summary", async () => {
  for (const kind of ["missing", "truncated", "reordered", "wrong-index", "wrong-codec", "wrong-bitrate", "wrong-final-summary", "nonfinite-rate", "private-track-field"] as const) {
    const built = buildArtifact({request: chain(), a: sine(440), b: sine(660)});
    const artifact = structuredClone(built.artifact) as PreparedArtifact;
    const a = artifact.a as unknown as { stages?: {stageIndex: number; requested: {codecId: string; bitrateKbps: number}; encodedSampleRate: number | null}[]; encoder: string };
    if (kind === "missing") delete a.stages;
    else if (kind === "truncated") a.stages!.pop();
    else if (kind === "reordered") a.stages!.reverse();
    else if (kind === "wrong-index") a.stages![0]!.stageIndex = 2;
    else if (kind === "wrong-codec") a.stages![0]!.requested.codecId = "mp3";
    else if (kind === "wrong-bitrate") a.stages![0]!.requested.bitrateKbps = 64;
    else if (kind === "wrong-final-summary") a.encoder = "invented final implementation";
    else if (kind === "private-track-field") Object.assign(a, { sourcePath: "/private/source.wav" });
    else a.stages![0]!.encodedSampleRate = Infinity;
    await assert.rejects(validatePreparedArtifact(artifact, makeReaders(built)), /stage|rate|summary|unexpected fields/i, kind);
  }
});

test("snapshots and exports retain independent full chain arrays and all request options", async () => {
  const request = chain();
  const built = buildArtifact({request, a: sine(440), b: sine(660)});
  const service = new ExperimentService();
  try {
    await service.configure(plan);
    const bound = await service.bindPrepared(built.artifact, makeReaders(built));
    assert.equal(bound.gates.nullStatus, "not-applicable");
    assert.deepEqual(bound.prepared!.request, request);
    assert.equal(bound.prepared!.request.version, 2);
    assert.ok(Array.isArray(bound.prepared!.request.a));
    assert.notEqual(bound.prepared!.request.a, request.a);
    (request.a[0] as {bitrateKbps: number}).bitrateKbps = 64;
    const next = await service.snapshot();
    assert.equal(next.prepared!.request.version, 2);
    if (next.prepared!.request.version !== 2) throw new Error("chain expected");
    assert.equal(next.prepared!.request.a[0]!.bitrateKbps, 128);
    assert.equal(finalSelectionForSide(next.prepared!.request, "a").codecId, "aac");
    const exported = await service.export();
    assert.deepEqual(exported.snapshot.prepared!.request, next.prepared!.request);
    assert.notEqual(exported.snapshot.prepared!.request.a, next.prepared!.request.a);
    assert.ok(Object.isFrozen(next.prepared!.request.a));
  } finally { await service.dispose(); }
});
