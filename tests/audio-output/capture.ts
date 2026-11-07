/**
 * Node-side recorder/control helper for the private PulseAudio capture lane.
 * It only talks to the private server named by CODEC_ABX_PULSE_SERVER.
 */
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const MAX_SECONDS = 30;
const MAX_BYTES = SAMPLE_RATE * CHANNELS * 2 * MAX_SECONDS;
const active = new Set<Recorder>();

export interface RecorderResult {
  readonly name: string;
  readonly source: string;
  readonly rawPath: string;
  readonly wavPath: string;
  readonly startedAtMs: number;
  readonly firstDataAtMs: number;
  readonly readyFrames: number;
  readonly stoppedAtMs: number;
  readonly bytes: number;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly truncated: boolean;
}

interface Recorder {
  readonly name: string;
  readonly source: string;
  readonly child: ReturnType<typeof spawn>;
  readonly chunks: Buffer[];
  readonly rawPath: string;
  readonly wavPath: string;
  readonly startedAtMs: number;
  firstDataAtMs: number | null;
  readyFrames: number;
  bytes: number;
  truncated: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stderr: string;
  stop(): Promise<RecorderResult>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireEnvironment(): { report: string; server: string; bin: string } {
  const report = process.env.CODEC_ABX_AUDIO_REPORT;
  const server = process.env.CODEC_ABX_PULSE_SERVER;
  const bin = process.env.CODEC_ABX_PULSE_BIN;
  if (!report || !server || !bin) {
    throw new Error(
      "Audio-output capture requires the private lane launcher. Run: npm run test:audio-output",
    );
  }
  return { report, server, bin };
}

function clientEnvironment(): NodeJS.ProcessEnv {
  const { server } = requireEnvironment();
  return { ...process.env, PULSE_SERVER: server };
}

export async function pactl(args: readonly string[]): Promise<string> {
  const { bin } = requireEnvironment();
  const result = await execFileAsync(path.join(bin, "pactl"), args, {
    env: clientEnvironment(),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function wavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

async function startRecorder(name: string, source: string): Promise<Recorder> {
  const { report, bin } = requireEnvironment();
  const directory = path.join(report, "audio");
  await fs.mkdir(directory, { recursive: true });
  const rawPath = path.join(directory, `${name}.s16le`);
  const wavPath = path.join(directory, `${name}.wav`);
  const child = spawn(
    path.join(bin, "parec"),
    [
      `--device=${source}`,
      "--format=s16le",
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      "--latency-msec=20",
      "--process-time-msec=20",
      "--raw",
    ],
    { env: clientEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const recorder: Recorder = {
    name,
    source,
    child,
    chunks: [],
    rawPath,
    wavPath,
    startedAtMs: Date.now(),
    firstDataAtMs: null,
    readyFrames: 0,
    bytes: 0,
    truncated: false,
    exit: null,
    stderr: "",
    stop: async () => {
      if (recorder.exit === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          delay(5000).then(() => {
            if (recorder.exit === null) child.kill("SIGKILL");
          }),
        ]);
      }
      if (recorder.exit === null) {
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          delay(2000),
        ]);
      }
      const stoppedAtMs = Date.now();
      if (recorder.exit === null) throw new Error(`parec recorder ${name} did not exit`);
      if (recorder.exit.code !== 0 && recorder.exit.signal !== "SIGTERM" && recorder.exit.signal !== "SIGKILL") {
        throw new Error(`parec recorder ${name} exited ${recorder.exit.code ?? recorder.exit.signal}: ${recorder.stderr.trim().slice(-600)}`);
      }
      const raw = Buffer.concat(recorder.chunks);
      await fs.writeFile(recorder.rawPath, raw);
      await fs.writeFile(recorder.wavPath, Buffer.concat([wavHeader(raw.byteLength), raw]));
      active.delete(recorder);
      return {
        name,
        source,
        rawPath,
        wavPath,
        startedAtMs: recorder.startedAtMs,
        firstDataAtMs: recorder.firstDataAtMs!,
        readyFrames: recorder.readyFrames,
        stoppedAtMs,
        bytes: raw.byteLength,
        frames: raw.byteLength / (CHANNELS * 2),
        durationSeconds: raw.byteLength / (CHANNELS * 2 * SAMPLE_RATE),
        truncated: recorder.truncated,
      };
    },
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (recorder.truncated) return;
    if (chunk.byteLength > 0) recorder.firstDataAtMs ??= Date.now();
    recorder.chunks.push(chunk);
    recorder.bytes += chunk.byteLength;
    if (recorder.bytes > MAX_BYTES) {
      recorder.truncated = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    recorder.stderr += chunk.toString();
  });
  child.once("exit", (code, signal) => {
    recorder.exit = { code, signal };
  });
  active.add(recorder);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // A spawned recorder may take seconds to connect/deliver its first fragment.
  // Wait for real PCM before any test action; process spawn alone is not proof
  // that a pre-play or wrong-sink silence window was actually recorded.
  const deadline = Date.now() + 5_000;
  const minimumBytes = SAMPLE_RATE * CHANNELS * 2 * 0.25;
  while (recorder.bytes < minimumBytes) {
    if (recorder.exit !== null || Date.now() >= deadline) {
      await recorder.stop();
      throw new Error(`Monitor ${name} did not deliver startup PCM before capture actions`);
    }
    await delay(20);
  }
  recorder.readyFrames = recorder.bytes / (CHANNELS * 2);
  return recorder;
}

export interface CaptureScenario {
  readonly name: string;
  readonly events: Readonly<Record<string, number>>;
  readonly recorders: readonly RecorderResult[];
  readonly manifestPath: string;
}

/**
 * Record one or more monitors across an explicit action sequence. Callers must
 * use real UI clicks and mark each action so timing and controls are attributable.
 */
export async function captureScenario(
  name: string,
  sources: readonly string[],
  run: (mark: (event: string) => void) => Promise<void>,
  options: { readonly settleMs?: number; readonly tailMs?: number } = {},
): Promise<CaptureScenario> {
  const { report } = requireEnvironment();
  const recorders = await Promise.all(sources.map((source, index) =>
    startRecorder(`${name}-${index === 0 ? "a" : "b"}-${source.replace(/[^a-zA-Z0-9_.-]/g, "_")}`, source)));
  await delay(options.settleMs ?? 250);
  const events: Record<string, number> = {};
  const mark = (event: string): void => {
    if (event in events) throw new Error(`capture event ${event} was marked twice`);
    events[event] = Date.now();
  };
  let failure: unknown = null;
  try {
    await run(mark);
  } catch (error) {
    failure = error;
  }
  await delay(options.tailMs ?? 350);
  const results = await Promise.all(recorders.map((recorder) => recorder.stop()));
  const manifestPath = path.join(report, "audio", `${name}.capture.json`);
  const manifest = {
    schema: "codec-abx-audio-output-capture-v1",
    name,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    events,
    recorders: results.map((result) => ({
      name: result.name,
      source: result.source,
      rawFile: path.relative(report, result.rawPath),
      wavFile: path.relative(report, result.wavPath),
      startedAtMs: result.startedAtMs,
      firstDataAtMs: result.firstDataAtMs,
      readyFrames: result.readyFrames,
      stoppedAtMs: result.stoppedAtMs,
      frames: result.frames,
      durationSeconds: result.durationSeconds,
      truncated: result.truncated,
    })),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (failure) throw failure;
  return { name, events, recorders: results, manifestPath };
}

export async function stopAllRecorders(): Promise<void> {
  const recorders = [...active];
  await Promise.allSettled(recorders.map((recorder) => recorder.stop()));
}

/** Assert no recorder still holds the private monitor sources. */
export async function assertNoSourceOutputs(): Promise<void> {
  const text = await pactl(["list", "short", "source-outputs"]);
  if (text.trim().length > 0) {
    throw new Error(`Private PulseAudio still has monitor recorder outputs:\n${text.trim()}`);
  }
}

/**
 * Move the only browser sink input on this private server to sink B. This is
 * host/software routing, not a browser UI/device-chooser acceptance claim.
 */
export async function moveOnlyBrowserStream(fromSink: string, toSink: string): Promise<{ streamCount: number }> {
  const sinkText = await pactl(["list", "short", "sinks"]);
  const sinks = new Map<string, string>();
  for (const line of sinkText.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2 && fields[0] && fields[1]) sinks.set(fields[1], fields[0]);
  }
  const fromIndex = sinks.get(fromSink);
  const toIndex = sinks.get(toSink);
  if (!fromIndex || !toIndex) throw new Error("Private capture sinks are not both present");
  const inputText = await pactl(["list", "short", "sink-inputs"]);
  const inputs = inputText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/));
  if (inputs.length !== 1) {
    throw new Error(`Expected exactly the private browser stream, found ${inputs.length} sink inputs`);
  }
  const input = inputs[0];
  const inputIndex = input?.[0];
  const sinkIndex = input?.[1];
  if (!inputIndex || sinkIndex !== fromIndex) {
    throw new Error(`Private browser stream is not on the expected source sink (found ${sinkIndex ?? "none"})`);
  }
  await pactl(["move-sink-input", inputIndex, toSink]);
  const movedText = await pactl(["list", "short", "sink-inputs"]);
  const moved = movedText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/));
  if (moved.length !== 1 || moved[0]?.[1] !== toIndex) {
    throw new Error("Private browser stream did not move to the requested capture sink");
  }
  return { streamCount: 1 };
}

export function reportDirectory(): string {
  return requireEnvironment().report;
}
