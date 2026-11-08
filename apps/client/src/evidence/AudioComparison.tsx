import type { EvidenceDetailsState, EvidenceDetailsChange } from "./details";
import type { JSX, RefCallback } from "react";
import type {
  CanarySide,
  LevelMeasurement,
  PreparedArtifact,
  Side,
} from "@codec-abx/contracts";
import { codecLabel } from "../codecs";
import { formatDuration } from "../diagnostics";

function formatLevel(
  level: LevelMeasurement,
  unit: string,
  meanings: { readonly negative: string; readonly missing: string },
): string {
  switch (level.status) {
    case "finite":
      return `${level.value.toFixed(2)} ${unit}`;
    case "negative-infinity":
      return `−∞ ${unit} — ${meanings.negative}`;
    case "undefined":
      return `undefined — ${meanings.missing} (${level.reason})`;
    case "unavailable":
      return `unavailable — ${level.reason}`;
  }
}

const LOUDNESS_MEANINGS = {
  negative: "digital silence or below the absolute loudness gate",
  missing: "no finite integrated level",
} as const;

const PEAK_MEANINGS = {
  negative: "digital silence",
  missing: "no defined peak",
} as const;

const NULL_MEANINGS = {
  negative: "exact digital null",
  missing: "silent reference; the ratio is not defined",
} as const;

const DELTA_MEANINGS = {
  negative: "an exact level difference is not a finite dB delta",
  missing: "at least one side has no finite integrated level",
} as const;

function TrackCard(props: {
  readonly side: Side;
  readonly artifact: PreparedArtifact;
  readonly actionsDisabled: boolean;
  readonly onLoadSample: (side: Side) => void;
  readonly onDownloadWav: (side: Side) => void;
}): JSX.Element {
  const track = props.side === "a" ? props.artifact.a : props.artifact.b;
  const delivered = track.delivered;
  const duration =
    delivered.sampleRate > 0 ? delivered.frames / delivered.sampleRate : 0;
  return (
    <article
      className="track-card"
      aria-label={`Delivered side ${props.side.toUpperCase()}`}
    >
      <header className="track-head">
        <h3>Side {props.side.toUpperCase()}</h3>
        <span className="track-codec">
          {codecLabel(track.requested.codecId)}
          {track.requested.codecId === "noop_passthrough"
            ? ""
            : ` · ${track.requested.bitrateKbps} kbps`}
        </span>
      </header>
      <dl className="facts track-facts">
        <dt>Delivered</dt>
        <dd>
          {delivered.sampleRate} Hz ·{" "}
          {delivered.channels === 1 ? "mono" : "stereo"} ·{" "}
          {formatDuration(duration)}
        </dd>
      </dl>
      <div className="track-actions">
        <button
          type="button"
          disabled={props.actionsDisabled}
          onClick={() => props.onLoadSample(props.side)}
        >
          Preview {props.side.toUpperCase()}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={props.actionsDisabled}
          onClick={() => props.onDownloadWav(props.side)}
        >
          Download WAV {props.side.toUpperCase()}
        </button>
      </div>
    </article>
  );
}

function CanaryMaterialPanel(props: {
  readonly artifact: PreparedArtifact;
  readonly actionsDisabled: boolean;
  readonly detailsState: EvidenceDetailsState;
  readonly onDetailsChange: EvidenceDetailsChange;
  readonly onLoad: (side: CanarySide) => void;
  readonly onDownload: (side: CanarySide) => void;
}): JSX.Element | null {
  const canary = props.artifact.canary;
  if (!canary) return null;
  const report = canary.report;
  return (
    <section className="canary" aria-labelledby="canary-heading">
      <div className="gate-line">
        <h3 id="canary-heading">
          Diagnostic canary material · <code>{report.policy}</code>
        </h3>
        <p className="section-meta">
          <strong>{report.status}</strong> · usable{" "}
          <code>{String(report.usable)}</code>
        </p>
      </div>
      {canary.audio ? (
        <div className="track-actions canary-actions">
          {(["pristine", "degraded"] as const).map((side) => (
            <span key={side} className="action-pair">
              <button
                type="button"
                disabled={props.actionsDisabled}
                onClick={() => props.onLoad(side)}
              >
                Load canary sample {side}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={props.actionsDisabled}
                onClick={() => props.onDownload(side)}
              >
                Download canary WAV {side}
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="warning" role="alert">
          <strong>No canary bytes retained or served.</strong> The material
          check did not pass, so this artifact keeps only the measured report.
          Nothing was silently substituted.
        </p>
      )}
      <details
        open={props.detailsState.canary}
        onToggle={(event) =>
          props.onDetailsChange("canary", event.currentTarget.open)
        }
      >
        <summary>Canary evidence and notes</summary>
        <p className="hint">
          A measured, deliberately easy material check on the final delivered
          Side A. It is not proof of human audibility, a listener calibration
          trial or a scored ABX result. No listener canary gate is implemented.
        </p>
        <dl className="facts">
          <dt>Minimum residual</dt>
          <dd>{report.minimumResidualDb} dB (strictly greater is usable)</dd>
          <dt>Measured residual</dt>
          <dd>{formatLevel(report.depthDb, "dB", NULL_MEANINGS)}</dd>
          <dt>Reason</dt>
          <dd>{report.reason}</dd>
          <dt>Frozen material facts</dt>
          <dd>
            cutoff {report.cutoffHz} Hz · grid{" "}
            <code>{report.frequencyGrid}</code> · drive {report.drive}× · clip ±
            {report.clipLevel}
          </dd>
          <dt>Layout</dt>
          <dd>
            {report.sampleRate} Hz · {report.channels === 1 ? "mono" : "stereo"}{" "}
            · {report.frames} frames
          </dd>
          {canary.audio ? (
            <>
              <dt>Pristine WAV SHA-256</dt>
              <dd>
                <code>{canary.audio.pristine.wavSha256}</code>
              </dd>
              <dt>Degraded WAV SHA-256</dt>
              <dd>
                <code>{canary.audio.degraded.wavSha256}</code>
              </dd>
            </>
          ) : null}
        </dl>
        <ul>
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

type SampleSide = Side | CanarySide;

interface AudioComparisonProps {
  readonly artifact: PreparedArtifact;
  readonly actionsDisabled: boolean;
  readonly listeningLocksLab: boolean;
  readonly audioBlocked: boolean;
  readonly exportDisabled: boolean;
  readonly detailsState: EvidenceDetailsState;
  readonly onDetailsChange: EvidenceDetailsChange;
  readonly resetting: boolean;
  readonly samples: Readonly<Record<SampleSide, string | null>>;
  readonly audioRefs: Readonly<
    Record<SampleSide, RefCallback<HTMLAudioElement>>
  >;
  readonly onLoadSample: (side: Side) => void;
  readonly onDownloadWav: (side: Side) => void;
  readonly onLoadCanary: (side: CanarySide) => void;
  readonly onDownloadCanary: (side: CanarySide) => void;
  readonly onDownloadResults: () => void;
  readonly onClear: () => void;
}

export function AudioComparison({
  artifact,
  actionsDisabled,
  listeningLocksLab,
  resetting,
  audioBlocked,
  exportDisabled,
  detailsState,
  onDetailsChange,
  samples,
  audioRefs,
  onLoadSample,
  onDownloadWav,
  onLoadCanary,
  onDownloadCanary,
  onDownloadResults,
  onClear,
}: AudioComparisonProps): JSX.Element {
  const delivered = artifact.measurements.delivered;
  return (
    <section className="evidence-audio" aria-labelledby="results-heading">
      <h2 id="results-heading">Audio comparison</h2>
      <div className="tracks delivered-grid">
        {(["a", "b"] as const).map((side) => (
          <TrackCard
            key={side}
            side={side}
            artifact={artifact}
            actionsDisabled={actionsDisabled}
            onLoadSample={onLoadSample}
            onDownloadWav={onDownloadWav}
          />
        ))}
      </div>
      {delivered ? (
        <details
          className="measurements"
          open={detailsState.measurements}
          onToggle={(event) =>
            onDetailsChange("measurements", event.currentTarget.open)
          }
        >
          <summary>Audio measurements</summary>
          <dl className="facts">
            <dt>Side A loudness</dt>
            <dd>
              {formatLevel(
                delivered.a.integratedLufs,
                "LUFS",
                LOUDNESS_MEANINGS,
              )}
            </dd>
            <dt>Side B loudness</dt>
            <dd>
              {formatLevel(
                delivered.b.integratedLufs,
                "LUFS",
                LOUDNESS_MEANINGS,
              )}
            </dd>
            <dt>Loudness difference</dt>
            <dd>
              {formatLevel(delivered.loudnessDeltaDb, "dB", DELTA_MEANINGS)}
            </dd>
            <dt>Side A peak</dt>
            <dd>
              {formatLevel(delivered.a.samplePeakDbfs, "dBFS", PEAK_MEANINGS)}
            </dd>
            <dt>Side B peak</dt>
            <dd>
              {formatLevel(delivered.b.samplePeakDbfs, "dBFS", PEAK_MEANINGS)}
            </dd>
            <dt>Timing difference</dt>
            <dd>
              {delivered.alignment.status === "estimated"
                ? `${delivered.alignment.lagSamples} samples`
                : "Unavailable"}
            </dd>
            <dt>Null depth</dt>
            <dd>
              {formatLevel(delivered.nullDepth.depthDb, "dB", NULL_MEANINGS)}
            </dd>
          </dl>
        </details>
      ) : null}
      {!audioBlocked && Object.values(samples).some(Boolean) && (
        <div className="diagnostic-audio">
          {(["a", "b", "pristine", "degraded"] as const).map((side) =>
            samples[side] ? (
              <audio
                key={side}
                ref={audioRefs[side]}
                controls
                preload="metadata"
                src={samples[side]}
                aria-label={`Preview ${side.toUpperCase()}`}
              />
            ) : null,
          )}
        </div>
      )}
      <details
        open={detailsState.files}
        onToggle={(event) => onDetailsChange("files", event.currentTarget.open)}
      >
        <summary>Files and diagnostics</summary>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={exportDisabled}
            onClick={onDownloadResults}
          >
            Download results
          </button>
          <button
            type="button"
            className="secondary"
            disabled={resetting || listeningLocksLab}
            onClick={onClear}
          >
            Clear prepared audio
          </button>
        </div>
        <CanaryMaterialPanel
          artifact={artifact}
          actionsDisabled={actionsDisabled}
          detailsState={detailsState}
          onDetailsChange={onDetailsChange}
          onLoad={onLoadCanary}
          onDownload={onDownloadCanary}
        />
      </details>
    </section>
  );
}
