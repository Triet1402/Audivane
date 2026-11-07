import type {
  CanaryDepthDecision,
  LevelMeasurement,
  NullGateDecision,
  PreparationRequest,
} from "@codec-abx/contracts";
import { freezeRequest, samePipelines } from "@codec-abx/contracts";

import { PreparationPolicyError } from "./errors.js";

/** Frozen floors. They mirror core.alignment and have no user adjustment. */
export const NULL_GATE_THRESHOLD_DB = -60 as const;
export const CANARY_MIN_RESIDUAL_DB = -30 as const;

function fail(message: string): never {
  throw new PreparationPolicyError("invalid-level", message);
}

/**
 * Copy and validate a discriminated level. A malformed discriminant must not
 * masquerade as a deep null: finite NaN and a null-valued "finite" record are
 * refusals, not measurements.
 */
export function validateLevelMeasurement(value: unknown, label: string): LevelMeasurement {
  if (!value || typeof value !== "object") fail(`${label} is not a level measurement`);
  const level = value as Record<string, unknown>;
  if (level.status === "finite") {
    if (typeof level.value !== "number" || !Number.isFinite(level.value)) {
      fail(`${label} has a non-finite "finite" value`);
    }
    if (level.reason !== null) fail(`${label} has a reason on a finite level`);
    return Object.freeze({ status: "finite", value: level.value, reason: null });
  }
  if (
    level.status === "negative-infinity" ||
    level.status === "undefined" ||
    level.status === "unavailable"
  ) {
    if (level.value !== null) fail(`${label} has a value on a non-finite level`);
    if (typeof level.reason !== "string" || level.reason.length === 0) {
      fail(`${label} is missing its non-finite reason`);
    }
    return Object.freeze({ status: level.status, value: null, reason: level.reason });
  }
  fail(`${label} has an unknown status ${String(level.status)}`);
}

function describeLevel(level: LevelMeasurement): string {
  if (level.status === "finite") return `${level.value.toFixed(2)} dB`;
  if (level.status === "negative-infinity") return "perfect (-inf dB)";
  if (level.status === "undefined") return "undefined (silence in reference)";
  return `unavailable (${level.reason})`;
}

/** Validate a request without accepting caller-controlled aliases or mutations. */
function freezeForGate(value: unknown): PreparationRequest {
  try {
    return freezeRequest(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PreparationPolicyError("invalid-request", message);
  }
}

/**
 * Decide whether a delivered pair that must null is at or below the -60 dB
 * floor. This is a delivered-audio diagnostic, not experiment authority.
 * Malformed requests/levels always throw before an applicability decision.
 *
 * Identical supported A/B selections are applicable. A finite depth <= -60 dB
 * or an exact -inf digital null passes; undefined/unavailable levels fail
 * closed. Different selections are always not-applicable so a shallow residual
 * cannot block a real codec comparison.
 */
export function evaluateNullGate(
  request: PreparationRequest,
  depthDb: LevelMeasurement,
): NullGateDecision {
  const frozen = freezeForGate(request);
  const level = validateLevelMeasurement(depthDb, "null depth");
  const expectedIdentical =
    samePipelines(frozen);

  if (!expectedIdentical) {
    return {
      policy: "identical-pipeline-null-v1",
      expectedIdentical: false,
      thresholdDb: NULL_GATE_THRESHOLD_DB,
      depthDb: level,
      status: "not-applicable",
      reason:
        "sides are configured differently, so a null is not expected: the gate " +
        "cannot judge this pair and does not block it",
    };
  }

  if (level.status === "negative-infinity") {
    return {
      policy: "identical-pipeline-null-v1",
      expectedIdentical: true,
      thresholdDb: NULL_GATE_THRESHOLD_DB,
      depthDb: level,
      status: "passed",
      reason:
        `identical pipelines null to ${describeLevel(level)}, at or below the ` +
        `${NULL_GATE_THRESHOLD_DB.toFixed(1)} dB floor: level and phase matching verified`,
    };
  }

  if (level.status !== "finite") {
    return {
      policy: "identical-pipeline-null-v1",
      expectedIdentical: true,
      thresholdDb: NULL_GATE_THRESHOLD_DB,
      depthDb: level,
      status: "failed",
      reason:
        "a pair built from identical pipelines must null, and the residual could " +
        `not be measured (${describeLevel(level)}): refusing to start trials (fail closed)`,
    };
  }

  if (level.value <= NULL_GATE_THRESHOLD_DB) {
    return {
      policy: "identical-pipeline-null-v1",
      expectedIdentical: true,
      thresholdDb: NULL_GATE_THRESHOLD_DB,
      depthDb: level,
      status: "passed",
      reason:
        `identical pipelines null to ${describeLevel(level)}, at or below the ` +
        `${NULL_GATE_THRESHOLD_DB.toFixed(1)} dB floor: level and phase matching verified`,
    };
  }

  return {
    policy: "identical-pipeline-null-v1",
    expectedIdentical: true,
    thresholdDb: NULL_GATE_THRESHOLD_DB,
    depthDb: level,
    status: "failed",
    reason:
      `identical pipelines did NOT null: residual ${describeLevel(level)} is above ` +
      `the ${NULL_GATE_THRESHOLD_DB.toFixed(1)} dB floor, so A and B are not ` +
      "level/phase matched at the sample level: refusing to start trials",
  };
}

/**
 * A measured material check: a finite delivered residual STRICTLY greater than
 * -30 dB is usable. Exactly -30 dB, deeper residuals, exact nulls and silent or
 * unavailable references are not. Usable is not proof of human audibility.
 */
export function evaluateCanaryDepth(depthDb: LevelMeasurement): CanaryDepthDecision {
  const level = validateLevelMeasurement(depthDb, "canary depth");
  const base = {
    minimumResidualDb: CANARY_MIN_RESIDUAL_DB,
    depthDb: level,
  } as const;

  if (level.status !== "finite") {
    return {
      ...base,
      status: "not-usable",
      usable: false,
      reason:
        `canary material has no finite delivered residual (${describeLevel(level)}); ` +
        "it cannot support a measured usability claim or a calibration trial",
    };
  }

  if (level.value > CANARY_MIN_RESIDUAL_DB) {
    return {
      ...base,
      status: "usable",
      usable: true,
      reason:
        `measured material differs by ${describeLevel(level)} residual, strictly ` +
        `above the ${CANARY_MIN_RESIDUAL_DB.toFixed(1)} dB floor: a gross, ` +
        "deliberately-easy difference (not proof of human audibility)",
    };
  }

  return {
    ...base,
    status: "not-usable",
    usable: false,
    reason:
      `measured material differs by only ${describeLevel(level)} residual, at or ` +
      `below the ${CANARY_MIN_RESIDUAL_DB.toFixed(1)} dB floor: too subtle to gate a run`,
  };
}
