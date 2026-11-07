import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import {
  CODEC_CATALOG,
  CODEC_IDS,
  type CanarySide,
  type CodecCapability,
  type CodecId,
  type CodecSelection,
  type EngineCapabilities,
  type ExperimentPlan,
  type ExperimentSnapshot,
  type LevelMeasurement,
  type PreparedArtifact,
  type PreparationProgress,
  type PreparationRequest,
  type SampleRateMode,
  type Side,
  type StageProvenance,
} from "@codec-abx/contracts";

import { buildDiagnosticExport, formatDuration, shortHash, producerAmbiguityDisclosures } from "./diagnostics";
import { desktopErrorMessage } from "./desktop/bridge";
import { RunActions } from "./listening/RunActions";
import { RunRecord } from "./listening/RunRecord";
import { ListeningSection } from "./listening/ListeningSection";
import type { ListeningReaders } from "./listening/controller";
import {
  LISTENING_DEFAULTS,
  isRawCodecProbeArtifact,
  validateListeningPlan,
  type ListeningPlanFields,
} from "./listening/model";
import { useListening } from "./listening/useListening";
import {
  PrepareTestWorkflow,
  type DiagnosticPreparationPolicy,
  type PrepareTestInputs,
  type PrepareTestRequestMode,
} from "./preparation/workflow";
import {
  detectClientRuntime,
  sourceName as clientSourceName,
  sourceSize as clientSourceSize,
  type ClientRuntime,
  type ClientRuntimeKind,
  type ClientSource,
} from "./runtime";
import { Sidebar, type PlanFormFields } from "./workspace/Sidebar";
import {
  ThemeSwitcher,
  useThemePreference,
} from "./workspace/ThemeSwitcher";

type CapabilitiesState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly capabilities: EngineCapabilities }
  | { readonly status: "error"; readonly error: string };

type BrowserPreparationMode = DiagnosticPreparationPolicy;

const PREPARATION_MODE_LABELS: Readonly<Record<BrowserPreparationMode, string>> = {
  "codec-probe-only": "Raw codec-stage measurement (manual diagnostic)",
  "aligned-gain-matched-v1": "Aligned + gain-matched preparation (default)",
};

interface SampleUrls {
  readonly a: string | null;
  readonly b: string | null;
  readonly pristine: string | null;
  readonly degraded: string | null;
}

const EMPTY_SAMPLES: SampleUrls = { a: null, b: null, pristine: null, degraded: null };

function sampleUrlList(urls: SampleUrls): readonly string[] {
  return [urls.a, urls.b, urls.pristine, urls.degraded]
    .filter((url): url is string => url !== null);
}

function errorMessage(error: unknown): string {
  return desktopErrorMessage(error);
}

function availability(
  capabilities: EngineCapabilities | null,
  codecId: CodecId,
): CodecCapability | null {
  return capabilities?.codecs.find((codec) => codec.codecId === codecId) ?? null;
}

function isAvailable(codec: CodecCapability | null): boolean {
  return codec?.availability === "available";
}

function codecLabel(codecId: CodecId): string {
  if (codecId === "noop_passthrough") return "PCM16 passthrough (no-op)";
  if (codecId === "opus") return "Opus (libopus)";
  return CODEC_CATALOG[codecId].displayName;
}

const MAX_STAGES_PER_SIDE = 4;

function preferredBitrate(codecId: CodecId): number {
  const options = CODEC_CATALOG[codecId].bitrateOptionsKbps;
  if (options.length === 0) return 0;
  if (options.includes(128)) return 128;
  return options[Math.floor(options.length / 2)] ?? options[0] ?? 0;
}

function stageSelection(codecId: CodecId, currentBitrate: number): CodecSelection {
  const options = CODEC_CATALOG[codecId].bitrateOptionsKbps;
  // A codec switch keeps the requested rate when it is valid for the new
  // codec; otherwise it picks a sensible catalog rate. No substitution occurs
  // silently on prepare, because the UI state is the request.
  const bitrateKbps = options.includes(currentBitrate) ? currentBitrate : preferredBitrate(codecId);
  return Object.freeze({ codecId, bitrateKbps });
}

function addableSelection(capabilities: EngineCapabilities | null): CodecSelection | null {
  if (capabilities === null) return null;
  const candidates = CODEC_IDS.filter((codecId) =>
    codecId !== "noop_passthrough" &&
    capabilities.codecs.some((codec) =>
      codec.codecId === codecId && codec.availability === "available"));
  const chosen = candidates[0] ?? (capabilities.codecs.some((codec) =>
    codec.codecId === "noop_passthrough" && codec.availability === "available")
    ? "noop_passthrough"
    : null);
  return chosen === null ? null : stageSelection(chosen, preferredBitrate(chosen));
}

function stageControlIds(side: Side, index: number): { readonly codec: string; readonly bitrate: string } {
  return index === 0
    ? { codec: `codec-${side}`, bitrate: `bitrate-${side}` }
    : { codec: `codec-${side}-${index + 1}`, bitrate: `bitrate-${side}-${index + 1}` };
}

function StageEditor(props: {
  readonly side: Side;
  readonly stages: readonly CodecSelection[];
  readonly capabilities: EngineCapabilities | null;
  readonly maxStages: number;
  readonly disabled: boolean;
  readonly onChange: (stages: readonly CodecSelection[]) => void;
}): JSX.Element {
  const sideLabel = props.side.toUpperCase();
  const replace = (index: number, selection: CodecSelection): void => {
    const next = props.stages.map((stage, stageIndex) => stageIndex === index ? selection : stage);
    props.onChange(Object.freeze(next));
  };
  const move = (index: number, offset: -1 | 1): void => {
    const target = index + offset;
    if (target < 0 || target >= props.stages.length) return;
    const next = [...props.stages];
    const value = next[index]!;
    next[index] = next[target]!;
    next[target] = value;
    props.onChange(Object.freeze(next));
  };
  const canAdd = !props.disabled && props.capabilities !== null &&
    props.stages.length < props.maxStages && addableSelection(props.capabilities) !== null;
  return (
    <fieldset className="codec-fields stage-editor" data-stage-count={props.stages.length} disabled={props.disabled}>
      <legend>
        <span>Side {sideLabel}</span>
        {props.stages.length > 1 ? <span className="stage-count">{props.stages.length} stages</span> : null}
      </legend>
      <ol className="stage-list">
        {props.stages.map((stage, index) => {
          const ids = stageControlIds(props.side, index);
          const capability = availability(props.capabilities, stage.codecId);
          const options = CODEC_CATALOG[stage.codecId].bitrateOptionsKbps;
          const stageLabel = props.stages.length === 1
            ? `Side ${sideLabel}`
            : `Side ${sideLabel} stage ${index + 1}`;
          return (
            <li className="stage-row" key={`${props.side}-${index}`} data-stage-index={index + 1}>
              <span className="stage-index" aria-hidden="true">{index + 1}</span>
              <div className="stage-fields">
                <div className="stage-select">
                  <label htmlFor={ids.codec}>Codec</label>
                  <select
                    id={ids.codec}
                    aria-label={`${stageLabel} codec`}
                    value={stage.codecId}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                      replace(index, stageSelection(event.target.value as CodecId, stage.bitrateKbps));
                    }}
                  >
                    {CODEC_IDS.map((codecId) => {
                      const codec = availability(props.capabilities, codecId);
                      const reason = codec?.reason ?? null;
                      return (
                        <option key={codecId} value={codecId} disabled={!isAvailable(codec)}>
                          {codecLabel(codecId)}
                          {codec && !isAvailable(codec)
                            ? ` — ${codec.availability}${reason ? `: ${reason}` : ""}`
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="stage-select">
                  <label htmlFor={ids.bitrate}>Bitrate</label>
                  <select
                    id={ids.bitrate}
                    aria-label={`${stageLabel} bitrate`}
                    value={String(stage.bitrateKbps)}
                    disabled={options.length <= 1}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                      replace(index, Object.freeze({
                        codecId: stage.codecId,
                        bitrateKbps: Number(event.target.value),
                      }));
                    }}
                  >
                    {options.map((rate) => (
                      <option key={rate} value={String(rate)}>
                        {rate === 0 ? "not applicable (PCM16)" : `${rate} kbps requested`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {props.stages.length > 1 ? (
                <div className="stage-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Remove side ${sideLabel} stage ${index + 1}`}
                    disabled={props.stages.length <= 1}
                    onClick={() => props.onChange(Object.freeze(
                      props.stages.filter((_value, stageIndex) => stageIndex !== index),
                    ))}
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Move side ${sideLabel} stage ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Move side ${sideLabel} stage ${index + 1} down`}
                    disabled={index === props.stages.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Down
                  </button>
                </div>
              ) : null}
              {capability && !isAvailable(capability) ? (
                <p className="stage-note status-error">
                  {capability.reason ?? "Availability is not established yet."}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="secondary add-stage"
        aria-label={`Add side ${sideLabel} stage`}
        disabled={!canAdd}
        onClick={() => {
          if (props.capabilities === null) return;
          const selection = addableSelection(props.capabilities);
          if (selection === null) return;
          props.onChange(Object.freeze([...props.stages, selection]));
        }}
      >
        Add stage
      </button>
    </fieldset>
  );
}

function phaseLabel(phase: PreparationProgress["phase"]): string {
  switch (phase) {
    case "loading":
      return "Loading";
    case "probing":
      return "Probing";
    case "encoding":
      return "Encoding/decoding";
    case "preparing":
      return "Aligning and matching levels";
    case "measuring":
      return "Measuring delivered bytes";
    case "complete":
      return "Complete";
  }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

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

function formatSignedDb(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)} dB`;
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

function planMatches(snapshot: ExperimentSnapshot, fields: ListeningPlanFields): boolean {
  return snapshot.plan.plannedTrials === Number(fields.plannedTrials) &&
    snapshot.plan.alpha === Number(fields.alpha) &&
    snapshot.plan.labelMode === fields.labelMode &&
    snapshot.plan.calibrationEnabled === fields.calibrationEnabled;
}

type WorkspaceView = "setup" | "listen" | "evidence";

function CapabilitiesPanel(props: {
  readonly state: CapabilitiesState;
  readonly kind: ClientRuntimeKind;
}): JSX.Element {
  const desktop = props.kind === "desktop";
  if (props.state.status === "loading") {
    return (
      <section className="panel capability-strip" aria-labelledby="capabilities-heading" data-runtime={props.kind}>
        <div className="section-head">
          <h2 id="capabilities-heading">Runtime capabilities</h2>
          <p className="section-meta">Probing the local runtime</p>
        </div>
        <p role="status" className="hint">
          {desktop
            ? "Probing native TypeScript/FFmpeg in Electron’s private worker…"
            : "Loading the local WASM core and probing real encoders/decoders…"}
        </p>
      </section>
    );
  }
  if (props.state.status === "error") {
    return (
      <section className="panel capability-strip" aria-labelledby="capabilities-heading" data-runtime={props.kind}>
        <div className="section-head">
          <h2 id="capabilities-heading">Runtime capabilities</h2>
          <p className="section-meta">Unavailable</p>
        </div>
        <p className="status-error" role="alert">
          Capability loading failed: {props.state.error}
        </p>
        <p className="hint">
          No engine substitution, upload or simulated codec fallback is applied. Restore the
          disclosed desktop prerequisites and retry explicitly.
        </p>
      </section>
    );
  }
  const capabilities = props.state.capabilities;
  const policies = capabilities.supportedPreparationPolicies ?? [capabilities.preparationPolicy];
  const availableCodecs = capabilities.codecs.filter(isAvailable).length;
  return (
    <section className="panel capability-strip" aria-labelledby="capabilities-heading" data-runtime={props.kind}>
      <div className="section-head">
        <h2 id="capabilities-heading">Runtime capabilities</h2>
        <p className="section-meta">
          <span className={`badge badge-${availableCodecs > 0 ? "available" : "unavailable"}`}>
            {availableCodecs} available
          </span>
        </p>
      </div>
      <details className="cap-details">
        <summary>Engine, codecs and limits</summary>
        <p className="hint">
          {desktop
            ? "Observed in Electron’s private worker from the native TypeScript engine."
            : "Observed in this browser/build. These are not native FFmpeg guarantees."}
        </p>
        <dl className="facts">
          <dt>Engine</dt>
          <dd>{capabilities.engineId}</dd>
          <dt>Location</dt>
          <dd>{capabilities.location}</dd>
          <dt>Build</dt>
          <dd>{capabilities.build}</dd>
          <dt>Default policy</dt>
          <dd>{capabilities.preparationPolicy}</dd>
          <dt>Supported policies</dt>
          <dd>
            {policies.map((policy) => {
              const label = (PREPARATION_MODE_LABELS as Readonly<Record<string, string>>)[policy] ?? policy;
              return `${policy} — ${label}`;
            }).join(" · ")}
          </dd>
          <dt>Canary material</dt>
          <dd>
            {capabilities.supportsCanaryMaterial
              ? desktop
                ? "supported as an explicit native opt-in generated from final Side A; a material check only, not a listener gate or scoring service"
                : "supported conditionally: explicit opt-in with aligned-gain-matched-v1 only; not a listener gate or scoring service"
              : "not advertised by this build"}
          </dd>
          <dt>Runtime limits</dt>
          <dd>
            {Math.round(capabilities.maxInputBytes / (1024 * 1024))} MiB
            {desktop ? (
              <> source; 0.4–{capabilities.maxDurationSeconds} s final delivery. Mono/stereo,
                session rates 44.1/48/96 kHz. Native mode preserves supported source rates;
                force-48 kHz mode can resample other source rates.</>
            ) : (
              <>, {capabilities.maxDurationSeconds} s, native rates 44.1/48/96 kHz or explicit 48 kHz conversion,
                mono/stereo PCM16 delivery</>
            )}
          </dd>
          <dt>Stages per side</dt>
          <dd>
            {capabilities.maxStagesPerSide === undefined
              ? "not advertised; this adapter refuses chains rather than silently reducing them"
              : `${capabilities.maxStagesPerSide} (editor hard cap ${MAX_STAGES_PER_SIDE})`}
          </dd>
        </dl>
        <ul className="codec-list">
          {capabilities.codecs.map((codec) => (
            <li key={codec.codecId}>
              <strong>{codecLabel(codec.codecId)}</strong>{" "}
              <span className={`badge badge-${codec.availability}`}>{codec.availability}</span>
              <span className="codec-identities">
                encoder {codec.encoder} · decoder {codec.decoder}
              </span>
              {codec.reason ? <span className="codec-reason">{codec.reason}</span> : null}
            </li>
          ))}
        </ul>
        <details>
          <summary>Capability limitations</summary>
          <ul>
            {capabilities.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </details>
      <div className="engine-choices">
        <div className="engine-choice" aria-disabled={!desktop}>
          <strong>Desktop native</strong>
          <span>
            {desktop
              ? "Active in the Electron main process’s private worker."
              : "Separate adapter; not connected to this browser build."}
          </span>
        </div>
        <div className="engine-choice" aria-disabled="true">
          <strong>Optional server</strong>
          <span>Not implemented. This page never uploads audio and has no server fallback.</span>
        </div>
      </div>
      </details>
    </section>
  );
}

function StageProvenanceTable(props: {
  readonly side: Side;
  readonly stages: readonly StageProvenance[] | undefined;
  readonly fallback: Pick<StageProvenance, "requested" | "encoder" | "decoder" | "actualBitrateKbps" | "encodedSampleRate">;
}): JSX.Element {
  const stages: readonly StageProvenance[] = props.stages ?? [
    { stageIndex: 1, ...props.fallback },
  ];
  const fallback = props.stages === undefined;
  return (
    <section className="stage-provenance" aria-label={`Side ${props.side.toUpperCase()} stage provenance`}>
      <h4>Stage provenance</h4>
      <p className="field-note">
        {fallback
          ? "This artifact has no per-stage array (legacy or one-stage v1 shape). The single row below repeats only the observed top-level facts; no intermediate data is invented."
          : `All ${stages.length} requested stage${stages.length === 1 ? "" : "s"} in order. Top-level track facts refer to the final stage.`}
      </p>
      <div className="table-scroll">
        <table className="stage-facts">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Requested codec</th>
              <th scope="col">Requested bitrate</th>
              <th scope="col">Encoder → decoder</th>
              <th scope="col">Actual bitrate</th>
              <th scope="col">Internal rate</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => (
              <tr key={stage.stageIndex}>
                <th scope="row">{stage.stageIndex}</th>
                <td>{codecLabel(stage.requested.codecId)}</td>
                <td>
                  {stage.requested.bitrateKbps === 0
                    ? "not applicable (PCM16)"
                    : `${stage.requested.bitrateKbps} kbps requested`}
                </td>
                <td>{stage.encoder} → {stage.decoder}</td>
                <td>
                  {stage.actualBitrateKbps === null
                    ? "null (PCM passthrough; not applicable)"
                    : `${stage.actualBitrateKbps.toFixed(1)} kbps including container overhead`}
                </td>
                <td>
                  {stage.encodedSampleRate === null ? "null" : `${stage.encodedSampleRate} Hz`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrackCard(props: {
  readonly side: Side;
  readonly artifact: PreparedArtifact;
  readonly actionsDisabled: boolean;
  readonly onLoadSample: (side: Side) => void;
  readonly onDownloadWav: (side: Side) => void;
}): JSX.Element {
  const track = props.side === "a" ? props.artifact.a : props.artifact.b;
  const delivered = track.delivered;
  const duration = delivered.sampleRate > 0 ? delivered.frames / delivered.sampleRate : 0;
  const stages = track.stages;
  const finalStage = stages !== undefined && stages.length > 0
    ? stages[stages.length - 1]!
    : null;
  return (
    <article className="track-card" aria-label={`Delivered side ${props.side.toUpperCase()}`}>
      <header className="track-head">
        <h3>Side {props.side.toUpperCase()}</h3>
        <span className="track-codec">
          {codecLabel(track.requested.codecId)}
          {track.requested.codecId === "noop_passthrough"
            ? " · bitrate n/a"
            : ` · ${track.requested.bitrateKbps} kbps`}
          {finalStage === null ? null : ` · stage ${finalStage.stageIndex}`}
        </span>
      </header>
      <dl className="facts track-facts">
        <dt>Delivered</dt>
        <dd>
          {delivered.sampleRate} Hz · {delivered.channels === 1 ? "mono" : "stereo"} ·{" "}
          {formatDuration(duration)}
        </dd>
        <dt>WAV SHA-256</dt>
        <dd>
          <code title={delivered.wavSha256}>{shortHash(delivered.wavSha256)}</code>
        </dd>
      </dl>
      <div className="track-actions">
        <button
          type="button"
          disabled={props.actionsDisabled}
          onClick={() => props.onLoadSample(props.side)}
        >
          Load diagnostic sample {props.side.toUpperCase()}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={props.actionsDisabled}
          onClick={() => props.onDownloadWav(props.side)}
        >
          Download delivered WAV {props.side.toUpperCase()}
        </button>
      </div>
      {props.actionsDisabled ? (
        <p className="field-note">
          Diagnostic playback and downloads are disabled while a listening session owns the
          artifact, so the page offers one output path.
        </p>
      ) : null}
      <details className="provenance">
        <summary>Stage provenance and final facts</summary>
        <StageProvenanceTable side={props.side} stages={stages} fallback={{
          requested: track.requested,
          encoder: track.encoder,
          decoder: track.decoder,
          actualBitrateKbps: track.actualBitrateKbps,
          encodedSampleRate: track.encodedSampleRate,
        }} />
        <dl className="facts">
          <dt>Final requested</dt>
          <dd>
            {codecLabel(track.requested.codecId)}
            {track.requested.codecId === "noop_passthrough"
              ? " · bitrate not applicable"
              : ` · ${track.requested.bitrateKbps} kbps requested`}
            {finalStage === null ? null : ` (stage ${finalStage.stageIndex})`}
          </dd>
          <dt>Final encoder / decoder</dt>
          <dd>{track.encoder} → {track.decoder}</dd>
          <dt>Final internal rate</dt>
          <dd>{track.encodedSampleRate === null ? "null" : `${track.encodedSampleRate} Hz`}</dd>
          <dt>Final actual bitrate</dt>
          <dd>
            {track.actualBitrateKbps === null
              ? "null (PCM passthrough; not applicable)"
              : `${track.actualBitrateKbps.toFixed(1)} kbps including container overhead`}
          </dd>
          <dt>Delivered final WAV</dt>
          <dd>
            {delivered.sampleRate} Hz · {delivered.channels === 1 ? "mono" : "stereo"} ·{" "}
            {delivered.frames} frames · {formatDuration(duration)}
          </dd>
          <dt>WAV SHA-256</dt>
          <dd>
            <code title={delivered.wavSha256}>{delivered.wavSha256}</code>
          </dd>
        </dl>
      </details>
    </article>
  );
}

function PreparationReportPanel(props: {
  readonly artifact: PreparedArtifact;
}): JSX.Element | null {
  const preparation = props.artifact.preparation;
  if (!preparation) return null;
  const alignment = preparation.alignment;
  return (
    <details className="preparation">
      <summary>
        Applied preparation · <code>{preparation.policy}</code>
      </summary>
      <p className="hint">
        These are operations actually written into the delivered PCM16 WAV bytes. Final
        levels, residual lag and null depth are measured again below on those serialized
        bytes. This is not a claim of codec equivalence or an audibility result.
      </p>
      <dl className="facts">
        <dt>Applied lag</dt>
        <dd>
          {alignment.lagSamples} samples (positive means B was delayed); status{" "}
          <code>{alignment.status}</code>; confidence{" "}
          {alignment.confidence.toExponential(6)}.{" "}
          {alignment.status === "no-evidence"
            ? "No lag evidence was found, so zero lag was applied and disclosed; this slice adds no confidence gate."
            : "This estimate was applied before serialization."}
        </dd>
        <dt>Applied crop</dt>
        <dd>
          Input frames A {alignment.inputFramesA}, B {alignment.inputFramesB}. Head start A{" "}
          {alignment.startFrameA}, B {alignment.startFrameB}; common output frames{" "}
          {alignment.outputFrames}. No silence padding, resampling or downmix.
        </dd>
        <dt>Pre-gain integrated loudness</dt>
        <dd>
          A {formatLevel(preparation.loudness.preA, "LUFS", LOUDNESS_MEANINGS)} · B{" "}
          {formatLevel(preparation.loudness.preB, "LUFS", LOUDNESS_MEANINGS)} after
          alignment/cropping.
        </dd>
        <dt>Independent gains</dt>
        <dd>
          A {formatSignedDb(preparation.loudness.gainADb)} · B{" "}
          {formatSignedDb(preparation.loudness.gainBDb)} to target{" "}
          {preparation.targetLufs} LUFS. No clamp or limiter.
        </dd>
        <dt>Common peak trim</dt>
        <dd>
          {formatSignedDb(-preparation.loudness.commonTrimDb)} attenuation (
          {preparation.loudness.commonTrimDb.toFixed(3)} dB reduction) applied equally to
          both sides before PCM16 quantization. Peak ceiling{" "}
          {preparation.peakCeiling.toPrecision(8)}.
        </dd>
        <dt>Serialization</dt>
        <dd>
          <code>{preparation.serialization.format}</code>,{" "}
          <code>{preparation.serialization.rounding}</code> quantization, floor bias{" "}
          {preparation.serialization.floorBiasCodeSteps} code steps, no dither.
        </dd>
        <dt>Measurement bounds</dt>
        <dd>
          max lag {alignment.maxLagSamples} samples; probe {alignment.probeSamples} samples.
        </dd>
      </dl>
      <details>
        <summary>Applied-policy notes</summary>
        <ul>
          {preparation.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </details>
  );
}

function ValidityPanel(props: { readonly artifact: PreparedArtifact }): JSX.Element | null {
  const validity = props.artifact.validity;
  if (!validity) return null;
  const gate = validity.nullGate;
  const preparationGate = validity.policy === "delivered-validity-v2"
    ? validity.preparationGate
    : null;
  const producerAmbiguity = producerAmbiguityDisclosures(props.artifact.disclosures);
  return (
    <section className="validity" aria-labelledby="validity-heading">
      <div className="gate-line">
        <h3 id="validity-heading">
          Preparation checks
        </h3>
        <dl className="facts gate-facts">
          <dt>Null gate</dt>
          <dd><strong>{gate.status}</strong></dd>
          <dt>Preparation validity</dt>
          <dd>
            {preparationGate === null
              ? "not measured (v1)"
              : <strong>{preparationGate.status}</strong>}
          </dd>
        </dl>
      </div>
      {preparationGate?.disclosure ? (
        <p className="warning" role="alert">
          <strong>Preparation ambiguity disclosure.</strong> {preparationGate.disclosure}
        </p>
      ) : null}
      {producerAmbiguity.length > 0 ? (
        <p className="warning" role="alert">
          <strong>Producer ambiguity disclosure.</strong>{" "}
          {producerAmbiguity.join(" ")}{" "}
          This remains disclosed even when the post-crop alignment estimate appears unique.
        </p>
      ) : null}
      {gate.status === "failed" ? (
        <p className="warning" role="alert">
          <strong>Null check failed.</strong> This diagnostic artifact is still published,
          but identical pipelines did not null at or below {gate.thresholdDb} dB. It must
          not be treated as a valid ABX comparison or used to certify an audible difference.
        </p>
      ) : null}
      {preparationGate?.status === "failed" ? (
        <p className="warning" role="alert">
          <strong>Preparation validity failed.</strong> Scored listening is blocked for this
          pair. The applied-policy report records any alignment, crop and gain corrections
          already performed on the served audio.
        </p>
      ) : null}
      <details>
        <summary>Gate evidence and meaning</summary>
        <p className="hint">Report policy: <code>{validity.policy}</code></p>
        <p className="hint">
          The frozen identical-pipeline null decision and preparation-validity gate were
          evaluated on the final delivered A/B pair. These are diagnostic delivered-audio
          checks, not experiment authority and not a claim that a scored ABX trial is valid.
        </p>
        <dl className="facts">
          <dt>Null gate</dt>
          <dd>
            <code>{gate.policy}</code> · status <strong>{gate.status}</strong> · expected
            identical <code>{String(gate.expectedIdentical)}</code> · threshold{" "}
            {gate.thresholdDb} dB
          </dd>
          <dt>Delivered null depth</dt>
          <dd>{formatLevel(gate.depthDb, "dB", NULL_MEANINGS)}</dd>
          <dt>Reason</dt>
          <dd>{gate.reason}</dd>
          {preparationGate === null ? (
            <>
              <dt>Preparation validity</dt>
              <dd>
                Not measured: this historical <code>delivered-validity-v1</code> artifact
                remains valid diagnostic data but is not authorized for scored listening.
              </dd>
            </>
          ) : (
            <>
              <dt>Preparation validity</dt>
              <dd>
                <code>{preparationGate.policy}</code> · status{" "}
                <strong>{preparationGate.status}</strong> · classification{" "}
                <code>{preparationGate.classification}</code>
              </dd>
              <dt>Preparation reason</dt>
              <dd>{preparationGate.reason}</dd>
              <dt>Preparation evidence</dt>
              <dd>
                AC RMS A {preparationGate.evidence.acRmsFullScaleA.toExponential(6)} / B{" "}
                {preparationGate.evidence.acRmsFullScaleB.toExponential(6)} full scale ·
                same {preparationGate.evidence.sameConfidence.toExponential(6)} at{" "}
                {preparationGate.evidence.sameLagSamples} samples · inverted{" "}
                {preparationGate.evidence.invertedConfidence.toExponential(6)} at{" "}
                {preparationGate.evidence.invertedLagSamples} samples · chosen{" "}
                {preparationGate.evidence.chosenPolarity} at{" "}
                {preparationGate.evidence.chosenLagSamples} samples · search bounds{" "}
                [{preparationGate.evidence.searchMinLagSamples},{" "}
                {preparationGate.evidence.searchMaxLagSamples}] · near-best distinct peaks{" "}
                {preparationGate.evidence.distinctPositivePeaksWithinTolerance}
              </dd>
              <dt>Frozen preparation constants</dt>
              <dd>
                min AC RMS {preparationGate.constants.minAcRmsFullScale.toExponential(6)} ·
                inverted confidence ≥ {preparationGate.constants.invertedMinConfidence} with
                margin &gt; {preparationGate.constants.invertedMargin} · same confidence ≥{" "}
                {preparationGate.constants.sameMinConfidence} · peak tolerance{" "}
                {preparationGate.constants.peakValueTolerance}
              </dd>
            </>
          )}
        </dl>
        {preparationGate?.classification === "same-polarity-periodic-ambiguous" ? (
          <p className="hint">
            This pass is evidence-visible but has no unique lag. Do not treat the chosen lag or
            polarity as unique just because the post-crop alignment report shows one estimate.
          </p>
        ) : null}
        {gate.status === "not-applicable" ? (
          <p className="hint">
            Sides are configured differently, so an identical-pipeline null is not expected.
            The gate is not applicable and does not block a real codec comparison.
          </p>
        ) : null}
        <ul>
          {validity.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function CanaryMaterialPanel(props: {
  readonly artifact: PreparedArtifact;
  readonly actionsDisabled: boolean;
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
          <strong>{report.status}</strong> · usable <code>{String(report.usable)}</code>
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
          <strong>No canary bytes retained or served.</strong> The material check did not
          pass, so this artifact keeps only the measured report. Nothing was silently
          substituted.
        </p>
      )}
      <details>
        <summary>Canary evidence and notes</summary>
        <p className="hint">
          A measured, deliberately easy material check on the final delivered Side A. It is
          not proof of human audibility, a listener calibration trial or a scored ABX result.
          No listener canary gate is implemented.
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
            cutoff {report.cutoffHz} Hz · grid <code>{report.frequencyGrid}</code> · drive{" "}
            {report.drive}× · clip ±{report.clipLevel}
          </dd>
          <dt>Layout</dt>
          <dd>
            {report.sampleRate} Hz · {report.channels === 1 ? "mono" : "stereo"} ·{" "}
            {report.frames} frames
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


export function App(): JSX.Element {
  const [startup] = useState<
    { readonly runtime: ClientRuntime; readonly error: null } |
    { readonly runtime: null; readonly error: string }
  >(() => {
    try { return { runtime: detectClientRuntime(), error: null }; }
    catch (error) { return { runtime: null, error: errorMessage(error) }; }
  });
  if (startup.runtime === null) {
    return (
      <main className="app" role="alert">
        <h1>Desktop unavailable</h1>
        <p>{startup.error}</p>
      </main>
    );
  }
  return <RuntimeApp runtime={startup.runtime} />;
}

function RuntimeApp({ runtime }: { readonly runtime: ClientRuntime }): JSX.Element {
  const desktop = runtime.kind === "desktop";
  const engine = runtime.preparation;
  const { preference: themePreference, setPreference: setThemePreference } = useThemePreference();
  const [view, setView] = useState<WorkspaceView>("setup");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilitiesState>({ status: "loading" });
  const [stagesA, setStagesA] = useState<readonly CodecSelection[]>(Object.freeze([
    Object.freeze({ codecId: "noop_passthrough" as const, bitrateKbps: 0 }),
  ]));
  const [stagesB, setStagesB] = useState<readonly CodecSelection[]>(Object.freeze([
    Object.freeze({ codecId: "opus" as const, bitrateKbps: 128 }),
  ]));
  const [rateMode, setRateMode] = useState<SampleRateMode>("native");
  const [preparationMode, setPreparationMode] =
    useState<BrowserPreparationMode>("aligned-gain-matched-v1");
  /** One opt-in: canary generation and the listening calibration plan. */
  const [calibrationEnabled, setCalibrationEnabled] = useState(false);
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [samples, setSamples] = useState<SampleUrls>(EMPTY_SAMPLES);
  const [planFields, setPlanFields] = useState<PlanFormFields>({
    plannedTrials: String(LISTENING_DEFAULTS.plannedTrials),
    alpha: String(LISTENING_DEFAULTS.alpha),
    labelMode: LISTENING_DEFAULTS.labelMode,
  });
  const [planError, setPlanError] = useState<string | null>(null);

  const listening = useListening(runtime.createListeningClient);
  const listeningLocksLab = listening.state.session !== "idle";
  const listeningLocksRef = useRef(listeningLocksLab);
  listeningLocksRef.current = listeningLocksLab;
  const listeningReaders = useMemo<ListeningReaders>(() => ({
    readAudio: (artifactId, side) => engine.readAudio(artifactId, side),
    ...(engine.readCanaryAudio
      ? {
          readCanaryAudio: (artifactId, side) =>
            engine.readCanaryAudio!(artifactId, side),
        }
      : {}),
  }), [engine]);

  const mountedRef = useRef(true);
  const samplesRef = useRef<SampleUrls>(EMPTY_SAMPLES);
  const audioElementsRef = useRef<Record<keyof SampleUrls, HTMLAudioElement | null>>({
    a: null,
    b: null,
    pristine: null,
    degraded: null,
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const revokeSamples = useCallback((): void => {
    for (const url of sampleUrlList(samplesRef.current)) {
      URL.revokeObjectURL(url);
    }
    samplesRef.current = EMPTY_SAMPLES;
    if (mountedRef.current) setSamples(EMPTY_SAMPLES);
  }, []);

  const stopDiagnosticOutputs = useCallback((): void => {
    // Pausing the element itself is required; removing the DOM or revoking a
    // blob URL alone does not guarantee that an already-playing element stops.
    for (const key of Object.keys(audioElementsRef.current) as (keyof SampleUrls)[]) {
      const element = audioElementsRef.current[key];
      audioElementsRef.current[key] = null;
      if (element === null) continue;
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    revokeSamples();
  }, [revokeSamples]);

  const audioRefCallbacks = useMemo(() => {
    const register = (key: keyof SampleUrls) => (element: HTMLAudioElement | null): void => {
      if (element !== null) {
        audioElementsRef.current[key] = element;
        return;
      }
      // React calls this on unmount before passive effects. Keep the element
      // reference so a playing HTML audio output is stopped, not just orphaned.
      const previous = audioElementsRef.current[key];
      audioElementsRef.current[key] = null;
      if (previous !== null) {
        previous.pause();
        previous.removeAttribute("src");
        previous.load();
      }
    };
    return {
      a: register("a"),
      b: register("b"),
      pristine: register("pristine"),
      degraded: register("degraded"),
    };
  }, []);

  useEffect(() => {
    if (listeningLocksLab) stopDiagnosticOutputs();
  }, [listeningLocksLab, stopDiagnosticOutputs]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const sidebar = document.getElementById("session-sidebar");
    const trigger = document.querySelector<HTMLButtonElement>("button[aria-controls='session-sidebar']");
    const focusable = (): HTMLElement[] => sidebar === null ? [] :
      Array.from(sidebar.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex='0']",
      )).filter((element) => element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden");
    const isDrawer = (): boolean => window.matchMedia("(max-width: 900px)").matches;
    if (isDrawer()) focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isDrawer()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
        trigger?.focus();
      } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const elements = focusable();
        const target = event.shiftKey ? elements.at(-1) : elements[0];
        const edge = event.shiftKey ? elements[0] : elements.at(-1);
        if (target && (document.activeElement === edge || !sidebar?.contains(document.activeElement))) {
          event.preventDefault();
          target.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  // Request policy stays a view/config fact: which manual policy and rate were
  // selected. Sequencing, captured identity and reuse belong to the workflow.
  const buildPreparationRequest = useCallback((
    inputs: PrepareTestInputs,
    mode: PrepareTestRequestMode,
  ): PreparationRequest => {
    // Desktop always requests the explicit shared policy of the native
    // TypeScript engine. Raw codec-probe-only is never a native fallback.
    const selectedPolicy = desktop || mode === "prepare-test" || inputs.diagnosticPolicy === "aligned-gain-matched-v1"
      ? { preparationPolicy: "aligned-gain-matched-v1" as const }
      : {};
    const global = {
      sampleRateMode: inputs.rateMode,
      ...selectedPolicy,
      ...(inputs.calibrationEnabled ? { canaryEnabled: true } : {}),
    };
    // Both sides with exactly one stage keep the delivered version-1 request.
    // Any explicit multi-stage chain is represented as version 2.
    return inputs.stagesA.length === 1 && inputs.stagesB.length === 1
      ? {
          version: 1,
          ...global,
          a: stageSelection(inputs.stagesA[0]!.codecId, inputs.stagesA[0]!.bitrateKbps),
          b: stageSelection(inputs.stagesB[0]!.codecId, inputs.stagesB[0]!.bitrateKbps),
        }
      : {
          version: 2,
          ...global,
          a: Object.freeze(inputs.stagesA.map((stage) =>
            stageSelection(stage.codecId, stage.bitrateKbps))),
          b: Object.freeze(inputs.stagesB.map((stage) =>
            stageSelection(stage.codecId, stage.bitrateKbps))),
        };
  }, [desktop]);

  // One workflow per mounted app. It is created lazily so its lifecycle and
  // engine disposal ownership cannot be replaced by a later render.
  const [workflow] = useState(() => new PrepareTestWorkflow<ClientSource, PreparedArtifact>({
    desktop,
    engine,
    controller: listening.controller,
    readers: listeningReaders,
    isListeningLocked: () => listeningLocksRef.current,
    onArtifactDiscarded: stopDiagnosticOutputs,
    buildRequest: buildPreparationRequest,
    publishError: (message) => {
      if (mountedRef.current) setError(message);
    },
    reportCleanupFailure: (message) => {
      console.error("Application cleanup was not confirmed:", message);
    },
  }));

  const [workflowState, setWorkflowState] = useState(() => workflow.state);
  useEffect(() => workflow.subscribe(setWorkflowState), [workflow]);
  // The lifecycle stays the artifact owner and is observed directly for
  // diagnostics; the workflow owns setup sequencing and reuse identity.
  const [preparationState, setPreparationState] = useState(() => workflow.lifecycle.state);
  useEffect(() => workflow.lifecycle.subscribe(setPreparationState), [workflow]);
  const { source, status, progress, artifact, resetting, changingSource } = preparationState;

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void engine.capabilities().then(
      (value) => {
        if (cancelled || !mountedRef.current) return;
        setCapabilities({ status: "ready", capabilities: value });
      },
      (reason: unknown) => {
        if (cancelled || !mountedRef.current) return;
        setCapabilities({ status: "error", error: errorMessage(reason) });
      },
    );
    return () => {
      cancelled = true;
      mountedRef.current = false;
      for (const url of sampleUrlList(samplesRef.current)) {
        URL.revokeObjectURL(url);
      }
      samplesRef.current = EMPTY_SAMPLES;
      // The workflow joins the listening Worker/player, then preparation, then
      // the engine. Each failure is reported; teardown never claims completion
      // or skips the remaining owners.
      void workflow.dispose();
    };
  }, [engine, workflow]);

  const caps = capabilities.status === "ready" ? capabilities.capabilities : null;
  const maxStagesPerSide = Math.max(1, Math.min(MAX_STAGES_PER_SIDE, caps?.maxStagesPerSide ?? 1));
  const allStages = useMemo(
    () => [...stagesA.map((stage, index) => ({ side: "a" as const, index, stage })),
      ...stagesB.map((stage, index) => ({ side: "b" as const, index, stage }))],
    [stagesA, stagesB],
  );
  const unavailableStages = allStages.flatMap(({ side, index, stage }) => {
    const capability = availability(caps, stage.codecId);
    return isAvailable(capability) ? [] : [{
      side,
      index,
      codecId: stage.codecId,
      availability: capability?.availability ?? "unknown",
      reason: capability?.reason ?? "Availability has not been established",
    }];
  });
  const chainsFit = stagesA.length <= maxStagesPerSide && stagesB.length <= maxStagesPerSide;
  const codecsReady = unavailableStages.length === 0 && chainsFit;
  const busy = status === "preparing" || status === "cancelling";
  const prepareTestBusy = workflowState.busy;
  const controlsDisabled = busy || resetting || changingSource || listeningLocksLab ||
    prepareTestBusy;
  const unavailableSelection =
    capabilities.status === "ready" && !codecsReady
      ? chainsFit
        ? "Selected stages cannot be requested: " +
          unavailableStages.map((entry) =>
            `side ${entry.side.toUpperCase()} stage ${entry.index + 1} ${CODEC_CATALOG[entry.codecId].displayName} is ${entry.availability} (${entry.reason})`,
          ).join("; ") + ". No codec substitution is applied."
        : `This build advertises at most ${maxStagesPerSide} stage(s) per side; remove stages before preparing.`
      : null;

  // Every value the primary action may capture. The workflow snapshots these
  // on an explicit command; nothing here starts work by itself.
  const inputs = useMemo<PrepareTestInputs>(() => ({
    sourceIdentity: source === null
      ? "none"
      : source.kind === "file"
        ? `file:${source.file.name}:${source.file.size}:${source.file.lastModified}`
        : `desktop:${source.source.name}:${source.source.size}`,
    stagesA,
    stagesB,
    rateMode,
    calibrationEnabled,
    diagnosticPolicy: preparationMode,
  }), [source, stagesA, stagesB, rateMode, calibrationEnabled, preparationMode]);

  const chooseSource = async (selected: ClientSource): Promise<boolean> => {
    const adopted = await workflow.chooseSource(selected);
    if (!adopted && fileInputRef.current) fileInputRef.current.value = "";
    return adopted;
  };

  const selectFile = (event: ChangeEvent<HTMLInputElement>): void => {
    if (listeningLocksLab) return;
    const selected = event.target.files?.[0] ?? null;
    if (!selected) return;
    void chooseSource({ kind: "file", file: selected });
  };

  const chooseDesktopSource = async (): Promise<void> => {
    if (listeningLocksLab || controlsDisabled) return;
    try {
      const selected = await engine.pickSource();
      if (!selected || !mountedRef.current) return;
      await chooseSource(selected);
    } catch (reason: unknown) {
      if (mountedRef.current) setError(`Source selection failed: ${errorMessage(reason)}`);
    }
  };

  const beginPrepare = (): void => {
    if (listeningLocksLab || prepareTestBusy) return;
    if (!source || controlsDisabled || !codecsReady || !preparationModeSupported) return;
    if (!desktop && preparationMode === "codec-probe-only" && calibrationEnabled) return;
    setModeNotice(null);
    void workflow.prepareDiagnostic(inputs);
  };

  const cancelPrepare = (): void => {
    if (prepareTestBusy) return;
    void workflow.cancel();
  };

  const reset = async (): Promise<void> => {
    if (resetting || listeningLocksLab) return;
    const cleared = await workflow.reset();
    if (cleared && mountedRef.current && fileInputRef.current) fileInputRef.current.value = "";
  };

  /**
   * One explicit primary action: prepare aligned audio, verify/bind the exact
   * captured plan, then stage trial 1 paused. The workflow owns that sequence;
   * this handler only submits the current form values. It never plays, answers
   * or advances, and it never binds a completed artifact from an effect.
   */
  const runPrepareTest = (plan: ExperimentPlan): Promise<void> => {
    // View prerequisites keep the button disabled; this guard mirrors them so a
    // programmatic call cannot bypass codec/policy readiness.
    if (!source || !codecsReady || !alignedPreparationSupported) return Promise.resolve();
    setModeNotice(null);
    return workflow.prepareTest(inputs, plan);
  };

  const cancelPrepareTest = (): Promise<void> => workflow.cancel();

  const loadSample = async (side: Side): Promise<void> => {
    if (listeningLocksLab) return;
    const current = workflow.lifecycle.readableArtifact;
    if (!current) return;
    try {
      const bytes = await engine.readAudio(current.id, side);
      if (!mountedRef.current || workflow.lifecycle.readableArtifact !== current) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const previous = samplesRef.current[side];
      if (previous) URL.revokeObjectURL(previous);
      const next: SampleUrls = { ...samplesRef.current, [side]: url };
      samplesRef.current = next;
      if (mountedRef.current) setSamples(next);
    } catch (reason: unknown) {
      if (mountedRef.current && workflow.lifecycle.readableArtifact === current) {
        setError(`Sample unavailable: ${errorMessage(reason)}`);
      }
    }
  };

  const downloadWav = async (side: Side): Promise<void> => {
    if (listeningLocksLab) return;
    const current = workflow.lifecycle.readableArtifact;
    if (!current) return;
    try {
      const bytes = await engine.readAudio(current.id, side);
      if (!mountedRef.current || workflow.lifecycle.readableArtifact !== current) return;
      triggerDownload(
        new Blob([bytes], { type: "audio/wav" }),
        `codec-abx-diagnostic-side-${side}-${current.id.slice(0, 8)}.wav`,
      );
    } catch (reason: unknown) {
      if (mountedRef.current && workflow.lifecycle.readableArtifact === current) {
        setError(`Diagnostic WAV unavailable: ${errorMessage(reason)}`);
      }
    }
  };

  const loadCanarySample = async (side: CanarySide): Promise<void> => {
    if (listeningLocksLab) return;
    const current = workflow.lifecycle.readableArtifact;
    if (!current?.canary?.audio) return;
    try {
      const bytes = await engine.readCanaryAudio?.(current.id, side);
      if (!bytes) throw new Error("This engine does not expose canary material");
      if (!mountedRef.current || workflow.lifecycle.readableArtifact !== current) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const previous = samplesRef.current[side];
      if (previous) URL.revokeObjectURL(previous);
      const next: SampleUrls = { ...samplesRef.current, [side]: url };
      samplesRef.current = next;
      if (mountedRef.current) setSamples(next);
    } catch (reason: unknown) {
      if (mountedRef.current && workflow.lifecycle.readableArtifact === current) {
        setError(`Canary sample unavailable: ${errorMessage(reason)}`);
      }
    }
  };

  const downloadCanaryWav = async (side: CanarySide): Promise<void> => {
    if (listeningLocksLab) return;
    const current = workflow.lifecycle.readableArtifact;
    if (!current?.canary?.audio) return;
    try {
      const bytes = await engine.readCanaryAudio?.(current.id, side);
      if (!bytes) throw new Error("This engine does not expose canary material");
      if (!mountedRef.current || workflow.lifecycle.readableArtifact !== current) return;
      triggerDownload(
        new Blob([bytes], { type: "audio/wav" }),
        `codec-abx-canary-${side}-${current.id.slice(0, 8)}.wav`,
      );
    } catch (reason: unknown) {
      if (mountedRef.current && workflow.lifecycle.readableArtifact === current) {
        setError(`Canary WAV unavailable: ${errorMessage(reason)}`);
      }
    }
  };

  const downloadJson = (): void => {
    const current = workflow.lifecycle.state.artifact;
    if (!current) return;
    const payload = buildDiagnosticExport(current, new Date().toISOString());
    triggerDownload(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      `codec-abx-diagnostic-${current.id.slice(0, 8)}.json`,
    );
  };

  const downloadListeningExport = async (): Promise<void> => {
    const payload = await listening.controller.exportPayload();
    if (payload === null) return;
    const id = artifact?.id.slice(0, 8) ?? "run";
    triggerDownload(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      `codec-abx-listening-${id}.json`,
    );
  };

  const closeListeningRun = async (): Promise<void> => {
    await listening.controller.closeSession();
    if (!mountedRef.current) return;
    setSidebarOpen(false);
    setView("setup");
  };

  const endTest = async (): Promise<void> => {
    // Stop the audible transport immediately; the controller owns whether a
    // paused graph can be resumed by an in-flight operation.
    listening.controller.pause();
    await listening.controller.seal();
    if (!mountedRef.current) return;
    if (listening.controller.state.snapshot?.lifecycle === "sealed") {
      setView("evidence");
      return;
    }
    // Seal could not complete while work was in flight. Terminate through the
    // explicit close path and never claim a sealed export for this run.
    await listening.controller.closeSession();
    if (!mountedRef.current) return;
    setError("The run was stopped before it could be sealed; no sealed export was produced.");
    setSidebarOpen(false);
    setView("setup");
  };

  const selectedName = clientSourceName(source);
  const selectedSize = clientSourceSize(source);
  const sourceSize = selectedSize === null
    ? null
    : `${(selectedSize / (1024 * 1024)).toFixed(2)} MiB`;
  const delivered = artifact?.measurements.delivered ?? null;
  const preparation = artifact?.preparation ?? null;
  const supportedPolicies = caps?.supportedPreparationPolicies ??
    (caps ? [caps.preparationPolicy] : []);
  const requestedPolicy = desktop ? "aligned-gain-matched-v1" : preparationMode;
  const preparationModeSupported = supportedPolicies.length === 0 ||
    supportedPolicies.includes(requestedPolicy);
  const alignedPreparationSupported = supportedPolicies.length === 0 ||
    supportedPolicies.includes("aligned-gain-matched-v1");
  const manualCanaryConflict = !desktop &&
    preparationMode === "codec-probe-only" && calibrationEnabled;
  const manualPrepareBlockedReason = listeningLocksLab
    ? "Close the current listening run before manual preparation."
    : !source
      ? "Choose a local audio file first."
      : !codecsReady
        ? unavailableSelection ?? "Choose available codecs first."
        : busy || resetting || changingSource || prepareTestBusy
          ? "Wait for the current operation to finish before manual preparation."
          : !preparationModeSupported
            ? "This build does not advertise the selected manual policy; no silent fallback is applied."
            : manualCanaryConflict
              ? "Manual raw preparation cannot generate the readiness check. Choose aligned for manual diagnostics or turn the readiness check off; Prepare test always uses aligned preparation."
              : null;
  const manualCanPrepare = manualPrepareBlockedReason === null;
  const primaryBlockedReason = listeningLocksLab && listening.state.session !== "configured"
    ? "Close the current listening run before preparing another test."
    : listening.state.planLocked
      ? "Reset the listening run before preparing another test."
      : !source
        ? "Choose a local audio file first."
        : !codecsReady
          ? unavailableSelection ?? "Choose available codecs first."
          : busy || resetting || changingSource
            ? "Wait for the current operation to finish before preparing the test."
            : !alignedPreparationSupported
              ? "This build does not advertise aligned + gain-matched preparation."
              : null;

  const planFieldsWithCalibration = useMemo<ListeningPlanFields>(
    () => ({ ...planFields, calibrationEnabled }),
    [planFields, calibrationEnabled],
  );
  const planValidation = useMemo(
    () => validateListeningPlan(planFieldsWithCalibration),
    [planFieldsWithCalibration],
  );
  const planDirty = listening.state.snapshot === null
    ? true
    : !planMatches(listening.state.snapshot, planFieldsWithCalibration);
  const planDisabled = listening.state.busy !== null || listening.state.planLocked ||
    prepareTestBusy || listening.state.session === "fatal";
  const calibrationDisabled = planDisabled || listening.state.session !== "idle";
  const runConfigured = listening.state.session === "configured";
  const canApplyPlan = runConfigured && listening.state.busy === null &&
    !listening.state.planLocked && planValidation.plan !== null && planDirty &&
    artifact !== null;
  const primaryCanPrepare = primaryBlockedReason === null && !prepareTestBusy &&
    listening.state.busy === null && !listening.state.planLocked &&
    planValidation.plan !== null;
  const primaryPairReady = workflow.isPairReady(inputs);
  const primaryProgressMessage = progress === null
    ? null
    : `${phaseLabel(progress.phase)}: ${progress.message}`;
  const globalError = error ?? workflowState.error;
  const snapshot = listening.state.snapshot;
  const terminal = listening.state.session === "completed" ||
    listening.state.session === "sealed" || listening.state.session === "void";

  const prepareTest = (): void => {
    if ((listeningLocksLab && listening.state.session !== "configured") ||
        prepareTestBusy || listening.state.busy !== null ||
        listening.state.planLocked) return;
    if (planValidation.plan === null) {
      setPlanError(planValidation.errors.join(" "));
      setView("setup");
      return;
    }
    if (primaryBlockedReason !== null) {
      setPlanError(primaryBlockedReason);
      setView("setup");
      return;
    }
    setPlanError(null);
    setModeNotice(null);
    setSidebarOpen(false);
    setView("listen");
    void runPrepareTest(planValidation.plan);
  };

  const retryPrepareTest = (): void => {
    if (prepareTestBusy || listening.state.busy !== null || listening.state.planLocked) return;
    if (planValidation.plan === null) {
      setPlanError(planValidation.errors.join(" "));
      setView("setup");
      return;
    }
    setPlanError(null);
    setSidebarOpen(false);
    setView("listen");
    void runPrepareTest(planValidation.plan);
  };

  const applyPlan = (): void => {
    const plan = planValidation.plan;
    if (plan === null) {
      setPlanError(planValidation.errors.join(" "));
      return;
    }
    if (artifact === null) {
      setPlanError("No prepared pair is retained. Run Prepare test again.");
      return;
    }
    if (listening.state.busy !== null || listening.state.planLocked) return;
    setPlanError(null);
    void listening.controller.prepareSession(plan, artifact, listeningReaders);
  };

  const changePlan = (patch: Partial<PlanFormFields>): void => {
    setPlanFields((previous) => ({ ...previous, ...patch }));
    setPlanError(null);
  };

  const changeCalibration = (enabled: boolean): void => {
    setCalibrationEnabled(enabled);
    setModeNotice(null);
    setPlanError(null);
  };

  const disableCalibration = (): void => {
    const next = validateListeningPlan({ ...planFields, calibrationEnabled: false });
    setCalibrationEnabled(false);
    setModeNotice(null);
    if (next.plan === null) {
      setPlanError(next.errors.join(" "));
      return;
    }
    setPlanError(null);
    if (artifact !== null && listening.state.session === "configured" &&
        listening.state.busy === null && !listening.state.planLocked) {
      void listening.controller.prepareSession(next.plan, artifact, listeningReaders);
    }
  };

  const runActions = snapshot !== null && listening.state.session !== "fatal" &&
      listening.state.session !== "idle"
    ? (
      <RunActions
        snapshot={snapshot}
        busy={listening.state.busy !== null}
        closing={listening.state.session === "closing"}
        canExport={listening.state.canExport}
        onExport={() => void downloadListeningExport()}
        onSeal={() => void listening.controller.seal()}
        onReset={() => void listening.controller.reset()}
        onClose={() => void closeListeningRun()}
      />
    )
    : null;

  const resultsContent = artifact === null ? null : (
    <section className="results panel" aria-labelledby="results-heading">
      <div className="section-head">
        <h2 id="results-heading">Prepared artifact</h2>
        <p className="section-meta">
          <span><code>{artifact.purpose}</code></span>
          <span>{artifact.elapsedMs} ms</span>
        </p>
      </div>
      <div className="tracks delivered-grid">
        <TrackCard
          side="a"
          artifact={artifact}
          actionsDisabled={controlsDisabled || status !== "complete"}
          onLoadSample={(side) => void loadSample(side)}
          onDownloadWav={(side) => void downloadWav(side)}
        />
        <TrackCard
          side="b"
          artifact={artifact}
          actionsDisabled={controlsDisabled || status !== "complete"}
          onLoadSample={(side) => void loadSample(side)}
          onDownloadWav={(side) => void downloadWav(side)}
        />
      </div>

      <PreparationReportPanel artifact={artifact} />

      <ValidityPanel artifact={artifact} />

      <CanaryMaterialPanel
        artifact={artifact}
        actionsDisabled={controlsDisabled || status !== "complete"}
        onLoad={(side) => void loadCanarySample(side)}
        onDownload={(side) => void downloadCanaryWav(side)}
      />

      <details className="measurements">
        <summary>Delivered PCM measurements</summary>
        {delivered ? (
          <>
            <p className="hint">
              Policy <code>{delivered.policy}</code>.{" "}
              {preparation ? (
                <>
                  Measured independently from the final serialized prepared WAV bytes.
                  Applied crop/lag/gains/common trim are recorded above; the lag shown
                  here is residual, not the applied alignment.
                </>
              ) : (
                <>
                  Measured from the unchanged delivered WAV bytes. The estimated lag was{" "}
                  <strong>not applied</strong>; there was no gain match, trim, filter,
                  gate or scoring.
                </>
              )}
            </p>
            <div className="measurement-sides">
              {(["a", "b"] as const).map((side) => {
                const summary = delivered[side];
                return (
                  <section className="track-card" key={side}
                    aria-label={`Side ${side.toUpperCase()} delivered measurements`}>
                    <h3>Side {side.toUpperCase()}</h3>
                    <dl className="facts">
                      <dt>Integrated loudness</dt>
                      <dd>{formatLevel(summary.integratedLufs, "LUFS", LOUDNESS_MEANINGS)}</dd>
                      <dt>Sample peak</dt>
                      <dd>{formatLevel(summary.samplePeakDbfs, "dBFS", PEAK_MEANINGS)}</dd>
                      <dt>Layout</dt>
                      <dd>
                        {summary.sampleRate} Hz ·{" "}
                        {summary.channels === 1 ? "mono" : "stereo"} ·{" "}
                        {summary.frames} frames
                      </dd>
                      <dt>Peak basis</dt>
                      <dd>Sample peak, not oversampled true peak.</dd>
                    </dl>
                  </section>
                );
              })}
            </div>
            <dl className="facts">
              <dt>
                {preparation ? "Residual lag" : "Estimated lag"}
              </dt>
              <dd>
                {delivered.alignment.status === "estimated" ? (
                  preparation ? (
                    <>
                      {delivered.alignment.lagSamples} samples (positive means B is
                      delayed); confidence{" "}
                      {delivered.alignment.confidence.toFixed(6)}; status{" "}
                      <code>estimated</code>. This is residual lag of the final
                      delivery, not the applied alignment (
                      {preparation.alignment.lagSamples} samples).
                    </>
                  ) : (
                    <>
                      {delivered.alignment.lagSamples} samples (positive means B is
                      delayed); confidence{" "}
                      {delivered.alignment.confidence.toFixed(6)}; status{" "}
                      <code>estimated</code>. Estimated only; no samples were shifted.
                    </>
                  )
                ) : (
                  <>
                    0 samples reported with confidence 0 and status{" "}
                    <code>no-evidence</code>. Silence/DC provided no alignment evidence,
                    so no lag was invented.{" "}
                    {preparation
                      ? "The applied lag is recorded above; this residual estimate carries no delay evidence."
                      : "No samples were shifted."}
                  </>
                )}
              </dd>
              <dt>Measurement bounds</dt>
              <dd>
                max lag {delivered.alignment.maxLagSamples} samples; probe{" "}
                {delivered.alignment.probeSamples} samples
              </dd>
              <dt>Loudness delta</dt>
              <dd>{formatLevel(delivered.loudnessDeltaDb, "dB", DELTA_MEANINGS)}</dd>
              <dt>
                {preparation ? "Residual null depth" : "Unshifted null depth"}
              </dt>
              <dd>
                {formatLevel(delivered.nullDepth.depthDb, "dB", NULL_MEANINGS)} over{" "}
                {delivered.nullDepth.comparedFrames} compared frames on the{" "}
                <code>{delivered.nullDepth.basis}</code>.
              </dd>
              <dt>Measurement policy</dt>
              <dd><code>{delivered.policy}</code></dd>
            </dl>
            <ul>
              {delivered.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="hint">
            This artifact does not contain a detailed delivered-pair measurement report.
          </p>
        )}
        <p className="warning">
          {preparation ? (
            <>
              <strong>Applied diagnostic preparation, not ABX authority.</strong> The
              shared aligned/gain-matched policy and PCM16 serialization ran on decoded
              codec-stage outputs. A delivered identical-pipeline null decision is
              reported separately, and optional canary material is a measured material
              check only. No bandwidth filtering, listener calibration trial, listener
              canary gate or ABX scoring has run. These measurements do not establish a
              valid ABX run or an audible difference, and browser/native codec output
              equivalence is not claimed.
            </>
          ) : (
            <>
              <strong>Missing preparation parity.</strong> No gain matching, alignment
              shift, bandwidth filtering, common peak protection, validity evaluation,
              canary material or experiment authority has run. Estimated lag is not
              applied alignment. These measurements do not establish a valid ABX run or
              an audible difference.
            </>
          )}
        </p>
      </details>

      {!listeningLocksLab ? <details className="diagnostic-audio" open={Object.values(samples).some(Boolean)}>
        <summary id="audition-heading">Optional diagnostic audition</summary>
        <p className="hint">
          Standard audio controls for informal inspection only. This is not a blinded or
          scored A/B/X trial and no answer mapping exists.
        </p>
        {(["a", "b"] as const).map((side) =>
          samples[side] ? (
            <figure key={side}>
              <figcaption>Diagnostic side {side.toUpperCase()} (not scored)</figcaption>
              <audio
                ref={audioRefCallbacks[side]}
                controls
                preload="metadata"
                src={samples[side]}
                aria-label={`Diagnostic side ${side.toUpperCase()} audition, not a scored trial`}
              />
            </figure>
          ) : (
            <p key={side} className="hint">
              Side {side.toUpperCase()} sample not loaded.
            </p>
          ),
        )}
        {(["pristine", "degraded"] as const).map((side) =>
          samples[side] ? (
            <figure key={side}>
              <figcaption>Canary material {side} (not scored)</figcaption>
              <audio
                ref={audioRefCallbacks[side]}
                controls
                preload="metadata"
                src={samples[side]}
                aria-label={`Canary material ${side} informal audition, not a scored trial`}
              />
            </figure>
          ) : null,
        )}
      </details> : null}

      <div className="actions">
        <button type="button" className="primary" onClick={downloadJson}>
          Download JSON diagnostics
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void reset();
          }}
          disabled={resetting || listeningLocksLab}
        >
          Release artifacts and reset
        </button>
      </div>
      <details>
        <summary>Disclosures</summary>
        <ul>
          {artifact.disclosures.map((disclosure) => (
            <li key={disclosure}>{disclosure}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Raw diagnostic artifact JSON</summary>
        <pre>{JSON.stringify(artifact, null, 2)}</pre>
      </details>
    </section>
  );

  const showSetupResults = view === "setup" && artifact !== null &&
    status === "complete" && workflowState.phase === "idle" && !listeningLocksLab;
  const websiteHome = !desktop && import.meta.env.BASE_URL === "/demo/";
  const Brand = websiteHome ? "a" : "div";

  return (
    <main className="app" data-runtime={runtime.kind}>
      <header className="topbar">
        <Brand
          className="brand"
          href={websiteHome ? "/" : undefined}
          aria-label={websiteHome ? "Audivane home" : undefined}
          title={websiteHome ? "Back to the Audivane website" : undefined}
        >
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 256 256">
              <path d="M120 40c-9 0-15 7-19 17L36 201c-2 4 0 7 5 7h36l18-40h27v-24h-16l16-40V40z" />
              <path d="M136 40c9 0 15 7 19 17l65 144c2 4 0 7-5 7h-36l-18-40h-27v-24h16l-16-40V40z" />
            </svg>
          </span>
          <div>
            <h1>Audivane</h1>
            <p className="brand-sub">Blind audio comparisons.</p>
          </div>
        </Brand>
        <div className="topbar-meta">
          <span className="runtime-pill">{desktop ? "Desktop native" : "Browser local"}</span>
          <span className="privacy-note">Audio stays on this device</span>
          <button
            type="button"
            className="mobile-setup secondary"
            aria-expanded={sidebarOpen}
            aria-controls="session-sidebar"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Setup &amp; device
          </button>
          <ThemeSwitcher preference={themePreference} onChange={setThemePreference} />
        </div>
      </header>

      <div className="workspace" data-sidebar-open={sidebarOpen ? "true" : "false"}>
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close setup"
          tabIndex={-1}
          onClick={() => setSidebarOpen(false)}
        />
        <Sidebar
          desktop={desktop}
          sourceName={selectedName}
          sourceSize={sourceSize}
          sourceDisabled={controlsDisabled}
          fileInputRef={fileInputRef}
          onSelectFile={selectFile}
          onChooseDesktopSource={() => void chooseDesktopSource()}
          output={listening.state.playback?.output}
          outputLocked={listening.state.planLocked}
          outputBusy={listening.state.busy !== null}
          onRefreshOutput={() => void listening.controller.refreshOutputDevices()}
          onSelectOutput={(deviceId) => void listening.controller.selectOutputDevice(deviceId)}
          onRequestOutput={() => void listening.controller.requestOutputDevice()}
          planFields={planFields}
          planDisabled={planDisabled}
          planLocked={listening.state.planLocked}
          planDirty={planDirty}
          planValid={planValidation.plan !== null}
          planError={planError}
          canApplyPlan={canApplyPlan}
          onApplyPlan={applyPlan}
          onPlanChange={changePlan}
          calibrationEnabled={calibrationEnabled}
          calibrationDisabled={calibrationDisabled}
          onCalibrationChange={changeCalibration}
          listeningLocked={listeningLocksLab}
          runConfigured={runConfigured}
          onClose={() => {
            setSidebarOpen(false);
            document.querySelector<HTMLButtonElement>("button[aria-controls='session-sidebar']")?.focus();
          }}
        />

        <div className="main">
          <nav className="viewbar" aria-label="Workspace views">
            {([
              ["setup", "Setup"],
              ["listen", "Listen"],
              ["evidence", "Evidence"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="tab"
                data-tab={id}
                aria-current={view === id ? "page" : undefined}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          {globalError ? (
            <div className="global-error status-error" role="alert">{globalError}</div>
          ) : null}

          <section
            className="view"
            id="setup-view"
            hidden={view !== "setup"}
            aria-labelledby="setup-heading"
          >
            <header className="view-head">
              <div>
                <h1 id="setup-heading">Set up a comparison</h1>
                <p className="subline">Choose the two codec chains.</p>
              </div>
            </header>

            {listeningLocksLab ? (
              <p className="notice" role="note">
                This test is active. End it to edit the source or chains.
              </p>
            ) : null}

            <section className="chain-board" aria-labelledby="config-heading">
              <div className="section-head">
                <h2 id="config-heading">Codec chains</h2>
                <p className="section-meta">
                  Up to {maxStagesPerSide} stage{maxStagesPerSide === 1 ? "" : "s"} per side
                </p>
              </div>
              <div className="chain-grid">
                <StageEditor
                  side="a"
                  stages={stagesA}
                  capabilities={caps}
                  maxStages={maxStagesPerSide}
                  disabled={controlsDisabled}
                  onChange={setStagesA}
                />
                <StageEditor
                  side="b"
                  stages={stagesB}
                  capabilities={caps}
                  maxStages={maxStagesPerSide}
                  disabled={controlsDisabled}
                  onChange={setStagesB}
                />
              </div>
              {!preparationModeSupported ? (
                <p className="status-error" role="alert">
                  This {desktop ? "desktop" : "browser"} build does not advertise the selected
                  manual preparation policy; no silent fallback is applied.
                </p>
              ) : null}
              {unavailableSelection ? (
                <p className="status-error" role="alert">{unavailableSelection}</p>
              ) : null}

              <details className="advanced-preparation">
                <summary>Advanced processing and diagnostics</summary>
                <div className="settings-row">
                  <fieldset className="codec-fields" disabled={controlsDisabled}>
                    <legend>Delivery rate</legend>
                    <label htmlFor="rate-mode">Sample-rate policy</label>
                    <select
                      id="rate-mode"
                      value={rateMode}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        setRateMode(event.target.value as SampleRateMode);
                      }}
                    >
                      <option value="native">Native source rate</option>
                      <option value="force_48k">Force 48 kHz delivery</option>
                    </select>
                    <p className="field-note">
                      Opus encodes at 48 kHz internally; final delivery follows the selected rate.
                    </p>
                  </fieldset>
                </div>
                <p className="field-note">Prepare diagnostic files without starting a listening test.</p>
                {desktop ? (
                  <details>
                    <summary>Native preparation policy details</summary>
                    <dl className="facts">
                      <dt>Policy</dt>
                      <dd><code>aligned-gain-matched-v1</code></dd>
                      <dt>Engine</dt>
                      <dd><code>engine-native-typescript</code></dd>
                      <dt>Runtime</dt>
                      <dd>Electron main process private worker with direct native FFmpeg</dd>
                    </dl>
                    <p className="field-note">
                      Raw codec-probe-only and unsupported policies are refused before source
                      reads, probes or subprocesses. The applied crop/gains/trim and final-byte
                      measurements come from this shared policy; no fallback or relabelling is applied.
                    </p>
                  </details>
                ) : (
                  <fieldset className="codec-fields" disabled={controlsDisabled}>
                    <legend>Manual preparation policy</legend>
                    <label htmlFor="preparation-policy">Delivery processing</label>
                    <select
                      id="preparation-policy"
                      value={preparationMode}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        const next = event.target.value as BrowserPreparationMode;
                        setPreparationMode(next);
                        setModeNotice(next === "codec-probe-only" && calibrationEnabled
                          ? "Raw manual preparation cannot generate the readiness check. Prepare test still uses aligned preparation; turn the readiness check off or choose aligned for manual diagnostics."
                          : null);
                      }}
                    >
                      <option value="codec-probe-only">
                        {PREPARATION_MODE_LABELS["codec-probe-only"]}
                      </option>
                      <option value="aligned-gain-matched-v1">
                        {PREPARATION_MODE_LABELS["aligned-gain-matched-v1"]}
                      </option>
                    </select>
                    <details>
                      <summary>Policy difference</summary>
                      <p className="field-note">
                        Raw mode keeps the codec-stage WAV and measures it. Prepared mode applies
                        alignment, independent gains and one common peak trim in a dedicated worker,
                        then measures the final serialized bytes. The desktop native worker applies the
                        same shared policy with native codecs.
                      </p>
                    </details>
                  </fieldset>
                )}
                {modeNotice ? (
                  <p className="field-note" role="status">{modeNotice}</p>
                ) : null}
                {manualPrepareBlockedReason ? (
                  <p className="field-note">{manualPrepareBlockedReason}</p>
                ) : null}
                <div className="prepare-bar">
                  <div className="prepare-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={!manualCanPrepare}
                      onClick={beginPrepare}
                    >
                      {desktop ? "Prepare native artifacts" : "Prepare diagnostic artifacts"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={status !== "preparing" || prepareTestBusy}
                      onClick={cancelPrepare}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={resetting || (!source && !artifact && status === "idle")}
                      onClick={() => void reset()}
                    >
                      {resetting ? "Resetting…" : "Reset"}
                    </button>
                  </div>
                  <div className="run-status" role="status" aria-live="polite">
                    {status === "preparing" ? (
                      <>
                        <strong>Preparing.</strong>{" "}
                        {progress ? `${phaseLabel(progress.phase)}: ${progress.message}` : "Starting…"}
                      </>
                    ) : status === "cancelling" ? (
                      <strong>
                        Cancelling and waiting for {desktop ? "main-owned native child cleanup" : "WASM worker termination"}…
                      </strong>
                    ) : status === "cancelled" ? (
                      <>
                        <strong>Cancelled.</strong>{" "}
                        {desktop
                          ? "Main-owned child processes and temporary files were cleaned up; retry is safe."
                          : "Worker terminated and temporary files removed; retry is safe."}
                      </>
                    ) : status === "complete" ? (
                      <strong>{desktop ? "Native artifacts ready." : "Diagnostic artifacts ready."}</strong>
                    ) : status === "error" ? (
                      <strong>Preparation failed.</strong>
                    ) : (
                      "Idle. One preparation at a time."
                    )}
                  </div>
                  <progress
                    aria-label="Preparation progress"
                    max={1}
                    value={status === "complete" ? 1 : status === "preparing" ? undefined : 0}
                  />
                </div>
              </details>
            </section>

            {artifact !== null && isRawCodecProbeArtifact(artifact) && !listeningLocksLab ? (
              <p className="field-note">
                Prepare test replaces this diagnostic artifact with an aligned pair; the
                current artifact is released when the new preparation starts.
              </p>
            ) : null}

            {showSetupResults ? resultsContent : null}

            <footer className="setup-footer">
              <p>
                {primaryBlockedReason ?? (primaryPairReady
                  ? "Prepared pair ready. Prepare test verifies and stages trial 1 paused."
                  : "Source and plan stay in the sidebar.")}
              </p>
              <button
                type="button"
                className="primary"
                disabled={!primaryCanPrepare}
                onClick={prepareTest}
              >
                Prepare test
              </button>
            </footer>
          </section>

          <section
            className="view"
            id="listen-view"
            hidden={view !== "listen"}
            aria-labelledby="listening-heading"
          >
            <ListeningSection
              artifact={listeningLocksLab || status === "complete" && !controlsDisabled ? artifact : null}
              listening={listening}
              runtimeKind={runtime.kind}
              primary={{
                phase: workflowState.phase,
                busy: prepareTestBusy,
                message: workflowState.message,
                progressMessage: primaryProgressMessage,
                error: workflowState.error,
                canPrepare: primaryCanPrepare,
                blockedReason: primaryBlockedReason,
                pairReady: primaryPairReady,
                onPrepare: retryPrepareTest,
                onCancel: cancelPrepareTest,
              }}
              plan={{
                valid: planValidation.plan !== null,
                dirty: planDirty,
                onDisableCalibration: disableCalibration,
              }}
              runActions={view === "listen" ? runActions : null}
              onEnd={() => void endTest()}
              onOpenEvidence={() => setView("evidence")}
            />
          </section>

          <section
            className="view"
            id="evidence-view"
            hidden={view !== "evidence"}
            aria-labelledby="evidence-heading"
          >
            <header className="view-head">
              <div>
                <h1 id="evidence-heading">Evidence</h1>
                <p className="subline">Processing, run record and exports.</p>
              </div>
              {!listeningLocksLab && (listening.state.session === "idle" ||
                listening.state.session === "configured") ? (
                <button
                  type="button"
                  className="primary"
                  disabled={!primaryCanPrepare}
                  onClick={prepareTest}
                >
                  Prepare test
                </button>
              ) : null}
            </header>

            {listening.state.error !== null && listening.state.session !== "fatal" ? (
              <div className="status-error" role="alert">
                <strong>Listening error:</strong> {listening.state.error.message}
                {listening.state.error.reasons.length > 0 ? (
                  <ul>
                    {listening.state.error.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {snapshot !== null && listening.state.session !== "fatal" ? (
              <RunRecord
                snapshot={snapshot}
                artifact={artifact}
                playback={listening.state.playback}
              />
            ) : (
              <p className="empty-state">No listening run yet. Prepare test to stage trial 1 paused.</p>
            )}
            {view === "evidence" ? runActions : null}
            {view === "evidence" ? (resultsContent ?? (
              <p className="empty-state">
                No prepared artifact yet. Choose source and chains in Setup, then run Prepare test.
              </p>
            )) : null}
            {terminal && snapshot !== null ? (
              <p className="field-note">
                The run record above is {snapshot.lifecycle === "completed"
                  ? "complete and final only if every gate held."
                  : "sealed or void and is not a final result."}
              </p>
            ) : null}
          </section>
        </div>
      </div>

      <footer className="app-footer">
        <CapabilitiesPanel state={capabilities} kind={runtime.kind} />
        <details className="scope-note">
          <summary>Scientific scope</summary>
          <p className="scope-lede">
            {desktop ? (
              <>
                Native TypeScript/FFmpeg preparation and the experiment service run in the
                Electron main process’s private worker, with the shared React listening flow and
                Web Audio player. There are no uploads, no server fallback and no silent
                WASM/engine substitution.
              </>
            ) : (
              <>
                Processing stays on this device. FFmpeg runs in a dedicated worker;
                LC3 and LDAC use separate WASM modules. There are no uploads, runtime
                CDN assets or server fallback.
              </>
            )}
          </p>
          <p className="warning" role="note">
            <strong>Preparation is diagnostic only.</strong>{" "}
            The primary <strong>Prepare test</strong> action applies the shared{" "}
            <code>aligned-gain-matched-v1</code> policy to decoded codec-stage outputs
            {desktop ? " in the Electron main process’s private native TypeScript worker" : ""}:
            alignment/crop, independent constant gains, one common peak trim and PCM16
            serialization. It records the actual applied operations, evaluates a delivered
            identical-pipeline null decision and can optionally generate diagnostic canary
            material from the first 10 s of the final Side A. Advanced manual preparation can
            instead request raw codec-probe-only diagnostics, which applies no alignment, gain
            match, trim, validity evaluation, canary material or scoring. Neither path claims
            codec equivalence, runs a listener calibration trial or performs ABX scoring itself.
            The Listen view can run a local calibration/scored flow on the verified aligned
            artifact. Local responses do not prove audibility, attention or qualified hearing,
            and local custody is not tamper-proof.
          </p>
        </details>
      </footer>
    </main>
  );
}
