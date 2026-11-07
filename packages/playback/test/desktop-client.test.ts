import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  DesktopBridge,
  DesktopRuntimeFailure,
  DesktopSource,
  EngineCapabilities,
  ExperimentExport,
  ExperimentSnapshot,
  PreparedArtifact,
  PreparationProgress,
  PreparationRequest,
} from "@codec-abx/contracts";

import { getDesktopBridge } from "../../../apps/client/src/desktop/bridge.js";
import { DesktopExperimentClient } from "../../../apps/client/src/desktop/experiment.js";
import { DesktopPreparationEngine } from "../../../apps/client/src/desktop/preparation.js";
import { buildListeningExport } from "../../../apps/client/src/listening/export.js";
import {
  calibrationMaterialAdvice,
  listeningArtifactEligibility,
} from "../../../apps/client/src/listening/model.js";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const SOURCE: DesktopSource = Object.freeze({
  id: "source_handle_0123456789",
  name: "fixture.wav",
  size: 44_000,
});

const CAPABILITIES: EngineCapabilities = Object.freeze({
  engineId: "engine-native-typescript",
  location: "desktop-native",
  build: "TypeScript native codec fixture",
  codecs: [],
  channels: [1, 2] as const,
  maxInputBytes: 256 * 1024 * 1024,
  maxDurationSeconds: 600,
  preparationPolicy: "aligned-gain-matched-v1",
  supportedPreparationPolicies: ["aligned-gain-matched-v1"] as const,
  supportsCanaryMaterial: true,
  limitations: [],
});

const REQUEST: PreparationRequest = Object.freeze({
  version: 1,
  preparationPolicy: "aligned-gain-matched-v1",
  sampleRateMode: "native",
  a: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
  b: { codecId: "opus" as const, bitrateKbps: 128 },
});

const ARTIFACT = { id: "artifact_0123456789abcdef" } as unknown as PreparedArtifact;

interface PreparationHarness {
  readonly bridge: DesktopBridge["preparation"];
  readonly calls: {
    prepare: string[];
    cancel: string[];
    release: string[];
    requests: PreparationRequest[];
    sources: string[];
  };
  emit(jobId: string, progress: PreparationProgress): void;
}

function preparationHarness(
  work: (jobId: string) => Promise<PreparedArtifact> = () => Promise.resolve(ARTIFACT),
  cancelWork: (jobId: string) => Promise<void> = () => Promise.resolve(),
): PreparationHarness {
  let listener: ((jobId: string, progress: PreparationProgress) => void) | null = null;
  const calls: PreparationHarness["calls"] = {
    prepare: [],
    cancel: [],
    release: [],
    requests: [],
    sources: [],
  };
  const bridge: DesktopBridge["preparation"] = {
    pickSource: () => Promise.resolve(SOURCE),
    capabilities: () => Promise.resolve(CAPABILITIES),
    prepare: (sourceId, request, jobId) => {
      calls.prepare.push(jobId);
      calls.sources.push(sourceId);
      calls.requests.push(request);
      return work(jobId);
    },
    cancel: (jobId) => {
      calls.cancel.push(jobId);
      return cancelWork(jobId);
    },
    readAudio: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
    readCanaryAudio: () => Promise.resolve(new Uint8Array([5, 6]).buffer),
    release: (artifactId) => {
      calls.release.push(artifactId);
      return Promise.resolve();
    },
    onProgress: (value) => {
      listener = value;
      return () => {
        listener = null;
      };
    },
  };
  return {
    bridge,
    calls,
    emit: (jobId, progress) => listener?.(jobId, progress),
  };
}

const PROGRESS: PreparationProgress = Object.freeze({
  phase: "encoding",
  message: "Encoding fixture",
});

test("desktop bridge detection requires the complete versioned surface", () => {
  const scope = globalThis as unknown as { window?: unknown };
  const previous = scope.window;
  try {
    scope.window = { location: { protocol: "https:" } };
    assert.equal(getDesktopBridge(), null);
    scope.window = { location: { protocol: "codec-abx:" } };
    assert.throws(getDesktopBridge, (error: unknown) =>
      (error as { code?: string }).code === "desktop-unavailable");
    scope.window = { codecAbxDesktop: { version: 1 } };
    assert.throws(getDesktopBridge);
    const bridge = {
      version: 1,
      preparation: preparationHarness().bridge,
      experiment: Object.fromEntries(["configure", "snapshot", "bindPrepared", "nextTrial",
        "answer", "readAudio", "seal", "reset", "export", "dispose"].map((name) => [name, () => Promise.resolve()])),
    };
    scope.window = { codecAbxDesktop: bridge };
    assert.equal(getDesktopBridge(), bridge);
    scope.window = { codecAbxDesktop: { ...bridge, version: 2 } };
    assert.throws(getDesktopBridge);
    scope.window = { codecAbxDesktop: { ...bridge, preparation: { ...bridge.preparation, cancel: null } } };
    assert.throws(getDesktopBridge);
    scope.window = undefined;
    assert.equal(getDesktopBridge(), null);
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
});

test("desktop preparation adapter scopes fresh job IDs, frozen requests and progress", async () => {
  const h = preparationHarness();
  const engine = new DesktopPreparationEngine(h.bridge);
  const seen: PreparationProgress[] = [];
  const mutable = structuredClone(REQUEST) as {
    version: 1;
    preparationPolicy: "aligned-gain-matched-v1";
    sampleRateMode: "native";
    a: { codecId: "noop_passthrough" | "opus"; bitrateKbps: number };
    b: { codecId: "noop_passthrough" | "opus"; bitrateKbps: number };
  };
  const prepared = engine.prepare(SOURCE, mutable, {
    onProgress: (progress) => seen.push(progress),
  });
  mutable.a = { codecId: "opus", bitrateKbps: 64 };
  await Promise.resolve();

  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.sources[0], SOURCE.id);
  assert.match(h.calls.prepare[0]!, /^job_[a-zA-Z0-9_-]{16,128}$/);
  assert.deepEqual(h.calls.requests[0]?.a, { codecId: "noop_passthrough", bitrateKbps: 0 });
  assert.equal(Object.isFrozen(h.calls.requests[0]), true);
  assert.equal(Object.isFrozen(h.calls.requests[0]?.a), true);

  h.emit("job_unrelated_0123456789", { phase: "measuring", message: "wrong job" });
  assert.equal(seen.length, 0);
  h.emit(h.calls.prepare[0]!, PROGRESS);
  assert.deepEqual(seen, [PROGRESS]);

  const artifact = await prepared;
  assert.equal(artifact.id, ARTIFACT.id);
  assert.equal(engine.activeJobId, null);

  const first = await engine.readAudio(ARTIFACT.id, "a");
  const second = await engine.readAudio(ARTIFACT.id, "a");
  assert.deepEqual([...new Uint8Array(first)], [1, 2, 3, 4]);
  assert.notEqual(first, second);
  assert.deepEqual([...new Uint8Array(await engine.readCanaryAudio(ARTIFACT.id, "pristine"))], [5, 6]);
  await engine.release(ARTIFACT.id);
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
  await assert.rejects(() => engine.readAudio(ARTIFACT.id, "a"), (error: unknown) =>
    (error as { code?: string }).code === "artifact-invalid");
  await engine.release(ARTIFACT.id);
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
  await engine.dispose();
  await assert.rejects(() => engine.capabilities(), (error: unknown) =>
    (error as { code?: string }).code === "disposed");
  await assert.rejects(() => engine.pickSource(), (error: unknown) =>
    (error as { code?: string }).code === "disposed");
});

test("desktop preparation disposal releases published artifacts and shares its completion", async () => {
  const gate = deferred();
  const h = preparationHarness();
  h.bridge.release = async (id) => { h.calls.release.push(id); await gate.promise; };
  const engine = new DesktopPreparationEngine(h.bridge);
  await engine.prepare(SOURCE, REQUEST);
  const disposal = engine.dispose();
  assert.equal(engine.dispose(), disposal);
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
  let settled = false;
  void disposal.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await disposal;
  await engine.release(ARTIFACT.id);
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
});

test("desktop progress exceptions cancel, await cleanup, release late audio and reject the original failure", async () => {
  const gate = deferred();
  const failure = new Error("Consumer progress failed");
  const h = preparationHarness(async () => { await gate.promise; return ARTIFACT; },
    async () => { await gate.promise; });
  const engine = new DesktopPreparationEngine(h.bridge);
  const work = engine.prepare(SOURCE, REQUEST, { onProgress: () => { throw failure; } });
  await Promise.resolve();
  const rejection = assert.rejects(work, (error) => error === failure);
  assert.doesNotThrow(() => h.emit(h.calls.prepare[0]!, PROGRESS));
  assert.equal(h.calls.cancel.length, 1);
  gate.resolve();
  await rejection;
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
  await engine.dispose();
});

test("desktop cancellation never claims cleanup when main cancellation fails", async () => {
  const gate = deferred();
  const h = preparationHarness(async () => { await gate.promise; return ARTIFACT; },
    async () => { throw { code: "transport-failed", message: "Lost cleanup acknowledgement" }; });
  const engine = new DesktopPreparationEngine(h.bridge);
  const controller = new AbortController();
  const work = engine.prepare(SOURCE, REQUEST, { signal: controller.signal });
  await Promise.resolve();
  const rejection = assert.rejects(work, (error: unknown) =>
    (error as { code?: string }).code === "cleanup-unconfirmed");
  controller.abort();
  gate.resolve();
  await rejection;
  assert.deepEqual(h.calls.release, [ARTIFACT.id], "late release still runs after cancel failed");
  await assert.rejects(() => engine.prepare(SOURCE, REQUEST), (error: unknown) =>
    (error as { code?: string }).code === "cleanup-unconfirmed");
  await assert.rejects(engine.dispose(), (error: unknown) =>
    (error as { code?: string }).code === "cleanup-unconfirmed");
});

test("late no-op cancel acknowledgement cannot hide the main prepare cleanup failure", async () => {
  const gate = deferred();
  const failure = { code: "cleanup-unconfirmed", message: "Main cleanup failed before cancel arrived" };
  const h = preparationHarness(async () => { await gate.promise; throw failure; });
  const engine = new DesktopPreparationEngine(h.bridge);
  const controller = new AbortController();
  const work = engine.prepare(SOURCE, REQUEST, { signal: controller.signal });
  await Promise.resolve();
  const rejection = assert.rejects(work, (error: unknown) => error === failure);
  controller.abort();
  gate.resolve();
  await rejection;
  assert.equal(h.calls.cancel.length, 1);
  await assert.rejects(engine.dispose(), (error: unknown) => error === failure);
});

test("desktop preparation rejects malformed sources, policies and concurrent jobs", async () => {
  const gate = deferred<void>();
  const h = preparationHarness(async () => {
    await gate.promise;
    return ARTIFACT;
  });
  const engine = new DesktopPreparationEngine(h.bridge);
  await assert.rejects(() => engine.prepare({ id: "" } as DesktopSource, REQUEST), (error: unknown) =>
    (error as { code?: string }).code === "source-invalid");
  await assert.rejects(() => engine.prepare(SOURCE, { ...REQUEST, preparationPolicy: "codec-probe-only" }), (error: unknown) =>
    (error as { code?: string }).code === "invalid-request");
  const first = engine.prepare(SOURCE, REQUEST);
  await assert.rejects(() => engine.prepare(SOURCE, REQUEST), (error: unknown) =>
    (error as { code?: string }).code === "job-conflict");
  gate.resolve();
  await first;
  await engine.dispose();
});

test("desktop preparation preserves structured main errors without inventing local cleanup", async () => {
  const refusal = {
    name: "DesktopError",
    code: "native-operation-failed",
    message: "Native operation failed; restore prerequisites and retry explicitly",
    reasons: ["Native codec dependency missing"],
    uncertain: false,
  };
  const h = preparationHarness(async () => {
    throw refusal;
  });
  const engine = new DesktopPreparationEngine(h.bridge);
  await assert.rejects(() => engine.prepare(SOURCE, REQUEST), (error: unknown) =>
    error === refusal);
  assert.deepEqual(h.calls.cancel, []);
  assert.deepEqual(h.calls.release, []);
  assert.equal(engine.activeJobId, null);
  await engine.dispose();
});

test("desktop cancellation waits for main cleanup and never publishes a late artifact", async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  const h = preparationHarness(
    async () => {
      started.resolve();
      await gate.promise;
      return ARTIFACT;
    },
    async () => {
      await gate.promise;
    },
  );
  const engine = new DesktopPreparationEngine(h.bridge);
  const controller = new AbortController();
  const work = engine.prepare(SOURCE, REQUEST, { signal: controller.signal });
  await started.promise;
  let settled = false;
  void work.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  controller.abort();
  assert.equal(h.calls.cancel.length, 1);
  await Promise.resolve();
  assert.equal(settled, false, "abort rejection waits for cleanup");
  gate.resolve();
  await assert.rejects(work, (error: unknown) => (error as Error).name === "AbortError");
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
  assert.equal(engine.activeJobId, null);
  await engine.dispose();
});

test("desktop disposal aborts one active job and waits for its cleanup", async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  const h = preparationHarness(
    async () => {
      started.resolve();
      await gate.promise;
      return ARTIFACT;
    },
    async () => {
      await gate.promise;
    },
  );
  const engine = new DesktopPreparationEngine(h.bridge);
  const work = engine.prepare(SOURCE, REQUEST);
  await started.promise;
  let disposed = false;
  const disposal = engine.dispose().then(() => { disposed = true; });
  assert.equal(h.calls.cancel.length, 1);
  await Promise.resolve();
  assert.equal(disposed, false);
  gate.resolve();
  await assert.rejects(work, (error: unknown) => (error as Error).name === "AbortError");
  await disposal;
  assert.equal(disposed, true);
  assert.deepEqual(h.calls.release, [ARTIFACT.id]);
});

test("desktop experiment adapter preserves identity/tokens and ignores renderer readers on bind", async () => {
  const calls: string[] = [];
  let readerCalls = 0;
  const snapshot = { runId: "run", prepared: null } as unknown as ExperimentSnapshot;
  const bridge: DesktopBridge["experiment"] = {
    configure: () => { calls.push("configure"); return Promise.resolve(snapshot); },
    snapshot: () => { calls.push("snapshot"); return Promise.resolve(snapshot); },
    bindPrepared: (artifactId) => {
      calls.push(`bind:${artifactId}`);
      return Promise.resolve(snapshot);
    },
    nextTrial: () => { calls.push("nextTrial"); return Promise.resolve({} as never); },
    answer: (token, answer) => {
      calls.push(`answer:${token}:${answer}`);
      return Promise.resolve({} as never);
    },
    readAudio: (token, label) => {
      calls.push(`read:${token}:${label}`);
      return Promise.resolve(new ArrayBuffer(2));
    },
    seal: (reason) => { calls.push(`seal:${reason ?? ""}`); return Promise.resolve(snapshot); },
    reset: () => { calls.push("reset"); return Promise.resolve(snapshot); },
    export: () => { calls.push("export"); return Promise.resolve({} as ExperimentExport); },
    dispose: () => { calls.push("dispose"); return Promise.resolve(); },
  };
  const client = new DesktopExperimentClient(bridge);
  const readers = {
    readAudio: () => {
      readerCalls += 1;
      return Promise.resolve(new ArrayBuffer(0));
    },
  };
  await client.configure({ version: 1, plannedTrials: 2, alpha: 0.05, labelMode: "fixed", calibrationEnabled: false });
  await client.bindPrepared(ARTIFACT, readers);
  await client.answer("token_0123456789", "A");
  await client.readAudio("token_0123456789", "X");
  await client.seal("fixture reason");
  await client.dispose();

  assert.equal(readerCalls, 0, "renderer readers are never sent to main");
  assert.deepEqual(calls, [
    "configure",
    "bind:artifact_0123456789abcdef",
    "answer:token_0123456789:A",
    "read:token_0123456789:X",
    "seal:fixture reason",
    "dispose",
  ]);
  await assert.rejects(() => client.snapshot(), (error: unknown) =>
    (error as { code?: string }).code === "disposed");
});

test("desktop experiment adapter delegates the optional fatal channel and unsubscribes", async () => {
  const received: DesktopRuntimeFailure[] = [];
  let listener: ((failure: DesktopRuntimeFailure) => void) | null = null;
  let unsubscribed = 0;
  const snapshot = { runId: "run", prepared: null } as unknown as ExperimentSnapshot;
  const bridge: DesktopBridge["experiment"] = {
    onFatal: (value) => {
      listener = value;
      return () => {
        unsubscribed += 1;
        if (listener === value) listener = null;
      };
    },
    configure: () => Promise.resolve(snapshot),
    snapshot: () => Promise.resolve(snapshot),
    bindPrepared: () => Promise.resolve(snapshot),
    nextTrial: () => Promise.resolve({} as never),
    answer: () => Promise.resolve({} as never),
    readAudio: () => Promise.resolve(new ArrayBuffer(0)),
    seal: () => Promise.resolve(snapshot),
    reset: () => Promise.resolve(snapshot),
    export: () => Promise.resolve({} as ExperimentExport),
    dispose: () => Promise.resolve(),
  };
  const client = new DesktopExperimentClient(bridge);
  const unsubscribe = client.onFatal((failure) => received.push(failure));
  const failure: DesktopRuntimeFailure = {
    code: "worker-fatal",
    message: "Desktop worker stopped.",
    reasons: ["worker exited"],
    uncertain: false,
  };
  listener!(failure);
  assert.deepEqual(received, [failure]);
  unsubscribe();
  assert.equal(unsubscribed, 1);
  await client.dispose();
  assert.equal(typeof client.onFatal(() => undefined), "function");
});

test("desktop experiment adapter without an optional fatal channel stays compatible", async () => {
  const snapshot = { runId: "run", prepared: null } as unknown as ExperimentSnapshot;
  const bridge: DesktopBridge["experiment"] = {
    configure: () => Promise.resolve(snapshot),
    snapshot: () => Promise.resolve(snapshot),
    bindPrepared: () => Promise.resolve(snapshot),
    nextTrial: () => Promise.resolve({} as never),
    answer: () => Promise.resolve({} as never),
    readAudio: () => Promise.resolve(new ArrayBuffer(0)),
    seal: () => Promise.resolve(snapshot),
    reset: () => Promise.resolve(snapshot),
    export: () => Promise.resolve({} as ExperimentExport),
    dispose: () => Promise.resolve(),
  };
  const client = new DesktopExperimentClient(bridge);
  assert.equal(typeof client.onFatal(() => undefined), "function");
  await client.dispose();
});

const SHARED_PREPARATION = {
  policy: "aligned-gain-matched-v1",
  targetLufs: -16,
  minimumDurationSeconds: 0.4,
  maxLagSeconds: 0.1,
  peakCeiling: 0.98,
  alignment: {
    lagSamples: 0, confidence: 0, maxLagSamples: 4800, probeSamples: 240_000,
    status: "no-evidence", inputFramesA: 24_000, inputFramesB: 24_000,
    startFrameA: 0, startFrameB: 0, outputFrames: 24_000,
  },
  loudness: {
    preA: { status: "finite", value: -16, reason: null },
    preB: { status: "finite", value: -16, reason: null },
    gainADb: 0, gainBDb: 0, commonTrimDb: 0,
  },
  serialization: { format: "pcm16-le", rounding: "floor", floorBiasCodeSteps: 2 ** -17, dither: false },
  notes: [],
} as const;

function nativeArtifact(overrides: Partial<Record<keyof PreparedArtifact, unknown>> = {}): PreparedArtifact {
  return {
    id: "native_artifact_0123456789",
    request: {
      version: 1,
      preparationPolicy: "aligned-gain-matched-v1",
      canaryEnabled: true,
      sampleRateMode: "native",
      a: { codecId: "noop_passthrough", bitrateKbps: 0 },
      b: { codecId: "opus", bitrateKbps: 128 },
    },
    engine: CAPABILITIES,
    sourceSha256: "1".repeat(64),
    a: {
      requested: { codecId: "noop_passthrough", bitrateKbps: 0 },
      encoder: "pcm",
      decoder: "pcm",
      actualBitrateKbps: null,
      encodedSampleRate: 48_000,
      delivered: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "2".repeat(64) },
    },
    b: {
      requested: { codecId: "opus", bitrateKbps: 128 },
      encoder: "libopus",
      decoder: "libopus",
      actualBitrateKbps: 128,
      encodedSampleRate: 48_000,
      delivered: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "3".repeat(64) },
    },
    elapsedMs: 1,
    measurements: {
      policy: "aligned-gain-matched-v1",
      alignmentLagSamples: 0,
      alignmentConfidence: 0,
      loudnessDeltaDb: 0,
      nullDepthDb: -60,
      notes: [],
      delivered: {
        policy: "delivered-pcm-measurements-v1",
        alignment: { lagSamples: 0, confidence: 0, maxLagSamples: 4800, probeSamples: 240_000, status: "no-evidence" },
        a: {
          sampleRate: 48_000, channels: 1, frames: 24_000,
          integratedLufs: { status: "finite", value: -16, reason: null },
          samplePeakDbfs: { status: "finite", value: -12, reason: null },
        },
        b: {
          sampleRate: 48_000, channels: 1, frames: 24_000,
          integratedLufs: { status: "finite", value: -16, reason: null },
          samplePeakDbfs: { status: "finite", value: -12, reason: null },
        },
        loudnessDeltaDb: { status: "finite", value: 0, reason: null },
        nullDepth: { basis: "unshifted-common-prefix", comparedFrames: 24_000, depthDb: { status: "finite", value: -60, reason: null } },
        notes: [],
      },
    },
    validity: {
      policy: "delivered-validity-v2",
      nullGate: {
        policy: "identical-pipeline-null-v1",
        status: "passed",
        expectedIdentical: false,
        thresholdDb: -60,
        depthDb: { status: "finite", value: -60, reason: null },
        reason: "fixture",
      },
      preparationGate: {
        policy: "preparation-validity-v2",
        status: "passed",
        classification: "same-polarity-unique",
        reason: "test fixture",
        constants: {
          minAcRmsFullScale: 1 / 32768,
          invertedMinConfidence: 0.5,
          invertedMargin: 0.25,
          sameMinConfidence: 0.5,
          peakValueTolerance: 0.01,
        },
        evidence: {
          acRmsFullScaleA: 0.1,
          acRmsFullScaleB: 0.1,
          acRmsCodeStepsA: 3276.8,
          acRmsCodeStepsB: 3276.8,
          sameConfidence: 0.99,
          sameLagSamples: 0,
          invertedConfidence: 0.01,
          invertedLagSamples: 0,
          chosenPolarity: "same",
          chosenLagSamples: 0,
          chosenConfidence: 0.99,
          searchMinLagSamples: -4800,
          searchMaxLagSamples: 4800,
          distinctPositivePeaksWithinTolerance: 1,
        },
        disclosure: null,
        notes: [],
      },
      notes: [],
    },
    canary: {
      report: {
        policy: "delivered-canary-v1",
        status: "usable",
        usable: true,
        minimumResidualDb: -30,
        depthDb: { status: "finite", value: -20, reason: null },
        reason: "fixture",
        cutoffHz: 3000,
        frequencyGrid: "numpy-rfftfreq-v1",
        drive: 10,
        clipLevel: 0.45,
        sampleRate: 48_000,
        channels: 1,
        frames: 24_000,
        notes: [],
      },
      audio: {
        pristine: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "4".repeat(64) },
        degraded: { sampleRate: 48_000, channels: 1, frames: 24_000, wavSha256: "5".repeat(64) },
      },
    },
    preparation: SHARED_PREPARATION,
    disclosures: [],
    purpose: "diagnostic-only",
    ...overrides,
  } as unknown as PreparedArtifact;
}

function browserSharedArtifact(): PreparedArtifact {
  return nativeArtifact({
    engine: { ...CAPABILITIES, location: "browser-local", preparationPolicy: "aligned-gain-matched-v1" },
    request: {
      version: 1,
      preparationPolicy: "aligned-gain-matched-v1",
      canaryEnabled: true,
      sampleRateMode: "native",
      a: { codecId: "noop_passthrough", bitrateKbps: 0 },
      b: { codecId: "opus", bitrateKbps: 128 },
    },
    preparation: SHARED_PREPARATION,
  });
}

test("listening eligibility accepts the shared native engine and preserves raw/unsupported refusals", () => {
  const native = nativeArtifact();
  assert.equal(listeningArtifactEligibility(native), null);
  assert.equal(calibrationMaterialAdvice(native), null);

  const unsupported = nativeArtifact({
    request: { ...native.request, preparationPolicy: "unknown-policy-v0" as never },
  });
  assert.match(listeningArtifactEligibility(unsupported) ?? "", /engine-native-typescript/);
  const raw = nativeArtifact({
    request: { ...native.request, preparationPolicy: "codec-probe-only" },
  });
  assert.match(listeningArtifactEligibility(raw) ?? "", /engine-native-typescript/);

  const shared = browserSharedArtifact();
  assert.equal(listeningArtifactEligibility(shared), null);
  const rawBrowser = browserSharedArtifact();
  (rawBrowser as { request: PreparationRequest }).request = {
    ...rawBrowser.request,
    preparationPolicy: "codec-probe-only",
  };
  (rawBrowser as { preparation?: unknown }).preparation = undefined;
  assert.match(listeningArtifactEligibility(rawBrowser) ?? "", /aligned-gain-matched-v1/);
});

test("listening export records provenance and unknown output channels", () => {
  const native = nativeArtifact();
  const snapshot = {
    authority: "local-self-test",
    lifecycle: "completed",
    plan: { version: 1, plannedTrials: 1, alpha: 0.05, labelMode: "fixed", calibrationEnabled: true },
    lockedAtUtc: "2026-10-29T00:00:00Z",
    commitment: "a".repeat(64),
    gates: {
      nullStatus: "passed",
      preparationStatus: "passed",
      preparationClassification: "same-polarity-unique",
      preparationReason: "test fixture",
      preparationDisclosure: null,
      calibrationStatus: "passed",
      reasons: [],
    },
    statistics: { significantVerdict: false },
    limitations: ["fixture limitation"],
  } as unknown as ExperimentSnapshot;
  const experiment: ExperimentExport = {
    schema: "codec-abx-experiment-v1",
    snapshot,
    trials: [],
    reveal: { commitment: "a".repeat(64), secretHex: "b".repeat(64), xSequence: [], redacted: false, verifiable: true },
  };
  const payload = buildListeningExport({
    artifact: native,
    experiment,
    playback: null,
    exportedAt: "2026-10-29T00:00:00Z",
  });
  assert.deepEqual(payload.listening.runtime, {
    preparation: "desktop-native",
    experiment: "electron-main",
    playback: "shared-webaudio",
    outputChannels: "unknown",
  });
  assert.match(String(payload.listening.localCustody), /desktop-native local-self-test/);
  assert.equal(payload.prepared.measurementPolicy, "aligned-gain-matched-v1");
  assert.equal((payload.prepared.preparation as { policy?: string }).policy, "aligned-gain-matched-v1");
  const engine = payload.prepared.engine as { location: string; build: string; preparationPolicy: string };
  assert.equal(engine.location, "desktop-native");
  assert.equal(engine.preparationPolicy, "aligned-gain-matched-v1");
  assert.equal(engine.build, CAPABILITIES.build);
  assert.equal(payload.playback.outputChannels, null);
  assert.equal(payload.playback.actualOutputSampleRate, null);
  assert.equal(payload.limitations.some((note) => note.includes("dedicated Worker")), false);
  assert.equal(
    (payload.playback.deliveredSampleRates as { a: number }).a,
    48_000,
  );
});
