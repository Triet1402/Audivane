import { AUDIO_MAX_DURATION_SECONDS, AUDIO_MAX_INPUT_BYTES, CODEC_IDS, freezeRequest, stagesForSide, finalSelectionForSide } from "@codec-abx/contracts";
import { exact, handle } from "./boundary.js";

type Guard = (value: unknown) => void;
const refuse = (): never => { throw new Error("Invalid public preparation result"); };
const finite: Guard = value => { if (typeof value !== "number" || !Number.isFinite(value)) refuse(); };
const nonnegative: Guard = value => { finite(value); if ((value as number) < 0) refuse(); };
const integer: Guard = value => { if (!Number.isSafeInteger(value)) refuse(); };
const count: Guard = value => { integer(value); if ((value as number) < 0) refuse(); };
const natural: Guard = value => { count(value); if (value === 0) refuse(); };
const positive: Guard = value => { finite(value); if ((value as number) <= 0) refuse(); };
const text: Guard = value => { if (typeof value !== "string" || value.length > 16384) refuse(); };
const bool: Guard = value => { if (typeof value !== "boolean") refuse(); };
const hash: Guard = value => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse(); };
const choice = (...allowed: readonly unknown[]): Guard => value => { if (!allowed.includes(value)) refuse(); };
const nullable = (guard: Guard): Guard => value => { if (value !== null) guard(value); };
const list = (guard: Guard, maximum = 256): Guard => value => {
  if (!Array.isArray(value) || value.length > maximum) refuse();
  for (const item of Array.from(value as unknown[])) guard(item);
};
const shape = (required: Record<string, Guard>, optional: Record<string, Guard> = {}): Guard => value => {
  exact(value, Object.keys(required), Object.keys(optional));
  for (const [key, guard] of Object.entries(required)) guard(value[key]);
  for (const [key, guard] of Object.entries(optional)) if (Object.hasOwn(value, key)) guard(value[key]);
};
const notes = list(text);
/** Only the actual shared policy of the installed native engine. */
const sharedPolicy = choice("aligned-gain-matched-v1");
const rate = choice(44100, 48000, 96000);
const channels = choice(1, 2);
const selection: Guard = value => { freezeRequest({ version: 1, sampleRateMode: "native", a: value, b: value }); };
const description = shape({ sampleRate: rate, channels, frames: natural, wavSha256: hash });
const level: Guard = value => {
  exact(value, ["status", "value", "reason"]);
  if (value.status === "finite") { finite(value.value); choice(null)(value.reason); }
  else { choice("negative-infinity", "undefined", "unavailable")(value.status); choice(null)(value.value); text(value.reason); }
};
const alignmentFields = { lagSamples: integer, confidence: finite, status: choice("estimated", "no-evidence"), maxLagSamples: count, probeSamples: count };
const alignment = shape(alignmentFields);
const summary = shape({ sampleRate: rate, channels, frames: natural, integratedLufs: level, samplePeakDbfs: level });
const delivered = shape({ policy: choice("delivered-pcm-measurements-v1"), a: summary, b: summary,
  alignment, loudnessDeltaDb: level,
  nullDepth: shape({ basis: choice("unshifted-common-prefix"), comparedFrames: count, depthDb: level }), notes });
const implementation = { requested: selection, encoder: text, decoder: text,
  actualBitrateKbps: nullable(positive), encodedSampleRate: nullable(natural) };
const stage = shape({ stageIndex: natural, ...implementation });
const track = shape({ ...implementation, delivered: description }, { stages: list(stage, 4) });
const nullGate = shape({ policy: choice("identical-pipeline-null-v1"), expectedIdentical: bool,
  thresholdDb: choice(-60), depthDb: level, status: choice("passed", "failed", "not-applicable"), reason: text });
const preparationGateEvidence = shape({
  acRmsFullScaleA: nonnegative, acRmsFullScaleB: nonnegative,
  acRmsCodeStepsA: nonnegative, acRmsCodeStepsB: nonnegative,
  sameConfidence: finite, sameLagSamples: integer,
  invertedConfidence: finite, invertedLagSamples: integer,
  chosenPolarity: choice("same", "inverted"),
  chosenLagSamples: integer, chosenConfidence: finite,
  searchMinLagSamples: integer, searchMaxLagSamples: integer,
  distinctPositivePeaksWithinTolerance: count,
});
const preparationGate = shape({
  policy: choice("preparation-validity-v2"),
  status: choice("passed", "failed"),
  classification: choice("non-evidentiary", "globally-inverted", "weak-or-unrelated",
    "alignment-at-search-bound", "same-polarity-periodic-ambiguous", "polarity-ambiguous", "same-polarity-unique"),
  reason: text,
  constants: shape({
    minAcRmsFullScale: choice(1 / 32768),
    invertedMinConfidence: choice(.5),
    invertedMargin: choice(.25),
    sameMinConfidence: choice(.5),
    peakValueTolerance: choice(.01),
  }),
  evidence: preparationGateEvidence,
  disclosure: nullable(text),
  notes,
});
const canaryReport = shape({ status: choice("usable", "not-usable"), usable: bool, minimumResidualDb: choice(-30),
  depthDb: level, reason: text, policy: choice("delivered-canary-v1"), cutoffHz: choice(3000),
  frequencyGrid: choice("numpy-rfftfreq-v1"), drive: choice(10), clipLevel: choice(.45), sampleRate: rate, channels, frames: natural, notes });
const preparation = shape({ policy: sharedPolicy, targetLufs: choice(-16),
  minimumDurationSeconds: choice(.4), maxLagSeconds: choice(.1), peakCeiling: positive,
  alignment: shape({ ...alignmentFields, inputFramesA: count, inputFramesB: count, startFrameA: count, startFrameB: count, outputFrames: count }),
  loudness: shape({ preA: level, preB: level, gainADb: finite, gainBDb: finite, commonTrimDb: nonnegative }),
  serialization: shape({ format: choice("pcm16-le"), rounding: choice("floor"), floorBiasCodeSteps: nonnegative, dither: choice(false) }), notes });

/** Structural public DTO boundary only. Byte/scientific verification stays in the service. */
export const guardNativeCapabilities: Guard = shape({ engineId: choice("engine-native-typescript"), location: choice("desktop-native"),
  build: text, codecs: list(shape({ codecId: choice(...CODEC_IDS), availability: choice("available", "unavailable", "unknown"),
    encoder: text, decoder: text, reason: nullable(text) }), CODEC_IDS.length), channels: list(channels, 2),
  maxInputBytes: choice(AUDIO_MAX_INPUT_BYTES), maxDurationSeconds: choice(AUDIO_MAX_DURATION_SECONDS), preparationPolicy: sharedPolicy, limitations: notes },
{ maxStagesPerSide: choice(4), supportedPreparationPolicies: list(sharedPolicy, 1), supportsCanaryMaterial: choice(true) });

const artifact = shape({ id: handle, request: value => { freezeRequest(value); }, engine: guardNativeCapabilities,
  sourceSha256: hash, a: track, b: track, elapsedMs: nonnegative,
  measurements: shape({ policy: sharedPolicy,
    alignmentLagSamples: nullable(integer), alignmentConfidence: nullable(finite), loudnessDeltaDb: nullable(finite),
    nullDepthDb: nullable(finite), notes }, { delivered }),
  preparation, disclosures: notes, purpose: choice("diagnostic-only"),
  validity: shape({ policy: choice("delivered-validity-v2"), nullGate, preparationGate, notes }) },
{ canary: shape({ report: canaryReport, audio: nullable(shape({ pristine: description, degraded: description })) }) });

export function guardPreparedArtifact(value: unknown): void {
  artifact(value);
  // Shape validation rejects every unknown nested key before any DTO is forwarded,
  // including obsolete diagnostic fields that are no longer part of this engine.
  const publicArtifact = value as import("@codec-abx/contracts").PreparedArtifact;
  const request = freezeRequest(publicArtifact.request);
  if (request.preparationPolicy !== "aligned-gain-matched-v1") refuse();
  if (publicArtifact.engine.engineId !== "engine-native-typescript" ||
      publicArtifact.engine.location !== "desktop-native" ||
      publicArtifact.measurements.policy !== "aligned-gain-matched-v1") refuse();
  const validity = publicArtifact.validity;
  if (validity?.policy === "delivered-validity-v2") {
    const gate = validity.preparationGate;
    const failed: readonly string[] = ["non-evidentiary", "globally-inverted", "weak-or-unrelated",
      "alignment-at-search-bound"];
    const passed: readonly string[] = ["same-polarity-periodic-ambiguous", "polarity-ambiguous", "same-polarity-unique"];
    if (gate.status === "failed" && !failed.includes(gate.classification)) refuse();
    if (gate.status === "passed" && !passed.includes(gate.classification)) refuse();
    if ((gate.classification === "same-polarity-periodic-ambiguous" || gate.classification === "polarity-ambiguous") !==
        (gate.disclosure !== null)) refuse();
  }
  for (const side of ["a", "b"] as const) {
    const actual = publicArtifact[side], requested = stagesForSide(request, side);
    const final = finalSelectionForSide(request, side);
    if (actual.requested.codecId !== final.codecId || actual.requested.bitrateKbps !== final.bitrateKbps) refuse();
    if (request.version === 2 || actual.stages !== undefined) {
      if (actual.stages?.length !== requested.length) refuse();
      actual.stages!.forEach((entry, index) => {
        if (entry.stageIndex !== index + 1 || entry.requested.codecId !== requested[index]!.codecId ||
            entry.requested.bitrateKbps !== requested[index]!.bitrateKbps) refuse();
      });
      const last = actual.stages!.at(-1)!;
      if (["encoder", "decoder", "actualBitrateKbps", "encodedSampleRate"].some(key =>
        actual[key as keyof typeof implementation] !== last[key as keyof typeof implementation])) refuse();
    }
  }
}
