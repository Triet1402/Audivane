import type {
  CodecSelection,
  ExperimentPlan,
  PreparedArtifact,
  PublicTrial,
  SampleRateMode,
} from "@codec-abx/contracts";

/**
 * Practical UI defaults, not experiment-policy changes. The listening plan
 * starts with calibration explicitly OFF; the single readiness-check opt-in in
 * the client turns on both canary generation and the calibration trial.
 */
export const LISTENING_DEFAULTS = Object.freeze({
  plannedTrials: 8,
  alpha: 0.05,
  labelMode: "blind_random" as const,
  calibrationEnabled: false,
});

export const MIN_PLANNED_TRIALS = 1;
export const MAX_PLANNED_TRIALS = 1000;

/** Identity of the inputs that produce one prepared test pair. */
export interface TestPreparationKey {
  readonly sourceIdentity: string;
  readonly stagesA: readonly CodecSelection[];
  readonly stagesB: readonly CodecSelection[];
  readonly rateMode: SampleRateMode;
  readonly calibrationEnabled: boolean;
}

/**
 * Stable signature for the primary prepare-test path. It deliberately excludes
 * the advanced manual policy selector: the primary action always requests
 * aligned + gain-matched preparation. Any source, codec, rate or readiness
 * change makes a retained artifact stale for reuse.
 */
export function testPreparationSignature(key: TestPreparationKey): string {
  return JSON.stringify({
    source: key.sourceIdentity,
    a: key.stagesA.map((stage) => [stage.codecId, stage.bitrateKbps]),
    b: key.stagesB.map((stage) => [stage.codecId, stage.bitrateKbps]),
    rate: key.rateMode,
    calibration: key.calibrationEnabled,
  });
}

/**
 * A retained artifact may be rebound without re-encoding only when it was
 * produced for exactly the current inputs and still passes listening
 * eligibility. Raw, historical or differently-configured artifacts are never
 * reused implicitly.
 */
export function preparedArtifactReusable(
  artifact: PreparedArtifact | null,
  preparedSignature: string | null,
  currentSignature: string,
): boolean {
  return artifact !== null && preparedSignature !== null &&
    preparedSignature === currentSignature &&
    listeningArtifactEligibility(artifact) === null;
}

export interface ListeningPlanFields {
  readonly plannedTrials: string;
  readonly alpha: string;
  readonly labelMode: "fixed" | "blind_random";
  readonly calibrationEnabled: boolean;
}

export interface PlanValidation {
  readonly plan: ExperimentPlan | null;
  readonly errors: readonly string[];
}

/**
 * Pure plan parsing for the form. The service remains the authority; this only
 * prevents obviously invalid local input and keeps the defaults explicit.
 */
export function validateListeningPlan(fields: ListeningPlanFields): PlanValidation {
  const errors: string[] = [];
  const planned = Number(fields.plannedTrials);
  if (
    fields.plannedTrials.trim().length === 0 ||
    !Number.isSafeInteger(planned) ||
    planned < MIN_PLANNED_TRIALS ||
    planned > MAX_PLANNED_TRIALS
  ) {
    errors.push(
      `Planned trials must be a whole number from ${MIN_PLANNED_TRIALS} to ${MAX_PLANNED_TRIALS}.`,
    );
  }
  const alpha = Number(fields.alpha);
  if (fields.alpha.trim().length === 0 || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    errors.push("Alpha must be a finite number strictly between 0 and 1.");
  }
  if (fields.labelMode !== "fixed" && fields.labelMode !== "blind_random") {
    errors.push("Label mode must be fixed or blind_random.");
  }
  if (errors.length > 0) return { plan: null, errors };
  return {
    plan: {
      version: 1,
      plannedTrials: planned,
      alpha,
      labelMode: fields.labelMode,
      calibrationEnabled: fields.calibrationEnabled,
    },
    errors,
  };
}

/**
 * A current raw browser artifact is a diagnostic probe, not a historical
 * artifact. Distinguish it before interpreting the missing delivery report so
 * the refusal names the actual state instead of inventing a v1 history.
 */
export function isRawCodecProbeArtifact(
  artifact: PreparedArtifact | null | undefined,
): boolean {
  return artifact !== null && artifact !== undefined &&
    artifact.engine.location === "browser-local" &&
    artifact.engine.preparationPolicy === "codec-probe-only" &&
    artifact.request.preparationPolicy !== "aligned-gain-matched-v1" &&
    artifact.preparation === undefined &&
    artifact.validity === undefined;
}

/**
 * The listening flow accepts the browser shared prepared pair or the native
 * shared prepared pair. Raw/unsupported artifacts are refused with a concrete
 * remediation; there is no engine switch.
 */
export function listeningArtifactEligibility(
  artifact: PreparedArtifact | null | undefined,
): string | null {
  if (!artifact) {
    return "Prepare a local PCM16 WAV artifact first.";
  }
  if (artifact.purpose !== "diagnostic-only") {
    return "This artifact is not a diagnostic-only preparation artifact.";
  }
  if (isRawCodecProbeArtifact(artifact)) {
    return (
      "ABX listening requires aligned, level-matched audio. " +
      "Select aligned + gain-matched preparation and prepare again."
    );
  }
  if (artifact.validity === undefined) {
    return (
      "This artifact has no delivered-validity-v2 report or measured preparation gate. " +
      "Re-prepare with the current engine before scored listening. No gate is invented, " +
      "upgraded or inferred."
    );
  }
  if (artifact.validity.policy === "delivered-validity-v1") {
    return (
      "The listening flow requires delivered-validity-v2 with a measured preparation " +
      "gate. Historical delivered-validity-v1 artifacts remain valid diagnostic data " +
      "but are not authorized for scored listening; re-prepare with the current engine. " +
      "No gate is invented, upgraded or inferred."
    );
  }
  if (artifact.validity.policy !== "delivered-validity-v2") {
    return (
      "The listening flow requires delivered-validity-v2 with a measured preparation " +
      "gate. This artifact reports an unsupported delivered-validity policy; " +
      "re-prepare with the current engine. No gate is invented, upgraded or inferred."
    );
  }
  if (artifact.validity.preparationGate.policy !== "preparation-validity-v2") {
    return "This preparation gate is historical. Re-prepare with the current engine before scored listening.";
  }
  if (artifact.engine.location === "desktop-native") {
    if (
      artifact.engine.engineId !== "engine-native-typescript" ||
      artifact.request.preparationPolicy !== "aligned-gain-matched-v1" ||
      artifact.preparation?.policy !== "aligned-gain-matched-v1" ||
      artifact.measurements.policy !== "aligned-gain-matched-v1"
    ) {
      return (
        "The desktop listening flow requires the actual shared aligned-gain-matched-v1 " +
        "artifact from the native TypeScript engine (engine-native-typescript). " +
        "This artifact is raw or labels an unsupported engine/policy. " +
        "Prepare it again with the current native shared-preparation engine; no fallback or relabelling is applied."
      );
    }
    if (!artifact.measurements.delivered) {
      return (
        "The native artifact is missing the delivered-pair measurement report required " +
        "for the listening bind; prepare it again with the current native engine."
      );
    }
    return null;
  }
  if (artifact.engine.location !== "browser-local") {
    return (
      "This listening flow accepts browser-local shared preparation or explicit native " +
      "delivered evidence. Optional-server artifacts are unsupported; no engine switch is performed."
    );
  }
  const preparedPolicy = artifact.preparation?.policy ?? null;
  if (
    artifact.request.preparationPolicy !== "aligned-gain-matched-v1" ||
    preparedPolicy !== "aligned-gain-matched-v1"
  ) {
    return (
      "The listening flow requires the shared aligned-gain-matched-v1 prepared pair. " +
      "This artifact uses raw codec-probe-only delivery (or an unsupported policy). " +
      "Select “Aligned + gain-matched preparation”, prepare again, and keep this diagnostic lab as-is. " +
      "No fallback, upload or codec substitution was applied."
    );
  }
  if (!artifact.measurements.delivered) {
    return (
      "The aligned artifact is missing the delivered-pair measurement report required for " +
      "the listening bind; prepare it again with the current engine."
    );
  }
  return null;
}

/**
 * Calibration is blocking when requested. This text never disables it; the
 * user must reprepare with canary material or explicitly turn calibration off.
 */
export function calibrationMaterialAdvice(artifact: PreparedArtifact): string | null {
  const native = artifact.engine.location === "desktop-native";
  const canary = artifact.canary;
  if (!canary) {
    return native
      ? "Calibration is ON but this native artifact contains no delivered canary material. " +
          "Prepare again with the optional native canary enabled, " +
          "or explicitly disable calibration. It is never disabled automatically."
      : "Calibration is ON but this artifact contains no canary material. " +
          "Prepare again with “Generate canary material” enabled (aligned-gain-matched-v1 only), " +
          "or explicitly disable calibration. It is never disabled automatically.";
  }
  if (!canary.report.usable || canary.audio === null) {
    return (
      `Calibration is ON but the retained canary material is not usable (${canary.report.reason}). ` +
      "Prepare again until a usable canary pair is retained, or explicitly disable calibration. " +
      "A generated material check is not a listener pass."
    );
  }
  return null;
}

export function isTrialCurrent(
  trial: PublicTrial | null,
  snapshotRunId: string | null,
  token: string,
  runId: string,
): boolean {
  return trial !== null && trial.token === token && trial.runId === runId &&
    snapshotRunId === runId;
}

export function rateText(rate: number | null): string {
  return rate === null ? "not created yet (first Play unlocks audio)" : `${rate} Hz`;
}

export function requiredCorrectText(required: number | null, planned: number | null): string {
  if (planned === null) return "practice run: no final verdict threshold";
  if (required === null) {
    return `no correct count at N=${planned} can reach this alpha; final significance is impossible at this N`;
  }
  return `at least ${required} of ${planned} scored trials correct`;
}
