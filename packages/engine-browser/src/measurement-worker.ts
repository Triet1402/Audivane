import { freezeRequest } from "@codec-abx/contracts";
import {
  DEFAULT_MAX_LAG_SAMPLES,
  DEFAULT_PROBE_SAMPLES,
  assessPairRelation,
  decodePcm16,
  measurePair,
} from "@codec-abx/measurements";
import {
  PREPARATION_PROBE_SAMPLES,
  PreparationGateRefusalError,
  PreparationPolicyError,
  assertPreparationGatePassed,
  buildCanaryExcerptPair,
  evaluateNullGate,
  evaluatePreparationGate,
  preparePair,
} from "@codec-abx/preparation-policy";

import type {
  MeasurementWorkerRequest,
  MeasurementWorkerRequestMessage,
  MeasurementWorkerResponse,
  PreparationWorkerRequest,
  PreparationWorkerResult,
} from "./measurement-protocol.js";
import { parsePcm16Wav } from "./wav.js";

/**
 * Dedicated numerical worker.
 *
 * It owns the heavy synchronous work for both supported browser policies:
 * strict WAV parsing of the exact delivered bytes, PCM16 decoding, FFT
 * alignment, K-weighted loudness, null depth and, for
 * `aligned-gain-matched-v1`, the shared correction/serialization/remeasurement
 * policy. It also computes the frozen identical-pipeline null decision on the
 * final corrected pair and, only when explicitly requested, canary material
 * from that final Side A. The UI thread only exchanges transferred copies of
 * serialized WAV files and data-only results. No Node or network access
 * is available or used here.
 */

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: MeasurementWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusalCode(error: unknown): string | undefined {
  if (error instanceof PreparationPolicyError) return error.code;
  if (error instanceof PreparationGateRefusalError) return error.code;
  return undefined;
}

function frozenPrepareRequest(value: unknown): PreparationWorkerRequest {
  if (!isRecord(value)) throw new Error("Numerical worker received an invalid prepare request");
  const request = freezeRequest(value.request);
  if (request.preparationPolicy !== "aligned-gain-matched-v1") {
    throw new Error(
      "The numerical prepare request requires explicit aligned-gain-matched-v1 policy",
    );
  }
  return {
    type: "prepare",
    id: value.id as string,
    a: value.a as ArrayBuffer,
    b: value.b as ArrayBuffer,
    request,
  };
}

function requestFrom(value: unknown): MeasurementWorkerRequestMessage {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Numerical worker received an invalid request");
  }
  if (value.type !== "measure" && value.type !== "prepare") {
    throw new Error("Numerical worker received an unsupported request type");
  }
  if (!(value.a instanceof ArrayBuffer) || !(value.b instanceof ArrayBuffer)) {
    throw new Error("Numerical worker requires two serialized WAV ArrayBuffers");
  }
  if (value.type === "prepare") {
    return frozenPrepareRequest(value);
  }
  const maxLagSamples = value.maxLagSamples;
  const probeSamples = value.probeSamples;
  return {
    type: "measure",
    id: value.id,
    a: value.a,
    b: value.b,
    maxLagSamples:
      typeof maxLagSamples === "number" ? maxLagSamples : DEFAULT_MAX_LAG_SAMPLES,
    probeSamples:
      typeof probeSamples === "number" ? probeSamples : DEFAULT_PROBE_SAMPLES,
  };
}

interface DecodedPair {
  readonly a: ReturnType<typeof decodePcm16>;
  readonly b: ReturnType<typeof decodePcm16>;
}

function decodePair(aBytes: Uint8Array, bBytes: Uint8Array): DecodedPair {
  // The main thread already validated these as delivered WAVs, but the worker
  // re-parses the exact same bytes rather than trusting inherited metadata.
  const aFacts = parsePcm16Wav(aBytes);
  const bFacts = parsePcm16Wav(bBytes);
  return {
    a: decodePcm16(aBytes, {
      sampleRate: aFacts.sampleRate,
      channels: aFacts.channels,
      dataOffset: aFacts.dataOffset,
      dataSize: aFacts.dataSize,
    }),
    b: decodePcm16(bBytes, {
      sampleRate: bFacts.sampleRate,
      channels: bFacts.channels,
      dataOffset: bFacts.dataOffset,
      dataSize: bFacts.dataSize,
    }),
  };
}

function computeMeasure(request: MeasurementWorkerRequest): MeasurementWorkerResponse {
  try {
    const pair = decodePair(new Uint8Array(request.a), new Uint8Array(request.b));
    const measurements = measurePair(pair.a, pair.b, {
      maxLagSamples: request.maxLagSamples,
      probeSamples: request.probeSamples,
    });
    return { type: "result", id: request.id, measurements };
  } catch (error: unknown) {
    return {
      type: "error",
      id: request.id,
      message: `Delivered pair measurement failed: ${errorMessage(error)}`,
    };
  }
}

function computePrepare(request: PreparationWorkerRequest): MeasurementWorkerResponse {
  try {
    let pair: DecodedPair | null = decodePair(
      new Uint8Array(request.a),
      new Uint8Array(request.b),
    );
    // The transferred WAV buffers are no longer needed once decoded.
    (request as { a: ArrayBuffer | null; b: ArrayBuffer | null }).a = null;
    (request as { a: ArrayBuffer | null; b: ArrayBuffer | null }).b = null;
    const relationOptions = {
      maxLagSamples: Math.floor(0.1 * pair.a.sampleRate),
      probeSamples: PREPARATION_PROBE_SAMPLES,
    };
    // Preflight the exact decoded codec-stage pair before the frozen v1
    // correction. A failed gate refuses without preparing or publishing.
    const preflightGate = evaluatePreparationGate(
      assessPairRelation(pair.a, pair.b, relationOptions),
    );
    assertPreparationGatePassed(preflightGate);

    const prepared = preparePair(pair.a, pair.b);
    // Drop the input pair before decoding the delivered pair; long tracks must
    // not retain two full Float64 pairs at once.
    pair = null;
    const final = decodePair(prepared.aWav, prepared.bWav);
    // The gate describes the final serialized pair that is actually delivered.
    const relation = assessPairRelation(final.a, final.b, relationOptions);
    const preparationGate = evaluatePreparationGate(relation);
    const validity = {
      policy: "delivered-validity-v2" as const,
      nullGate: evaluateNullGate(request.request, prepared.delivered.nullDepth.depthDb),
      preparationGate,
      notes: [
        "Evaluated the frozen identical-pipeline null gate on the final delivered " +
          "corrected PCM16 pair. This is a diagnostic, not experiment authority.",
        `Preparation-validity-v1 preflight on the decoded codec-stage pair classified ` +
          `${preflightGate.classification}; the exact final serialized pair classified ` +
          `${preparationGate.classification}.`,
        ...(preflightGate.disclosure === null ? [] : [preflightGate.disclosure]),
        ...(preparationGate.disclosure === null ||
            preparationGate.disclosure === preflightGate.disclosure
          ? []
          : [preparationGate.disclosure]),
      ],
    };
    if (request.request.canaryEnabled !== true) {
      return {
        type: "prepare-result",
        id: request.id,
        a: prepared.aWav.buffer as ArrayBuffer,
        b: prepared.bWav.buffer as ArrayBuffer,
        report: prepared.report,
        delivered: prepared.delivered,
        preflightDisclosure: preflightGate.disclosure,
        relation,
        validity,
      };
    }

    // The stage message is queued before this synchronous canary work so the
    // main thread can cancel/reset on the real canary computation.
    scope.postMessage({ type: "stage", id: request.id, stage: "canary" });
    const material = buildCanaryExcerptPair(final.a);
    const result: PreparationWorkerResult = {
      type: "prepare-result",
      id: request.id,
      a: prepared.aWav.buffer as ArrayBuffer,
      b: prepared.bWav.buffer as ArrayBuffer,
      report: prepared.report,
      delivered: prepared.delivered,
      preflightDisclosure: preflightGate.disclosure,
      relation,
      validity,
      canary: material.report.usable
        ? {
            report: material.report,
            pristine: material.pristineWav.buffer as ArrayBuffer,
            degraded: material.degradedWav.buffer as ArrayBuffer,
          }
        : {
            report: material.report,
            pristine: null,
            degraded: null,
          },
    };
    return result;
  } catch (error: unknown) {
    const code = refusalCode(error);
    return {
      type: "error",
      id: request.id,
      message:
        code === undefined
          ? `Aligned/gain-matched preparation failed: ${errorMessage(error)}`
          : `Aligned/gain-matched preparation refused (${code}): ${errorMessage(error)}`,
      ...(code === undefined ? {} : { code }),
    };
  }
}

function transferList(result: MeasurementWorkerResponse): Transferable[] {
  if (result.type !== "prepare-result") return [];
  const transfer: Transferable[] = [result.a, result.b];
  if (result.canary?.pristine instanceof ArrayBuffer) transfer.push(result.canary.pristine);
  if (result.canary?.degraded instanceof ArrayBuffer) transfer.push(result.canary.degraded);
  return transfer;
}

scope.onmessage = (event: MessageEvent<unknown>): void => {
  let request: MeasurementWorkerRequestMessage;
  try {
    request = requestFrom(event.data);
  } catch (error: unknown) {
    const raw = event.data;
    if (isRecord(raw) && typeof raw.id === "string") {
      scope.postMessage({
        type: "error",
        id: raw.id,
        message: errorMessage(error),
      });
    }
    return;
  }

  // Post "started" before the synchronous numerical work so the main thread can
  // process Cancel/Reset while this worker is busy. The message is queued by the
  // platform; the following compute call blocks this worker only.
  scope.postMessage({ type: "started", id: request.id, mode: request.type });
  if (request.type === "prepare") {
    const result = computePrepare(request);
    scope.postMessage(result, transferList(result));
    return;
  }
  scope.postMessage(computeMeasure(request));
};
