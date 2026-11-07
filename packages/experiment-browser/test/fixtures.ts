import type {
  AnswerReceipt,
  AudioDescription,
  CanaryMaterialReport,
  ExperimentExport,
  ExperimentPlan,
  ExperimentSnapshot,
  PreparedArtifact,
  PublicTrial,
} from "@codec-abx/contracts";
import { AUDIO_MAX_DURATION_SECONDS, AUDIO_MAX_INPUT_BYTES } from "@codec-abx/contracts";

import {
  EXPERIMENT_PROTOCOL,
  EXPERIMENT_PROTOCOL_VERSION,
  type ExperimentRequest,
  type ExperimentResponse,
} from "../src/protocol.js";
import type { ExperimentWorkerLike } from "../src/client.js";

export const HEX = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
} as const;

export function makeWav(options: {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly seconds?: number;
  readonly seed?: number;
} = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 0.6;
  const seed = options.seed ?? 0;
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * channels * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.round(
        8_000 * Math.sin(((seed + 1) * 2 * Math.PI * 440 * frame) / sampleRate + channel),
      );
      view.setInt16(44 + (frame * channels + channel) * 2, value, true);
    }
  }
  return bytes;
}

function description(bytes: Uint8Array, hash: string): AudioDescription {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true) === 2 ? 2 : 1;
  const sampleRate = view.getUint32(24, true);
  const dataSize = view.getUint32(40, true);
  return {
    sampleRate,
    channels,
    frames: dataSize / (channels * 2),
    wavSha256: hash,
  };
}

export function canaryReport(usable = true): CanaryMaterialReport {
  return {
    policy: "delivered-canary-v1",
    cutoffHz: 3000,
    frequencyGrid: "numpy-rfftfreq-v1",
    drive: 10,
    clipLevel: 0.45,
    status: usable ? "usable" : "not-usable",
    usable,
    minimumResidualDb: -30,
    depthDb: usable
      ? { status: "finite", value: -12, reason: null }
      : { status: "finite", value: -40, reason: null },
    reason: usable ? "" : "canary residual below threshold",
    sampleRate: 48_000,
    channels: 1,
    frames: 28_800,
    notes: [],
  };
}

export interface ArtifactFixture {
  readonly artifact: PreparedArtifact;
  readonly a: Uint8Array;
  readonly b: Uint8Array;
  readonly canary: { readonly pristine: Uint8Array; readonly degraded: Uint8Array } | null;
}

export function makeArtifact(options: {
  readonly id?: string;
  readonly canary?: "usable" | "unusable" | "none";
  readonly corruptDescription?: boolean;
} = {}): ArtifactFixture {
  const a = makeWav({ seed: 0 });
  const b = makeWav({ seed: 1 });
  const pristine = makeWav({ seed: 0 });
  const degraded = makeWav({ seed: 2 });
  const request = {
    version: 1 as const,
    preparationPolicy: "aligned-gain-matched-v1" as const,
    sampleRateMode: "native" as const,
    canaryEnabled: options.canary === "usable" || options.canary === "unusable",
    a: { codecId: "opus" as const, bitrateKbps: 128 },
    b: { codecId: "opus" as const, bitrateKbps: 64 },
  };
  const aDescription = description(a, options.corruptDescription ? HEX.d : HEX.a);
  const bDescription = description(b, HEX.b);
  const artifact: PreparedArtifact = {
    id: options.id ?? "artifact-unit",
    request,
    engine: {
      engineId: "unit-engine",
      location: "browser-local",
      build: "unit-build",
      codecs: [],
      channels: [1, 2],
      maxInputBytes: AUDIO_MAX_INPUT_BYTES,
      maxDurationSeconds: AUDIO_MAX_DURATION_SECONDS,
      preparationPolicy: "aligned-gain-matched-v1",
      supportedPreparationPolicies: ["aligned-gain-matched-v1"],
      supportsCanaryMaterial: true,
      limitations: [],
    },
    sourceSha256: HEX.c,
    a: {
      requested: request.a,
      encoder: "unit",
      decoder: "unit",
      actualBitrateKbps: null,
      encodedSampleRate: aDescription.sampleRate,
      delivered: aDescription,
    },
    b: {
      requested: request.b,
      encoder: "unit",
      decoder: "unit",
      actualBitrateKbps: null,
      encodedSampleRate: bDescription.sampleRate,
      delivered: bDescription,
    },
    elapsedMs: 1,
    measurements: {
      policy: "delivered-pcm-measurements-v1",
      alignmentLagSamples: 0,
      alignmentConfidence: 1,
      loudnessDeltaDb: 0,
      nullDepthDb: null,
      notes: [],
    },
    ...(options.canary === "none" || options.canary === undefined
      ? {}
      : {
          canary: {
            report: canaryReport(options.canary === "usable"),
            audio: options.canary === "usable"
              ? {
                  pristine: description(pristine, HEX.a),
                  degraded: description(degraded, HEX.e),
                }
              : null,
          },
        }),
    disclosures: [],
    purpose: "diagnostic-only",
  };
  return {
    artifact,
    a,
    b,
    canary: options.canary === "usable" ? { pristine, degraded } : null,
  };
}

export const DEFAULT_PLAN: ExperimentPlan = {
  version: 1,
  plannedTrials: 5,
  alpha: 0.05,
  labelMode: "blind_random",
  calibrationEnabled: true,
};

export const DEFAULT_TRIAL: PublicTrial = {
  runId: "run-unit",
  token: "token-unit",
  trialIndex: 1,
  kind: "scored",
};

export const DEFAULT_RECEIPT: AnswerReceipt = {
  runId: "run-unit",
  token: "token-unit",
  trialIndex: 1,
  kind: "scored",
  answer: "A",
  correct: true,
  answeredAtUtc: "2026-01-01T00:00:00.000Z",
};

export function makeSnapshot(
  overrides: Partial<ExperimentSnapshot> = {},
): ExperimentSnapshot {
  return {
    version: 1,
    runId: "run-unit",
    authority: "local-self-test",
    lifecycle: "configured",
    plan: DEFAULT_PLAN,
    lockedAtUtc: null,
    commitment: HEX.c,
    prepared: null,
    pendingTrial: null,
    lastAnswer: null,
    gates: {
      nullStatus: "not-measured",
      preparationStatus: "not-measured",
      preparationClassification: null,
      preparationReason: null,
      preparationDisclosure: null,
      calibrationStatus: "not-configured",
      reasons: [],
    },
    statistics: {
      scoredTrials: 0,
      correctTrials: 0,
      plannedTrials: DEFAULT_PLAN.plannedTrials,
      requiredCorrect: 4,
      pValue: 1,
      ability: null,
      abilityCi95: [0, 1],
      significant: false,
      isFinal: false,
      significantVerdict: false,
    },
    sealedReason: null,
    limitations: ["unit fixture"],
    ...overrides,
  };
}

export function makeExport(
  overrides: Partial<ExperimentExport> = {},
  snapshot: ExperimentSnapshot = makeSnapshot(),
): ExperimentExport {
  return {
    schema: "codec-abx-experiment-v1",
    snapshot,
    trials: [],
    reveal: {
      commitment: snapshot.commitment,
      secretHex: null,
      xSequence: [],
      redacted: true,
      verifiable: false,
    },
    ...overrides,
  };
}

export type FakeHandler = (
  request: ExperimentRequest,
  worker: FakeExperimentWorker,
) => void | Promise<void>;

/**
 * Test-only public-boundary fake. It never imports the runtime service; unit
 * tests exercise the client's RPC guards and ownership behavior directly.
 */
export class FakeExperimentWorker implements ExperimentWorkerLike {
  readonly requests: ExperimentRequest[] = [];
  readonly transfers: Transferable[][] = [];
  handler: FakeHandler | null = null;
  terminated = false;

  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.terminated) throw new Error("fake worker is terminated");
    const request = message as ExperimentRequest;
    this.requests.push(request);
    this.transfers.push(transfer ? [...transfer] : []);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (this.handler) {
        void this.handler(request, this);
        return;
      }
      this.defaultRespond(request);
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener as (event: unknown) => void);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const listener of [...(this.#listeners.get("message") ?? [])]) {
      listener({ data });
    }
  }

  emitError(message = "fake worker failed"): void {
    for (const listener of [...(this.#listeners.get("error") ?? [])]) {
      listener({ message, preventDefault: () => undefined });
    }
  }

  respond(request: ExperimentRequest, result: unknown): void {
    this.emitMessage({
      protocol: EXPERIMENT_PROTOCOL,
      version: EXPERIMENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      operation: request.operation,
      ok: true,
      result,
    } satisfies ExperimentResponse);
  }

  respondError(
    request: ExperimentRequest,
    code: string,
    message = "fake error",
    reasons: string[] = [],
  ): void {
    this.emitMessage({
      protocol: EXPERIMENT_PROTOCOL,
      version: EXPERIMENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      operation: request.operation,
      ok: false,
      error: { code, message, reasons },
    });
  }

  private defaultRespond(request: ExperimentRequest): void {
    switch (request.operation) {
      case "configure":
        this.respond(request, makeSnapshot({ plan: request.plan }));
        return;
      case "snapshot":
        this.respond(request, makeSnapshot());
        return;
      case "nextTrial":
        this.respond(request, DEFAULT_TRIAL);
        return;
      case "answer":
        this.respond(request, { ...DEFAULT_RECEIPT, token: request.token, answer: request.answer });
        return;
      case "readAudio": {
        const buffer = makeWav({ seed: request.label === "A" ? 0 : 1 }).buffer as ArrayBuffer;
        this.respond(request, buffer);
        return;
      }
      case "seal":
        this.respond(request, makeSnapshot({ lifecycle: "sealed", sealedReason: "sealed" }));
        return;
      case "reset":
        this.respond(request, makeSnapshot({ runId: "run-reset", lifecycle: "configured" }));
        return;
      case "export":
        this.respond(request, makeExport());
        return;
      case "dispose":
        this.respond(request, null);
        return;
      case "bindPrepared":
        this.respond(request, makeSnapshot({ runId: "run-bound" }));
        return;
    }
  }
}
