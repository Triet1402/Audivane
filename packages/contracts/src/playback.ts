import type { PlaybackLabel, PublicTrial } from "./experiment.js";

export interface PlaybackLoop {
  readonly enabled: boolean;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/** Capability of the browser to route Web Audio output at all. */
export type OutputDeviceSupport = "unsupported" | "unavailable" | "supported";

/** A single in-flight output operation; only one runs at a time. */
export type OutputDeviceOperation = "refresh" | "select" | "request";

/** Browser-observed routing change since the last successful selection. */
export type OutputRouteChange = "none" | "changed" | "lost";

/**
 * Opaque local-UI device entry. The deviceId is a browser handle and the label is
 * browser-provided; neither belongs in exports or shared diagnostics by default.
 * The empty deviceId denotes the browser/OS default output.
 */
export interface OutputDeviceEntry {
  readonly deviceId: string;
  readonly label: string;
}

/**
 * Optional public output-device state. It describes capabilities, local entries,
 * intent and browser-observed routing, never a physical channel claim. The
 * default output remains usable when selection is unsupported.
 */
export interface PlaybackOutputState {
  readonly support: OutputDeviceSupport;
  /** True when an explicit output chooser API is available. */
  readonly canRequest: boolean;
  readonly devices: readonly OutputDeviceEntry[];
  readonly pending: OutputDeviceOperation | null;
  /** Last device explicitly requested, including a selection that failed. */
  readonly requestedDeviceId: string | null;
  /** Last successfully applied device, or null when no device was ever applied. */
  readonly selectedDeviceId: string | null;
  /** Browser-reported sink id, or null when the browser cannot report it. */
  readonly observedDeviceId: string | null;
  readonly change: OutputRouteChange;
  /** Sanitised; never contains a device id or label. */
  readonly error: string | null;
}

/** Public playback state never describes which physical source X represents. */
export interface PlaybackSnapshot {
  readonly phase: "empty" | "loading" | "ready" | "error" | "disposed";
  readonly trial: PublicTrial | null;
  readonly playing: boolean;
  readonly selected: PlaybackLabel;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly loop: PlaybackLoop;
  readonly deliveredSampleRate: number | null;
  readonly outputSampleRate: number | null;
  readonly channels: 1 | 2 | null;
  readonly error: string | null;
  /**
   * True when a newly staged trial has no active current-trial selection yet.
   * `selected` may still describe the retired sounding label for compatibility,
   * but it is not the new trial's mapping and answers must stay unavailable
   * until the listener picks A, B or X. Omitted by adapters that never carry.
   */
  readonly selectionRequired?: boolean;
  /**
   * True while a retired trial graph is still sounding behind a staged next
   * trial. `trial`, `selected` and `positionSeconds` then describe the new token
   * and shared clock; this flag says the audible material belongs to the
   * previous trial and must not be relabelled with the new mapping.
   */
  readonly carryingPreviousTrial?: boolean;
  /** Optional for backward-compatible adapters/fakes; the browser adapter always publishes it. */
  readonly output?: PlaybackOutputState;
}

/** A/B/X are display labels; the experiment runtime already resolved the mapping. */
export type TrialAudioReader = (token: string, label: PlaybackLabel) => Promise<ArrayBuffer>;

/**
 * Optional load mode. Initial preparation omits it and retains the existing
 * atomic-replacement/stop-on-failure semantics. Continuation is used only after
 * a confirmed answer: the still-sounding graph and its clock stay untouched
 * while all three new buffers are verified and staged, then an explicit
 * `select` switches at the shared position.
 */
export interface TrialLoadOptions {
  readonly carryPrevious?: boolean;
}

/** Shared controls; this slice implements the browser Web Audio adapter. */
export interface TrialPlayer {
  /** Freeze old playback immediately; publish all three buffers together or none.
   * Preserve side/play intent/position/loop across Next, clamped to the new pair.
   * A failed load retains retry intent but has no playable old or partial buffers.
   * With `options.carryPrevious`, the sounding graph/clock/loop stay untouched
   * while the new set is verified; on success it is staged with
   * `selectionRequired` (and `carryingPreviousTrial` while it sounds), and a
   * failed continuation keeps the retired sound only, never a partial set.
   * Reader/format/layout failures resolve an error snapshot; invalid controls throw.
   */
  loadTrial(
    trial: PublicTrial,
    read: TrialAudioReader,
    options?: TrialLoadOptions,
  ): Promise<PlaybackSnapshot>;
  play(): Promise<PlaybackSnapshot>;
  pause(): PlaybackSnapshot;
  select(label: PlaybackLabel): PlaybackSnapshot;
  seek(positionSeconds: number): PlaybackSnapshot;
  setLoop(loop: PlaybackLoop): PlaybackSnapshot;
  snapshot(): PlaybackSnapshot;
  /** Publish mode/state changes; UI may poll snapshot for animated position. */
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
  /** Invalidate pending loads, clear audio and reset intent/position/loop. */
  reset(): PlaybackSnapshot;
  /** Idempotent; terminate pending work and close resources owned by this player. */
  dispose(): Promise<void>;
  /**
   * Optional output-device extension. The browser adapter implements all three.
   * Enumeration never captures a microphone or requests media permission and
   * the default output remains usable when selection is unsupported.
   */
  refreshOutputDevices?(): Promise<PlaybackSnapshot>;
  /** Pauses first and never auto-resumes. Resolves an error snapshot on failure. */
  selectOutputDevice?(deviceId: string): Promise<PlaybackSnapshot>;
  /** Explicit browser output chooser, when the browser exposes one. */
  requestOutputDevice?(): Promise<PlaybackSnapshot>;
}
