import {
  useEffect,
  useId,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import type {
  PlaybackLabel,
  PreparedArtifact,
} from "@codec-abx/contracts";

import { deviceLabel } from "../workspace/OutputDevicePanel.js";
import type { ClientRuntimeKind } from "../runtime.js";
import type { ListeningReaders } from "./controller.js";
import type { ListeningHook } from "./useListening.js";
import {
  calibrationMaterialAdvice,
  isRawCodecProbeArtifact,
  listeningArtifactEligibility,
} from "./model.js";
import { trialStartGateBlocker } from "./readiness.js";

function formatClock(value: number): string {
  const seconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function artifactRuntime(
  artifact: PreparedArtifact | null,
  fallback: ClientRuntimeKind,
): {
  readonly native: boolean;
  readonly preparation: string;
  readonly experiment: string;
  readonly local: string;
} {
  const native = artifact === null
    ? fallback === "desktop"
    : artifact.engine.location === "desktop-native";
  return native
    ? {
        native: true,
        preparation: "desktop-native shared aligned-gain-matched-v1 prepared via the Electron main process’s private worker",
        experiment: "main-process private-worker experiment service",
        local: "desktop-native local self-test",
      }
    : {
        native: false,
        preparation: "browser-local shared aligned-gain-matched-v1",
        experiment: "dedicated experiment Worker",
        local: "browser-local local self-test",
      };
}

export type ListeningPrimaryPhase =
  | "idle"
  | "preparing"
  | "binding"
  | "staging"
  | "ready"
  | "cancelled"
  | "error";

export interface ListeningPrimary {
  readonly phase: ListeningPrimaryPhase;
  /** Preparation, binding or staging currently owns the primary action. */
  readonly busy: boolean;
  readonly message: string | null;
  readonly progressMessage: string | null;
  readonly error: string | null;
  readonly canPrepare: boolean;
  readonly blockedReason: string | null;
  /** The retained artifact matches the current source, codecs, rate and opt-in. */
  readonly pairReady: boolean;
  readonly onPrepare: () => void;
  readonly onCancel: () => Promise<void>;
}

export interface ListeningPlanState {
  readonly valid: boolean;
  readonly dirty: boolean;
  readonly onDisableCalibration: () => void;
}

export interface ListeningSectionProps {
  readonly artifact: PreparedArtifact | null;
  readonly listening: ListeningHook;
  readonly runtimeKind: ClientRuntimeKind;
  readonly primary: ListeningPrimary;
  readonly plan?: ListeningPlanState;
  readonly runActions?: ReactNode;
  readonly onEnd?: () => void;
  readonly onOpenEvidence?: () => void;
  /** Legacy/injected reader slot retained for existing callers; the sidebar owns plan submission. */
  readonly readers?: ListeningReaders | null;
  readonly calibrationEnabled?: boolean;
  readonly onCalibrationChange?: (enabled: boolean) => void;
}

const DEFAULT_PLAN_STATE: ListeningPlanState = {
  valid: true,
  dirty: false,
  onDisableCalibration: () => {},
};

export function ListeningSection(props: ListeningSectionProps): JSX.Element {
  const { artifact, listening, primary } = props;
  const plan = props.plan ?? DEFAULT_PLAN_STATE;
  const onEnd = props.onEnd ?? (() => {});
  const onOpenEvidence = props.onOpenEvidence ?? (() => {});
  const { controller, state } = listening;
  const ids = useId();
  const [loopError, setLoopError] = useState<string | null>(null);
  const [loopStart, setLoopStart] = useState("0");
  const [loopEnd, setLoopEnd] = useState("0");
  const [lastFeedback, setLastFeedback] = useState<typeof state.feedback>(null);

  const eligibility = listeningArtifactEligibility(artifact);
  const rawArtifact = isRawCodecProbeArtifact(artifact);
  const runtime = artifactRuntime(artifact, props.runtimeKind);
  const playback = state.playback;
  const output = playback?.output;
  const trial = state.trial;
  const snapshot = state.snapshot;
  const busy = state.busy !== null;
  const planLocked = state.planLocked;
  const selectionRequired = playback?.selectionRequired === true;
  const carryingPrevious = playback?.carryingPreviousTrial === true;
  const selected = selectionRequired ? null : playback?.selected ?? null;
  const advice = artifact ? calibrationMaterialAdvice(artifact) : null;
  const feedback = state.feedback ?? lastFeedback;

  useEffect(() => {
    if (state.feedback !== null) {
      setLastFeedback(state.feedback);
      return;
    }
    if (state.trial === null) setLastFeedback(null);
  }, [state.feedback, state.trial]);

  useEffect(() => {
    if (playback === null) return;
    setLoopStart(String(playback.loop.startSeconds));
    setLoopEnd(
      String(playback.loop.endSeconds > playback.loop.startSeconds
        ? playback.loop.endSeconds
        : playback.durationSeconds),
    );
  }, [trial?.token, playback === null ? null : playback.durationSeconds]);

  const playbackReady = playback !== null && playback.phase === "ready";
  const outputPending = playback?.output?.pending != null;
  const controlsEnabled = playbackReady && !state.answered && state.busy === null &&
    state.pendingAnswer === null && !state.outputBlocked && !outputPending &&
    snapshot?.lifecycle === "running";
  const playEnabled = controlsEnabled && !selectionRequired && playback?.playing !== true;
  const pauseEnabled = playback?.playing === true && !state.outputBlocked;
  const answerEnabled = controlsEnabled && !selectionRequired && trial !== null &&
    playback?.trial?.token === trial.token && playback.trial.runId === trial.runId;
  const terminal = state.session === "completed" || state.session === "sealed" ||
    state.session === "void";
  const canNext = state.answered && snapshot?.lifecycle === "running" &&
    state.busy === null && !state.outputBlocked && !outputPending;
  const calibrationBlocked = snapshot?.plan.calibrationEnabled === true &&
    snapshot.gates.calibrationStatus === "unavailable";

  const stageLoading = primary.busy || state.session === "configuring" ||
    state.session === "closing" || state.busy === "start" || state.busy === "reset" ||
    state.busy === "next";
  const stageState: "idle" | "loading" | "ready" = stageLoading
    ? "loading"
    : trial !== null && !terminal
      ? "ready"
      : "idle";
  const stageTitle = terminal
    ? "Run ended"
    : primary.phase === "cancelled"
      ? "Test preparation cancelled"
      : primary.phase === "error"
        ? "Test setup stopped"
        : stageLoading
          ? primary.phase === "preparing"
            ? "Preparing test…"
            : primary.phase === "binding"
              ? "Verifying prepared pair…"
              : primary.phase === "staging"
                ? "Loading trial 1…"
                : state.busy === "next"
                  ? "Loading next trial…"
                  : state.busy === "reset"
                    ? "Resetting run…"
                    : "Loading audio…"
          : trial !== null
            ? playback?.playing === true ? "Playing" : "Paused"
            : state.session === "configured"
              ? "Ready"
              : "Ready to listen";
  const stageDetail = terminal
    ? snapshot === null
      ? "No run state is available."
      : snapshot.lifecycle === "completed"
        ? "All answers recorded."
        : snapshot.lifecycle === "sealed"
          ? "Sealed, not a final result."
          : "Void; no scored verdict."
    : carryingPrevious
      ? "Previous trial audio"
      : selectionRequired
        ? "Choose A, B or X"
        : trial !== null && selected !== null
          ? playback?.playing === true ? `Listening to ${selected}` : `Selected ${selected}`
          : null;
  const startBlocker = snapshot === null ? null : trialStartGateBlocker(snapshot, artifact);
  const stagePlaceholder = primary.phase === "cancelled"
    ? primary.message ?? "Test preparation was cancelled. No trial was staged."
    : primary.phase === "error"
      ? primary.message ?? "Test setup stopped before staging. Review the error above."
      : state.session === "configured"
        ? startBlocker === null
          ? "No trial is staged. Start trial 1 paused when you are ready."
          : "No trial is staged. Review the gate status before starting."
        : terminal
          ? "This run is terminal."
          : primary.pairReady
            ? "Prepared pair ready. Prepare test stages trial 1 paused."
            : artifact !== null && eligibility === null
              ? "Inputs changed since the last preparation. Prepare test makes a matching pair."
              : "Prepare the test to load trial 1.";
  const canStart = state.session === "configured" && snapshot !== null &&
    !busy && !planLocked && !plan.dirty && !outputPending && !state.outputBlocked &&
    plan.valid && startBlocker === null &&
    state.error?.retry !== "prepare";
  const inlineStartBlocker = state.session === "configured" && state.error === null &&
      startBlocker !== null && startBlocker.code !== "artifact-unbound" &&
      startBlocker.code !== "calibration-unavailable"
    ? startBlocker.message
    : null;
  const runActive = snapshot !== null &&
    (snapshot.lifecycle === "running" || snapshot.lifecycle === "configured") &&
    (state.session === "running" || state.session === "configured");
  const heading = terminal
    ? snapshot?.lifecycle === "completed" ? "Test complete" : "Test ended"
    : primary.phase === "preparing" || primary.phase === "binding" || primary.phase === "staging"
      ? "Preparing test"
      : primary.phase === "cancelled"
        ? "Test preparation cancelled"
        : primary.phase === "error"
          ? "Test setup stopped"
          : trial !== null
            ? `Trial ${trial.trialIndex} of ${snapshot?.plan.plannedTrials ?? "practice"}`
            : "Listen";
  const subline = trial !== null && !terminal
    ? trial.kind === "calibration" ? "Calibration · excluded from N" : "Scored trial"
    : terminal
      ? snapshot?.lifecycle === "completed"
        ? "Final only if every gate held"
        : "Not a final result"
      : primary.busy
        ? "Preparing test"
        : state.session === "configured"
          ? "Start paused"
          : "Prepare test first";
  const plannedTrials = snapshot?.plan.plannedTrials ?? null;
  const scoredTrials = snapshot?.statistics.scoredTrials ?? 0;
  const showStagePlaceholder = !terminal && trial === null && (
    !stageLoading || primary.phase === "error" || primary.phase === "cancelled" ||
    state.session === "configured"
  );

  const applyLoop = (enabled: boolean): void => {
    if (playback === null) return;
    const start = Number(loopStart);
    const end = Number(loopEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 ||
        end > playback.durationSeconds || end - start < 0.01) {
      setLoopError("Loop needs finite bounds inside the clip with at least 10 ms between start and end.");
      return;
    }
    setLoopError(null);
    controller.setLoop({ enabled, startSeconds: start, endSeconds: end });
  };

  const toggleLoop = (): void => {
    applyLoop(playback?.loop.enabled !== true);
  };

  return (
    <section className="listen-content listening" data-session={state.session}
      aria-labelledby="listening-heading">
      <header className="view-head listen-head">
        <div className="listen-heading">
          <h1 id="listening-heading">{heading}</h1>
          {subline === null ? null : <p className="subline">{subline}</p>}
          <div className="trial-progress">
            <progress
              aria-label="Trials completed"
              max={plannedTrials === null || plannedTrials <= 0 ? 1 : plannedTrials}
              value={plannedTrials === null || plannedTrials <= 0
                ? 0
                : Math.min(scoredTrials, plannedTrials)}
            />
            <span>
              {plannedTrials === null || plannedTrials <= 0
                ? primary.busy ? "Preparing" : "No trial staged"
                : `${scoredTrials} of ${plannedTrials} scored`}
            </span>
          </div>
        </div>
        <div className="view-actions">
          {primary.busy ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void primary.onCancel()}
            >
              Cancel preparation
            </button>
          ) : null}
          {runActive && !primary.busy ? (
            <button
              type="button"
              className="secondary end-test"
              onClick={onEnd}
            >
              End test
            </button>
          ) : null}
          {terminal ? (
            <button type="button" className="secondary" onClick={onOpenEvidence}>
              View results
            </button>
          ) : null}
        </div>
      </header>

      {state.session === "idle" && artifact !== null && eligibility !== null ? (
        <p className="warning" role="alert">
          <strong>{rawArtifact ? "Prepared for diagnostics." : "Listening refused."}</strong>{" "}
          {eligibility}
          {rawArtifact
            ? " Prepare test replaces this diagnostic artifact with an aligned pair; the current artifact is released when the new preparation starts."
            : ""}
        </p>
      ) : null}
      {state.outputBlocked ? (
        <div className="status-error" role="alert">
          <strong>Output route changed after the plan locked.</strong> Playback was paused and
          Play, trial changes and answers are blocked. No fallback device or automatic resume is
          used, and the existing calibration cannot be assumed valid. Reset the run explicitly
          before continuing.
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void controller.reset()}
            >
              Reset listening run to recover
            </button>
          </div>
        </div>
      ) : null}

      {calibrationBlocked ? (
        <div className="warning" role="alert">
          <strong>Calibration is requested but unavailable.</strong>{" "}
          {advice ?? "The bound canary material or reader is unavailable."} Start is blocked.
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || planLocked}
              onClick={plan.onDisableCalibration}
            >
              Disable calibration explicitly for this plan
            </button>
          </div>
        </div>
      ) : null}

      <div className="listen-layout">
        <section className="listening-stage" data-state={stageState} aria-labelledby={ids + "-stage"}>
          <h2 className="sr-only" id={ids + "-stage"}>Listening controls</h2>
          <article
            className={trial !== null && !terminal ? "listening-trial" : "listening-stage-body"}
            {...(trial !== null && !terminal ? {
              "data-token": trial.token,
              "data-kind": trial.kind,
            } : {})}
          >
            <div className="stage-status" role="status" aria-live="polite">
              <strong>{stageTitle}</strong>
              {stageDetail === null ? null : <span>{stageDetail}</span>}
              {stageState === "loading" ? (
                <progress
                  className="stage-progress"
                  aria-label="Test preparation progress"
                  max={1}
                  value={undefined}
                />
              ) : null}
            </div>
            {showStagePlaceholder ? (
              <div className="listening-stage-placeholder">
                <p>{stagePlaceholder}</p>
                {primary.phase === "error" || primary.phase === "cancelled" ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={!primary.canPrepare || primary.busy}
                    onClick={primary.onPrepare}
                  >
                    Retry prepare test
                  </button>
                ) : null}
                {state.session === "configured" && !terminal ? (
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={!canStart}
                      aria-describedby={inlineStartBlocker === null ? undefined : "trial-start-blocker"}
                      onClick={() => void controller.start()}
                    >
                      Start trial 1 (paused)
                    </button>
                  </div>
                ) : null}
                {inlineStartBlocker === null ? null : (
                  <p id="trial-start-blocker" className="field-note" role="status">
                    {inlineStartBlocker}
                  </p>
                )}
              </div>
            ) : null}

            <div className="listening-transport">
              <div className="transport-row">
                <button
                  type="button"
                  className="primary transport-toggle"
                  aria-label={playback?.playing === true ? "Pause" : "Play"}
                  disabled={playback?.playing === true ? !pauseEnabled : !playEnabled}
                  onClick={() => {
                    if (playback?.playing === true) controller.pause();
                    else void controller.play();
                  }}
                >
                  {playback?.playing === true ? "Pause" : "Play"}
                </button>
                <span
                  className="time-readout"
                  data-duration-seconds={(playback?.durationSeconds ?? 0).toFixed(3)}
                >
                  {formatClock(playback?.positionSeconds ?? 0)} /{" "}
                  {formatClock(playback?.durationSeconds ?? 0)}
                  <span className="sr-only">
                    {" "}({(playback?.durationSeconds ?? 0).toFixed(3)} s)
                  </span>
                </span>
              </div>
              <label className="sr-only" htmlFor={`${ids}-position`}>
                Shared timeline position
              </label>
              <input
                id={`${ids}-position`}
                className="timeline"
                type="range"
                min={0}
                max={Math.max(0.001, playback?.durationSeconds ?? 0)}
                step={0.001}
                value={Math.min(playback?.positionSeconds ?? 0, playback?.durationSeconds ?? 0)}
                disabled={!controlsEnabled}
                onChange={(event) => controller.seek(Number(event.target.value))}
              />
              <div className="label-select" role="group" aria-label="Playback label selection">
                {(["A", "B", "X"] as const).map((label: PlaybackLabel) => (
                  <button
                    key={label}
                    type="button"
                    className={selected === label ? "selected" : "secondary"}
                    aria-pressed={selected === label}
                    aria-label={`Monitor playback label ${label}`}
                    disabled={!controlsEnabled}
                    onClick={() => controller.select(label)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="loop-row">
                <button
                  type="button"
                  className="secondary loop-toggle"
                  aria-pressed={playback?.loop.enabled === true}
                  aria-label={playback?.loop.enabled === true ? "Disable loop" : "Enable loop"}
                  disabled={!controlsEnabled}
                  onClick={toggleLoop}
                >
                  {playback?.loop.enabled === true ? "Loop on" : "Loop off"}
                </button>
                {playback?.loop.enabled === true ? (
                  <div className="loop-edit">
                    <label>
                      From
                      <input
                        aria-label="Loop start (s)"
                        type="number"
                        min={0}
                        step={0.01}
                        value={loopStart}
                        disabled={!controlsEnabled}
                        onChange={(event) => setLoopStart(event.target.value)}
                      />
                    </label>
                    <label>
                      to
                      <input
                        aria-label="Loop end (s)"
                        type="number"
                        min={0}
                        step={0.01}
                        value={loopEnd}
                        disabled={!controlsEnabled}
                        onChange={(event) => setLoopEnd(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!controlsEnabled}
                      onClick={() => applyLoop(true)}
                    >
                      Apply loop range
                    </button>
                  </div>
                ) : null}
              </div>
              {loopError ? <p className="status-error" role="alert">{loopError}</p> : null}
            </div>

            {terminal && snapshot !== null ? (
              <div className={`terminal terminal-${snapshot.lifecycle}`} role="status">
                <h2>Terminal lifecycle: {snapshot.lifecycle}</h2>
                {snapshot.lifecycle === "completed" ? (
                  <p>
                    Reached the pre-registered N. Final verdict:{" "}
                    <strong>{String(snapshot.statistics.significantVerdict)}</strong>. This is only
                    a final result when all gates held; human listening validation was not performed.
                  </p>
                ) : snapshot.lifecycle === "sealed" ? (
                  <p>
                    Sealed before completion. This is auditable and exportable but is not a final
                    result; no further trials or answers are accepted.
                  </p>
                ) : (
                  <p>
                    Calibration failed or the run was voided. No scored verdict is claimed; the
                    terminal export reveals the answered run for audit.
                  </p>
                )}
                {feedback ? (
                  <p>
                    Last accepted answer: {feedback.answer} ·{" "}
                    {feedback.correct ? "correct" : "incorrect"} · trial{" "}
                    {feedback.trialIndex} ({feedback.kind}).
                  </p>
                ) : null}
              </div>
            ) : (
              <section className="listening-answer" aria-labelledby={`${ids}-answer`}>
                <div className="answer-title">
                  <h2 id={`${ids}-answer`}>Is X A or B?</h2>
                  {trial?.kind === "calibration" ? <span className="tag">Calibration</span> : null}
                </div>
                <div className="answer-buttons">
                  <button
                    type="button"
                    className="primary"
                    aria-label="Answer A"
                    disabled={!answerEnabled || state.answered}
                    onClick={() => void controller.answer("A")}
                  >
                    X is A
                  </button>
                  <button
                    type="button"
                    className="primary"
                    aria-label="Answer B"
                    disabled={!answerEnabled || state.answered}
                    onClick={() => void controller.answer("B")}
                  >
                    X is B
                  </button>
                </div>
                {feedback ? (
                  <p className="answer-status" role="status" aria-live="polite">
                    <strong>Answer {feedback.answer} accepted:</strong>{" "}
                    {feedback.correct ? "correct" : "incorrect"} for trial{" "}
                    {feedback.trialIndex} ({feedback.kind}).
                    {feedback.kind === "calibration"
                      ? feedback.correct ? " Calibration passed." : " Calibration failed."
                      : ""}
                  </p>
                ) : null}
                {state.error !== null && state.error.retry === "answer" ? (
                  <div className="status-error" role="alert">
                    <strong>Answer submission needs reconciliation.</strong>{" "}
                    {state.error.message}
                    {state.error.reasons.length > 0 ? (
                      <ul>{state.error.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    ) : null}
                    <div className="actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || state.pendingAnswer === null}
                        onClick={() => void controller.retryAnswer()}
                      >
                        Retry identical answer {state.pendingAnswer ?? ""}
                      </button>
                    </div>
                  </div>
                ) : null}
                {canNext ? (
                  <div className="actions">
                    <button
                      type="button"
                      className="secondary quiet"
                      disabled={!canNext}
                      onClick={() => void controller.next()}
                    >
                      Next trial
                    </button>
                  </div>
                ) : null}
              </section>
            )}
          </article>
        </section>

        {snapshot === null ? null : (
          <aside className="listen-context" aria-label="Session context">
            <section>
              <h2>Session</h2>
              <dl className="facts">
                <dt>Plan</dt>
                <dd>{snapshot.plan.plannedTrials ?? "practice"} trials · α {snapshot.plan.alpha}</dd>
                <dt>Labels</dt>
                <dd><code>{snapshot.plan.labelMode}</code></dd>
                <dt>Readiness</dt>
                <dd>{snapshot.plan.calibrationEnabled ? "ON (excluded from scored N)" : "explicitly OFF"}</dd>
                <dt>Preparation validity</dt>
                <dd><strong>{snapshot.gates.preparationStatus}</strong></dd>
                <dt>Calibration gate</dt>
                <dd><strong>{snapshot.gates.calibrationStatus}</strong></dd>
                <dt>Null gate</dt>
                <dd><strong>{snapshot.gates.nullStatus}</strong></dd>
                <dt>Output</dt>
                <dd>{deviceLabel(output, output?.selectedDeviceId ?? null)}</dd>
                <dt>Lifecycle</dt>
                <dd><strong>{snapshot.lifecycle}</strong></dd>
              </dl>
            </section>
          </aside>
        )}
      </div>

      {state.session === "fatal" ? (
        <div className="status-error" role="alert">
          <strong>This listening run is unavailable.</strong>{" "}
          {state.error?.message ?? `The ${runtime.experiment} failed.`} No export is claimed to exist
          for the lost run. Start a new run explicitly; the runtime is never recreated silently.
          <div className="actions">
            <button type="button" className="primary" onClick={() => void controller.closeSession()}>
              Discard unavailable run
            </button>
          </div>
        </div>
      ) : null}

      {state.error !== null && snapshot === null && state.session !== "fatal" ? (
        <div className="status-error" role="alert">
          <strong>Listening setup failed.</strong> {state.error.message}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || !artifact || eligibility !== null}
              onClick={primary.onPrepare}
            >
              Retry/check listening preparation
            </button>
            {state.session === "idle" ? null : (
              <button type="button" className="secondary" disabled={busy}
                onClick={() => void controller.closeSession()}>
                Close listening run
              </button>
            )}
          </div>
        </div>
      ) : null}

      {snapshot !== null && state.session !== "fatal" && state.session !== "idle" ? (
        <section className="listening-run" aria-labelledby={`${ids}-run`}>
          <h2 className="sr-only" id={`${ids}-run`}>Run · {snapshot.lifecycle}</h2>
          {state.error !== null && state.error.retry !== "answer" ? (
            <div className="status-error" role="alert">
              <strong>Listening error {state.error.code ? `(${state.error.code})` : ""}:</strong>{" "}
              {state.error.message}
              {state.error.reasons.length > 0 ? (
                <ul>{state.error.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              ) : null}
              {state.error.code === "calibration-unavailable" && snapshot.lifecycle === "configured" ? (
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || planLocked}
                    onClick={plan.onDisableCalibration}
                  >
                    Disable calibration explicitly for this plan
                  </button>
                </div>
              ) : null}
              {state.error.retry === "load" && playback?.phase === "error" ? (
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void controller.retryLoad()}
                  >
                    Retry trial load
                  </button>
                </div>
              ) : null}
              {state.error.retry === "start" ? (
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void controller.start()}
                  >
                    Retry staging
                  </button>
                </div>
              ) : null}
              {state.error.retry === "prepare" ? (
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || planLocked || !artifact || eligibility !== null}
                    onClick={primary.onPrepare}
                  >
                    Retry/check listening preparation
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {playback?.phase === "error" ? (
            <div className="status-error" role="alert">
              <strong>This A/B/X set failed to load atomically.</strong>{" "}
              {carryingPrevious
                ? "Previous trial audio continues; answers stay disabled. Retry or end the test."
                : "No partial audio is available."}{" "}{playback.error}
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void controller.retryLoad()}
                >
                  Retry trial load
                </button>
              </div>
            </div>
          ) : null}
          {state.notice ? <p className="field-note" role="status">{state.notice}</p> : null}
        </section>
      ) : null}

      {props.runActions === undefined || props.runActions === null ? null : (
        <div className="listen-actions-wide">{props.runActions}</div>
      )}
    </section>
  );
}
