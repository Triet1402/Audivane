import type { JSX } from "react";
import type { ExperimentSnapshot } from "@codec-abx/contracts";

function resultHeading({
  statistics,
  gates,
  plan,
  lifecycle,
}: ExperimentSnapshot): string {
  if (
    gates.preparationStatus === "failed" ||
    gates.nullStatus === "failed" ||
    (plan.calibrationEnabled && gates.calibrationStatus === "failed")
  )
    return "Test checks failed";
  if (statistics.isFinal) {
    return statistics.significantVerdict
      ? "Significant difference detected"
      : "No significant difference detected";
  }
  if (lifecycle === "void") return "Test invalid";
  if (lifecycle === "sealed") return "Test ended early";
  return "Test in progress";
}

export function RunRecord(props: {
  readonly snapshot: ExperimentSnapshot;
  readonly detailsOpen: boolean;
  readonly onDetailsToggle: (open: boolean) => void;
}): JSX.Element {
  const { statistics: stats, gates, plan } = props.snapshot;
  return (
    <section className="run-record" aria-labelledby="run-record-heading">
      <h2 id="run-record-heading">{resultHeading(props.snapshot)}</h2>
      <dl className="evidence-metrics">
        <div>
          <dt>Correct</dt>
          <dd>
            {stats.correctTrials} <span>/ {stats.scoredTrials}</span>
          </dd>
        </div>
        <div>
          <dt>Accuracy</dt>
          <dd>
            {stats.scoredTrials
              ? `${Math.round((stats.correctTrials / stats.scoredTrials) * 100)}%`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>p-value</dt>
          <dd>{stats.pValue.toFixed(4)}</dd>
        </div>
        <div>
          <dt>95% confidence interval</dt>
          <dd>
            {(stats.abilityCi95[0] * 100).toFixed(1)}–
            {(stats.abilityCi95[1] * 100).toFixed(1)}%
          </dd>
        </div>
      </dl>
      {gates.preparationDisclosure && (
        <p className="warning" role="alert">
          {gates.preparationDisclosure}
        </p>
      )}
      {gates.reasons.length > 0 && (
        <ul className="gate-reasons">
          {gates.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <details
        open={props.detailsOpen}
        onToggle={(event) => props.onDetailsToggle(event.currentTarget.open)}
      >
        <summary>Test details</summary>
        <dl className="facts">
          <dt>Trials</dt>
          <dd>
            {stats.scoredTrials} / {plan.plannedTrials ?? "Practice"}
          </dd>
          <dt>Significance threshold</dt>
          <dd>{plan.alpha}</dd>
          <dt>Required correct</dt>
          <dd>{stats.requiredCorrect ?? "—"}</dd>
          <dt>Labels</dt>
          <dd>{plan.labelMode === "fixed" ? "Fixed" : "Randomized"}</dd>
          <dt>Readiness check</dt>
          <dd>{plan.calibrationEnabled ? gates.calibrationStatus : "Off"}</dd>
          <dt>Audio preparation</dt>
          <dd>{gates.preparationStatus}</dd>
          <dt>Identical-audio check</dt>
          <dd>
            {gates.nullStatus === "not-applicable"
              ? "Not needed"
              : gates.nullStatus}
          </dd>
        </dl>
      </details>
    </section>
  );
}
