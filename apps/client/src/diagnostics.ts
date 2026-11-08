import type { PreparedArtifact } from "@codec-abx/contracts";

/**
 * Diagnostic export only. It deliberately states that this is not a scored ABX
 * artifact. For raw mode, numerical measurements describe unchanged delivery.
 * For aligned-gain-matched-v1, the detailed applied report is kept separate
 * from the residual measurements of the final serialized bytes.
 */

/** Numerical zero tolerance for exported flags; this is not an audibility threshold. */
const ZERO_OPERATION_EPSILON = 1e-9;

export function producerAmbiguityDisclosures(disclosures: readonly string[]): readonly string[] {
  return disclosures.filter(disclosure => /^(?:no unique lag|polarity ambiguous):/i.test(disclosure));
}

export function buildDiagnosticExport(
  artifact: PreparedArtifact,
  exportedAt: string,
): Record<string, unknown> {
  const delivered = artifact.measurements.delivered ?? null;
  const preparation = artifact.preparation ?? null;
  const aLoudness = delivered?.a.integratedLufs.status;
  const bLoudness = delivered?.b.integratedLufs.status;
  const nullStatus = delivered?.nullDepth.depthDb.status;
  const policyExecuted =
    preparation !== null && preparation.policy === "aligned-gain-matched-v1";
  const gainA = preparation?.loudness.gainADb ?? 0;
  const gainB = preparation?.loudness.gainBDb ?? 0;
  const independentGainApplied =
    policyExecuted &&
    (Math.abs(gainA) > ZERO_OPERATION_EPSILON ||
      Math.abs(gainB) > ZERO_OPERATION_EPSILON);
  // Matching is relative to the other side; normalization to target alone is
  // not presented as gain matching when both sides received the same gain.
  const gainMatchingApplied =
    policyExecuted && Math.abs(gainA - gainB) > ZERO_OPERATION_EPSILON;
  const alignmentShiftSamples = preparation?.alignment.lagSamples ?? 0;
  const alignmentApplied = policyExecuted && alignmentShiftSamples !== 0;
  const tailCropApplied =
    policyExecuted &&
    preparation.alignment.outputFrames <
      Math.max(
        preparation.alignment.inputFramesA - preparation.alignment.startFrameA,
        preparation.alignment.inputFramesB - preparation.alignment.startFrameB,
      );
  const commonPeakTrimApplied =
    policyExecuted && preparation.loudness.commonTrimDb > ZERO_OPERATION_EPSILON;
  const validity = artifact.validity ?? null;
  const preparationGate = validity?.policy === "delivered-validity-v2"
    ? validity.preparationGate
    : null;
  const ambiguityDisclosures = producerAmbiguityDisclosures(artifact.disclosures);
  const canary = artifact.canary ?? null;
  const desktopNative = artifact.engine.location === "desktop-native";
  const canaryMaterialChecked = canary !== null;
  // A checked report means both files were generated, even if the failed
  // material check caused their bytes to be discarded before publication.
  const canaryMaterialGenerated = canary !== null;
  const canaryAudioRetained = canary?.audio !== null && canary?.audio !== undefined;
  const canaryMaterialUsable = canary?.report.usable === true && canaryAudioRetained;

  return {
    schema: "codec-abx-browser-diagnostic-v4",
    exportedAt,
    purpose: "diagnostic-only",
    engineLocation: artifact.engine.location,
    engine: {
      engineId: artifact.engine.engineId,
      build: artifact.engine.build,
      location: artifact.engine.location,
      preparationPolicy: artifact.engine.preparationPolicy,
      supportedPreparationPolicies:
        artifact.engine.supportedPreparationPolicies ?? null,
    },
    preparationPolicy: artifact.engine.preparationPolicy,
    measurementPolicy: artifact.measurements.policy,
    supportedPreparationPolicies:
      artifact.engine.supportedPreparationPolicies ?? null,
    runtimeCustody: {
      authority: "local-self-test",
      preparationLocation: artifact.engine.location,
      experimentRuntime: "not-run; this is a preparation artifact",
      playbackOutputChannels: "unknown; no playback ran",
      physicalOutputRateControl: false,
      trustedRemoteCustody: false,
    },
    runAuthority: "none; local diagnostic preparation artifact",
    scientificStatus: {
      scoredAbxRun: false,
      experimentParity: false,
      // The applied flags come from the detailed report and describe actual
      // operations, not merely that a policy was available or selected.
      preparationPolicyExecuted: policyExecuted,
      alignmentEstimated: delivered?.alignment.status === "estimated",
      alignmentApplied,
      deliveredLoudnessMeasured: aLoudness === "finite" && bLoudness === "finite",
      nullDepthMeasured: nullStatus === "finite" || nullStatus === "negative-infinity",
      normalizationApplied: independentGainApplied,
      gainMatchingApplied,
      commonPeakTrimApplied,
      tailCropApplied,
      // Delivered checks are distinct from listener calibration and scoring.
      nullGateEvaluated: validity !== null,
      nullGateStatus: validity?.nullGate.status ?? null,
      preparationGateEvaluated: preparationGate !== null,
      preparationGateStatus: preparationGate?.status ?? null,
      preparationGateClassification: preparationGate?.classification ?? null,
      preparationGateReason: preparationGate?.reason ?? null,
      preparationDisclosure: preparationGate?.disclosure ?? null,
      producerAmbiguityDisclosures: ambiguityDisclosures,
      canaryMaterialChecked,
      canaryMaterialGenerated,
      canaryAudioRetained,
      canaryMaterialUsable,
      listenerCalibrationRun: false,
      listenerCalibrationTrial: "not-run",
      scoringRun: false,
      // No listener canary gate is implemented by this diagnostic slice.
      canaryGates: false,
      note: policyExecuted
        ? "aligned-gain-matched-v1 executed on decoded codec-stage outputs in " +
          (desktopNative
            ? "the Electron main process’s private native TypeScript worker. "
            : "the browser-local shared preparation pipeline. ") +
          "Applied alignment, independent gains, common peak trim and any tail crop are " +
          "recorded below; delivered measurements are residual measurements of the final " +
          "serialized WAV bytes. The identical-pipeline null gate and any requested canary " +
          "material describe the final delivered bytes only. No bandwidth filtering, listener " +
          "calibration trial, listener canary gate or ABX scoring ran, and these results " +
          "do not establish a valid ABX run or an audible difference."
        : "Delivered PCM measurements describe unchanged codec-stage bytes. No gain " +
          "matching, alignment shift, common peak trim, bandwidth filtering, validity " +
          "evaluation, canary material or ABX scoring was applied, and these measurements " +
          "do not establish a valid ABX run or an audible difference.",
    },
    appliedOperations: preparation
      ? {
          policy: preparation.policy,
          appliedLagSamples: preparation.alignment.lagSamples,
          alignmentStatus: preparation.alignment.status,
          alignmentConfidence: preparation.alignment.confidence,
          inputFramesA: preparation.alignment.inputFramesA,
          inputFramesB: preparation.alignment.inputFramesB,
          startFrameA: preparation.alignment.startFrameA,
          startFrameB: preparation.alignment.startFrameB,
          outputFrames: preparation.alignment.outputFrames,
          gainADb: preparation.loudness.gainADb,
          gainBDb: preparation.loudness.gainBDb,
          commonTrimDb: preparation.loudness.commonTrimDb,
        }
      : null,
    preparation,
    validity,
    preparationGate,
    producerAmbiguityDisclosures: ambiguityDisclosures,
    canary,
    deliveredMeasurements: delivered,
    stageProvenance: {
      a: artifact.a.stages ?? null,
      b: artifact.b.stages ?? null,
      perStageFallback: artifact.a.stages === undefined || artifact.b.stages === undefined,
      note:
        "Per-stage arrays are exported exactly as observed. When absent (legacy/one-stage v1), the artifact's top-level track facts remain the truthful single-stage fallback; no intermediate facts are invented.",
      topLevelRefersToFinalStage: true,
    },
    artifact,
  };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  return `${seconds.toFixed(3)} s`;
}
