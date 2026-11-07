import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  finalSelectionForSide,
  stagesForSide,
} from "@codec-abx/contracts";
import { createHash } from "node:crypto";

import type {
  AudioDescription,
  CanaryMaterialReport,
  CanarySide,
  DeliveredPairMeasurements,
  PairPreparationReport,
  PairValidityReport,
  PreparedArtifact,
  PreparationRequest,
  Side,
} from "@codec-abx/contracts";
import { assessPairRelation, decodePcm16, type PcmAudio } from "@codec-abx/measurements";
import {
  buildCanaryExcerptPair,
  evaluateNullGate,
  evaluatePreparationGate,
  preparePair,
  PREPARATION_PROBE_SAMPLES,
} from "@codec-abx/preparation-policy";

import { parseCanonicalPcm16Wav } from "../src/runtime/wav.js";
import type { ArtifactReaders } from "../src/runtime/validation.js";

export const SAMPLE_RATE = 48_000;
export const FIXTURE_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index);
export const FIXTURE_SWAPS = [true, false, false, true, true, false, true, false] as const;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sine(
  frequency: number,
  options: {
    readonly seconds?: number;
    readonly sampleRate?: number;
    readonly channels?: 1 | 2;
    readonly amplitude?: number;
  } = {},
): PcmAudio {
  const seconds = options.seconds ?? 0.6;
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const channels = options.channels ?? 1;
  const amplitude = options.amplitude ?? 0.25;
  const frames = Math.round(seconds * sampleRate);
  const planar: Float64Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const samples = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const phase = (2 * Math.PI * frequency * frame) / sampleRate +
        (channel === 1 ? Math.PI / 3 : 0);
      samples[frame] = Math.round(amplitude * Math.sin(phase) * 32767) / 32768;
    }
    planar.push(samples);
  }
  return { sampleRate, channels: planar };
}

function description(bytes: Uint8Array): AudioDescription {
  const facts = parseCanonicalPcm16Wav(bytes);
  return {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    frames: facts.frames,
    wavSha256: sha256(bytes),
  };
}

function decoded(bytes: Uint8Array): PcmAudio {
  const facts = parseCanonicalPcm16Wav(bytes);
  return decodePcm16(bytes, {
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    dataOffset: facts.dataOffset,
    dataSize: facts.dataSize,
  });
}

export interface BuiltArtifact {
  readonly artifact: PreparedArtifact;
  readonly bytes: {
    readonly a: Uint8Array;
    readonly b: Uint8Array;
    readonly canary: Readonly<Record<CanarySide, Uint8Array>> | null;
  };
  readonly preparation: PairPreparationReport;
  readonly delivered: DeliveredPairMeasurements;
  readonly validity: PairValidityReport;
  readonly canaryReport: CanaryMaterialReport | null;
}

/** Build genuine delivered-validity-v2 from the exact serialized fixture bytes. */
export function makeValidity(
  request: PreparationRequest,
  delivered: DeliveredPairMeasurements,
  aWav: Uint8Array,
  bWav: Uint8Array,
): PairValidityReport {
  const a = decoded(aWav);
  const b = decoded(bWav);
  const relation = assessPairRelation(a, b, {
    maxLagSamples: Math.floor(0.1 * a.sampleRate),
    probeSamples: PREPARATION_PROBE_SAMPLES,
  });
  return {
    policy: "delivered-validity-v2",
    nullGate: evaluateNullGate(request, delivered.nullDepth.depthDb),
    preparationGate: evaluatePreparationGate(relation),
    notes: [],
  };
}

export interface BuildArtifactOptions {
  readonly a?: PcmAudio;
  readonly b?: PcmAudio;
  readonly request?: PreparationRequest;
  readonly canary?: boolean;
  readonly id?: string;
}

export function makeRequest(options: {
  readonly canaryEnabled?: boolean;
  readonly aCodec?: "noop_passthrough" | "opus";
  readonly aBitrate?: number;
  readonly bCodec?: "noop_passthrough" | "opus";
  readonly bBitrate?: number;
} = {}): PreparationRequest {
  return {
    version: 1,
    preparationPolicy: "aligned-gain-matched-v1",
    ...(options.canaryEnabled === undefined ? {} : { canaryEnabled: options.canaryEnabled }),
    sampleRateMode: "native",
    a: {
      codecId: options.aCodec ?? "opus",
      bitrateKbps: options.aBitrate ?? (options.aCodec === "noop_passthrough" ? 0 : 128),
    },
    b: {
      codecId: options.bCodec ?? "opus",
      bitrateKbps: options.bBitrate ?? (options.bCodec === "noop_passthrough" ? 0 : 64),
    },
  };
}

/** Build a genuine shared-policy artifact with real serialized bytes/hashes. */
export function buildArtifact(options: BuildArtifactOptions = {}): BuiltArtifact {
  const request = options.request ?? makeRequest({ canaryEnabled: options.canary === true });
  const a = options.a ?? sine(440);
  // A related, deliberately periodic default exercises the ambiguous pass and
  // its mandatory no-unique-lag disclosure without pretending to be unique.
  const b = options.b ?? sine(440, { amplitude: 0.2 });
  const prepared = preparePair(a, b);
  const delivered = prepared.delivered;
  const validity = makeValidity(request, delivered, prepared.aWav, prepared.bWav);
  let canaryBytes: Readonly<Record<CanarySide, Uint8Array>> | null = null;
  let canaryReport: CanaryMaterialReport | null = null;
  let canary: PreparedArtifact["canary"];
  if (request.canaryEnabled === true) {
    const built = buildCanaryExcerptPair(decoded(prepared.aWav));
    canaryReport = built.report;
    canaryBytes = {
      pristine: built.pristineWav,
      degraded: built.degradedWav,
    };
    canary = {
      report: built.report,
      audio: {
        pristine: description(built.pristineWav),
        degraded: description(built.degradedWav),
      },
    };
  }
  const sourceBytes = new Uint8Array([
    ...new Uint8Array(prepared.aWav.slice(0, 64)),
    ...new Uint8Array(prepared.bWav.slice(0, 64)),
  ]);
  const artifact: PreparedArtifact = {
    id: options.id ?? "fixture-aligned-pair",
    request,
    engine: {
      engineId: "fixture-shared-policy",
      location: "browser-local",
      build: "fixture-build-1",
      codecs: [],
      channels: [1, 2],
      maxInputBytes: AUDIO_MAX_INPUT_BYTES,
      maxDurationSeconds: AUDIO_MAX_DURATION_SECONDS,
      preparationPolicy: "aligned-gain-matched-v1",
      supportedPreparationPolicies: ["aligned-gain-matched-v1"],
      limitations: ["fixture only"],
    },
    sourceSha256: sha256(sourceBytes),
    a: {
      ...(request.version === 2 ? { stages: stagesForSide(request, "a").map((selected, i) => ({stageIndex: i + 1, requested: { ...selected }, encoder: "fixture", decoder: "fixture", actualBitrateKbps: null, encodedSampleRate: prepared.delivered.a.sampleRate})) } : {}),
      requested: finalSelectionForSide(request, "a"),
      encoder: "fixture",
      decoder: "fixture",
      actualBitrateKbps: null,
      encodedSampleRate: prepared.delivered.a.sampleRate,
      delivered: description(prepared.aWav),
    },
    b: {
      ...(request.version === 2 ? { stages: stagesForSide(request, "b").map((selected, i) => ({stageIndex: i + 1, requested: { ...selected }, encoder: "fixture", decoder: "fixture", actualBitrateKbps: null, encodedSampleRate: prepared.delivered.b.sampleRate})) } : {}),
      requested: finalSelectionForSide(request, "b"),
      encoder: "fixture",
      decoder: "fixture",
      actualBitrateKbps: null,
      encodedSampleRate: prepared.delivered.b.sampleRate,
      delivered: description(prepared.bWav),
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
    preparation: prepared.report,
    delivered: prepared.delivered,
    validity,
    canaryReport,
  };
}

export interface ReaderOptions {
  readonly corrupt?: Side | CanarySide | null;
  readonly throwSide?: Side | CanarySide | null;
  readonly gateA?: Promise<void>;
  /** Gate only from the second Side A read; binding's first read stays fast. */
  readonly gateAfterBindA?: Promise<void>;
  readonly gateCanary?: Promise<void>;
}

export function makeReaders(built: BuiltArtifact, options: ReaderOptions = {}): ArtifactReaders {
  let sideAReads = 0;
  async function bytesFor(side: Side | CanarySide): Promise<ArrayBuffer> {
    if (side === "a" || side === "b") {
      if (side === "a") {
        sideAReads += 1;
        if (options.gateAfterBindA && sideAReads > 1) await options.gateAfterBindA;
      }
      if (options.gateA && side === "a") await options.gateA;
      if (options.throwSide === side) throw new Error(`fixture ${side} reader failed`);
      const source = side === "a" ? built.bytes.a : built.bytes.b;
      const copy = new Uint8Array(source);
      if (options.corrupt === side) copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
      return copy.buffer as ArrayBuffer;
    }
    if (!built.bytes.canary) throw new Error("fixture has no canary bytes");
    if (options.gateCanary) await options.gateCanary;
    if (options.throwSide === side) throw new Error(`fixture ${side} reader failed`);
    const source = side === "pristine" ? built.bytes.canary.pristine : built.bytes.canary.degraded;
    const copy = new Uint8Array(source);
    if (options.corrupt === side) copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
    return copy.buffer as ArrayBuffer;
  }
  return {
    readAudio: async (_id, side) => bytesFor(side),
    readCanaryAudio: async (_id, side) => bytesFor(side),
  };
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Deterministic internal seams: known secret, predictable IDs/tokens and clock. */
export function deterministicOptions(options: {
  readonly secrets?: readonly Uint8Array[];
  readonly swaps?: readonly boolean[];
  readonly startMs?: number;
} = {}) {
  const secrets = [...(options.secrets ?? [FIXTURE_SECRET])];
  const swaps = [...(options.swaps ?? [])];
  let counter = 0;
  let secretIndex = 0;
  let swapIndex = 0;
  let clock = options.startMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  return {
    randomBytes(length: number): Uint8Array {
      if (length === 32) {
        const secret = secrets[secretIndex] ?? FIXTURE_SECRET;
        secretIndex += 1;
        return new Uint8Array(secret);
      }
      counter += 1;
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        // Unique for well over the 1000-trial practice bound.
        output[index] = index < 4
          ? (counter >>> (index * 8)) & 0xff
          : (counter * 17 + index * 31) & 0xff;
      }
      return output;
    },
    randomBit(): boolean {
      const swap = swaps[swapIndex % Math.max(swaps.length, 1)] ?? false;
      swapIndex += 1;
      return swap;
    },
    now(): Date {
      clock += 1000;
      return new Date(clock);
    },
  };
}

/** Display label whose source side equals the trial's hidden X. */
export function correctDisplay(
  xSource: "A" | "B",
  swap: boolean,
): "A" | "B" {
  return (swap ? (xSource === "A" ? "B" : "A") : xSource);
}

export function keysDeep(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.add(key);
      keysDeep(item, output);
    }
  }
  return output;
}
