/**
 * Browser Web Audio implementation of the public TrialPlayer contract.
 *
 * All three labels share one AudioContext timeline: three buffer sources are
 * started together at the same timestamp with the same offset and loop bounds.
 * Selection only changes complementary linear gains, so a side switch never
 * restarts the clock or changes the paused/playing state.
 */
import type {
  OutputDeviceEntry,
  OutputDeviceOperation,
  OutputDeviceSupport,
  OutputRouteChange,
  PlaybackLabel,
  PlaybackLoop,
  PlaybackOutputState,
  PlaybackSnapshot,
  PublicTrial,
  TrialAudioReader,
  TrialLoadOptions,
  TrialPlayer,
} from "@codec-abx/contracts";

import { PlaybackError, playbackError } from "./errors.js";
import {
  advancePosition,
  clampLoop,
  clampPosition,
  positionForLoop,
  validateLoop,
} from "./timeline.js";
import {
  decodeCanonicalPcm16,
  MAX_CLIP_BYTES,
  type DecodedClip,
} from "./wav.js";

export const GAIN_RAMP_SECONDS = 0.005;
/** Schedule live groups ahead of graph construction, across render quanta. */
export const LIVE_SCHEDULE_LEAD_SECONDS = 0.01;

const LABELS: readonly PlaybackLabel[] = Object.freeze(["A", "B", "X"]);
const ZERO_LOOP: PlaybackLoop = Object.freeze({
  enabled: false,
  startSeconds: 0,
  endSeconds: 0,
});

interface ParamModel {
  readonly from: number;
  readonly to: number;
  readonly startTime: number;
  readonly endTime: number;
}

interface SourceGraph {
  readonly id: number;
  readonly duration: number;
  readonly loop: PlaybackLoop;
  readonly sources: Record<PlaybackLabel, AudioBufferSourceNode>;
  readonly gains: Record<PlaybackLabel, GainNode>;
  readonly gainModels: Record<PlaybackLabel, ParamModel>;
  readonly master: GainNode;
  masterModel: ParamModel;
  readonly startTime: number;
  readonly basePosition: number;
  ignoreEnd: boolean;
  endedHandled: boolean;
  cleanedSources: number;
}

interface ClipFacts {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly durationSeconds: number;
}

/**
 * One verified A/B/X set held behind the sounding graph. Only one set may be
 * pending; committing it replaces the active ownership and releases the old
 * references on the next switch.
 */
interface StagedTrial {
  readonly trial: PublicTrial;
  readonly clips: Record<PlaybackLabel, DecodedClip> | null;
  readonly buffers: Record<PlaybackLabel, AudioBuffer> | null;
  readonly facts: ClipFacts;
}

export interface BrowserTrialPlayerOptions {
  /**
   * Explicit dependency seam for graph/offline tests. The caller owns this
   * context and must close it itself; the player never closes an injected
   * context. Without it the player lazily creates and owns an AudioContext on
   * the first play call (a user-gesture path).
   */
  readonly audioContext?: BaseAudioContext;
}

function emptyRecord<T>(): Record<PlaybackLabel, T> {
  return {} as Record<PlaybackLabel, T>;
}

function isLabel(value: unknown): value is PlaybackLabel {
  return value === "A" || value === "B" || value === "X";
}

function freezeTrial(input: PublicTrial): PublicTrial {
  if (typeof input !== "object" || input === null) {
    playbackError("invalid-trial", "trial must be a prepared public trial DTO");
  }
  const candidate = input as {
    readonly runId?: unknown;
    readonly token?: unknown;
    readonly trialIndex?: unknown;
    readonly kind?: unknown;
  };
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) {
    playbackError("invalid-trial", "trial runId must be a non-empty string");
  }
  if (typeof candidate.token !== "string" || candidate.token.length === 0) {
    playbackError("invalid-trial", "trial token must be a non-empty string");
  }
  if (
    typeof candidate.trialIndex !== "number" ||
    !Number.isSafeInteger(candidate.trialIndex) ||
    candidate.trialIndex < 1
  ) {
    playbackError("invalid-trial", "trial index must be a positive integer");
  }
  if (candidate.kind !== "calibration" && candidate.kind !== "scored") {
    playbackError("invalid-trial", "trial kind must be calibration or scored");
  }
  return Object.freeze({
    runId: candidate.runId,
    token: candidate.token,
    trialIndex: candidate.trialIndex,
    kind: candidate.kind,
  });
}

function paramValue(model: ParamModel, time: number): number {
  if (time <= model.startTime) return model.from;
  if (time >= model.endTime) return model.to;
  const span = model.endTime - model.startTime;
  if (span <= 0) return model.to;
  return model.from + (model.to - model.from) * ((time - model.startTime) / span);
}

function constantModel(value: number): ParamModel {
  return { from: value, to: value, startTime: 0, endTime: 0 };
}

function isOfflineContext(context: BaseAudioContext): boolean {
  return typeof (context as BaseAudioContext & { startRendering?: unknown }).startRendering === "function";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown audio failure";
  const prefix = error instanceof PlaybackError ? `${error.code}: ` : "";
  return `${prefix}${message}`.slice(0, 240);
}

interface SinkCapableContext extends BaseAudioContext {
  setSinkId?: (sinkId: string) => Promise<void>;
  readonly sinkId?: string;
}

interface EventCapableContext {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface ChooserDevice {
  readonly deviceId?: unknown;
}

interface OutputMediaDevices {
  enumerateDevices?: () => Promise<readonly MediaDeviceInfo[]>;
  selectAudioOutput?: () => Promise<ChooserDevice>;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

const DEFAULT_OUTPUT: OutputDeviceEntry = Object.freeze({
  deviceId: "",
  label: "System default output",
});

function audioConstructor(): (new () => AudioContext) | undefined {
  const globals = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  return typeof AudioContext === "undefined" ? globals.webkitAudioContext : AudioContext;
}

function globalSinkApiAvailable(): boolean {
  const Constructor = audioConstructor();
  const prototype = Constructor?.prototype as { setSinkId?: unknown } | undefined;
  return typeof prototype?.setSinkId === "function";
}

function contextSinkApiAvailable(context: BaseAudioContext | null): boolean {
  if (context !== null) return typeof (context as SinkCapableContext).setSinkId === "function";
  return globalSinkApiAvailable();
}

function outputMediaDevices(): OutputMediaDevices | null {
  try {
    const navigatorValue = (globalThis as { navigator?: { mediaDevices?: OutputMediaDevices } }).navigator;
    return navigatorValue?.mediaDevices ?? null;
  } catch {
    return null;
  }
}

function chooserApiAvailable(): boolean {
  return typeof outputMediaDevices()?.selectAudioOutput === "function";
}

function observedSink(context: BaseAudioContext | null): string | null {
  if (context === null) return null;
  const value = (context as SinkCapableContext).sinkId;
  return typeof value === "string" ? value : null;
}

/** DOMException names are safe to disclose; messages may contain device handles. */
function safeErrorName(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name)) return name;
  }
  return "Error";
}

function outputError(code: string, detail: string): string {
  return `${code}: ${detail}`.slice(0, 240);
}

function normaliseDevices(devices: readonly MediaDeviceInfo[]): readonly OutputDeviceEntry[] {
  const entries: OutputDeviceEntry[] = [];
  let defaultSeen = false;
  for (const device of devices) {
    if (device.kind !== "audiooutput") continue;
    const deviceId = typeof device.deviceId === "string" ? device.deviceId : "";
    if (deviceId === "") defaultSeen = true;
    const label = typeof device.label === "string" && device.label.length > 0
      ? device.label.slice(0, 160)
      : deviceId === ""
        ? DEFAULT_OUTPUT.label
        : "Output device (label unavailable)";
    entries.push(Object.freeze({ deviceId, label }));
  }
  if (!defaultSeen) entries.unshift(DEFAULT_OUTPUT);
  return Object.freeze(entries);
}

export class BrowserTrialPlayer implements TrialPlayer {
  private context: BaseAudioContext | null = null;
  private ownsContext = false;
  private clips: Record<PlaybackLabel, DecodedClip> | null = null;
  private buffers: Record<PlaybackLabel, AudioBuffer> | null = null;
  private facts: ClipFacts | null = null;
  /** Verified next-trial audio awaiting an explicit A/B/X selection. */
  private staged: StagedTrial | null = null;
  private selectionRequiredValue = false;
  private carryingPreviousValue = false;
  private loading = false;
  private deviceChangeDeferred = false;
  private graph: SourceGraph | null = null;
  private readonly graphs = new Set<SourceGraph>();
  private graphSequence = 0;
  private generation = 0;
  private phase: PlaybackSnapshot["phase"] = "empty";
  private trialValue: PublicTrial | null = null;
  private selectedValue: PlaybackLabel = "X";
  private positionValue = 0;
  private loopValue: PlaybackLoop = ZERO_LOOP;
  private playIntent = false;
  private errorValue: string | null = null;
  private blockedUntil = 0;
  private disposed = false;
  private readonly listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  private outputSupport: OutputDeviceSupport = "unsupported";
  private outputCanRequest = false;
  private outputDevices: readonly OutputDeviceEntry[] = Object.freeze([]);
  private outputPending: OutputDeviceOperation | null = null;
  private outputRequested: string | null = null;
  private outputSelected: string | null = null;
  private outputObserved: string | null = null;
  private outputChange: OutputRouteChange = "none";
  private outputError: string | null = null;
  // Output events may follow setSinkId resolution and a subsequent trial load.
  // This epoch changes only on reset/dispose, not on ordinary trial generations.
  private outputEpoch = 0;
  private expectedOutputEvent: { epoch: number; deviceId: string } | null = null;
  private sinkListener: {
    readonly context: SinkCapableContext & EventCapableContext;
    readonly handler: () => void;
  } | null = null;
  private mediaListener: { readonly media: OutputMediaDevices; readonly handler: () => void } | null = null;

  constructor(options: BrowserTrialPlayerOptions = {}) {
    const injected = options.audioContext;
    if (injected !== undefined) {
      if (
        typeof injected !== "object" ||
        injected === null ||
        typeof injected.createBuffer !== "function" ||
        typeof injected.createBufferSource !== "function" ||
        typeof injected.createGain !== "function" ||
        typeof injected.sampleRate !== "number" ||
        typeof injected.destination !== "object"
      ) {
        throw new PlaybackError("invalid-context", "injected audio context is not usable");
      }
      this.context = injected;
      this.ownsContext = false;
      this.attachContextOutputListener(injected);
    }
    this.outputSupport = contextSinkApiAvailable(this.context) ? "supported" : "unsupported";
    this.outputCanRequest = this.outputSupport === "supported" && chooserApiAvailable();
    this.outputObserved = observedSink(this.context);
    this.attachMediaDeviceListener();
  }

  async loadTrial(
    trial: PublicTrial,
    read: TrialAudioReader,
    options: TrialLoadOptions = {},
  ): Promise<PlaybackSnapshot> {
    this.requireActive();
    if (this.outputPending !== null) throw new PlaybackError("output-busy", "Wait for output setup before loading a trial");
    const frozen = freezeTrial(trial);
    if (typeof read !== "function") {
      throw new PlaybackError("invalid-reader", "trial reader must be a function");
    }
    const continuation = options.carryPrevious === true;
    const reader = read;
    const token = frozen.token;
    const generation = ++this.generation;
    this.loading = true;

    if (continuation) {
      // Keep the immutable sounding graph, its clock and the active buffers
      // untouched. The verified next set is held aside until an explicit pick.
      this.staged = null;
      this.selectionRequiredValue = true;
      this.carryingPreviousValue = this.graph !== null && !this.graph.ignoreEnd;
      this.trialValue = frozen;
      this.errorValue = null;
      this.phase = "loading";
    } else {
      const frozenPosition = this.currentPosition();
      this.positionValue = frozenPosition;
      const now = this.context?.currentTime ?? 0;
      if (this.graph) {
        this.stopGraph(this.graph, now + GAIN_RAMP_SECONDS, true);
      }
      this.staged = null;
      this.clips = null;
      this.buffers = null;
      this.facts = null;
      this.selectionRequiredValue = false;
      this.carryingPreviousValue = false;
      this.phase = "loading";
      this.trialValue = frozen;
      this.errorValue = null;
    }
    this.emit();

    const reads = LABELS.map((label) =>
      Promise.resolve().then(() => reader(token, label)),
    );
    const settled = await Promise.allSettled(reads);
    if (this.generation !== generation || this.disposed) {
      if (this.generation === generation) this.loading = false;
      return this.snapshot();
    }

    const decoded: DecodedClip[] = [];
    let failure: string | null = null;
    for (let index = 0; index < LABELS.length; index += 1) {
      const result = settled[index];
      if (!result) {
        failure = "load-failed: a reader result disappeared";
        break;
      }
      if (result.status === "rejected") {
        failure = "load-failed: one or more A/B/X reads failed";
        break;
      }
      const value = result.value;
      if (!(value instanceof ArrayBuffer)) {
        failure = "load-failed: reader did not return an ArrayBuffer";
        break;
      }
      if (value.byteLength > MAX_CLIP_BYTES) {
        failure = `load-failed: audio exceeds the ${MAX_CLIP_BYTES} byte bound`;
        break;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(value.slice(0));
      } catch {
        failure = "load-failed: audio buffer could not be copied";
        break;
      }
      try {
        decoded.push(decodeCanonicalPcm16(bytes));
      } catch (error) {
        failure = errorText(error);
        break;
      }
    }

    if (failure !== null) {
      if (this.generation === generation) this.loading = false;
      if (continuation) this.failContinuationLoad(generation, failure, frozen);
      else this.failLoad(generation, failure);
      return this.snapshot();
    }

    const [a, b, x] = decoded;
    if (!a || !b || !x) {
      if (this.generation === generation) this.loading = false;
      if (continuation) this.failContinuationLoad(generation, "load-failed: A/B/X audio was incomplete", frozen);
      else this.failLoad(generation, "load-failed: A/B/X audio was incomplete");
      return this.snapshot();
    }
    if (
      a.sampleRate !== b.sampleRate ||
      b.sampleRate !== x.sampleRate ||
      a.channels !== b.channels ||
      b.channels !== x.channels ||
      a.frames !== b.frames ||
      b.frames !== x.frames
    ) {
      if (this.generation === generation) this.loading = false;
      if (continuation) this.failContinuationLoad(generation, "load-failed: A/B/X layouts differ", frozen);
      else this.failLoad(generation, "load-failed: A/B/X layouts differ");
      return this.snapshot();
    }
    if (a.channelData.length + b.channelData.length + x.channelData.length > 6) {
      if (this.generation === generation) this.loading = false;
      if (continuation) this.failContinuationLoad(generation, "load-failed: channel copy count is inconsistent", frozen);
      else this.failLoad(generation, "load-failed: channel copy count is inconsistent");
      return this.snapshot();
    }

    const clips: Record<PlaybackLabel, DecodedClip> = { A: a, B: b, X: x };
    let audioBuffers: Record<PlaybackLabel, AudioBuffer> | null = null;
    if (this.context) {
      try {
        audioBuffers = this.createAudioBuffers(this.context, clips);
      } catch (error) {
        if (this.generation === generation) this.loading = false;
        if (continuation) this.failContinuationLoad(generation, errorText(error), frozen);
        else this.failLoad(generation, errorText(error));
        return this.snapshot();
      }
    }
    if (this.generation !== generation || this.disposed) {
      if (this.generation === generation) this.loading = false;
      return this.snapshot();
    }
    this.loading = false;

    const duration = a.durationSeconds;
    const facts: ClipFacts = {
      sampleRate: a.sampleRate,
      channels: a.channels,
      frames: a.frames,
      durationSeconds: duration,
    };

    if (continuation) {
      this.staged = {
        trial: frozen,
        clips: audioBuffers ? null : clips,
        buffers: audioBuffers,
        facts,
      };
      this.trialValue = frozen;
      this.loopValue = clampLoop(this.loopValue, duration);
      this.phase = "ready";
      this.errorValue = null;
      this.selectionRequiredValue = true;
      this.carryingPreviousValue = this.graph !== null && !this.graph.ignoreEnd;
      // Never start the new token before the listener explicitly picks a label.
      if (this.graph === null) this.playIntent = false;
      this.emit();
      return this.snapshot();
    }

    this.staged = null;
    this.facts = facts;
    this.clips = audioBuffers ? null : clips;
    this.buffers = audioBuffers;
    this.selectionRequiredValue = false;
    this.carryingPreviousValue = false;
    this.loopValue = clampLoop(this.loopValue, duration);
    this.positionValue = this.loopValue.enabled
      ? positionForLoop(this.positionValue, this.loopValue, duration)
      : clampPosition(this.positionValue, duration);
    this.phase = "ready";
    this.errorValue = null;

    if (this.playIntent) {
      try {
        await this.beginPlayback(generation);
      } catch (error) {
        if (this.generation !== generation || this.disposed) return this.snapshot();
        this.playIntent = false;
        this.errorValue = errorText(error);
      }
      if (this.generation !== generation || this.disposed) return this.snapshot();
    }
    this.emit();
    return this.snapshot();
  }

  async play(): Promise<PlaybackSnapshot> {
    this.requireActive();
    if (this.outputPending !== null) throw new PlaybackError("output-busy", "Wait for output setup before playing");
    if (this.phase !== "ready" || !this.facts) {
      throw new PlaybackError("not-loaded", "trial audio is not ready to play");
    }
    if (this.selectionRequiredValue && this.staged !== null) {
      // A retired graph may still be sounding; otherwise the new token has no
      // authoritative label yet, so starting it would mislabel the audio.
      if (this.graph !== null && !this.graph.ignoreEnd) return this.snapshot();
      throw new PlaybackError("not-loaded", "choose A, B or X for the staged trial before playing");
    }
    const generation = this.generation;
    this.playIntent = true;
    let context: BaseAudioContext;
    try {
      context = this.ensureContext();
      this.ensureBuffers();
      await this.resumeContext(context);
    } catch (error) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.playIntent = false;
      this.errorValue = errorText(error);
      this.emit();
      return this.snapshot();
    }
    if (this.generation !== generation || this.disposed) return this.snapshot();
    if (!this.playIntent) return this.snapshot();
    if (this.phase !== "ready" || !this.facts) {
      this.playIntent = false;
      this.emit();
      return this.snapshot();
    }

    try {
      if (this.graph === null) {
        const loop = this.currentLoop();
        if (!loop.enabled && this.positionValue >= this.facts.durationSeconds - 1e-9) {
          this.positionValue = 0;
        }
        this.startGraph(
          this.positionValue,
          loop,
          Math.max(context.currentTime, this.blockedUntil),
        );
      }
      this.errorValue = null;
    } catch (error) {
      if (this.graph) this.stopGraph(this.graph, context.currentTime, false);
      this.playIntent = false;
      this.errorValue = errorText(error);
    }
    this.emit();
    return this.snapshot();
  }

  pause(): PlaybackSnapshot {
    this.requireActive();
    const duration = this.durationSeconds();
    const position = this.currentPosition();
    this.playIntent = false;
    this.positionValue = duration > 0
      ? (this.currentLoop().enabled
        ? positionForLoop(position, this.currentLoop(), duration)
        : clampPosition(position, duration))
      : position;
    if (this.graph && this.context) {
      this.stopGraph(this.graph, this.context.currentTime + GAIN_RAMP_SECONDS, true);
    }
    this.emit();
    return this.snapshot();
  }

  select(label: PlaybackLabel): PlaybackSnapshot {
    this.requireActive();
    if (!isLabel(label)) {
      throw new PlaybackError("invalid-label", "playback label must be A, B or X");
    }
    if (this.selectionRequiredValue) {
      if (this.staged === null || this.phase !== "ready") {
        throw new PlaybackError("not-loaded", "the staged A/B/X set is not ready for selection");
      }
      this.commitStagedSelection(label);
      return this.snapshot();
    }
    const changed = this.selectedValue !== label;
    this.selectedValue = label;
    if (changed && this.graph && this.context) {
      this.scheduleSelection(this.graph, this.context.currentTime);
    }
    this.emit();
    return this.snapshot();
  }

  /**
   * Commit the verified pending set as the active trial. If the retired graph
   * is still sounding, switch at the live shared position using the existing
   * fade/click-safe restart; otherwise stay paused at the retained position.
   */
  private commitStagedSelection(label: PlaybackLabel): void {
    const staged = this.staged;
    if (staged === null) {
      throw new PlaybackError("not-loaded", "no staged A/B/X set is available");
    }
    const duration = staged.facts.durationSeconds;
    const sharedPosition = this.graph !== null ? this.currentPosition() : this.positionValue;
    const loop = clampLoop(this.loopValue, duration);
    const target = loop.enabled
      ? positionForLoop(sharedPosition, loop, duration)
      : clampPosition(sharedPosition, duration);
    this.staged = null;
    this.clips = staged.clips;
    this.buffers = staged.buffers;
    this.facts = staged.facts;
    this.trialValue = staged.trial;
    this.loopValue = loop;
    this.positionValue = target;
    this.selectedValue = label;
    this.selectionRequiredValue = false;
    this.carryingPreviousValue = false;
    this.errorValue = null;
    if (this.graph && this.context) {
      this.restartGraph(this.graph, target, loop, this.context.currentTime, true);
    }
    this.emit();
  }

  seek(positionSeconds: number): PlaybackSnapshot {
    this.requireActive();
    if (!this.facts) {
      throw new PlaybackError("not-loaded", "trial audio is not ready to seek");
    }
    if (!Number.isFinite(positionSeconds)) {
      throw new PlaybackError("invalid-position", "seek position must be finite");
    }
    const duration = this.facts.durationSeconds;
    const loop = this.currentLoop();
    const target = loop.enabled
      ? positionForLoop(positionSeconds, loop, duration)
      : clampPosition(positionSeconds, duration);
    this.positionValue = target;
    if (this.graph && this.context) {
      this.restartGraph(this.graph, target, loop, this.context.currentTime);
    }
    this.emit();
    return this.snapshot();
  }

  setLoop(loop: PlaybackLoop): PlaybackSnapshot {
    this.requireActive();
    if (typeof loop !== "object" || loop === null) {
      throw new PlaybackError("invalid-loop", "loop must be an object");
    }
    if (typeof loop.enabled !== "boolean") {
      throw new PlaybackError("invalid-loop", "loop.enabled must be a boolean");
    }
    if (!Number.isFinite(loop.startSeconds) || !Number.isFinite(loop.endSeconds)) {
      throw new PlaybackError("invalid-loop", "loop bounds must be finite");
    }
    if (loop.startSeconds < 0) {
      throw new PlaybackError("invalid-loop", "loop start must not be negative");
    }
    if (this.phase !== "ready" || !this.facts) {
      if (loop.enabled === false) {
        this.loopValue = ZERO_LOOP;
        this.emit();
        return this.snapshot();
      }
      throw new PlaybackError("not-loaded", "trial audio must be loaded before enabling a loop");
    }
    let normalized: PlaybackLoop;
    try {
      normalized = validateLoop(loop, this.facts.durationSeconds);
    } catch (error) {
      throw new PlaybackError(
        "invalid-loop",
        error instanceof Error ? error.message : "loop bounds are invalid",
      );
    }
    const previous = this.loopValue;
    if (
      previous.enabled === normalized.enabled &&
      previous.startSeconds === normalized.startSeconds &&
      previous.endSeconds === normalized.endSeconds
    ) {
      return this.snapshot();
    }
    const duration = this.facts.durationSeconds;
    const position = this.currentPosition();
    this.loopValue = normalized;
    this.positionValue = normalized.enabled
      ? positionForLoop(position, normalized, duration)
      : clampPosition(position, duration);
    if (this.graph && this.context) {
      this.restartGraph(this.graph, this.positionValue, normalized, this.context.currentTime);
    }
    this.emit();
    return this.snapshot();
  }

  snapshot(): PlaybackSnapshot {
    const sounded = this.graph !== null && !this.graph.ignoreEnd;
    // While the retired graph sounds, duration/position describe the audible
    // material. Once it ends or was never playing, the staged set is next.
    const facts = this.staged !== null && !sounded ? this.staged.facts : this.facts;
    const duration = facts?.durationSeconds ?? 0;
    const loop = duration > 0
      ? clampLoop(this.loopValue, duration)
      : this.phase === "empty" || this.phase === "disposed"
        ? ZERO_LOOP
        : Object.freeze({ ...this.loopValue });
    const rawPosition = this.currentPosition();
    const position = duration > 0
      ? (loop.enabled ? positionForLoop(rawPosition, loop, duration) : clampPosition(rawPosition, duration))
      : 0;
    const trial = this.trialValue ? Object.freeze({ ...this.trialValue }) : null;
    const output: PlaybackOutputState = Object.freeze({
      support: this.outputSupport,
      canRequest: this.outputCanRequest,
      devices: Object.freeze(this.outputDevices.map((device) =>
        Object.freeze({ deviceId: device.deviceId, label: device.label }))),
      pending: this.outputPending,
      requestedDeviceId: this.outputRequested,
      selectedDeviceId: this.outputSelected,
      observedDeviceId: this.outputObserved,
      change: this.outputChange,
      error: this.outputError,
    });
    return Object.freeze({
      phase: this.phase,
      trial,
      playing:
        this.playIntent &&
        this.graph !== null &&
        !this.graph.ignoreEnd,
      selected: this.selectedValue,
      selectionRequired: this.selectionRequiredValue,
      carryingPreviousTrial: this.carryingPreviousValue && sounded,
      positionSeconds: position,
      durationSeconds: duration,
      loop: Object.freeze({ ...loop }),
      deliveredSampleRate: facts?.sampleRate ?? null,
      outputSampleRate: this.disposed || this.context === null ? null : this.context.sampleRate,
      channels: facts?.channels ?? null,
      error: this.errorValue,
      output,
    });
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    if (typeof listener !== "function") {
      throw new PlaybackError("invalid-listener", "subscriber must be a function");
    }
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  reset(): PlaybackSnapshot {
    this.requireActive();
    this.outputEpoch += 1;
    this.expectedOutputEvent = null;
    this.generation += 1;
    const now = this.context?.currentTime ?? 0;
    this.clearGraphs(now);
    this.clips = null;
    this.buffers = null;
    this.facts = null;
    this.staged = null;
    this.selectionRequiredValue = false;
    this.carryingPreviousValue = false;
    this.loading = false;
    this.deviceChangeDeferred = false;
    this.trialValue = null;
    this.phase = "empty";
    this.selectedValue = "X";
    this.positionValue = 0;
    this.loopValue = ZERO_LOOP;
    this.playIntent = false;
    this.errorValue = null;
    this.blockedUntil = 0;
    this.outputPending = null;
    this.outputChange = "none";
    this.outputError = null;
    this.emit();
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.outputEpoch += 1;
    this.expectedOutputEvent = null;
    this.disposed = true;
    this.generation += 1;
    this.detachOutputListeners();
    const context = this.context;
    const owned = this.ownsContext ? context : null;
    const now = context?.currentTime ?? 0;
    this.clearGraphs(now);
    this.clips = null;
    this.buffers = null;
    this.facts = null;
    this.staged = null;
    this.selectionRequiredValue = false;
    this.carryingPreviousValue = false;
    this.loading = false;
    this.deviceChangeDeferred = false;
    this.trialValue = null;
    this.phase = "disposed";
    this.selectedValue = "X";
    this.positionValue = 0;
    this.loopValue = ZERO_LOOP;
    this.playIntent = false;
    this.errorValue = null;
    this.blockedUntil = 0;
    this.outputPending = null;
    this.outputChange = "none";
    this.outputError = null;
    this.context = null;
    this.ownsContext = false;
    this.emit();
    this.listeners.clear();
    if (owned && typeof (owned as AudioContext).close === "function") {
      try {
        await (owned as AudioContext).close();
      } catch {
        // Disposal is complete even if the browser rejects a second close.
      }
    }
  }

  async refreshOutputDevices(): Promise<PlaybackSnapshot> {
    this.requireActive();
    if (this.outputPending !== null) return this.snapshot();
    const generation = this.generation;
    this.outputPending = "refresh";
    this.outputError = null;
    this.emit();

    if (!contextSinkApiAvailable(this.context)) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputSupport = "unsupported";
      this.outputCanRequest = false;
      this.outputDevices = Object.freeze([]);
      this.outputPending = null;
      this.emit();
      return this.snapshot();
    }

    const media = outputMediaDevices();
    if (typeof media?.enumerateDevices !== "function") {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputSupport = this.outputCanRequest ? "supported" : "unavailable";
      this.outputError = this.outputCanRequest
        ? null
        : outputError("output-enumeration-unavailable", "this browser cannot list output devices");
      this.emit();
      return this.snapshot();
    }

    let listed: readonly MediaDeviceInfo[];
    try {
      listed = await media.enumerateDevices();
    } catch (error) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputSupport = this.outputCanRequest ? "supported" : "unavailable";
      this.outputDevices = this.outputCanRequest
        ? Object.freeze([DEFAULT_OUTPUT])
        : Object.freeze([]);
      this.outputError = outputError(
        "output-enumeration-failed",
        `the browser did not expose output devices (${safeErrorName(error)})`,
      );
      this.emit();
      return this.snapshot();
    }
    if (this.generation !== generation || this.disposed) return this.snapshot();

    const devices = normaliseDevices(Array.isArray(listed) ? listed : []);
    this.outputDevices = devices;
    this.outputSupport = devices.length > 0 || this.outputCanRequest
      ? "supported"
      : "unavailable";
    this.outputError = devices.length > 0 || this.outputCanRequest
      ? null
      : outputError("output-enumeration-empty", "no output devices are currently exposed");
    this.outputPending = null;
    this.outputObserved = observedSink(this.context) ?? this.outputObserved;

    if (
      this.outputSelected !== null &&
      this.outputSelected !== "" &&
      !devices.some((device) => device.deviceId === this.outputSelected)
    ) {
      this.outputChange = "lost";
      this.outputRequested = this.outputSelected;
      if (this.playIntent) this.pause();
    }
    this.emit();
    return this.snapshot();
  }

  async selectOutputDevice(deviceId: string): Promise<PlaybackSnapshot> {
    this.requireActive();
    if (typeof deviceId !== "string") {
      throw new PlaybackError("invalid-device", "output device id must be a string");
    }
    if (this.outputPending !== null) return this.snapshot();
    const generation = this.generation;
    this.pause();
    this.outputRequested = deviceId;
    this.outputPending = "select";
    this.outputError = null;
    this.emit();
    if (!contextSinkApiAvailable(this.context)) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputSupport = "unsupported";
      this.outputError = outputError(
        "output-unsupported",
        "this browser cannot route Web Audio output to a chosen device",
      );
      this.emit();
      return this.snapshot();
    }
    return await this.applyOutputSelection(generation, deviceId);
  }

  async requestOutputDevice(): Promise<PlaybackSnapshot> {
    this.requireActive();
    if (this.outputPending !== null) return this.snapshot();
    const generation = this.generation;
    this.pause();
    this.outputPending = "request";
    this.outputError = null;
    this.emit();

    if (!contextSinkApiAvailable(this.context)) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputSupport = "unsupported";
      this.outputCanRequest = false;
      this.outputError = outputError(
        "output-unsupported",
        "this browser cannot route Web Audio output to a chosen device",
      );
      this.emit();
      return this.snapshot();
    }
    const media = outputMediaDevices();
    if (typeof media?.selectAudioOutput !== "function") {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputCanRequest = false;
      this.outputError = outputError(
        "output-chooser-unavailable",
        "this browser has no explicit output-device chooser",
      );
      this.emit();
      return this.snapshot();
    }

    let choice: ChooserDevice;
    try {
      choice = await media.selectAudioOutput();
    } catch (error) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      const name = safeErrorName(error);
      this.outputError = name === "NotAllowedError"
        ? outputError("output-permission-denied", "the browser denied output-device access")
        : name === "AbortError" || name === "NotFoundError"
          ? outputError("output-selection-cancelled", "no output device was chosen")
          : outputError("output-selection-failed", `the chooser failed (${name})`);
      this.emit();
      return this.snapshot();
    }
    if (this.generation !== generation || this.disposed) return this.snapshot();
    const chosen = typeof choice?.deviceId === "string" ? choice.deviceId : "";
    this.outputRequested = chosen;
    this.outputCanRequest = true;
    return await this.applyOutputSelection(generation, chosen);
  }

  private async applyOutputSelection(
    generation: number,
    deviceId: string,
  ): Promise<PlaybackSnapshot> {
    let context: BaseAudioContext;
    try {
      context = this.ensureContext();
      this.attachContextOutputListener(context);
    } catch (error) {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputSupport = "unsupported";
      this.outputError = outputError("output-unavailable", "Web Audio output is unavailable");
      this.emit();
      return this.snapshot();
    }
    const sink = context as SinkCapableContext;
    if (typeof sink.setSinkId !== "function") {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputSupport = "unsupported";
      this.outputError = outputError(
        "output-unsupported",
        "this browser cannot route Web Audio output to a chosen device",
      );
      this.emit();
      return this.snapshot();
    }
    if ((context as { state?: string }).state === "closed") {
      if (this.generation !== generation || this.disposed) return this.snapshot();
      this.outputPending = null;
      this.outputError = outputError("context-closed", "AudioContext is closed");
      this.emit();
      return this.snapshot();
    }

    const expected = observedSink(context) !== deviceId
      ? { epoch: this.outputEpoch, deviceId } : null;
    this.expectedOutputEvent = expected;
    try {
      await sink.setSinkId(deviceId);
    } catch (error) {
      if (this.expectedOutputEvent === expected) this.expectedOutputEvent = null;
      if (this.generation !== generation || this.disposed) {
        this.reconcileLateOutputChange(context);
        return this.snapshot();
      }
      this.outputPending = null;
      const name = safeErrorName(error);
      this.outputError = name === "NotAllowedError"
        ? outputError("output-permission-denied", "the browser denied the output route change")
        : name === "NotFoundError"
          ? outputError("output-device-unavailable", "the requested output device is not available")
          : outputError("output-selection-failed", `the browser rejected the output route (${name})`);
      this.outputObserved = observedSink(context) ?? this.outputObserved;
      this.emit();
      return this.snapshot();
    }

    if (this.generation !== generation || this.disposed) {
      this.reconcileLateOutputChange(context);
      return this.snapshot();
    }
    this.outputSelected = deviceId;
    this.outputObserved = observedSink(context);
    this.outputChange = "none";
    this.outputError = null;
    this.outputPending = null;
    this.outputSupport = "supported";
    this.emit();
    return this.snapshot();
  }

  /** A late route operation must not claim success, but must not hide the real sink. */
  private reconcileLateOutputChange(context: BaseAudioContext): void {
    if (this.disposed) return;
    const observed = observedSink(context);
    if (observed === null) return;
    this.outputObserved = observed;
    if (this.outputSelected !== observed) {
      this.outputChange = "changed";
      this.pause();
    }
  }

  private attachContextOutputListener(context: BaseAudioContext): void {
    if (this.sinkListener !== null) return;
    const sink = context as SinkCapableContext & EventCapableContext;
    if (typeof sink.addEventListener !== "function") return;
    const handler = (): void => {
      if (this.disposed || this.context !== context) return;
      this.outputObserved = observedSink(context) ?? this.outputObserved;
      // Consume one matching non-noop selection event, before or after the
      // promise resolves. A same-default selection expects no event, so it
      // cannot conceal a later change of the system's default physical route.
      const expected = this.expectedOutputEvent;
      this.expectedOutputEvent = null;
      if (expected?.epoch === this.outputEpoch && expected.deviceId === this.outputObserved) return;
      // Any unsolicited sink change may reroute audio, including a default-route
      // change whose reported id stays empty. Pause synchronously, never resume.
      this.outputChange = "changed";
      this.pause();
    };
    sink.addEventListener("sinkchange", handler);
    this.sinkListener = { context: sink, handler };
  }

  private attachMediaDeviceListener(): void {
    if (this.mediaListener !== null) return;
    const media = outputMediaDevices();
    if (typeof media?.addEventListener !== "function") return;
    const handler = (): void => {
      if (this.disposed) return;
      // Never interleave automatic enumeration with an in-flight trial load;
      // it is replayed once the load settles. This keeps load/play control
      // decisions from racing a device-change refresh.
      if (this.loading || this.outputPending !== null) {
        this.deviceChangeDeferred = true;
        return;
      }
      void this.refreshOutputDevices().catch(() => {
        // A device-change refresh failure remains in the output error state on a
        // live player; it must never become an unhandled rejection.
      });
    };
    media.addEventListener("devicechange", handler);
    this.mediaListener = { media, handler };
  }

  private detachOutputListeners(): void {
    const sink = this.sinkListener;
    this.sinkListener = null;
    if (sink) {
      try {
        sink.context.removeEventListener?.("sinkchange", sink.handler);
      } catch {
        // Listener removal is best effort on a closing context.
      }
    }
    const media = this.mediaListener;
    this.mediaListener = null;
    if (media) {
      try {
        media.media.removeEventListener?.("devicechange", media.handler);
      } catch {
        // Listener removal is best effort.
      }
    }
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new PlaybackError("disposed", "playback player has been disposed");
    }
  }

  private durationSeconds(): number {
    return this.facts?.durationSeconds ?? 0;
  }

  private currentLoop(): PlaybackLoop {
    const duration = this.durationSeconds();
    if (duration > 0) return clampLoop(this.loopValue, duration);
    if (this.phase === "empty" || this.phase === "disposed") return ZERO_LOOP;
    return Object.freeze({ ...this.loopValue });
  }

  private currentPosition(): number {
    if (this.graph && this.playIntent && this.context) {
      const elapsed = Math.max(0, this.context.currentTime - this.graph.startTime);
      return advancePosition(
        this.graph.basePosition,
        elapsed,
        this.graph.loop,
        this.graph.duration,
      );
    }
    return this.positionValue;
  }

  private ensureContext(): BaseAudioContext {
    if (this.context) return this.context;
    const globals = globalThis as typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Constructor = typeof AudioContext === "undefined"
      ? globals.webkitAudioContext
      : AudioContext;
    if (!Constructor) {
      throw new PlaybackError("audio-unavailable", "this browser has no Web Audio API");
    }
    let context: AudioContext;
    try {
      context = new Constructor();
    } catch {
      throw new PlaybackError("audio-unavailable", "AudioContext could not be created");
    }
    this.context = context;
    this.ownsContext = true;
    this.attachContextOutputListener(context);
    this.outputObserved = observedSink(context) ?? this.outputObserved;
    this.outputSupport = contextSinkApiAvailable(context)
      ? "supported"
      : "unsupported";
    this.outputCanRequest = this.outputSupport === "supported" && chooserApiAvailable();
    this.attachMediaDeviceListener();
    return context;
  }

  private ensureBuffers(): Record<PlaybackLabel, AudioBuffer> {
    if (this.buffers) return this.buffers;
    if (!this.clips) {
      throw new PlaybackError("not-loaded", "trial PCM is not available");
    }
    const context = this.ensureContext();
    const buffers = this.createAudioBuffers(context, this.clips);
    this.buffers = buffers;
    this.clips = null;
    return buffers;
  }

  private createAudioBuffers(
    context: BaseAudioContext,
    clips: Record<PlaybackLabel, DecodedClip>,
  ): Record<PlaybackLabel, AudioBuffer> {
    const build = (clip: DecodedClip): AudioBuffer => {
      const buffer = context.createBuffer(clip.channels, clip.frames, clip.sampleRate);
      for (let channel = 0; channel < clip.channels; channel += 1) {
        const data = clip.channelData[channel];
        if (!data) {
          throw new PlaybackError("load-failed", "decoded channel data is incomplete");
        }
        buffer.copyToChannel(data, channel);
      }
      return buffer;
    };
    return {
      A: build(clips.A),
      B: build(clips.B),
      X: build(clips.X),
    };
  }

  private async resumeContext(context: BaseAudioContext): Promise<void> {
    if (isOfflineContext(context)) return;
    const state = (context as { state?: string }).state;
    if (state === "closed") {
      throw new PlaybackError("context-closed", "AudioContext is closed");
    }
    if (state === "running") return;
    const resumable = context as BaseAudioContext & { resume?: () => Promise<void> };
    if (typeof resumable.resume !== "function") return;
    try {
      await resumable.resume();
    } catch {
      throw new PlaybackError("context-suspended", "AudioContext could not resume");
    }
    const after = (context as { state?: string }).state;
    if (after === "closed") {
      throw new PlaybackError("context-closed", "AudioContext is closed");
    }
    if (after !== undefined && after !== "running") {
      throw new PlaybackError(
        "context-suspended",
        "AudioContext remained suspended; a user gesture is required",
      );
    }
  }

  private async beginPlayback(generation: number): Promise<void> {
    const context = this.ensureContext();
    this.ensureBuffers();
    await this.resumeContext(context);
    if (this.generation !== generation || this.disposed) return;
    if (!this.playIntent) return;
    if (this.phase !== "ready" || !this.facts) return;
    if (this.graph !== null) return;
    const loop = this.currentLoop();
    if (!loop.enabled && this.positionValue >= this.facts.durationSeconds - 1e-9) {
      this.positionValue = 0;
    }
    this.startGraph(
      this.positionValue,
      loop,
      Math.max(context.currentTime, this.blockedUntil),
    );
    this.errorValue = null;
  }

  private failLoad(generation: number, message: string): void {
    if (this.generation !== generation || this.disposed) return;
    this.phase = "error";
    this.staged = null;
    this.selectionRequiredValue = false;
    this.carryingPreviousValue = false;
    this.clips = null;
    this.buffers = null;
    this.facts = null;
    this.errorValue = message;
    if (this.graph) this.stopGraph(this.graph, this.context?.currentTime ?? 0, false);
    this.emit();
  }

  /**
   * A continuation failure publishes no partial next set and enables no answer
   * authority. The old graph, if still sounding, is retained only as retired
   * monitoring until an explicit retry or reset/end.
   */
  private failContinuationLoad(
    generation: number,
    message: string,
    trial: PublicTrial,
  ): void {
    if (this.generation !== generation || this.disposed) return;
    this.staged = null;
    this.phase = "error";
    this.trialValue = trial;
    this.selectionRequiredValue = true;
    this.carryingPreviousValue = this.graph !== null && !this.graph.ignoreEnd;
    this.errorValue = message;
    // Keep the active (retired) buffers/facts and graph untouched.
    this.emit();
  }

  private startGraph(
    position: number,
    loop: PlaybackLoop,
    startTime: number,
    positionTime?: number,
  ): SourceGraph {
    const context = this.context;
    const buffers = this.buffers;
    if (!context || !buffers || !this.facts) {
      throw new PlaybackError("not-loaded", "source buffers are not available");
    }
    if (!isOfflineContext(context)) {
      startTime = Math.max(startTime, context.currentTime + LIVE_SCHEDULE_LEAD_SECONDS);
    }
    const duration = this.facts.durationSeconds;
    if (positionTime !== undefined) {
      position += Math.max(0, startTime - positionTime);
      position = loop.enabled
        ? positionForLoop(position, loop, duration)
        : clampPosition(position, duration);
    }
    const master = context.createGain();
    master.connect(context.destination);
    master.gain.value = 0;
    master.gain.setValueAtTime(0, startTime);
    master.gain.linearRampToValueAtTime(1, startTime + GAIN_RAMP_SECONDS);
    const masterModel: ParamModel = {
      from: 0,
      to: 1,
      startTime,
      endTime: startTime + GAIN_RAMP_SECONDS,
    };

    const sources = emptyRecord<AudioBufferSourceNode>();
    const gains = emptyRecord<GainNode>();
    const gainModels = emptyRecord<ParamModel>();
    const graph: SourceGraph = {
      id: ++this.graphSequence,
      duration,
      loop,
      sources,
      gains,
      gainModels,
      master,
      masterModel,
      startTime,
      basePosition: position,
      ignoreEnd: false,
      endedHandled: false,
      cleanedSources: 0,
    };

    const offset = loop.enabled
      ? positionForLoop(position, loop, duration)
      : clampPosition(position, duration);
    const created: Array<{
      readonly source: AudioBufferSourceNode;
      readonly gain: GainNode;
    }> = [];
    try {
      for (const label of LABELS) {
        const source = context.createBufferSource();
        const gain = context.createGain();
        created.push({ source, gain });
        source.buffer = buffers[label];
        if (loop.enabled) {
          source.loop = true;
          source.loopStart = loop.startSeconds;
          source.loopEnd = loop.endSeconds;
        } else {
          source.loop = false;
        }
        const target = label === this.selectedValue ? 1 : 0;
        gain.gain.value = target;
        source.connect(gain);
        gain.connect(master);
        source.onended = () => this.handleSourceEnded(graph, source, gain);
        source.start(startTime, offset);
        graph.sources[label] = source;
        graph.gains[label] = gain;
        graph.gainModels[label] = constantModel(target);
      }
    } catch (error) {
      for (const { source, gain } of created) {
        try {
          source.stop();
        } catch {
          // The source may not have started.
        }
        source.disconnect();
        gain.disconnect();
      }
      master.disconnect();
      throw error;
    }
    this.graphs.add(graph);
    this.graph = graph;
    this.blockedUntil = Math.max(this.blockedUntil, startTime + GAIN_RAMP_SECONDS);
    return graph;
  }

  private scheduleSelection(graph: SourceGraph, now: number): void {
    for (const label of LABELS) {
      const target = label === this.selectedValue ? 1 : 0;
      const current = paramValue(graph.gainModels[label], now);
      const param = graph.gains[label].gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
      param.linearRampToValueAtTime(target, now + GAIN_RAMP_SECONDS);
      graph.gainModels[label] = {
        from: current,
        to: target,
        startTime: now,
        endTime: now + GAIN_RAMP_SECONDS,
      };
    }
  }

  private restartGraph(
    old: SourceGraph,
    position: number,
    loop: PlaybackLoop,
    now: number,
    continueClock = false,
  ): void {
    // Create the replacement before retiring the old graph: live scheduling
    // may move its start beyond the requested time. Both sides must use the
    // actual scheduled boundary, with the old graph audible until its 5 ms
    // fade immediately before that boundary (no extra scheduling-lead gap).
    const next = this.startGraph(
      position, loop, Math.max(now + GAIN_RAMP_SECONDS, this.blockedUntil),
      continueClock ? now : undefined,
    );
    this.stopGraph(old, next.startTime, true, next.startTime - GAIN_RAMP_SECONDS);
  }

  private stopGraph(graph: SourceGraph, when: number, fade: boolean, fadeFrom?: number): void {
    const context = this.context;
    graph.ignoreEnd = true;
    if (this.graph === graph) this.graph = null;
    if (!context) return;
    const now = context.currentTime;
    const stopAt = Math.max(now, when);
    const master = graph.master.gain;
    const current = paramValue(graph.masterModel, now);
    try {
      master.cancelScheduledValues(now);
      if (fade && stopAt > now) {
        const fadeStart = Math.max(now, Math.min(stopAt, fadeFrom ?? now));
        master.setValueAtTime(current, now);
        if (fadeStart > now) master.setValueAtTime(current, fadeStart);
        master.linearRampToValueAtTime(0, stopAt);
        graph.masterModel = {
          from: current,
          to: 0,
          startTime: fadeStart,
          endTime: stopAt,
        };
      } else {
        master.setValueAtTime(0, now);
        graph.masterModel = constantModel(0);
      }
    } catch {
      // A context closed by its owner cannot be rescheduled; it is already silent.
    }
    for (const label of LABELS) {
      try {
        graph.sources[label].stop(stopAt);
      } catch {
        // A source that already ended needs no second stop.
      }
    }
    this.blockedUntil = Math.max(this.blockedUntil, stopAt);
  }

  private handleSourceEnded(
    graph: SourceGraph,
    source: AudioBufferSourceNode,
    gain: GainNode,
  ): void {
    source.disconnect();
    gain.disconnect();
    graph.cleanedSources += 1;
    if (graph.cleanedSources >= LABELS.length) {
      graph.master.disconnect();
      this.graphs.delete(graph);
    }
    if (
      this.disposed ||
      this.graph !== graph ||
      graph.ignoreEnd ||
      graph.endedHandled
    ) {
      return;
    }
    if (graph.loop.enabled) return;
    graph.endedHandled = true;
    graph.ignoreEnd = true;
    this.graph = null;
    this.positionValue = graph.duration;
    this.playIntent = false;
    this.carryingPreviousValue = false;
    this.emit();
  }

  private flushDeferredDeviceChange(): void {
    if (!this.deviceChangeDeferred || this.disposed || this.loading || this.outputPending !== null) return;
    this.deviceChangeDeferred = false;
    queueMicrotask(() => {
      if (this.disposed || this.loading || this.outputPending !== null) {
        if (!this.disposed) this.deviceChangeDeferred = true;
        return;
      }
      void this.refreshOutputDevices().catch(() => {
        // Bounded background enumeration never becomes an unhandled rejection.
      });
    });
  }

  private emit(): void {
    this.flushDeferredDeviceChange();
    if (this.listeners.size === 0) return;
    const listeners = [...this.listeners];
    for (const listener of listeners) {
      try {
        listener(this.snapshot());
      } catch {
        // A subscriber failure must not break playback state or cleanup.
      }
    }
  }

  /** A retiring group still owns audible nodes until its fade/end completes. */
  private clearGraphs(now: number): void {
    for (const graph of this.graphs) {
      this.stopGraph(graph, now, false);
      for (const label of LABELS) {
        graph.sources[label].onended = null;
        graph.sources[label].disconnect();
        graph.gains[label].disconnect();
      }
      graph.master.disconnect();
    }
    this.graphs.clear();
    this.graph = null;
  }
}

