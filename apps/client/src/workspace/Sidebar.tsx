import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";

import type { PlaybackOutputState } from "@codec-abx/contracts";

import { OutputDevicePanel } from "./OutputDevicePanel.js";

export interface PlanFormFields {
  readonly plannedTrials: string;
  readonly alpha: string;
  readonly labelMode: "fixed" | "blind_random";
}

export interface SidebarProps {
  readonly desktop: boolean;
  readonly sourceName: string | null;
  readonly sourceSize: string | null;
  readonly sourceDisabled: boolean;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onSelectFile: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onChooseDesktopSource: () => void;
  readonly output: PlaybackOutputState | undefined;
  readonly outputLocked: boolean;
  readonly outputBusy: boolean;
  readonly onRefreshOutput: () => void;
  readonly onSelectOutput: (deviceId: string) => void;
  readonly onRequestOutput: () => void;
  readonly planFields: PlanFormFields;
  readonly planDisabled: boolean;
  readonly planLocked: boolean;
  readonly planDirty: boolean;
  readonly planValid: boolean;
  readonly planError: string | null;
  readonly canApplyPlan: boolean;
  readonly onApplyPlan: () => void;
  readonly onPlanChange: (patch: Partial<PlanFormFields>) => void;
  readonly calibrationEnabled: boolean;
  readonly calibrationDisabled: boolean;
  readonly onCalibrationChange: (enabled: boolean) => void;
  readonly listeningLocked: boolean;
  readonly runConfigured: boolean;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
}

function HelpPopover(props: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div
      className="side-help"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        ref.current?.focus();
      }}
    >
      <button type="button" ref={ref} aria-label={props.label}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        About
      </button>
      {open ? <div className="help-panel" id={id}>{props.children}</div> : null}
    </div>
  );
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const labelMode = props.planFields.labelMode === "blind_random" ? "Randomized" : "Fixed";
  return (
    <aside className="sidebar" id="session-sidebar" aria-label="Session setup">
      <button type="button" className="mobile-setup sidebar-close" onClick={props.onClose}>
        Close setup
      </button>
      <section className="side-group" aria-labelledby="source-heading">
        <div className="side-head">
          <h2 id="source-heading" className="side-title">Source</h2>
        </div>
        <div className="source-picker">
          {props.desktop ? (
            <button
              type="button"
              className="file-picker primary"
              disabled={props.sourceDisabled}
              onClick={props.onChooseDesktopSource}
            >
              Choose local audio…
            </button>
          ) : (
            <input
              id="source-file"
              ref={props.fileInputRef}
              aria-label="Audio file"
              type="file"
              accept=".wav,.flac,.mp3,.m4a,.mp4,.aac,.ogg,.oga,.opus,audio/wav,audio/flac,audio/x-flac,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/opus"
              aria-describedby="source-limit-line"
              disabled={props.sourceDisabled}
              onChange={props.onSelectFile}
            />
          )}
        </div>
        {props.sourceName !== null ? (
          <p className="file-summary" aria-live="polite">
            {props.sourceName}{props.sourceSize === null ? "" : ` · ${props.sourceSize}`}
          </p>
        ) : null}
        <p className="side-note" id="source-limit-line">
          Up to 30 min · 512 MiB · 32-bit input
        </p>
        <details className="source-limits">
          <summary>Formats and limits</summary>
          <p className="side-note">
            WAV, FLAC, MP3, AAC, M4A, Ogg and Opus.
          </p>
        </details>
      </section>

      <OutputDevicePanel
        output={props.output}
        locked={props.outputLocked}
        busy={props.outputBusy}
        onRefresh={props.onRefreshOutput}
        onSelect={props.onSelectOutput}
        onRequest={props.onRequestOutput}
      />

      <section className="side-group" aria-labelledby="plan-heading">
        <div className="side-head">
          <h2 id="plan-heading" className="side-title">Test plan</h2>
          <span className="side-meta">
            {props.planLocked ? "Locked" : "Not locked"}
          </span>
        </div>
        <dl className="plan-lines">
          <dt>Scored trials</dt>
          <dd>{props.planFields.plannedTrials}</dd>
          <dt>Labels</dt>
          <dd>{labelMode}</dd>
          <dt>Alpha</dt>
          <dd>{props.planFields.alpha}</dd>
          <dt>Readiness</dt>
          <dd>{props.calibrationEnabled ? "On" : "Off"}</dd>
        </dl>
        <details className="listening-test-plan">
          <summary>Edit plan</summary>
          <div className="plan-fields">
            <div className="plan-field">
              <label htmlFor="plan-trials">Planned scored trials N (1–1000)</label>
              <input
                id="plan-trials"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={props.planFields.plannedTrials}
                disabled={props.planDisabled}
                onChange={(event) => props.onPlanChange({ plannedTrials: event.target.value })}
              />
            </div>
            <div className="plan-field">
              <label htmlFor="plan-alpha">Alpha (strict p &lt; alpha)</label>
              <input
                id="plan-alpha"
                type="number"
                min={0.001}
                max={0.999}
                step={0.001}
                value={props.planFields.alpha}
                disabled={props.planDisabled}
                onChange={(event) => props.onPlanChange({ alpha: event.target.value })}
              />
            </div>
            <div className="plan-field">
              <label htmlFor="plan-label-mode">Label mode</label>
              <select
                id="plan-label-mode"
                value={props.planFields.labelMode}
                disabled={props.planDisabled}
                onChange={(event) => props.onPlanChange({
                  labelMode: event.target.value as "fixed" | "blind_random",
                })}
              >
                <option value="blind_random">blind_random (actual per-trial swap)</option>
                <option value="fixed">fixed display order</option>
              </select>
            </div>
          </div>
          <p className="field-note">
            The plan locks at the first staged trial. Calibration is excluded
            from scored N.
          </p>
        </details>
        <div className="readiness">
          <label htmlFor="canary-enabled" className="calibration-optin">
            <input
              id="canary-enabled"
              aria-label="Calibration readiness check (first 10 s of prepared Side A)"
              type="checkbox"
              checked={props.calibrationEnabled}
              disabled={props.calibrationDisabled}
              onChange={(event) => props.onCalibrationChange(event.target.checked)}
            />{" "}
            Readiness check
          </label>
          <HelpPopover label="About the readiness check">
            Optional calibration using exactly the first min(10 s, prepared
            Side A). It must pass before scored trials, is excluded from N, and
            scored trials keep the full prepared track. Off creates no
            calibration material.
          </HelpPopover>
        </div>
        {props.planError ? (
          <p className="status-error" role="alert">{props.planError}</p>
        ) : null}
        {props.planValid ? null : (
          <p className="status-error" role="alert">
            The plan has invalid fields. Review N and alpha before preparing.
          </p>
        )}
        {props.runConfigured ? (
          <button
            type="button"
            className="secondary side-action"
            disabled={!props.canApplyPlan}
            onClick={props.onApplyPlan}
          >
            Apply plan and re-check gates
          </button>
        ) : null}
        {props.runConfigured && props.planDirty ? (
          <p className="side-note">The edits differ from the verified plan.</p>
        ) : null}
      </section>

      {props.listeningLocked || props.footer !== undefined ? (
        <div className="side-foot">
          {props.listeningLocked ? (
            <p className="side-note" role="note">
              Source, chains and plan are locked during a test.
            </p>
          ) : null}
          {props.footer}
        </div>
      ) : null}
    </aside>
  );
}
