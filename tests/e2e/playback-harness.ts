/**
 * Test-only browser harness for the playback package.
 *
 * It is bundled by Vite into a temporary file and served by a Playwright route.
 * It is never imported by the application, creates no production globals or
 * routes, and performs no network I/O. OfflineAudioContext proves rendered PCM
 * and scheduling; the live AudioContext check is triggered by a real button
 * click so it never relies on autoplay policy flags.
 */
import type { PlaybackLabel, PublicTrial } from "@codec-abx/contracts";
import { BrowserTrialPlayer } from "@codec-abx/playback";

export interface HarnessResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly checks: Readonly<Record<string, boolean | string | number>>;
}

interface WavOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly seconds?: number;
  readonly sample?: (frame: number, channel: number, sampleRate: number) => number;
}

const TRIAL: PublicTrial = {
  runId: "playback-harness-run",
  token: "playback-harness-token",
  trialIndex: 1,
  kind: "scored",
};

function makeWav(options: WavOptions): Uint8Array {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 0.6;
  const sample = options.sample ?? (() => 0);
  const frames = Math.round(sampleRate * seconds);
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(bytes, 8, "WAVE");
  ascii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, sample(frame, channel, sampleRate)));
      view.setInt16(44 + (frame * channels + channel) * 2, Math.round(value * 32767), true);
    }
  }
  return bytes;
}

function ascii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readerFor(
  values: Readonly<Record<PlaybackLabel, () => Uint8Array>>,
): (token: string, label: PlaybackLabel) => Promise<ArrayBuffer> {
  return async (_token, label) => bufferOf(values[label]());
}

function tone(
  frequency: number,
  options: { readonly sampleRate?: number; readonly channels?: 1 | 2; readonly seconds?: number } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? 48_000;
  return makeWav({
    sampleRate,
    channels: options.channels ?? 1,
    seconds: options.seconds ?? 0.6,
    sample: (frame, channel) => {
      const phase = channel === 1 ? Math.PI : 0;
      return 0.3 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate + phase);
    },
  });
}

function constant(value: number, options: { readonly seconds?: number } = {}): Uint8Array {
  return makeWav({
    seconds: options.seconds ?? 0.6,
    sample: () => value,
  });
}

function marker(): Uint8Array {
  return makeWav({
    seconds: 0.6,
    sample: (frame, _channel, sampleRate) => {
      const time = frame / sampleRate;
      if (time < 0.3 || time >= 0.34) return 0;
      return 0.3 * Math.sin(2 * Math.PI * 1000 * time);
    },
  });
}

function close(actual: number, expected: number, tolerance: number, label: string): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${label}: got ${actual}, expected ${expected} +/- ${tolerance}`);
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function rms(data: Float32Array, fromSeconds: number, toSeconds: number, sampleRate: number): number {
  const start = Math.max(0, Math.floor(fromSeconds * sampleRate));
  const end = Math.min(data.length, Math.ceil(toSeconds * sampleRate));
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += (data[index] ?? 0) ** 2;
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

function minMax(
  data: Float32Array,
  fromSeconds: number,
  toSeconds: number,
  sampleRate: number,
): { min: number; max: number } {
  const start = Math.max(0, Math.floor(fromSeconds * sampleRate));
  const end = Math.min(data.length, Math.ceil(toSeconds * sampleRate));
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = start; index < end; index += 1) {
    const value = data[index] ?? 0;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

interface RenderAction {
  readonly at: number;
  readonly run: (player: BrowserTrialPlayer) => void | Promise<void>;
}

interface RenderOptions {
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  readonly seconds: number;
  readonly read: (token: string, label: PlaybackLabel) => Promise<ArrayBuffer>;
  readonly selected?: PlaybackLabel;
  readonly loop?: { readonly enabled: boolean; readonly startSeconds: number; readonly endSeconds: number };
  readonly actions?: readonly RenderAction[];
}

async function render(options: RenderOptions): Promise<{
  readonly buffer: AudioBuffer;
  readonly player: BrowserTrialPlayer;
}> {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const context = new OfflineAudioContext(
    channels,
    Math.ceil(options.seconds * sampleRate),
    sampleRate,
  );
  const player = new BrowserTrialPlayer({ audioContext: context });
  await player.loadTrial(TRIAL, options.read);
  if (options.selected) player.select(options.selected);
  if (options.loop) player.setLoop(options.loop);
  await player.play();

  const actions = options.actions ?? [];
  const suspensions = actions.map((action) => context.suspend(action.at));
  const rendering = context.startRendering();
  for (let index = 0; index < actions.length; index += 1) {
    const suspension = suspensions[index];
    const action = actions[index];
    if (!suspension || !action) continue;
    await suspension;
    let failure: unknown = null;
    try {
      await action.run(player);
    } catch (error) {
      failure = error;
    }
    await context.resume();
    if (failure) throw failure;
  }
  const buffer = await rendering;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { buffer, player };
}

async function liveGestureCheck(): Promise<{
  readonly delivered: number | null;
  readonly output: number | null;
  readonly playing: boolean;
  readonly disposed: boolean;
}> {
  const player = new BrowserTrialPlayer();
  const loaded = await player.loadTrial(
    TRIAL,
    readerFor({
      A: () => tone(440, { sampleRate: 44_100, seconds: 0.5 }),
      B: () => tone(660, { sampleRate: 44_100, seconds: 0.5 }),
      X: () => tone(880, { sampleRate: 44_100, seconds: 0.5 }),
    }),
  );
  if (loaded.outputSampleRate !== null) {
    throw new Error("live: AudioContext was created before the play gesture");
  }
  const button = document.createElement("button");
  button.id = "playback-gesture";
  button.textContent = "Start playback";
  button.type = "button";
  document.body.append(button);
  return await new Promise((resolve, reject) => {
    button.addEventListener(
      "click",
      () => {
        void (async () => {
          try {
            const played = await player.play();
            const delivered = played.deliveredSampleRate;
            const output = played.outputSampleRate;
            await player.dispose();
            resolve({
              delivered,
              output,
              playing: played.playing,
              disposed: player.snapshot().phase === "disposed",
            });
          } catch (error) {
            reject(error);
          } finally {
            button.remove();
          }
        })();
      },
      { once: true },
    );
  });
}

export async function runHarness(): Promise<HarnessResult> {
  const checks: Record<string, boolean | string | number> = {};
  const failures: string[] = [];

  const check = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      checks[name] = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks[name] = message;
      failures.push(`${name}: ${message}`);
    }
  };

  await check("shared-start-identical-a-b", async () => {
    const a = await render({
      seconds: 0.3,
      read: readerFor({
        A: () => tone(440),
        B: () => tone(440),
        X: () => tone(440),
      }),
      selected: "A",
    });
    const b = await render({
      seconds: 0.3,
      read: readerFor({
        A: () => tone(440),
        B: () => tone(440),
        X: () => tone(440),
      }),
      selected: "B",
    });
    const left = a.buffer.getChannelData(0);
    const right = b.buffer.getChannelData(0);
    let maxDifference = 0;
    for (let index = 0; index < left.length; index += 1) {
      maxDifference = Math.max(maxDifference, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
    }
    expect(maxDifference < 1e-5, `A and B start-phase difference was ${maxDifference}`);
    checks["shared-start-max-difference"] = maxDifference;
    await a.player.dispose();
    await b.player.dispose();
  });

  await check("stereo-anti-phase-preserved", async () => {
    const result = await render({
      channels: 2,
      seconds: 0.4,
      read: readerFor({
        A: () => tone(440, { channels: 2 }),
        B: () => tone(440, { channels: 2 }),
        X: () => tone(440, { channels: 2 }),
      }),
      selected: "A",
    });
    const left = result.buffer.getChannelData(0);
    const right = result.buffer.getChannelData(1);
    let maxSum = 0;
    let maxLeft = 0;
    const start = Math.floor(0.05 * 48_000);
    const end = Math.floor(0.35 * 48_000);
    for (let index = start; index < end; index += 1) {
      maxSum = Math.max(maxSum, Math.abs((left[index] ?? 0) + (right[index] ?? 0)));
      maxLeft = Math.max(maxLeft, Math.abs(left[index] ?? 0));
    }
    expect(maxLeft > 0.1, `anti-phase output amplitude was ${maxLeft}`);
    expect(maxSum < 1e-5, `stereo channels were not preserved: |L+R| reached ${maxSum}`);
    checks["anti-phase-max-sum"] = maxSum;
    await result.player.dispose();
  });

  await check("identical-a-b-switch-constant-gain", async () => {
    const result = await render({
      seconds: 0.3,
      read: readerFor({
        A: () => constant(0.2),
        B: () => constant(0.2),
        X: () => constant(0.2),
      }),
      selected: "A",
      actions: [
        { at: 0.05, run: (player) => void player.select("B") },
        { at: 0.1, run: (player) => void player.select("A") },
      ],
    });
    const { min, max } = minMax(result.buffer.getChannelData(0), 0.01, 0.29, 48_000);
    close(min, 0.2, 5e-4, "switch minimum");
    close(max, 0.2, 5e-4, "switch maximum");
    checks["switch-min"] = min;
    checks["switch-max"] = max;
    await result.player.dispose();
  });

  await check("rapid-reversal-complementary-gain", async () => {
    const result = await render({
      seconds: 0.3,
      read: readerFor({
        A: () => constant(0.2),
        B: () => constant(0.2),
        X: () => constant(0.2),
      }),
      selected: "A",
      actions: [
        { at: 0.05, run: (player) => void player.select("B") },
        { at: 0.054, run: (player) => void player.select("A") },
        { at: 0.058, run: (player) => void player.select("B") },
        { at: 0.062, run: (player) => void player.select("A") },
      ],
    });
    const { min, max } = minMax(result.buffer.getChannelData(0), 0.01, 0.29, 48_000);
    close(min, 0.2, 5e-4, "reversal minimum");
    close(max, 0.2, 5e-4, "reversal maximum");
    checks["reversal-min"] = min;
    checks["reversal-max"] = max;
    await result.player.dispose();
  });

  await check("pause-resume-retains-position", async () => {
    let pausedAt = -1;
    let resumedAt = -1;
    const result = await render({
      seconds: 0.4,
      read: readerFor({
        A: () => constant(0.2, { seconds: 0.6 }),
        B: () => constant(0.2, { seconds: 0.6 }),
        X: () => constant(0.2, { seconds: 0.6 }),
      }),
      selected: "A",
      actions: [
        {
          at: 0.05,
          run: (player) => {
            const snapshot = player.pause();
            pausedAt = snapshot.positionSeconds;
            expect(!snapshot.playing, "pause left the player playing");
          },
        },
        {
          at: 0.1,
          run: async (player) => {
            resumedAt = player.snapshot().positionSeconds;
            await player.play();
          },
        },
      ],
    });
    close(pausedAt, 0.05, 0.002, "paused position");
    close(resumedAt, pausedAt, 0.002, "resumed position");
    expect(rms(result.buffer.getChannelData(0), 0.02, 0.045, 48_000) > 0.15, "audio before pause was silent");
    expect(rms(result.buffer.getChannelData(0), 0.07, 0.09, 48_000) < 1e-5, "audio did not stop during pause");
    expect(rms(result.buffer.getChannelData(0), 0.12, 0.3, 48_000) > 0.15, "audio did not resume");
    checks["paused-position"] = pausedAt;
    checks["resumed-position"] = resumedAt;
    await result.player.dispose();
  });

  await check("seek-moves-shared-timeline", async () => {
    let seekPosition = -1;
    const result = await render({
      seconds: 0.4,
      read: readerFor({
        A: () => marker(),
        B: () => marker(),
        X: () => marker(),
      }),
      selected: "A",
      actions: [
        {
          at: 0.1,
          run: (player) => {
            const snapshot = player.seek(0.3);
            seekPosition = snapshot.positionSeconds;
            expect(snapshot.playing, "seek lost play intent");
          },
        },
      ],
    });
    close(seekPosition, 0.3, 1e-6, "seek position");
    const before = rms(result.buffer.getChannelData(0), 0.02, 0.08, 48_000);
    const burst = rms(result.buffer.getChannelData(0), 0.11, 0.14, 48_000);
    const after = rms(result.buffer.getChannelData(0), 0.2, 0.3, 48_000);
    expect(before < 1e-5, `audio before the seek marker was not silent: ${before}`);
    expect(burst > 0.02, `seek did not reach the marker: ${burst}`);
    expect(after < 1e-5, `audio after the marker was not silent: ${after}`);
    await result.player.dispose();
  });

  await check("loop-wraps-shared-region", async () => {
    const result = await render({
      seconds: 0.5,
      read: readerFor({
        A: () => tone(440),
        B: () => tone(440),
        X: () => tone(440),
      }),
      selected: "A",
      loop: { enabled: true, startSeconds: 0.1, endSeconds: 0.2 },
      actions: [],
    });
    const data = result.buffer.getChannelData(0);
    let maxDifference = 0;
    for (let time = 0.12; time < 0.18; time += 1 / 48_000) {
      const first = data[Math.round(time * 48_000)] ?? 0;
      const second = data[Math.round((time + 0.1) * 48_000)] ?? 0;
      maxDifference = Math.max(maxDifference, Math.abs(first - second));
    }
    expect(maxDifference < 1e-5, `loop period was not shared: ${maxDifference}`);
    checks["loop-repeat-difference"] = maxDifference;
    await result.player.dispose();
  });

  await check("nonloop-end-stops-once", async () => {
    const result = await render({
      seconds: 0.6,
      read: readerFor({
        A: () => constant(0.2, { seconds: 0.4 }),
        B: () => constant(0.2, { seconds: 0.4 }),
        X: () => constant(0.2, { seconds: 0.4 }),
      }),
      selected: "A",
    });
    const data = result.buffer.getChannelData(0);
    expect(rms(data, 0.02, 0.35, 48_000) > 0.15, "nonloop audio was silent before its end");
    expect(rms(data, 0.42, 0.58, 48_000) < 1e-6, "nonloop audio replayed after its end");
    const snapshot = result.player.snapshot();
    close(snapshot.positionSeconds, 0.4, 1e-6, "nonloop end position");
    expect(!snapshot.playing, "nonloop end left the player playing");
    await result.player.dispose();
  });

  await check("delivered-rate-separate-from-output-rate", async () => {
    const result = await render({
      sampleRate: 96_000,
      seconds: 0.5,
      read: readerFor({
        A: () => constant(0.2, { seconds: 0.4 }),
        B: () => constant(0.2, { seconds: 0.4 }),
        X: () => constant(0.2, { seconds: 0.4 }),
      }),
      selected: "A",
    });
    const snapshot = result.player.snapshot();
    expect(snapshot.deliveredSampleRate === 48_000, `delivered rate was ${String(snapshot.deliveredSampleRate)}`);
    expect(snapshot.outputSampleRate === 96_000, `output rate was ${String(snapshot.outputSampleRate)}`);
    expect(rms(result.buffer.getChannelData(0), 0.05, 0.35, 96_000) > 0.15, "resampled output was silent");
    await result.player.dispose();
  });

  await check("atomic-failure-then-retry", async () => {
    const context = new OfflineAudioContext(1, 19_200, 48_000);
    const player = new BrowserTrialPlayer({ audioContext: context });
    const good = readerFor({
      A: () => constant(0.2, { seconds: 0.4 }),
      B: () => constant(0.2, { seconds: 0.4 }),
      X: () => constant(0.2, { seconds: 0.4 }),
    });
    const failed = await player.loadTrial(TRIAL, async (token, label) => {
      if (label === "X") return new ArrayBuffer(16);
      return good(token, label);
    });
    expect(failed.phase === "error", `partial load phase was ${failed.phase}`);
    expect(failed.durationSeconds === 0, "partial load published a duration");
    expect(failed.playing === false, "partial load started playback");
    const retried = await player.loadTrial(TRIAL, good);
    expect(retried.phase === "ready", `retry phase was ${retried.phase}`);
    expect(retried.playing === false, "retry unexpectedly autoplayed a paused intent");
    await player.dispose();
  });

  await check("reset-invalidates-late-reads", async () => {
    const context = new OfflineAudioContext(1, 19_200, 48_000);
    const player = new BrowserTrialPlayer({ audioContext: context });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = player.loadTrial(TRIAL, async () => {
      await gate;
      return bufferOf(constant(0.2, { seconds: 0.4 }));
    });
    await Promise.resolve();
    const reset = player.reset();
    expect(reset.phase === "empty", "reset did not empty the player");
    release();
    const late = await pending;
    expect(late.phase === "empty", `late read published ${late.phase}`);
    expect(late.trial === null, "late read restored a trial");
    await player.dispose();
  });

  await check("reset-dispose-silence-retiring-graphs", async () => {
    for (const action of ["reset", "dispose"] as const) {
      const result = await render({
        seconds: 0.15,
        read: readerFor({
          A: () => constant(0.2, { seconds: 0.6 }),
          B: () => constant(0.2, { seconds: 0.6 }),
          X: () => constant(0.2, { seconds: 0.6 }),
        }),
        actions: [{ at: 0.05, run: async (player) => {
          player.pause();
          if (action === "reset") player.reset();
          else await player.dispose();
        } }],
      });
      const residual = rms(result.buffer.getChannelData(0), 0.052, 0.054, 48_000);
      expect(residual === 0, `${action} retained an audible fade graph: RMS ${residual}`);
      await result.player.dispose();
    }
  });

  const live = await liveGestureCheck();
  expect(live.playing, "live play gesture did not start playback");
  expect(live.delivered === 44_100, `live delivered rate was ${String(live.delivered)}`);
  expect(typeof live.output === "number" && live.output > 0, "live output rate was missing");
  expect(live.disposed, "live player did not dispose");
  checks["live-delivered-rate"] = live.delivered ?? -1;
  checks["live-output-rate"] = live.output ?? -1;
  checks["live-playing"] = live.playing;
  checks["live-disposed"] = live.disposed;

  return { ok: failures.length === 0, failures, checks };
}
