/**
 * Test-only browser harness exported for Playwright/Vite bundling.
 *
 * It is not imported by the application, exposes no production route or global
 * and does no network I/O. It exercises the real runtime service with actual
 * Chromium WebCrypto, real shared-policy fixtures and token-mapped binary reads.
 */
import type {
  AudioDescription,
  CanaryMaterialReport,
  CanarySide,
  DeliveredPairMeasurements,
  EngineCapabilities,
  PairPreparationReport,
  PairValidityReport,
  PreparedArtifact,
  PreparationRequest,
} from "@codec-abx/contracts";
import { assessPairRelation, decodePcm16, type PcmAudio } from "@codec-abx/measurements";
import {
  buildCanaryPair,
  evaluateNullGate,
  evaluatePreparationGate,
  preparePair,
  PREPARATION_PROBE_SAMPLES,
} from "@codec-abx/preparation-policy";
import { ExperimentService, ExperimentServiceError, verifyReveal } from "@codec-abx/experiment";

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

function sameBytes(left: ArrayBuffer, right: Uint8Array): boolean {
  return sameUint8(new Uint8Array(left), right);
}

function sameUint8(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function buildFixture(options: {
  readonly identicalRequest: boolean;
  readonly bFrequency: number;
  readonly bHarmonic?: boolean;
  readonly canary: boolean;
}): Promise<BuiltFixture> {
  const sampleRateMode = "native" as const;
  const request: PreparationRequest = {
    version: 1,
    preparationPolicy: "aligned-gain-matched-v1",
    canaryEnabled: options.canary,
    sampleRateMode,
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
    engineId: "browser-harness-shared-policy",
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
    id: "browser-harness-pair",
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
    preparation: prepared.report,
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

function keys(value: unknown, output = new Set<string>()): Set<string> {
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

function serviceErrorCode(error: unknown): string | null {
  return error instanceof ExperimentServiceError ? error.code : null;
}

export async function runHarness(): Promise<HarnessResult> {
  const failures: string[] = [];
  const checks: Record<string, boolean | string | number> = {};
  const check = (name: string, condition: boolean, detail = ""): void => {
    checks[name] = condition;
    if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  };
  const expectCode = async (name: string, operation: Promise<unknown>, code: string): Promise<void> => {
    try {
      await operation;
      check(name, false, `resolved instead of ${code}`);
    } catch (error) {
      check(name, serviceErrorCode(error) === code, `${String(serviceErrorCode(error))} != ${code}`);
    }
  };

  // Main flow: real canary material, calibration answer by comparing served
  // bytes, then perfect scored answers over three planned trials.
  const main = await buildFixture({
    identicalRequest: false, bFrequency: 440, bHarmonic: true, canary: true,
  });
  const service = new ExperimentService();
  const configured = await service.configure({
    version: 1,
    plannedTrials: 5,
    alpha: 0.05,
    labelMode: "blind_random",
    calibrationEnabled: true,
  });
  check("prepared-null-before-binding", configured.prepared === null);
  await service.bindPrepared(main.artifact, readersFor(main));
  const bound = await service.snapshot();
  check("binding-null-not-applicable", bound.gates.nullStatus === "not-applicable");
  check("binding-preparation-gate", bound.gates.preparationStatus === "passed");
  check("binding-preparation-classification",
    bound.gates.preparationClassification !== null);
  check("binding-calibration-pending", bound.gates.calibrationStatus === "pending");
  check("authority-local", bound.authority === "local-self-test");
  check("prepared-identity", bound.prepared?.artifactId === main.artifact.id);
  const forbidden = ["xSource", "answerSource", "displayMapping", "secretHex", "secret", "mapping"];
  const publicKeys = keys(bound);
  check("public-dto-no-private-keys", forbidden.every((key) => !publicKeys.has(key)));

  const calibration = await service.nextTrial();
  check("calibration-is-trial-1", calibration.trialIndex === 1 && calibration.kind === "calibration");
  const canaryA = await service.readAudio(calibration.token, "A");
  const canaryB = await service.readAudio(calibration.token, "B");
  const canaryX = await service.readAudio(calibration.token, "X");
  const aIsPristine = sameBytes(canaryA, main.bytes.canary!.pristine);
  const bIsPristine = sameBytes(canaryB, main.bytes.canary!.pristine);
  check(
    "calibration-binary-sources",
    aIsPristine !== bIsPristine &&
      (aIsPristine
        ? sameBytes(canaryB, main.bytes.canary!.degraded)
        : sameBytes(canaryA, main.bytes.canary!.degraded)) &&
      (sameBytes(canaryX, main.bytes.canary!.pristine) ||
        sameBytes(canaryX, main.bytes.canary!.degraded)),
  );
  // Byte comparison is the harness "listener": X matches one display side.
  const calibrationAnswer = sameUint8(new Uint8Array(canaryX), new Uint8Array(canaryA)) ? "A" : "B";
  const calibrationReceipt = await service.answer(calibration.token, calibrationAnswer);
  check("calibration-listener-pass", calibrationReceipt.correct);
  check(
    "calibration-excluded",
    (await service.snapshot()).statistics.scoredTrials === 0,
  );

  for (let index = 2; index <= 6; index += 1) {
    const trial = await service.nextTrial();
    check(`scored-index-${index}`, trial.trialIndex === index && trial.kind === "scored");
    const a = await service.readAudio(trial.token, "A");
    const b = await service.readAudio(trial.token, "B");
    const x = await service.readAudio(trial.token, "X");
    const xMatchesA = sameUint8(new Uint8Array(x), new Uint8Array(a));
    const xMatchesB = sameUint8(new Uint8Array(x), new Uint8Array(b));
    check(`scored-x-binary-${index}`, xMatchesA !== xMatchesB);
    const receipt = await service.answer(trial.token, xMatchesA ? "A" : "B");
    check(`scored-correct-${index}`, receipt.correct);
    await expectCode(`stale-audio-${index}`, service.readAudio(trial.token, "A"), "stale-token");
  }

  const completed = await service.snapshot();
  check("completed-plan-n", completed.lifecycle === "completed" && completed.statistics.scoredTrials === 5);
  check("completed-verdict", completed.statistics.isFinal && completed.statistics.significantVerdict);
  const exported = await service.export();
  check("reveal-secret-terminal", exported.reveal.secretHex !== null && !exported.reveal.redacted);
  check(
    "reveal-commitment-verifies",
    exported.reveal.secretHex !== null &&
      await verifyReveal(
        exported.reveal.secretHex,
        exported.reveal.commitment,
        exported.reveal.xSequence,
      ),
  );
  check("audit-includes-calibration", exported.trials.length === 6);
  const oldRunId = completed.runId;
  const oldCommitment = completed.commitment;
  const reset = await service.reset();
  check(
    "reset-new-run",
    reset.runId !== oldRunId && reset.commitment !== oldCommitment && reset.lifecycle === "configured",
  );
  check(
    "reset-retains-pair",
    reset.prepared?.artifactId === main.artifact.id && reset.gates.calibrationStatus === "pending",
  );
  check("reset-clears-answer", reset.lastAnswer === null && reset.pendingTrial === null);
  const afterReset = await service.export();
  check(
    "reset-redacted",
    afterReset.reveal.redacted && afterReset.reveal.secretHex === null && !afterReset.reveal.verifiable,
  );

  const sealedTrial = await service.nextTrial();
  await service.seal("browser harness seal");
  check("seal-terminal", (await service.snapshot()).lifecycle === "sealed");
  const sealedExport = await service.export();
  check(
    "seal-reveals-secret",
    sealedExport.reveal.secretHex !== null && sealedExport.reveal.verifiable,
  );
  await expectCode("sealed-answers-refused", service.answer(sealedTrial.token, "A"), "run-closed");
  await service.dispose();
  await expectCode("dispose-refuses", service.snapshot(), "disposed");

  // Null gate: identical pipeline passes; a mismatched pair with an identical
  // request fails and blocks staging without revealing while configured.
  const passing = await buildFixture({ identicalRequest: true, bFrequency: 440, canary: false });
  const passingService = new ExperimentService();
  await passingService.configure({
    version: 1,
    plannedTrials: 2,
    alpha: 0.05,
    labelMode: "fixed",
    calibrationEnabled: false,
  });
  await passingService.bindPrepared(passing.artifact, readersFor(passing));
  const passingSnapshot = await passingService.snapshot();
  check("null-passed-gate", passingSnapshot.gates.nullStatus === "passed");
  const passingTrial = await passingService.nextTrial();
  check("null-passed-stages", passingTrial.trialIndex === 1);
  await passingService.dispose();

  const failing = await buildFixture({ identicalRequest: true, bFrequency: 660, canary: false });
  const failingService = new ExperimentService();
  await failingService.configure({
    version: 1,
    plannedTrials: 2,
    alpha: 0.05,
    labelMode: "fixed",
    calibrationEnabled: false,
  });
  await failingService.bindPrepared(failing.artifact, readersFor(failing));
  check("null-failed-gate", (await failingService.snapshot()).gates.nullStatus === "failed");
  await expectCode("null-failed-blocks", failingService.nextTrial(), "null-gate-failed");
  const failingExport = await failingService.export();
  check(
    "null-failed-redacted-configured",
    failingExport.reveal.redacted && failingExport.reveal.secretHex === null,
  );
  await failingService.dispose();

  // Corrupted reader bytes after binding cannot be served.
  const corrupt = await buildFixture({
    identicalRequest: false, bFrequency: 440, bHarmonic: true, canary: false,
  });
  const corruptService = new ExperimentService();
  await corruptService.configure({
    version: 1,
    plannedTrials: 2,
    alpha: 0.05,
    labelMode: "fixed",
    calibrationEnabled: false,
  });
  await corruptService.bindPrepared(corrupt.artifact, readersFor(corrupt));
  const corruptTrial = await corruptService.nextTrial();
  const last = corrupt.bytes.a.length - 1;
  corrupt.bytes.a[last] = (corrupt.bytes.a[last] ?? 0) ^ 0xff;
  await expectCode("corrupt-served-bytes", corruptService.readAudio(corruptTrial.token, "A"),
    "artifact-bytes-mismatch");
  await corruptService.dispose();

  return { ok: failures.length === 0, failures, checks };
}
