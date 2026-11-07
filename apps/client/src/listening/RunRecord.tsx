import type { JSX } from "react";

import type {
  ExperimentSnapshot,
  PlaybackSnapshot,
  PreparedArtifact,
} from "@codec-abx/contracts";

import { producerAmbiguityDisclosures } from "../diagnostics.js";
import { requiredCorrectText, rateText } from "./model.js";

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function PlanSummary(props: { readonly snapshot: ExperimentSnapshot }): JSX.Element {
  const plan = props.snapshot.plan;
  return (
    <dl className="facts listening-plan-facts">
      <dt>Planned N</dt>
      <dd>{plan.plannedTrials ?? "practice (no final verdict)"}</dd>
      <dt>Alpha</dt>
      <dd>{plan.alpha}</dd>
      <dt>Label mode</dt>
      <dd><code>{plan.labelMode}</code></dd>
      <dt>Calibration</dt>
      <dd>{plan.calibrationEnabled ? "ON (excluded from scored N)" : "explicitly OFF"}</dd>
      <dt>Required correct</dt>
      <dd>{requiredCorrectText(props.snapshot.statistics.requiredCorrect, plan.plannedTrials)}</dd>
      <dt>Commitment</dt>
      <dd><code className="commitment">{props.snapshot.commitment}</code></dd>
      <dt>Lifecycle</dt>
      <dd>
        <strong>{props.snapshot.lifecycle}</strong>
        {props.snapshot.lockedAtUtc ? ` · plan locked ${props.snapshot.lockedAtUtc}` : " · not yet locked"}
      </dd>
    </dl>
  );
}

export function StatsPanel(props: {
  readonly snapshot: ExperimentSnapshot;
  readonly artifact: PreparedArtifact | null;
}): JSX.Element {
  const stats = props.snapshot.statistics;
  const producerAmbiguity = producerAmbiguityDisclosures(props.artifact?.disclosures ?? []);
  return (
    <section className="listening-stats" aria-labelledby="listening-stats-heading">
      <div className="section-head compact-head">
        <h3 id="listening-stats-heading">Scores and gates</h3>
        <p className="section-meta">{stats.scoredTrials} / {stats.plannedTrials ?? "practice"} scored</p>
      </div>
      <dl className="facts stat-line">
        <dt>Scored progress</dt>
        <dd>
          {stats.scoredTrials} / {stats.plannedTrials ?? "practice"} scored ·
          {" "}{stats.correctTrials} correct
        </dd>
        <dt>Calibration gate</dt>
        <dd><strong>{props.snapshot.gates.calibrationStatus}</strong></dd>
        <dt>Null gate</dt>
        <dd><strong>{props.snapshot.gates.nullStatus}</strong></dd>
        <dt>Preparation validity</dt>
        <dd>
          <strong>{props.snapshot.gates.preparationStatus}</strong>
          {props.snapshot.gates.preparationClassification === null
            ? null
            : <> · <code>{props.snapshot.gates.preparationClassification}</code></>}
        </dd>
      </dl>
      {props.snapshot.gates.preparationDisclosure === null ? null : (
        <p className="warning" role="alert">
          <strong>Preparation ambiguity.</strong> {props.snapshot.gates.preparationDisclosure}
        </p>
      )}
      {producerAmbiguity.length > 0 ? (
        <p className="warning" role="alert">
          <strong>Producer ambiguity disclosure.</strong>{" "}
          {producerAmbiguity.join(" ")} Retained even when the post-crop alignment report
          appears unique.
        </p>
      ) : null}
      {props.snapshot.gates.reasons.length > 0 ? (
        <ul className="gate-reasons">
          {props.snapshot.gates.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
      <details>
        <summary>Statistics and gate evidence</summary>
        <dl className="facts">
          <dt>Provisional arithmetic</dt>
          <dd>
            one-tailed p = {stats.pValue.toFixed(6)} · strict p &lt; alpha · CI{" "}
            [{stats.abilityCi95[0].toFixed(4)}, {stats.abilityCi95[1].toFixed(4)}] · ability{" "}
            {stats.ability === null ? "null" : stats.ability}
          </dd>
          <dt>Raw significance</dt>
          <dd>
            {String(stats.significant)} (never a result on its own; final verdict{" "}
            {String(stats.significantVerdict)}, final completed run{" "}
            {String(stats.isFinal)})
          </dd>
          <dt>Completion</dt>
          <dd>{formatPct(stats.scoredTrials / Math.max(1, stats.plannedTrials ?? 1))} of planned N</dd>
          {props.snapshot.gates.preparationReason === null ? null : (
            <>
              <dt>Preparation reason</dt>
              <dd>{props.snapshot.gates.preparationReason}</dd>
            </>
          )}
        </dl>
        <p className="hint">
          Calibration is excluded from scored N. The final verdict requires completion at the
          pre-registered N and all gates; a sealed run is not a final result.
        </p>
      </details>
    </section>
  );
}

export function PlaybackFacts(props: {
  readonly playback: PlaybackSnapshot | null;
}): JSX.Element {
  const playback = props.playback;
  return (
    <details className="playback-facts">
      <summary>Playback route and guarantees</summary>
      <dl className="facts">
        <dt>Delivered rate</dt>
        <dd>{rateText(playback?.deliveredSampleRate ?? null)}</dd>
        <dt>Actual output rate</dt>
        <dd>{rateText(playback?.outputSampleRate ?? null)}</dd>
        <dt>Delivery channels</dt>
        <dd>{playback?.channels === 1 ? "mono" : playback?.channels === 2 ? "stereo" : "unknown"}</dd>
        <dt>Loop</dt>
        <dd>
          {playback?.loop.enabled
            ? `${playback.loop.startSeconds.toFixed(3)} s – ${playback.loop.endSeconds.toFixed(3)} s`
            : "off"}
        </dd>
      </dl>
      <p className="hint">
        First trial starts paused. A/B/X are display labels; the page never remaps them.
        Web Audio may resample at the actual output. This page does not promise bit-perfect,
        exclusive, gapless or device-identical output; Bluetooth/OS processing may intervene.
      </p>
    </details>
  );
}

export function RunRecord(props: {
  readonly snapshot: ExperimentSnapshot;
  readonly artifact: PreparedArtifact | null;
  readonly playback: PlaybackSnapshot | null;
}): JSX.Element {
  return (
    <section className="run-record" aria-labelledby="run-record-heading">
      <div className="section-head">
        <h2 id="run-record-heading">Run record</h2>
        <p className="section-meta">
          <strong>{props.snapshot.lifecycle}</strong>
          {props.snapshot.lifecycle === "sealed"
            ? " · sealed, not a final result"
            : props.snapshot.lifecycle === "void"
              ? " · void, no verdict"
              : null}
        </p>
      </div>
      <PlanSummary snapshot={props.snapshot} />
      <StatsPanel snapshot={props.snapshot} artifact={props.artifact} />
      <PlaybackFacts playback={props.playback} />
    </section>
  );
}
