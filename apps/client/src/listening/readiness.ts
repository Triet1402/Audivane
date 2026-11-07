import type { ExperimentSnapshot, PreparedArtifact } from "@codec-abx/contracts";

import { calibrationMaterialAdvice } from "./model.js";

/** Gate-side reasons that block staging trial 1 on a configured run. */
export type TrialStartGateCode =
  | "artifact-unbound"
  | "calibration-unavailable"
  | "null-gate-failed"
  | "preparation-gate-failed"
  | "preparation-gate-not-measured";

export interface TrialStartGateBlocker {
  readonly code: TrialStartGateCode;
  readonly message: string;
  readonly reasons: readonly string[];
}

/**
 * The client gate decision shared by the rendered Start control and the
 * listening controller. It deliberately covers only facts carried by the bound
 * snapshot and artifact: async lifecycle/busy/lock state stays with the
 * controller, and dirty or invalid form fields stay with the view.
 *
 * Callers must still treat the run authority as authoritative; this predicate
 * prevents an enabled control from promising a start the controller refuses.
 * Its refusal order preserves the client controller's existing messages; the
 * authority independently enforces its own checks against exact served bytes.
 */
export function trialStartGateBlocker(
  snapshot: ExperimentSnapshot,
  artifact: PreparedArtifact | null,
): TrialStartGateBlocker | null {
  if (snapshot.prepared === null) {
    return {
      code: "artifact-unbound",
      message: "Prepare the listening run before starting a trial.",
      reasons: [],
    };
  }
  if (snapshot.plan.calibrationEnabled && snapshot.gates.calibrationStatus === "unavailable") {
    const advice = artifact === null ? null : calibrationMaterialAdvice(artifact);
    return {
      code: "calibration-unavailable",
      message:
        "Calibration is required for this plan but usable canary material is unavailable. " +
        "No trial was staged and calibration was not disabled automatically.",
      reasons: [advice ?? "Prepare again with usable canary material."],
    };
  }
  if (snapshot.gates.nullStatus === "failed") {
    return {
      code: "null-gate-failed",
      message:
        "The bound pair failed the identical-pipeline null gate, so scoring is blocked. " +
        "Prepare a different pair; no fallback was applied.",
      reasons: snapshot.gates.reasons,
    };
  }
  if (snapshot.gates.preparationStatus === "failed") {
    return {
      code: "preparation-gate-failed",
      message:
        "The bound pair failed the frozen preparation-validity gate, so all trials are blocked. " +
        "Prepare a different pair; no correction or fallback was applied.",
      reasons: [
        snapshot.gates.preparationReason ?? "preparation validity failed",
        ...(snapshot.gates.preparationDisclosure === null
          ? []
          : [snapshot.gates.preparationDisclosure]),
      ],
    };
  }
  if (snapshot.gates.preparationStatus !== "passed") {
    return {
      code: "preparation-gate-not-measured",
      message:
        "Preparation validity has not been measured for the bound pair, so trials are not authorized.",
      reasons: snapshot.gates.reasons,
    };
  }
  return null;
}
