import { finalSelectionForSide } from "@codec-abx/contracts";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  AnswerReceipt,
  ExperimentExport,
  ExperimentPlan,
  ExperimentSnapshot,
  PlaybackLabel,
} from "@codec-abx/contracts";
import { buildCanaryPair, evaluateCanaryDepth, evaluateNullGate } from "@codec-abx/preparation-policy";
import { AUDIO_CANARY_EXCERPT_SECONDS } from "@codec-abx/contracts";
import { decodePcm16 } from "@codec-abx/measurements";
import { secretToHex, verifyReveal, xSequence, xSourceForIndex } from "../src/commitment.js";
import { ExperimentService, ExperimentServiceError } from "../src/index.js";
import type { ArtifactReaders } from "../src/runtime/validation.js";
import { MAX_ARTIFACT_BYTES, parseCanonicalPcm16Wav } from "../src/runtime/wav.js";
import {
  FIXTURE_SECRET,
  FIXTURE_SWAPS,
  buildArtifact,
  correctDisplay,
  deferred,
  deterministicOptions,
  keysDeep,
  makeReaders,
  makeRequest,
  sha256,
  sine,
  type BuiltArtifact,
} from "./fixtures.js";


test("configure snapshots the caller plan before its first queue await", async () => {
  const service = new ExperimentService(deterministicOptions());
  const input = plan({ plannedTrials: 8 });
  const configuring = service.configure(input);
  (input as { plannedTrials: number }).plannedTrials = 999;
  assert.equal((await configuring).plan.plannedTrials, 8);
});

test("binding snapshots artifact metadata and reader methods before awaits", async () => {
  const built = buildArtifact();
  const service = new ExperimentService(deterministicOptions());
  await service.configure(PLAN_FIXED);
  const gate = deferred();
  const started = deferred();
  const originalReaders = makeReaders(built);
  const readers: ArtifactReaders = {
    readAudio: async (id, side) => {
      if (side === "a") { started.resolve(); await gate.promise; }
      return originalReaders.readAudio(id, side);
    },
  };
  const binding = service.bindPrepared(built.artifact, readers);
  await started.promise;
  (built.artifact.engine as { location: string }).location = "bogus";
  readers.readAudio = async () => { throw new Error("replacement reader"); };
  gate.resolve();
  assert.equal((await binding).prepared?.preparationLocation, "browser-local");
  const trial = await service.nextTrial();
  audioEquals(await service.readAudio(trial.token, "A"), built.bytes.a);
});

test("reset and dispose reject a terminal export held in WebCrypto", async () => {
  for (const action of ["reset", "dispose"] as const) {
    const { service } = await configured();
    await service.seal();
    const original = crypto.subtle.digest;
    const gate = deferred();
    const started = deferred();
    let first = true;
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (first) { first = false; started.resolve(); await gate.promise; }
        return original.call(crypto.subtle, algorithm, data);
      },
    });
    try {
      const exporting = service.export();
      await started.promise;
      if (action === "reset") await service.reset();
      else await service.dispose();
      gate.resolve();
      await expectCode(exporting, action === "reset" ? "stale-token" : "disposed");
    } finally {
      gate.resolve();
      Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: original });
    }
  }
});

test("a queued command cannot stage a trial in a replacement run", async () => {
  const built = buildArtifact();
  const gate = deferred();
  const started = deferred();
  const service = new ExperimentService({
    ...deterministicOptions(),
    xSourceForIndex: async () => { started.resolve(); await gate.promise; return "A"; },
  });
  await service.configure(PLAN_FIXED);
  await service.bindPrepared(built.artifact, makeReaders(built));
  const first = service.nextTrial();
  await started.promise;
  const queued = service.nextTrial();
  await service.reset();
  gate.resolve();
  await expectCode(first, "stale-token");
  await expectCode(queued, "stale-token");
  assert.equal((await service.snapshot()).pendingTrial, null);
});

test("serving bounds buffers before copying and hides private reader errors", async () => {
  for (const failure of ["oversized", "wrong-type", "private-error"] as const) {
    const built = buildArtifact();
    let serving = false;
    const original = makeReaders(built);
    let sliceCalled = false;
    const readers: ArtifactReaders = {
      readAudio: async (id, side) => {
        if (!serving) return original.readAudio(id, side);
        if (failure === "private-error") throw new Error("secret assignment X=source-A /private/audio.wav");
        if (failure === "wrong-type") return "not audio" as unknown as ArrayBuffer;
        const oversized = new ArrayBuffer(MAX_ARTIFACT_BYTES + 1);
        oversized.slice = () => { sliceCalled = true; throw new Error("copy must not happen"); };
        return oversized;
      },
    };
    const { service } = await configured(built, { readers });
    const trial = await service.nextTrial();
    serving = true;
    const error = await expectCode(service.readAudio(trial.token, "A"),
      failure === "private-error" ? "artifact-reader-unavailable" : "artifact-bytes-mismatch");
    assert.equal(sliceCalled, false);
    assert.doesNotMatch(JSON.stringify({ message: error.message, reasons: error.reasons }), /secret assignment|private\/audio/);
  }
});

test("binding rejects contradictory frozen preparation and delivered reports", async () => {
  for (const field of ["probe", "gain", "crop", "delivered-level"] as const) {
    const built = buildArtifact();
    const artifact = structuredClone(built.artifact);
    if (field === "probe") {
      (artifact.preparation!.alignment as { probeSamples: number }).probeSamples = 2;
      (artifact.measurements.delivered!.alignment as { probeSamples: number }).probeSamples = 2;
    } else if (field === "gain") {
      (artifact.preparation!.loudness as { gainADb: number }).gainADb = 999;
    } else if (field === "crop") {
      (artifact.preparation!.alignment as { inputFramesA: number }).inputFramesA += 100;
      (artifact.preparation!.alignment as { inputFramesB: number }).inputFramesB += 100;
    } else {
      (artifact.measurements.delivered!.a.integratedLufs as { value: number }).value = -99;
    }
    const service = new ExperimentService(deterministicOptions());
    await service.configure(PLAN_FIXED);
    await expectCode(service.bindPrepared(artifact, makeReaders(built)), "artifact-invalid");
  }
});

test("reported ability uses exact half-even rounding at the 1/32 tie", async () => {
  const { service } = await configured(buildArtifact(), { plan: plan({ plannedTrials: 32 }) });
  for (let index = 1; index <= 32; index += 1) {
    const trial = await service.nextTrial();
    const correct = await xSourceForIndex(FIXTURE_SECRET, index);
    await service.answer(trial.token, index === 1 ? correct : (correct === "A" ? "B" : "A"));
  }
  const stats = (await service.snapshot()).statistics;
  assert.equal(stats.correctTrials, 1);
  assert.equal(stats.ability, 0.0312);
});

test("binding rejects contradictory request, track and canary provenance", async () => {
  for (const field of ["track", "canary", "rate"] as const) {
    const built = buildArtifact({
      canary: field === "canary",
      ...(field === "rate" ? { a: sine(440, { sampleRate: 44100 }), b: sine(660, { sampleRate: 44100 }) } : {}),
    });
    const artifact = structuredClone(built.artifact);
    if (field === "track") (artifact.a as { requested: unknown }).requested = { ...artifact.a.requested, bitrateKbps: 192 };
    else if (field === "canary") (artifact.request as { canaryEnabled: boolean }).canaryEnabled = false;
    else (artifact.request as { sampleRateMode: string }).sampleRateMode = "force_48k";
    const service = new ExperimentService(deterministicOptions());
    await service.configure(PLAN_FIXED);
    await expectCode(service.bindPrepared(artifact, makeReaders(built)), "artifact-invalid");
  }
});

test("unconfigured bind, seal and reset refuse before changing experiment state", async () => {
  for (const operation of ["bind", "seal", "reset"] as const) {
    const built = buildArtifact();
    const service = new ExperimentService(deterministicOptions());
    let reads = 0;
    const originalReaders = makeReaders(built);
    const readers: ArtifactReaders = {
      readAudio: async (id, side) => { reads += 1; return originalReaders.readAudio(id, side); },
    };
    await expectCode(operation === "bind" ? service.bindPrepared(built.artifact, readers)
      : operation === "seal" ? service.seal() : service.reset(), "not-configured");
    const snapshot = await service.configure(PLAN_FIXED);
    assert.equal(snapshot.lifecycle, "configured");
    assert.equal(snapshot.prepared, null);
    assert.equal(snapshot.sealedReason, null);
    assert.equal(reads, 0);
    await expectCode(service.nextTrial(), "artifact-unbound");
  }
});

test("binding rejects forged legacy measurement summaries", async () => {
  for (const field of ["alignmentLagSamples", "alignmentConfidence", "loudnessDeltaDb"] as const) {
    const built = buildArtifact();
    const artifact = structuredClone(built.artifact);
    (artifact.measurements as unknown as Record<string, unknown>)[field] = field === "alignmentConfidence" ? 0.123456789 : 9999;
    const service = new ExperimentService(deterministicOptions());
    await service.configure(PLAN_FIXED);
    await expectCode(service.bindPrepared(artifact, makeReaders(built)), "artifact-invalid");
    assert.equal((await service.snapshot()).prepared, null);
  }
});

test("corrupted pristine and degraded canary bytes reject at binding and serving", async () => {
  for (const side of ["pristine", "degraded"] as const) {
    const built = buildArtifact({ canary: true });
    const service = new ExperimentService(deterministicOptions());
    await service.configure(plan({ calibrationEnabled: true }));
    await expectCode(service.bindPrepared(built.artifact, makeReaders(built, { corrupt: side })), "artifact-bytes-mismatch");
    assert.equal((await service.snapshot()).prepared, null);
    await service.bindPrepared(built.artifact, makeReaders(built));
    const trial = await service.nextTrial();
    assert.equal(trial.kind, "calibration");
    const label = side === "pristine" ? "A" : "B";
    audioEquals(await service.readAudio(trial.token, label), built.bytes.canary![side]);
    const bytes = built.bytes.canary![side];
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    await expectCode(service.readAudio(trial.token, label), "artifact-bytes-mismatch");
    const after = await service.snapshot();
    assert.equal(after.gates.calibrationStatus, "pending");
    assert.equal(after.statistics.scoredTrials, 0);
  }
});

test("long-track canary must be the exact FIRST ten seconds of Side A", async () => {
  const built = buildArtifact({
    // 437.3 Hz is not an integer number of cycles across the two-second offset,
    // so a suffix is genuinely different material from the leading prefix.
    a: sine(437.3, { seconds: 12 }),
    b: sine(437.3, { amplitude: 0.2, seconds: 12 }),
    canary: true,
  });
  assert.ok(built.canaryReport);
  const excerptFrames = AUDIO_CANARY_EXCERPT_SECONDS * 48_000;
  assert.equal(built.canaryReport.frames, excerptFrames);

  // The genuine prefix artifact binds, but a valid same-length suffix canary is
  // refused: an excerpt is authority only when it is Side A's leading prefix.
  const { service } = await configured(built, {
    plan: plan({ calibrationEnabled: true }),
  });
  await service.dispose();

  const facts = parseCanonicalPcm16Wav(built.bytes.a);
  const decoded = decodePcm16(built.bytes.a, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
  const suffix = buildCanaryPair({
    sampleRate: facts.sampleRate,
    channels: decoded.channels.map((channel) =>
      channel.subarray(channel.length - excerptFrames)),
  });
  const suffixBytes = {
    pristine: suffix.pristineWav,
    degraded: suffix.degradedWav,
  };
  const description = (bytes: Uint8Array) => {
    const value = parseCanonicalPcm16Wav(bytes);
    return {
      sampleRate: value.sampleRate,
      channels: value.channels,
      frames: value.frames,
      wavSha256: sha256(bytes),
    };
  };
  (built.artifact as { canary: unknown }).canary = {
    report: suffix.report,
    audio: {
      pristine: description(suffixBytes.pristine),
      degraded: description(suffixBytes.degraded),
    },
  };
  const readers = makeReaders(built);
  const tampered: ArtifactReaders = {
    readAudio: readers.readAudio,
    readCanaryAudio: async (_id, side) =>
      (side === "pristine" ? suffixBytes.pristine : suffixBytes.degraded)
        .slice().buffer as ArrayBuffer,
  };
  const rejected = await expectCode(
    configured(built, { plan: plan({ calibrationEnabled: true }), readers: tampered })
      .then((value) => value.service),
    "artifact-invalid",
  );
  assert.match(rejected.message, /exact FIRST calibration prefix/);
});

const PLAN_FIXED: ExperimentPlan = Object.freeze({
  version: 1,
  plannedTrials: 8,
  alpha: 0.05,
  labelMode: "fixed",
  calibrationEnabled: false,
});

function plan(overrides: Partial<ExperimentPlan> = {}): ExperimentPlan {
  return { ...PLAN_FIXED, ...overrides };
}

async function configured(
  built: BuiltArtifact = buildArtifact(),
  options: {
    readonly plan?: ExperimentPlan;
    readonly readers?: ArtifactReaders;
    readonly seams?: ReturnType<typeof deterministicOptions>;
  } = {},
): Promise<{
  readonly service: ExperimentService;
  readonly seams: ReturnType<typeof deterministicOptions>;
  readonly built: BuiltArtifact;
}> {
  const seams = options.seams ?? deterministicOptions();
  const service = new ExperimentService(seams);
  await service.configure(options.plan ?? PLAN_FIXED);
  await service.bindPrepared(built.artifact, options.readers ?? makeReaders(built));
  return { service, seams, built };
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<ExperimentServiceError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ExperimentServiceError, `expected service error, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected operation to reject with ${code}`);
}

function sameKeys(value: object, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertNoLeakedKeys(value: unknown): void {
  const forbidden = [
    "xSource",
    "answerSource",
    "displayMapping",
    "secretHex",
    "secret",
    "mapping",
  ];
  const keys = keysDeep(value);
  for (const key of forbidden) {
    assert.equal(keys.has(key), false, `public DTO leaked runtime-private key ${key}`);
  }
}

function audioEquals(buffer: ArrayBuffer, expected: Uint8Array): void {
  assert.deepEqual(new Uint8Array(buffer), new Uint8Array(expected));
}

async function readLabel(
  service: ExperimentService,
  token: string,
  label: PlaybackLabel,
): Promise<ArrayBuffer> {
  return service.readAudio(token, label);
}

function sourceSideBytes(built: BuiltArtifact, side: "A" | "B"): Uint8Array {
  return side === "A" ? built.bytes.a : built.bytes.b;
}

test("public DTOs are allowlisted, leak-free and mutation-isolated", async () => {
  const built = buildArtifact();
  const inputPlan = plan();
  const { service } = await configured(built, { plan: inputPlan });

  const first = await service.snapshot();
  sameKeys(first, [
    "version", "runId", "authority", "lifecycle", "plan", "lockedAtUtc", "commitment",
    "prepared", "pendingTrial", "lastAnswer", "gates", "statistics", "sealedReason",
    "limitations",
  ]);
  sameKeys(first.plan, ["version", "plannedTrials", "alpha", "labelMode", "calibrationEnabled"]);
  sameKeys(first.gates, [
    "nullStatus", "preparationStatus", "preparationClassification",
    "preparationReason", "preparationDisclosure", "calibrationStatus", "reasons",
  ]);
  sameKeys(first.statistics, [
    "scoredTrials", "correctTrials", "plannedTrials", "requiredCorrect", "pValue",
    "ability", "abilityCi95", "significant", "isFinal", "significantVerdict",
  ]);
  assert.deepEqual(first.prepared?.request.a, built.artifact.request.a);
  assertNoLeakedKeys(first);

  const pending = await service.nextTrial();
  sameKeys(pending, ["runId", "token", "trialIndex", "kind"]);
  const withPending = await service.snapshot();
  sameKeys(withPending.pendingTrial!, ["runId", "token", "trialIndex", "kind"]);
  assertNoLeakedKeys(withPending);

  // Caller input mutation does not move internal state.
  (inputPlan as { plannedTrials: number | null }).plannedTrials = 3;
  (built.artifact.request.a as { bitrateKbps: number }).bitrateKbps = 64;
  // Returned DTO mutation likewise cannot move internal state.
  (first.plan as { plannedTrials: number | null }).plannedTrials = 2;
  (withPending.pendingTrial as { token: string }).token = "mutated";
  (withPending.pendingTrial as { trialIndex: number }).trialIndex = 99;

  const later = await service.snapshot();
  assert.equal(later.plan.plannedTrials, 8);
  assert.equal(finalSelectionForSide(later.prepared!.request, "a").bitrateKbps, 128);
  assert.equal(later.pendingTrial?.token, pending.token);
  assert.equal(later.pendingTrial?.trialIndex, 1);
});

test("plan and prepared pair freeze at first staging; reset reopens configuration", async () => {
  const built = buildArtifact();
  const { service } = await configured(built);
  const oldRunId = (await service.snapshot()).runId;
  const pending = await service.nextTrial();
  assert.equal((await service.snapshot()).lifecycle, "running");
  assert.equal((await service.snapshot()).lockedAtUtc !== null, true);

  await expectCode(service.configure(plan({ plannedTrials: 4 })), "config-locked");
  await expectCode(
    service.bindPrepared(built.artifact, makeReaders(built)),
    "config-locked",
  );

  await service.answer(pending.token, "A");
  const reset = await service.reset();
  assert.equal(reset.lifecycle, "configured");
  assert.equal(reset.pendingTrial, null);
  assert.equal(reset.prepared?.artifactId, built.artifact.id);
  assert.notEqual(reset.runId, oldRunId);
  await service.configure(plan({ plannedTrials: 3 }));
  assert.equal((await service.snapshot()).plan.plannedTrials, 3);
});

test("fixed perfect scoring uses one private mapping for bytes and scoring", async () => {
  const built = buildArtifact();
  const seams = deterministicOptions();
  const { service } = await configured(built, { seams });

  for (let index = 1; index <= 8; index += 1) {
    const trial = await service.nextTrial();
    assert.equal(trial.trialIndex, index);
    assert.equal(trial.kind, "scored");
    const x = await xSourceForIndex(FIXTURE_SECRET, index);
    const a = await readLabel(service, trial.token, "A");
    const b = await readLabel(service, trial.token, "B");
    const xAudio = await readLabel(service, trial.token, "X");
    audioEquals(a, sourceSideBytes(built, "A"));
    audioEquals(b, sourceSideBytes(built, "B"));
    audioEquals(xAudio, sourceSideBytes(built, x));
    const receipt = await service.answer(trial.token, correctDisplay(x, false));
    assert.equal(receipt.correct, true);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.lastAnswer?.token, receipt.token);
    assert.deepEqual(snapshot.lastAnswer, receipt);
    assert.equal(snapshot.pendingTrial, null);
  }

  const final = await service.snapshot();
  assert.equal(final.lifecycle, "completed");
  assert.equal(final.statistics.scoredTrials, 8);
  assert.equal(final.statistics.correctTrials, 8);
  assert.equal(final.statistics.isFinal, true);
  assert.equal(final.statistics.significant, true);
  assert.equal(final.statistics.significantVerdict, true);
  assert.equal(final.statistics.requiredCorrect, 7);
  await expectCode(service.nextTrial(), "run-closed");

  const exported = await service.export();
  assert.equal(exported.reveal.redacted, false);
  assert.equal(exported.reveal.verifiable, true);
  assert.equal(exported.reveal.xSequence.length, 8);
  assert.ok(exported.reveal.secretHex);
  assert.equal(
    await verifyReveal(
      exported.reveal.secretHex!,
      exported.reveal.commitment,
      exported.reveal.xSequence,
    ),
    true,
  );
});

test("blind-swapped perfect scoring and audio mapping stay aligned", async () => {
  const built = buildArtifact();
  const seams = deterministicOptions({ swaps: FIXTURE_SWAPS });
  const { service } = await configured(built, {
    seams,
    plan: plan({ labelMode: "blind_random" }),
  });

  for (let index = 1; index <= 8; index += 1) {
    const trial = await service.nextTrial();
    const x = await xSourceForIndex(FIXTURE_SECRET, index);
    const swap = FIXTURE_SWAPS[index - 1] ?? false;
    const aDisplaySource = swap ? "B" : "A";
    const bDisplaySource = swap ? "A" : "B";
    audioEquals(await readLabel(service, trial.token, "A"), sourceSideBytes(built, aDisplaySource));
    audioEquals(await readLabel(service, trial.token, "B"), sourceSideBytes(built, bDisplaySource));
    audioEquals(await readLabel(service, trial.token, "X"), sourceSideBytes(built, x));
    const receipt = await service.answer(trial.token, correctDisplay(x, swap));
    assert.equal(receipt.correct, true);
  }
  const final = await service.snapshot();
  assert.equal(final.statistics.correctTrials, 8);
  assert.equal(final.statistics.significantVerdict, true);
});

test("calibration is trial 1, excluded from N, and only a listener answer passes it", async () => {
  const built = buildArtifact({ canary: true });
  const seams = deterministicOptions();
  const { service } = await configured(built, {
    seams,
    plan: plan({ plannedTrials: 2, calibrationEnabled: true }),
  });
  assert.equal((await service.snapshot()).gates.calibrationStatus, "pending");

  const calibration = await service.nextTrial();
  assert.equal(calibration.trialIndex, 1);
  assert.equal(calibration.kind, "calibration");
  const x = await xSourceForIndex(FIXTURE_SECRET, 1);
  const xAudio = await readLabel(service, calibration.token, "X");
  const aAudio = await readLabel(service, calibration.token, "A");
  const bAudio = await readLabel(service, calibration.token, "B");
  assert.ok(built.bytes.canary);
  const expectedPristine = built.bytes.canary.pristine;
  const expectedDegraded = built.bytes.canary.degraded;
  audioEquals(aAudio, expectedPristine);
  audioEquals(bAudio, expectedDegraded);
  audioEquals(xAudio, x === "A" ? expectedPristine : expectedDegraded);
  const pass = await service.answer(calibration.token, correctDisplay(x, false));
  assert.equal(pass.correct, true);
  assert.equal((await service.snapshot()).statistics.scoredTrials, 0);
  assert.equal((await service.snapshot()).gates.calibrationStatus, "passed");

  for (let index = 2; index <= 3; index += 1) {
    const trial = await service.nextTrial();
    assert.equal(trial.trialIndex, index);
    assert.equal(trial.kind, "scored");
    const scoredX = await xSourceForIndex(FIXTURE_SECRET, index);
    assert.equal((await service.answer(trial.token, correctDisplay(scoredX, false))).correct, true);
  }
  const final = await service.snapshot();
  assert.equal(final.lifecycle, "completed");
  assert.equal(final.statistics.scoredTrials, 2);
  assert.equal(final.statistics.correctTrials, 2);
  assert.equal(final.statistics.isFinal, true);
  const exported = await service.export();
  assert.equal(exported.trials.length, 3);
  assert.deepEqual(exported.trials.map((row) => row.trialIndex), [1, 2, 3]);
  assert.deepEqual(exported.trials.map((row) => row.kind), ["calibration", "scored", "scored"]);
});

test("wrong calibration voids the run; reset keeps material but starts a new run", async () => {
  const built = buildArtifact({ canary: true });
  const secondSecret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const seams = deterministicOptions({ secrets: [FIXTURE_SECRET, secondSecret] });
  const { service } = await configured(built, {
    seams,
    plan: plan({ calibrationEnabled: true }),
  });
  const calibration = await service.nextTrial();
  const x = await xSourceForIndex(FIXTURE_SECRET, 1);
  const wrong = correctDisplay(x, false) === "A" ? "B" : "A";
  const receipt = await service.answer(calibration.token, wrong);
  assert.equal(receipt.correct, false);
  const voided = await service.snapshot();
  assert.equal(voided.lifecycle, "void");
  assert.equal(voided.gates.calibrationStatus, "failed");
  assert.equal(voided.statistics.scoredTrials, 0);
  assert.equal(voided.statistics.isFinal, false);
  assert.equal(voided.pendingTrial, null);
  await expectCode(service.nextTrial(), "run-closed");
  const oldExport = await service.export();
  assert.ok(oldExport.reveal.secretHex);

  const reset = await service.reset();
  assert.equal(reset.lifecycle, "configured");
  assert.equal(reset.gates.calibrationStatus, "pending");
  assert.equal(reset.prepared?.artifactId, built.artifact.id);
  assert.notEqual(reset.runId, voided.runId);
  assert.notEqual(reset.commitment, voided.commitment);
  assert.equal(reset.lastAnswer, null);
  const afterReset = await service.export();
  assert.equal(afterReset.reveal.redacted, true);
  assert.equal(afterReset.reveal.secretHex, null);
  await expectCode(service.answer(calibration.token, wrong), "unknown-token");
});

test("requested but unusable/missing calibration blocks staging as unavailable", async () => {
  const noCanary = buildArtifact({ request: makeRequest({ canaryEnabled: false }) });
  {
    const { service } = await configured(noCanary, {
      plan: plan({ calibrationEnabled: true }),
    });
    const snapshot = await service.snapshot();
    assert.equal(snapshot.gates.calibrationStatus, "unavailable");
    assert.equal(snapshot.lifecycle, "configured");
    await expectCode(service.nextTrial(), "calibration-unavailable");
  }
  {
    const built = buildArtifact({ canary: true });
    const readers = makeReaders(built);
    const withoutCanary: ArtifactReaders = { readAudio: readers.readAudio };
    const { service } = await configured(built, {
      readers: withoutCanary,
      plan: plan({ calibrationEnabled: true }),
    });
    assert.equal((await service.snapshot()).gates.calibrationStatus, "unavailable");
    await expectCode(service.nextTrial(), "calibration-unavailable");
  }
  {
    const depth = { status: "finite" as const, value: -40, reason: null };
    const decision = evaluateCanaryDepth(depth);
    const notUsable = buildArtifact({ canary: true });
    (notUsable.artifact as { canary: unknown }).canary = {
      report: {
        ...notUsable.artifact.canary!.report,
        status: decision.status,
        usable: decision.usable,
        depthDb: decision.depthDb,
        reason: decision.reason,
      },
      audio: null,
    };
    const { service } = await configured(notUsable, {
      plan: plan({ calibrationEnabled: true }),
    });
    assert.equal((await service.snapshot()).gates.calibrationStatus, "unavailable");
    await expectCode(service.nextTrial(), "calibration-unavailable");
  }
  {
    const built = buildArtifact({ canary: true });
    (built.artifact.canary as { audio: unknown }).audio = null;
    const { service } = await configured(built, {
      plan: plan({ calibrationEnabled: true }),
    });
    assert.equal((await service.snapshot()).gates.calibrationStatus, "unavailable");
    await expectCode(service.nextTrial(), "calibration-unavailable");
  }
});

test("failed null gate blocks staging while configured; a forged pass is rejected", async () => {
  const failedPair = buildArtifact({
    request: makeRequest({ aCodec: "opus", aBitrate: 128, bCodec: "opus", bBitrate: 128 }),
    a: sine(440),
    b: sine(660),
  });
  assert.equal(failedPair.validity.nullGate.status, "failed");
  const { service } = await configured(failedPair);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.gates.nullStatus, "failed");
  assert.deepEqual(snapshot.gates.reasons.length > 0, true);
  await expectCode(service.nextTrial(), "null-gate-failed");
  const exported = await service.export();
  assert.equal(exported.reveal.redacted, true);
  assert.equal(exported.reveal.secretHex, null);

  // A configured pair can still be replaced; the blocking facts move with it.
  const passingPair = buildArtifact({
    request: makeRequest({ aCodec: "opus", aBitrate: 128, bCodec: "opus", bBitrate: 128 }),
    a: sine(440),
    b: sine(440),
  });
  assert.equal(passingPair.validity.nullGate.status, "passed");
  const replaced = await service.bindPrepared(passingPair.artifact, makeReaders(passingPair));
  assert.equal(replaced.gates.nullStatus, "passed");
  const trial = await service.nextTrial();
  assert.equal(trial.trialIndex, 1);

  const forged = buildArtifact({
    request: makeRequest({ aCodec: "opus", aBitrate: 128, bCodec: "opus", bBitrate: 128 }),
    a: sine(440),
    b: sine(660),
  });
  (forged.artifact as { validity: unknown }).validity = {
    policy: "delivered-validity-v1",
    nullGate: evaluateNullGate(forged.artifact.request, {
      status: "negative-infinity",
      value: null,
      reason: "forged",
    }),
    notes: [],
  };
  const other = new ExperimentService(deterministicOptions());
  await other.configure(PLAN_FIXED);
  await expectCode(other.bindPrepared(forged.artifact, makeReaders(forged)), "artifact-invalid");
});

test("raw, missing-report and corrupted-reader artifacts fail closed", async () => {
  const service = new ExperimentService(deterministicOptions());
  await service.configure(PLAN_FIXED);

  const rawRequest = { ...makeRequest() } as Record<string, unknown>;
  delete rawRequest.preparationPolicy;
  const raw = buildArtifact({ request: rawRequest as unknown as ReturnType<typeof makeRequest> });
  await expectCode(service.bindPrepared(raw.artifact, makeReaders(raw)), "artifact-invalid");

  const missingPreparation = buildArtifact();
  delete (missingPreparation.artifact as { preparation?: unknown }).preparation;
  await expectCode(
    service.bindPrepared(missingPreparation.artifact, makeReaders(missingPreparation)),
    "artifact-invalid",
  );

  const missingValidity = buildArtifact();
  delete (missingValidity.artifact as { validity?: unknown }).validity;
  await expectCode(
    service.bindPrepared(missingValidity.artifact, makeReaders(missingValidity)),
    "artifact-invalid",
  );

  const wrongPurpose = buildArtifact();
  (wrongPurpose.artifact as { purpose: string }).purpose = "scored-evidence";
  await expectCode(service.bindPrepared(wrongPurpose.artifact, makeReaders(wrongPurpose)), "artifact-invalid");

  const corrupt = buildArtifact();
  await expectCode(
    service.bindPrepared(corrupt.artifact, makeReaders(corrupt, { corrupt: "a" })),
    "artifact-bytes-mismatch",
  );

  const throwing = buildArtifact();
  await expectCode(
    service.bindPrepared(throwing.artifact, makeReaders(throwing, { throwSide: "b" })),
    "artifact-reader-unavailable",
  );
});

test("serving re-verifies exact bytes; corrupted or late reads fail closed", async () => {
  const built = buildArtifact();
  const readers = makeReaders(built);
  const { service } = await configured(built, { readers });
  const trial = await service.nextTrial();
  const first = new Uint8Array(await service.readAudio(trial.token, "A"));
  const expectedHash = sha256(first);
  first.fill(0);
  const second = new Uint8Array(await service.readAudio(trial.token, "A"));
  assert.equal(sha256(second), expectedHash);
  assert.equal(second[0] ?? -1, built.bytes.a[0] ?? -1);

  // Corrupt the reader after binding: serving must reject, not publish bytes.
  const lastIndex = built.bytes.a.length - 1;
  built.bytes.a[lastIndex] = (built.bytes.a[lastIndex] ?? 0) ^ 0xff;
  await expectCode(service.readAudio(trial.token, "A"), "artifact-bytes-mismatch");

  const unknownBuilt = buildArtifact();
  const unknown = new ExperimentService(deterministicOptions());
  await unknown.configure(PLAN_FIXED);
  await unknown.bindPrepared(unknownBuilt.artifact, makeReaders(unknownBuilt));
  await expectCode(unknown.readAudio("not-a-token", "A"), "unknown-token");
});

test("token semantics: idempotence after Next, conflicts, stale/unknown and coalescing", async () => {
  const built = buildArtifact();
  const { service } = await configured(built);
  await expectCode(service.answer("unknown", "A"), "unknown-token");
  await expectCode(service.answer("unknown", "C" as "A"), "invalid-answer");

  const [first, second] = await Promise.all([service.nextTrial(), service.nextTrial()]);
  assert.equal(first.token, second.token);
  assert.equal(first.trialIndex, 1);

  const answers = await Promise.allSettled([
    service.answer(first.token, "A"),
    service.answer(first.token, "A"),
  ]);
  assert.equal(answers[0]?.status, "fulfilled");
  assert.equal(answers[1]?.status, "fulfilled");
  const receipt = (answers[0] as PromiseFulfilledResult<AnswerReceipt>).value;
  assert.deepEqual((answers[1] as PromiseFulfilledResult<AnswerReceipt>).value, receipt);

  const next = await service.nextTrial();
  assert.notEqual(next.token, first.token);
  const replay = await service.answer(first.token, "A");
  assert.deepEqual(replay, receipt);
  await expectCode(service.answer(first.token, "B"), "conflicting-answer");
  await expectCode(service.answer("never-issued", "A"), "unknown-token");

  // A token that existed in the run but no longer names the pending trial.
  const stale = next.token;
  await service.answer(stale, "A");
  const third = await service.nextTrial();
  await expectCode(service.answer(stale, "B"), "conflicting-answer");
  await expectCode(service.readAudio(stale, "A"), "stale-token");
  assert.equal(third.trialIndex, 3);
});

test("raw significance is not a final verdict; completed requires planned N and gates", async () => {
  const built = buildArtifact({ request: makeRequest({ canaryEnabled: false }) });
  const { service } = await configured(built, {
    plan: plan({ plannedTrials: 20 }),
  });
  for (let index = 1; index <= 10; index += 1) {
    const trial = await service.nextTrial();
    const x = await xSourceForIndex(FIXTURE_SECRET, index);
    await service.answer(trial.token, correctDisplay(x, false));
  }
  const provisional = await service.snapshot();
  assert.equal(provisional.lifecycle, "running");
  assert.equal(provisional.statistics.scoredTrials, 10);
  assert.equal(provisional.statistics.significant, true);
  assert.equal(provisional.statistics.isFinal, false);
  assert.equal(provisional.statistics.significantVerdict, false);
  assert.equal(provisional.statistics.requiredCorrect, 15);
  const provisionalExport = await service.export();
  assert.equal(provisionalExport.reveal.redacted, true);
  assert.equal(provisionalExport.reveal.secretHex, null);

  for (let index = 11; index <= 20; index += 1) {
    const trial = await service.nextTrial();
    const x = await xSourceForIndex(FIXTURE_SECRET, index);
    await service.answer(trial.token, correctDisplay(x, false));
  }
  const final = await service.snapshot();
  assert.equal(final.lifecycle, "completed");
  assert.equal(final.statistics.isFinal, true);
  assert.equal(final.statistics.significantVerdict, true);
});

test("null planned N is descriptive practice, seals to reveal and is capped at 1000", async () => {
  {
    const built = buildArtifact();
    const { service } = await configured(built, { plan: plan({ plannedTrials: null }) });
    for (let index = 1; index <= 3; index += 1) {
      const trial = await service.nextTrial();
      assert.equal(trial.kind, "scored");
      await service.answer(trial.token, "A");
    }
    const practice = await service.snapshot();
    assert.equal(practice.statistics.plannedTrials, null);
    assert.equal(practice.statistics.requiredCorrect, null);
    assert.equal(practice.statistics.isFinal, false);
    assert.equal(practice.statistics.significantVerdict, false);
    assert.equal((await service.export()).reveal.redacted, true);
    const sealed = await service.seal("practice complete");
    assert.equal(sealed.lifecycle, "sealed");
    assert.equal(sealed.sealedReason, "practice complete");
    const exported = await service.export();
    assert.equal(exported.reveal.redacted, false);
    assert.ok(exported.reveal.secretHex);
    assert.equal(exported.reveal.xSequence.length, 3);
  }
  {
    const built = buildArtifact();
    const { service } = await configured(built, { plan: plan({ plannedTrials: null }) });
    for (let index = 1; index <= 1000; index += 1) {
      const trial = await service.nextTrial();
      await service.answer(trial.token, "A");
    }
    const capped = await service.snapshot();
    assert.equal(capped.statistics.scoredTrials, 1000);
    assert.equal(capped.lifecycle, "running");
    await expectCode(service.nextTrial(), "practice-limit");
  }
});

test("seal and terminal reveal export the secret only after the run is closed", async () => {
  const built = buildArtifact();
  const { service } = await configured(built, { plan: plan({ plannedTrials: 20 }) });
  const trial = await service.nextTrial();
  await service.answer(trial.token, "A");
  const before = await service.snapshot();
  assert.equal(before.lifecycle, "running");
  assert.equal((await service.export()).reveal.secretHex, null);
  const sealed = await service.seal("listener left");
  assert.equal(sealed.lifecycle, "sealed");
  assert.equal(sealed.sealedReason, "listener left");
  assert.equal(sealed.pendingTrial, null);
  await expectCode(service.nextTrial(), "run-closed");
  const exported = await service.export();
  assert.equal(exported.reveal.redacted, false);
  assert.equal(exported.reveal.verifiable, true);
  assert.ok(exported.reveal.secretHex);
  assert.equal(
    await verifyReveal(exported.reveal.secretHex!, exported.reveal.commitment, exported.reveal.xSequence),
    true,
  );
  // Idempotent seal keeps the terminal state.
  const again = await service.seal("different");
  assert.equal(again.lifecycle, "sealed");
  assert.equal(again.sealedReason, "listener left");
});

test("delayed reads are invalidated by reset, seal and dispose", async () => {
  for (const invalidate of ["reset", "seal", "dispose"] as const) {
    const built = buildArtifact();
    const gate = deferred();
    const readers = makeReaders(built, { gateAfterBindA: gate.promise });
    const { service } = await configured(built, { readers });
    const trial = await service.nextTrial();
    const reading = service.readAudio(trial.token, "A");
    if (invalidate === "reset") {
      const reset = await service.reset();
      assert.equal(reset.lifecycle, "configured");
    } else if (invalidate === "seal") {
      await service.seal();
    } else {
      await service.dispose();
    }
    gate.resolve();
    await expectCode(reading, invalidate === "dispose" ? "disposed" : "stale-token");
    if (invalidate === "reset") {
      await expectCode(service.answer(trial.token, "A"), "unknown-token");
      assert.equal((await service.snapshot()).pendingTrial, null);
    } else if (invalidate === "seal") {
      await expectCode(service.answer(trial.token, "A"), "run-closed");
    } else {
      await expectCode(service.snapshot(), "disposed");
      await service.dispose();
    }
  }
});

test("late assignment crypto cannot publish after dispose", async () => {
  const built = buildArtifact();
  const assignment = deferred();
  const seams = deterministicOptions();
  const service = new ExperimentService({
    ...seams,
    xSourceForIndex: async () => {
      await assignment.promise;
      return "A";
    },
  });
  await service.configure(PLAN_FIXED);
  await service.bindPrepared(built.artifact, makeReaders(built));
  const trial = service.nextTrial();
  await service.dispose();
  assignment.resolve();
  await expectCode(trial, "disposed");
  await expectCode(service.nextTrial(), "disposed");
});

test("seal and reset preempt in-flight trial assignment crypto", async () => {
  for (const action of ["seal", "reset"] as const) {
    const built = buildArtifact();
    const assignment = deferred();
    const started = deferred();
    const seams = deterministicOptions();
    const service = new ExperimentService({
      ...seams,
      xSourceForIndex: async () => {
        started.resolve();
        await assignment.promise;
        return "A";
      },
    });
    await service.configure(PLAN_FIXED);
    await service.bindPrepared(built.artifact, makeReaders(built));
    const staging = service.nextTrial();
    await started.promise;
    if (action === "seal") {
      const sealed = await service.seal("seal during assignment");
      assert.equal(sealed.lifecycle, "sealed");
    } else {
      const reset = await service.reset();
      assert.equal(reset.lifecycle, "configured");
      assert.equal(reset.pendingTrial, null);
    }
    assignment.resolve();
    await expectCode(staging, "stale-token");
    const snapshot = await service.snapshot();
    assert.equal(snapshot.pendingTrial, null);
    assert.equal(snapshot.lifecycle, action === "seal" ? "sealed" : "configured");
  }
});

test("late commitment reset cannot publish state after dispose", async () => {
  const built = buildArtifact();
  const commit = deferred();
  let calls = 0;
  const seams = deterministicOptions({ secrets: [FIXTURE_SECRET, FIXTURE_SECRET] });
  const service = new ExperimentService({
    ...seams,
    commitSecret: async (secret) => {
      calls += 1;
      if (calls === 1) {
        const { commitSecret } = await import("../src/commitment.js");
        return commitSecret(secret);
      }
      await commit.promise;
      return "f".repeat(64);
    },
  });
  await service.configure(PLAN_FIXED);
  await service.bindPrepared(built.artifact, makeReaders(built));
  const resetting = service.reset();
  await service.dispose();
  commit.resolve();
  await expectCode(resetting, "disposed");
});

test("reset from a failed null gate retains the blocking pair facts", async () => {
  const failedPair = buildArtifact({
    request: makeRequest({ aCodec: "opus", aBitrate: 128, bCodec: "opus", bBitrate: 128 }),
    a: sine(440),
    b: sine(660),
  });
  const secondSecret = Uint8Array.from({ length: 32 }, (_, index) => 17 + index);
  const { service } = await configured(failedPair, {
    seams: deterministicOptions({ secrets: [FIXTURE_SECRET, secondSecret] }),
  });
  const old = await service.snapshot();
  const reset = await service.reset();
  assert.equal(reset.gates.nullStatus, "failed");
  assert.equal(reset.prepared?.artifactId, old.prepared?.artifactId);
  assert.notEqual(reset.commitment, old.commitment);
  await expectCode(service.nextTrial(), "null-gate-failed");
});

test("statistics fields match the numerics module for scored answers", async () => {
  const built = buildArtifact();
  const { service } = await configured(built, { plan: plan({ plannedTrials: 8 }) });
  // Perfect plus one deliberate miss, so p/CI are non-trivial.
  for (let index = 1; index <= 8; index += 1) {
    const trial = await service.nextTrial();
    const x = await xSourceForIndex(FIXTURE_SECRET, index);
    await service.answer(trial.token, index === 4
      ? (correctDisplay(x, false) === "A" ? "B" : "A")
      : correctDisplay(x, false));
  }
  const stats = (await service.snapshot()).statistics;
  assert.equal(stats.scoredTrials, 8);
  assert.equal(stats.correctTrials, 7);
  assert.equal(stats.pValue, 9 / 256);
  assert.equal(stats.ability, 0.875);
  assert.deepEqual(stats.abilityCi95, [0.47349, 0.99684]);
  assert.equal(stats.significant, true);
  assert.equal(stats.significantVerdict, true);
});

// ── Deterministic lifecycle trace ─────────────────────────────────────────────

test("perfect fixed N=8 publishes a completed audit and reveal from exact trial answers", async () => {
  const built = buildArtifact();
  const { service } = await configured(built, { plan: plan({ plannedTrials: 8 }) });
  for (let index = 1; index <= 8; index += 1) {
    const trial = await service.nextTrial();
    const source = await xSourceForIndex(FIXTURE_SECRET, index);
    assert.equal(trial.trialIndex, index);
    await service.answer(trial.token, correctDisplay(source, false));
  }

  const snapshot = await service.snapshot();
  assert.equal(snapshot.lifecycle, "completed");
  assert.equal(snapshot.gates.calibrationStatus, "not-configured");
  assert.notEqual(snapshot.gates.nullStatus, "failed");
  assert.equal(snapshot.statistics.scoredTrials, 8);
  assert.equal(snapshot.statistics.correctTrials, 8);
  assert.equal(snapshot.statistics.pValue, 1 / 256);
  assert.equal(snapshot.statistics.ability, 1);
  assert.deepEqual(snapshot.statistics.abilityCi95, [0.630583, 1]);
  assert.equal(snapshot.statistics.significant, true);
  assert.equal(snapshot.statistics.significantVerdict, true);
  assert.equal(snapshot.statistics.isFinal, true);

  const exported = await service.export();
  assert.equal(exported.trials.length, 8);
  for (const [index, row] of exported.trials.entries()) {
    const expectedSource = await xSourceForIndex(FIXTURE_SECRET, index + 1);
    assert.equal(row.trialIndex, index + 1);
    assert.equal(row.kind, "scored");
    assert.equal(row.xSource, expectedSource);
    assert.equal(row.correct, true);
    assert.equal(row.displayMapping.A, "A");
    assert.equal(row.displayMapping.B, "B");
  }
  assert.deepEqual(exported.reveal.xSequence, await xSequence(FIXTURE_SECRET, 8));
  assert.equal(exported.reveal.redacted, false);
  assert.equal(exported.reveal.verifiable, true);
  assert.equal(exported.reveal.secretHex, secretToHex(FIXTURE_SECRET));
});

test("provisional N=20 answers stay running, descriptive and redacted before the plan is final", async () => {
  const built = buildArtifact();
  const { service } = await configured(built, { plan: plan({ plannedTrials: 20 }) });
  for (let index = 1; index <= 10; index += 1) {
    const trial = await service.nextTrial();
    const source = await xSourceForIndex(FIXTURE_SECRET, index);
    await service.answer(trial.token, correctDisplay(source, false));
  }
  const provisional = await service.snapshot();
  assert.equal(provisional.lifecycle, "running");
  assert.equal(provisional.statistics.scoredTrials, 10);
  assert.equal(provisional.statistics.correctTrials, 10);
  assert.equal(provisional.statistics.plannedTrials, 20);
  assert.equal(provisional.statistics.isFinal, false);
  assert.equal(provisional.statistics.pValue, 1 / 1024);
  const provisionalExport = await service.export();
  assert.equal(provisionalExport.reveal.redacted, true);
  assert.equal(provisionalExport.reveal.secretHex, null);
  assert.equal(provisionalExport.trials.length, 10);
});
