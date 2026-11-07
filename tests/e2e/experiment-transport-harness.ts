/**
 * Test-only browser harness for the experiment transport package.
 *
 * Vite bundles this file (and the real experiment module Worker it starts) into
 * temporary assets served by a Playwright route. It is never imported by the
 * application, creates no production route/global and performs no network I/O.
 * Instrumentation observes/drops native Worker message events in this test
 * harness only; production has no test hook.
 */
import type {
  AudioDescription,
  CanaryMaterialReport,
  CanarySide,
  DeliveredPairMeasurements,
  EngineCapabilities,
  ExperimentPlan,
  PairPreparationReport,
  PairValidityReport,
  PreparedArtifact,
  PreparationRequest,
  PublicTrial,
} from "@codec-abx/contracts";
import { assessPairRelation, decodePcm16, type PcmAudio } from "@codec-abx/measurements";
import {
  buildCanaryPair,
  evaluateNullGate,
  evaluatePreparationGate,
  preparePair,
  PREPARATION_PROBE_SAMPLES,
} from "@codec-abx/preparation-policy";
import { verifyReveal } from "@codec-abx/experiment";
import {
  BrowserExperimentClient,
  ExperimentClientError,
  createExperimentWorker,
  type ExperimentWorkerLike,
} from "@codec-abx/experiment-browser";

import { parseCanonicalPcm16Wav } from "../../packages/experiment/src/runtime/wav.js";
import type { ArtifactReaders } from "../../packages/experiment/src/runtime/validation.js";

export interface HarnessResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly checks: Readonly<Record<string, boolean | string | number>>;
}

interface BuiltFixture {
  readonly artifact: PreparedArtifact;
  readonly bytes: {
    a: Uint8Array;
    b: Uint8Array;
    canary: Record<CanarySide, Uint8Array> | null;
  };
}

interface ObservedMessage {
  readonly direction: "request" | "response";
  readonly data: unknown;
}

type Listener = (event: unknown) => void;

/**
 * Test-only wrapper around the real module Worker. It can hold or drop a
 * native message event to simulate a lost reply without changing production.
 */
class InstrumentedWorker implements ExperimentWorkerLike {
  readonly inner: Worker;
  readonly observed: ObservedMessage[] = [];
  holdNextRead = false;
  holdNextAnswer = false;
  dropNextAnswer = false;
  readonly #messageListeners = new Set<Listener>();
  readonly #errorListeners = new Set<Listener>();
  readonly #messageErrorListeners = new Set<Listener>();
  readonly #held: unknown[] = [];
  readonly #innerMessage: Listener;
  readonly #innerError: Listener;
  readonly #innerMessageError: Listener = (event) => {
    for (const listener of [...this.#messageErrorListeners]) listener(event);
  };

  constructor() {
    this.inner = createExperimentWorker() as unknown as Worker;
    this.#innerMessage = (event) => {
      const data = (event as { data?: unknown }).data;
      this.observed.push({ direction: "response", data });
      const response = data as { ok?: unknown; operation?: unknown } | null;
      if (response && response.ok === true && response.operation === "readAudio" && this.holdNextRead) {
        this.holdNextRead = false;
        this.#held.push(event);
        return;
      }
      if (response && response.ok === true && response.operation === "answer" &&
          (this.dropNextAnswer || this.holdNextAnswer)) {
        if (this.dropNextAnswer) {
          this.dropNextAnswer = false;
          return;
        }
        this.holdNextAnswer = false;
        this.#held.push(event);
        return;
      }
      for (const listener of [...this.#messageListeners]) listener(event);
    };
    this.#innerError = (event) => {
      for (const listener of [...this.#errorListeners]) listener(event);
    };
    this.inner.addEventListener("message", this.#innerMessage);
    this.inner.addEventListener("error", this.#innerError);
    this.inner.addEventListener("messageerror", this.#innerMessageError);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.observed.push({ direction: "request", data: message });
    if (transfer) this.inner.postMessage(message, transfer);
    else this.inner.postMessage(message);
  }

  addEventListener(type: string, listener: Listener): void {
    this.#setFor(type)?.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#setFor(type)?.delete(listener);
  }

  terminate(): void {
    this.inner.terminate();
  }

  releaseHeld(): void {
    for (const event of this.#held.splice(0)) {
      for (const listener of [...this.#messageListeners]) listener(event);
    }
  }

  #setFor(type: string): Set<Listener> | null {
    switch (type) {
      case "message": return this.#messageListeners;
      case "error": return this.#errorListeners;
      case "messageerror": return this.#messageErrorListeners;
      default: return null;
    }
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hash(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

function pcmSine(frequency: number, harmonic = false): PcmAudio {
  const sampleRate = 48_000;
  const frames = Math.round(0.6 * sampleRate);
  const samples = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
    const value = 0.25 * Math.sin(phase) +
      (harmonic ? 0.02 * Math.sin(2 * phase + 0.3) : 0);
    samples[frame] = Math.round(value * 32767) / 32768;
  }
  return { sampleRate, channels: [samples] };
}

function decode(bytes: Uint8Array): PcmAudio {
  const facts = parseCanonicalPcm16Wav(bytes);
  return decodePcm16(bytes, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
}

async function description(bytes: Uint8Array): Promise<AudioDescription> {
  const facts = parseCanonicalPcm16Wav(bytes);
  return {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    frames: facts.frames,
    wavSha256: await hash(bytes),
  };
}

function sameUint8(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameBuffer(left: ArrayBuffer, right: ArrayBuffer | Uint8Array): boolean {
  return sameUint8(
    new Uint8Array(left),
    right instanceof Uint8Array ? right : new Uint8Array(right),
  );
}

async function buildFixture(options: {
  readonly identicalRequest: boolean;
  readonly bFrequency: number;
  readonly bHarmonic?: boolean;
  readonly canary: boolean;
}): Promise<BuiltFixture> {
  const request: PreparationRequest = {
    version: 1,
    preparationPolicy: "aligned-gain-matched-v1",
    canaryEnabled: options.canary,
    sampleRateMode: "native",
    a: { codecId: "opus", bitrateKbps: 128 },
    b: options.identicalRequest
      ? { codecId: "opus", bitrateKbps: 128 }
      : { codecId: "opus", bitrateKbps: 64 },
  };
  const prepared = preparePair(
    pcmSine(440),
    pcmSine(options.bFrequency, options.bHarmonic ?? false),
  );
  const relation = assessPairRelation(decode(prepared.aWav), decode(prepared.bWav), {
    maxLagSamples: Math.floor(0.1 * prepared.delivered.a.sampleRate),
    probeSamples: PREPARATION_PROBE_SAMPLES,
  });
  const validity: PairValidityReport = {
    policy: "delivered-validity-v2",
    nullGate: evaluateNullGate(request, prepared.delivered.nullDepth.depthDb),
    preparationGate: evaluatePreparationGate(relation),
    notes: [],
  };
  let canary: PreparedArtifact["canary"];
  let canaryBytes: Record<CanarySide, Uint8Array> | null = null;
  if (options.canary) {
    const built = buildCanaryPair(decode(prepared.aWav));
    canaryBytes = { pristine: built.pristineWav, degraded: built.degradedWav };
    canary = {
      report: built.report,
      audio: {
        pristine: await description(built.pristineWav),
        degraded: await description(built.degradedWav),
      },
    };
  }
  const engine: EngineCapabilities = {
    engineId: "browser-transport-harness",
    location: "browser-local",
    build: "harness-build-1",
    codecs: [],
    channels: [1, 2],
    maxInputBytes: 16 * 1024 * 1024,
    maxDurationSeconds: 10,
    preparationPolicy: "aligned-gain-matched-v1",
    supportedPreparationPolicies: ["aligned-gain-matched-v1"],
    limitations: ["test-only harness fixture"],
  };
  const source = new Uint8Array([
    ...prepared.aWav.slice(0, 64),
    ...prepared.bWav.slice(0, 64),
  ]);
  const artifact: PreparedArtifact = {
    id: `browser-transport-pair-${String(Math.random()).slice(2)}`,
    request,
    engine,
    sourceSha256: await hash(source),
    a: {
      requested: request.a,
      encoder: "fixture",
      decoder: "fixture",
      actualBitrateKbps: null,
      encodedSampleRate: prepared.delivered.a.sampleRate,
      delivered: await description(prepared.aWav),
    },
    b: {
      requested: request.b,
      encoder: "fixture",
      decoder: "fixture",
      actualBitrateKbps: null,
      encodedSampleRate: prepared.delivered.b.sampleRate,
      delivered: await description(prepared.bWav),
    },
    elapsedMs: 1,
    measurements: {
      policy: "delivered-pcm-measurements-v1",
      alignmentLagSamples: prepared.delivered.alignment.lagSamples,
      alignmentConfidence: prepared.delivered.alignment.confidence,
      loudnessDeltaDb: prepared.delivered.loudnessDeltaDb.status === "finite"
        ? prepared.delivered.loudnessDeltaDb.value
        : null,
      nullDepthDb: prepared.delivered.nullDepth.depthDb.status === "finite"
        ? prepared.delivered.nullDepth.depthDb.value
        : null,
      notes: [],
      delivered: prepared.delivered,
    },
    preparation: prepared.report as PairPreparationReport,
    validity,
    ...(canary === undefined ? {} : { canary }),
    disclosures: [],
    purpose: "diagnostic-only",
  };
  return {
    artifact,
    bytes: { a: prepared.aWav, b: prepared.bWav, canary: canaryBytes },
  };
}

function readersFor(built: BuiltFixture): ArtifactReaders {
  return {
    readAudio: async (_id, side) =>
      (side === "a" ? built.bytes.a : built.bytes.b).slice().buffer as ArrayBuffer,
    readCanaryAudio: async (_id, side) => {
      if (!built.bytes.canary) throw new Error("fixture has no canary bytes");
      return built.bytes.canary[side].slice().buffer as ArrayBuffer;
    },
  };
}

function readersFrom(
  a: Uint8Array,
  b: Uint8Array,
  canary: Record<CanarySide, Uint8Array> | null,
): ArtifactReaders {
  return {
    readAudio: async (_id, side) => (side === "a" ? a : b).slice().buffer as ArrayBuffer,
    readCanaryAudio: async (_id, side) => {
      if (!canary) throw new Error("fixture has no canary bytes");
      return canary[side].slice().buffer as ArrayBuffer;
    },
  };
}

function keys(value: unknown, output = new Set<string>()): Set<string> {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return output;
  if (Array.isArray(value)) {
    for (const item of value) keys(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.add(key);
      keys(item, output);
    }
  }
  return output;
}

function errorCode(error: unknown): string | null {
  return error instanceof ExperimentClientError ? error.code : null;
}

const PLAN: ExperimentPlan = {
  version: 1,
  plannedTrials: 5,
  alpha: 0.05,
  labelMode: "blind_random",
  calibrationEnabled: true,
};

export async function runHarness(): Promise<HarnessResult> {
  const failures: string[] = [];
  const checks: Record<string, boolean | string | number> = {};
  const check = (name: string, condition: boolean, detail = ""): void => {
    checks[name] = condition;
    if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  };
  const expectCode = async (
    name: string,
    operation: Promise<unknown>,
    code: string,
  ): Promise<unknown> => {
    try {
      const value = await operation;
      check(name, false, `resolved instead of ${code}`);
      return value;
    } catch (error) {
      check(name, errorCode(error) === code, `${String(errorCode(error))} != ${code}`);
      return error;
    }
  };
  const newClient = (options: {
    readonly worker?: InstrumentedWorker;
    readonly timeoutMs?: number;
  } = {}): { client: BrowserExperimentClient; worker: InstrumentedWorker } => {
    const worker = options.worker ?? new InstrumentedWorker();
    const client = new BrowserExperimentClient({
      workerFactory: () => worker,
      requestTimeoutMs: options.timeoutMs ?? 5_000,
      disposeTimeoutMs: 500,
    });
    return { client, worker };
  };

  const main = await buildFixture({
    identicalRequest: false, bFrequency: 440, bHarmonic: true, canary: true,
  });
  const mainRun = newClient();
  const client = mainRun.client;
  const instrumented = mainRun.worker;

  const configured = await client.configure(PLAN);
  check("configure-before-bind", configured.prepared === null && configured.lifecycle === "configured");
  const bound = await client.bindPrepared(main.artifact, readersFor(main));
  check("bind-prepared-identity", bound.prepared?.artifactId === main.artifact.id);
  check("bind-calibration-pending", bound.gates.calibrationStatus === "pending");
  check("bind-retains-engine-bytes",
    main.bytes.a.byteLength > 0 && main.bytes.b.byteLength > 0);
  const observedBeforeTerminal = instrumented.observed.length;

  const [calibration, calibrationAgain] = await Promise.all([
    client.nextTrial(),
    client.nextTrial(),
  ]);
  check("concurrent-next-same-token",
    calibration.token === calibrationAgain.token &&
      calibration.trialIndex === 1 &&
      calibration.kind === "calibration");
  const [canaryA, canaryB, canaryX] = await Promise.all([
    client.readAudio(calibration.token, "A"),
    client.readAudio(calibration.token, "B"),
    client.readAudio(calibration.token, "X"),
  ]);
  check("readaudio-arraybuffers",
    canaryA instanceof ArrayBuffer && canaryB instanceof ArrayBuffer && canaryX instanceof ArrayBuffer);
  const canaryABytes = main.bytes.canary!.pristine;
  const canaryBBytes = main.bytes.canary!.degraded;
  const aIsPristine = sameBuffer(canaryA, canaryABytes);
  const bIsPristine = sameBuffer(canaryB, canaryABytes);
  check("calibration-binary-sources",
    aIsPristine !== bIsPristine &&
      (aIsPristine ? sameBuffer(canaryB, canaryBBytes) : sameBuffer(canaryA, canaryBBytes)) &&
      (sameBuffer(canaryX, canaryABytes) || sameBuffer(canaryX, canaryBBytes)));
  const calibrationAnswer = sameBuffer(canaryX, canaryA) ? "A" : "B";
  const calibrationReceipt = await client.answer(calibration.token, calibrationAnswer);
  check("calibration-pass", calibrationReceipt.correct);

  let copiesDistinct = true;
  for (let index = 2; index <= 6; index += 1) {
    const trial = await client.nextTrial();
    check(`scored-index-${index}`, trial.trialIndex === index && trial.kind === "scored");
    const [a, b, x] = await Promise.all([
      client.readAudio(trial.token, "A"),
      client.readAudio(trial.token, "B"),
      client.readAudio(trial.token, "X"),
    ]);
    const aSecond = await client.readAudio(trial.token, "A");
    copiesDistinct = copiesDistinct && a !== aSecond && sameBuffer(a, aSecond);
    const aIsMainA = sameBuffer(a, main.bytes.a);
    const aIsMainB = sameBuffer(a, main.bytes.b);
    const bIsMainA = sameBuffer(b, main.bytes.a);
    const bIsMainB = sameBuffer(b, main.bytes.b);
    check(
      `scored-display-sides-${index}`,
      aIsMainA !== aIsMainB && bIsMainA !== bIsMainB && aIsMainA !== bIsMainA,
    );
    const xMatchesA = sameBuffer(x, a);
    const xMatchesB = sameBuffer(x, b);
    check(`scored-x-binary-${index}`, xMatchesA !== xMatchesB);
    const receipt = await client.answer(trial.token, xMatchesA ? "A" : "B");
    check(
      `scored-correct-${index}`,
      receipt.correct,
      `x=${xMatchesA ? "A" : "B"} answered=${receipt.answer} aLen=${a.byteLength} bLen=${b.byteLength} xLen=${x.byteLength}`,
    );
    const snapshot = await client.snapshot();
    check(`snapshot-last-answer-${index}`, snapshot.lastAnswer?.token === trial.token);
  }
  check("readaudio-exact-copies", copiesDistinct);
  check("engine-bytes-not-detached",
    main.bytes.a.byteLength > 0 && main.bytes.b.byteLength > 0);

  const completed = await client.snapshot();
  check("completed-at-n",
    completed.lifecycle === "completed" && completed.statistics.scoredTrials === 5);
  check("completed-verdict", completed.statistics.significantVerdict);
  const terminal = await client.export();
  check("terminal-reveal",
    terminal.reveal.secretHex !== null && !terminal.reveal.redacted &&
      terminal.reveal.xSequence.length === terminal.trials.length);
  check("terminal-commitment-verifies",
    terminal.reveal.secretHex !== null &&
      await verifyReveal(
        terminal.reveal.secretHex,
        terminal.reveal.commitment,
        terminal.reveal.xSequence,
      ));

  const forbidden = new Set(["xSource", "answerSource", "displayMapping", "secretHex", "secret", "mapping", "stack"]);
  const earlyKeys = keys(instrumented.observed.slice(0, observedBeforeTerminal).map((item) => item.data));
  check("no-early-private-keys", [...forbidden].every((key) => !earlyKeys.has(key)));
  const bindMessage = instrumented.observed.find(
    (item) => item.direction === "request" &&
      (item.data as { operation?: unknown } | null)?.operation === "bindPrepared",
  );
  const bindData = bindMessage?.data as {
    a?: unknown;
    b?: unknown;
    canary?: { pristine?: unknown } | null;
  } | null;
  check("binding-binary-not-json",
    bindData?.a instanceof ArrayBuffer &&
      bindData?.b instanceof ArrayBuffer &&
      bindData?.canary?.pristine instanceof ArrayBuffer);

  const reset = await client.reset();
  check("reset-new-run", reset.runId !== completed.runId && reset.lifecycle === "configured");
  check("reset-retains-pair",
    reset.prepared?.artifactId === main.artifact.id &&
      reset.gates.calibrationStatus === "pending");
  check("reset-clears-answer", reset.lastAnswer === null && reset.pendingTrial === null);
  const redacted = await client.export();
  check("reset-export-redacted",
    redacted.reveal.redacted && redacted.reveal.secretHex === null);
  const sealedTrial = await client.nextTrial();
  await client.seal("transport harness seal");
  check("seal-terminal", (await client.snapshot()).lifecycle === "sealed");
  const sealedExport = await client.export();
  check("seal-reveals",
    sealedExport.reveal.secretHex !== null && sealedExport.reveal.verifiable);
  await expectCode("sealed-answer-refused", client.answer(sealedTrial.token, "A"), "run-closed");
  await client.dispose();
  await expectCode("dispose-refuses", client.snapshot(), "disposed");

  // Two independent clients own independent workers/runs.
  const first = newClient();
  const second = newClient();
  await first.client.configure({ ...PLAN, calibrationEnabled: false, plannedTrials: 2 });
  await second.client.configure({ ...PLAN, calibrationEnabled: false, plannedTrials: 2 });
  await first.client.bindPrepared(main.artifact, readersFor(main));
  await second.client.bindPrepared(main.artifact, readersFor(main));
  const firstTrial = await first.client.nextTrial();
  const secondTrial = await second.client.nextTrial();
  check("independent-runs",
    firstTrial.runId !== secondTrial.runId && firstTrial.token !== secondTrial.token);
  await first.client.dispose();
  await second.client.dispose();

  // Answer accepted, reply held, then a snapshot reconciles and a same-token
  // retry returns the original receipt. The real Worker keeps accepting.
  const uncertainRun = newClient({ timeoutMs: 200 });
  await uncertainRun.client.configure({ ...PLAN, calibrationEnabled: false, plannedTrials: 3 });
  await uncertainRun.client.bindPrepared(main.artifact, readersFor(main));
  const uncertainTrial = await uncertainRun.client.nextTrial();
  uncertainRun.worker.holdNextAnswer = true;
  const uncertain = await expectCode(
    "answer-timeout-uncertain",
    uncertainRun.client.answer(uncertainTrial.token, "A"),
    "request-timeout",
  );
  check("answer-timeout-uncertain-flag",
    uncertain instanceof ExperimentClientError && uncertain.uncertain);
  const reconciled = await uncertainRun.client.snapshot();
  check("answer-reconciled-last-answer",
    reconciled.lastAnswer?.token === uncertainTrial.token && reconciled.pendingTrial === null);
  uncertainRun.worker.releaseHeld(); // stale reply after timeout is benign
  const retried = await uncertainRun.client.answer(uncertainTrial.token, "A");
  check("answer-retry-same-receipt",
    retried.token === uncertainTrial.token && retried.answeredAtUtc === reconciled.lastAnswer?.answeredAtUtc);
  const nextAfterUncertain = await uncertainRun.client.nextTrial();
  check("answer-retry-no-redraw", nextAfterUncertain.token !== uncertainTrial.token);
  await uncertainRun.client.dispose();

  // Dropped rather than held: the same token/answer retry must still work.
  const droppedRun = newClient({ timeoutMs: 200 });
  await droppedRun.client.configure({ ...PLAN, calibrationEnabled: false, plannedTrials: 3 });
  await droppedRun.client.bindPrepared(main.artifact, readersFor(main));
  const droppedTrial = await droppedRun.client.nextTrial();
  droppedRun.worker.dropNextAnswer = true;
  await expectCode(
    "answer-dropped-timeout",
    droppedRun.client.answer(droppedTrial.token, "B"),
    "request-timeout",
  );
  const droppedRetry = await droppedRun.client.answer(droppedTrial.token, "B");
  check("answer-dropped-retry", droppedRetry.token === droppedTrial.token);
  await droppedRun.client.dispose();

  // Corrupt binding bytes and mismatched metadata fail closed, preserving the
  // previously committed pair.
  const replaceRun = newClient();
  await replaceRun.client.configure(PLAN);
  const oldBinding = await replaceRun.client.bindPrepared(main.artifact, readersFor(main));
  const corruptBytes = main.bytes.a.slice();
  corruptBytes[100] = (corruptBytes[100] ?? 0) ^ 0xff;
  await expectCode(
    "corrupt-binding-rejected",
    replaceRun.client.bindPrepared(
      main.artifact,
      readersFrom(corruptBytes, main.bytes.b, main.bytes.canary),
    ),
    "artifact-bytes-mismatch",
  );
  check("failed-replacement-preserves-binding",
    (await replaceRun.client.snapshot()).prepared?.artifactId === oldBinding.prepared?.artifactId);
  const wrongLayout: PreparedArtifact = {
    ...main.artifact,
    a: {
      ...main.artifact.a,
      delivered: {
        ...main.artifact.a.delivered,
        frames: main.artifact.a.delivered.frames + 1,
      },
    },
  };
  await expectCode(
    "read-layout-rejected",
    replaceRun.client.bindPrepared(
      wrongLayout,
      readersFrom(main.bytes.a, main.bytes.b, main.bytes.canary),
    ),
    "artifact-invalid",
  );
  await replaceRun.client.dispose();

  // Missing canary keeps calibration requested but unavailable and blocks
  // staging rather than silently disabling the gate.
  const noCanary = await buildFixture({
    identicalRequest: false, bFrequency: 440, bHarmonic: true, canary: false,
  });
  const missingRun = newClient();
  await missingRun.client.configure(PLAN);
  const missingBound = await missingRun.client.bindPrepared(noCanary.artifact, readersFor(noCanary));
  check("missing-canary-unavailable", missingBound.gates.calibrationStatus === "unavailable");
  await expectCode(
    "missing-canary-blocks",
    missingRun.client.nextTrial(),
    "calibration-unavailable",
  );
  await missingRun.client.dispose();

  // Client generation guards: a held read cannot publish after reset.
  const raceRun = newClient();
  await raceRun.client.configure(PLAN);
  await raceRun.client.bindPrepared(main.artifact, readersFor(main));
  const raceTrial = await raceRun.client.nextTrial();
  raceRun.worker.holdNextRead = true;
  const heldReadCheck = expectCode(
    "reset-invalidates-held-read",
    raceRun.client.readAudio(raceTrial.token, "A"),
    "stale-response",
  );
  const raceReset = await raceRun.client.reset();
  await heldReadCheck;
  raceRun.worker.releaseHeld();
  check("reset-race-current-run", (await raceRun.client.snapshot()).runId === raceReset.runId);
  await raceRun.client.dispose();

  // Bind reads racing reset are discarded and never posted.
  const bindRace = newClient();
  await bindRace.client.configure(PLAN);
  let releaseReads!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReads = resolve; });
  const delayedBinding = bindRace.client.bindPrepared(main.artifact, {
    readAudio: async (_id, side) => {
      await gate;
      return (side === "a" ? main.bytes.a : main.bytes.b).slice().buffer as ArrayBuffer;
    },
    readCanaryAudio: async (_id, side) =>
      (side === "pristine" ? noCanary.bytes.a : noCanary.bytes.b).slice().buffer as ArrayBuffer,
  });
  const delayedBindingCheck = expectCode(
    "reset-invalidates-bind",
    delayedBinding,
    "stale-response",
  );
  await bindRace.client.reset();
  releaseReads();
  await delayedBindingCheck;
  check("bind-race-never-posted",
    !bindRace.worker.observed.some((item) =>
      item.direction === "request" &&
      (item.data as { operation?: unknown } | null)?.operation === "bindPrepared"));
  await bindRace.client.dispose();

  // Dispose rejects an in-flight read and terminates the owned Worker.
  const disposeRun = newClient();
  await disposeRun.client.configure({ ...PLAN, calibrationEnabled: false, plannedTrials: 2 });
  await disposeRun.client.bindPrepared(main.artifact, readersFor(main));
  const disposeTrial = await disposeRun.client.nextTrial();
  disposeRun.worker.holdNextRead = true;
  const disposeReadCheck = expectCode(
    "dispose-invalidates-read",
    disposeRun.client.readAudio(disposeTrial.token, "B"),
    "disposed",
  );
  await disposeRun.client.dispose();
  await disposeReadCheck;
  await disposeRun.client.dispose();

  // Actual Worker load failure is fatal, never an inline/fallback renderer.
  const loadFailure = new BrowserExperimentClient({
    workerFactory: () => new Worker(
      new URL("/missing-experiment-worker.js", globalThis.location.origin),
      { type: "module" },
    ) as unknown as ExperimentWorkerLike,
    requestTimeoutMs: 3_000,
    disposeTimeoutMs: 500,
  });
  await expectCode("worker-load-failure", loadFailure.snapshot(), "worker-fatal");
  await loadFailure.dispose();
  const constructionFailure = (() => {
    try {
      return new BrowserExperimentClient({
        workerFactory: () => { throw new Error("constructor failure"); },
      });
    } catch (error) {
      return error;
    }
  })();
  check("worker-construction-failure",
    constructionFailure instanceof ExperimentClientError &&
      constructionFailure.code === "worker-start-failed");
  const crossOriginFailure = (() => {
    try {
      return new BrowserExperimentClient({
        workerFactory: () => new Worker(
          "https://example.invalid/experiment-worker.js",
          { type: "module" },
        ) as unknown as ExperimentWorkerLike,
      });
    } catch (error) {
      return error;
    }
  })();
  check("worker-cross-origin-construction-failure",
    crossOriginFailure instanceof ExperimentClientError &&
      crossOriginFailure.code === "worker-start-failed");

  return { ok: failures.length === 0, failures, checks };
}
