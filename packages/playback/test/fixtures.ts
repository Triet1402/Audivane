import type { PlaybackLabel } from "@codec-abx/contracts";

export interface WavOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly seconds?: number;
  readonly frequency?: number;
  readonly amplitude?: number;
  readonly antiPhase?: boolean;
  readonly dc?: number;
}

/** Canonical 44-byte PCM16 WAV fixture, independent of the playback parser. */
export function makeWav(options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 1;
  const frequency = options.frequency ?? 440;
  const amplitude = options.amplitude ?? 0.2;
  const dc = options.dc ?? 0;
  const frames = Math.round(sampleRate * seconds);
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = quantize(
      dc + amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate),
    );
    const right = options.antiPhase
      ? -left
      : quantize(
          dc + amplitude * Math.sin((2 * Math.PI * (frequency * 1.5) * frame) / sampleRate),
        );
    view.setInt16(44 + frame * blockAlign, left, true);
    if (channels === 2) view.setInt16(44 + frame * blockAlign + 2, right, true);
  }
  return bytes;
}

export function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function quantize(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export interface ParamEvent {
  readonly type: "set" | "ramp" | "cancel";
  readonly value: number;
  readonly time: number;
}

export class FakeAudioParam {
  value = 0;
  readonly events: ParamEvent[] = [];

  cancelScheduledValues(time: number): void {
    this.events.push({ type: "cancel", value: 0, time });
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: "ramp", value, time });
  }
}

export class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly connections: unknown[] = [];
  disconnected = false;

  connect(node: unknown): void {
    this.connections.push(node);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeAudioBuffer {
  readonly channelData: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channelData = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  copyToChannel(source: Float32Array, channel: number): void {
    const target = this.channelData[channel];
    if (!target) throw new Error("fake buffer channel missing");
    target.set(source);
  }

  getChannelData(channel: number): Float32Array {
    const target = this.channelData[channel];
    if (!target) throw new Error("fake buffer channel missing");
    return target;
  }
}

export interface StartedSource {
  readonly when: number;
  readonly offset: number;
}

export class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  started: StartedSource | null = null;
  stopAt: number | null = null;
  disconnected = false;

  connect(_node: unknown): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  start(when: number, offset = 0): void {
    this.started = { when, offset };
  }

  stop(when = 0): void {
    this.stopAt = when;
  }

  fireEnded(): void {
    this.onended?.();
  }
}

export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  state: "suspended" | "running" | "closed" = "running";
  readonly destination = {};
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly buffers: FakeAudioBuffer[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  resumeError: Error | null = null;

  constructor(sampleRate = 48_000) {
    this.sampleRate = sampleRate;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    const buffer = new FakeAudioBuffer(channels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeError) throw this.resumeError;
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
  }

  asBase(): BaseAudioContext {
    return this as unknown as BaseAudioContext;
  }
}

export function labels(): readonly PlaybackLabel[] {
  return ["A", "B", "X"];
}
