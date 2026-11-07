import assert from "node:assert/strict";
import test from "node:test";

import type { PreparationRequest } from "@codec-abx/contracts";
import type { PcmAudio } from "@codec-abx/measurements";

import {
  TypeScriptNativePreparationEngine,
  type NativePreparationExecutor,
  type TypeScriptNativePreparationEngineOptions,
} from "@codec-abx/engine-native/typescript";
import type {
  NativeCodecCapabilities,
  NativeCodecRunResult,
  NativeCodecSource,
} from "@codec-abx/engine-native/typescript";

const RATE = 48_000;
const FRAMES = Math.round(0.6 * RATE);

function lcg(frames: number, seed: number, amplitude = 0.4): Float64Array {
  const channel = new Float64Array(frames);
  let state = seed >>> 0;
  for (let index = 0; index < frames; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    channel[index] = (state / 0x1_0000_0000 - 0.5) * amplitude;
  }
  return channel;
}

function sine(frames: number, frequency: number, amplitude = 0.3): Float64Array {
  const channel = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) {
    channel[index] = amplitude * Math.sin(2 * Math.PI * frequency * index / RATE);
  }
  return channel;
}

function constant(frames: number, value: number): Float64Array {
  return new Float64Array(frames).fill(value);
}

function pcm(channel: Float64Array, channels: readonly Float64Array[] = [channel]): PcmAudio {
  return { sampleRate: RATE, channels };
}

function runResult(a: PcmAudio, b: PcmAudio): NativeCodecRunResult {
  const frames = a.channels[0]?.length ?? 0;
  const channels: 1 | 2 = a.channels.length === 2 ? 2 : 1;
  const track = (side: "a" | "b", pcmAudio: PcmAudio) => ({
    side,
    requested: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
    encoder: "pcm_f64le",
    decoder: "pcm_f64le",
    encodedSampleRate: RATE,
    encodedChannels: channels,
    actualBitrateKbps: null,
    stages: [{
      stageIndex: 1,
      requested: { codecId: "noop_passthrough" as const, bitrateKbps: 0 },
      codecId: "noop_passthrough" as const,
      encoder: "pcm_f64le",
      decoder: "pcm_f64le",
      encodedSampleRate: RATE,
      encodedSampleRateSource: "lossless-passthrough" as const,
      encodedChannels: channels,
      actualBitrateKbps: null,
      bitrateBasis: "lossless-passthrough" as const,
      encodedBytes: null,
      codecReportedBitrateKbps: null,
      inputFrames: frames,
      decodedFrames: frames,
      decodedDurationSeconds: frames / RATE,
      inputPeak: 0.5,
      inputSamplesOutsideUnitRange: 0,
      pcm16ClampedSamples: 0,
      notes: [],
    }],
    pcm: pcmAudio,
  });
  return {
    source: {
      sha256: "0".repeat(64),
      bytes: 0,
      format: "wav",
      formatLabel: "WAV",
      container: "wav",
      codec: "pcm_s16le",
    },
    session: {
      sampleRate: RATE,
      channels,
      sourceSampleRate: RATE,
      sourceChannels: channels,
      sampleRateMode: "native",
      frames,
      durationSeconds: frames / RATE,
    },
    a: track("a", a),
    b: track("b", b),
    disclosures: [],
    elapsedMs: 0,
  };
}

const CAPABILITIES: NativeCodecCapabilities = {
  schema: "native-codec-capabilities-v1",
  ffmpegVersion: null,
  ffprobeVersion: null,
  ldacHelperVersion: null,
  tools: { ffmpeg: false, ffprobe: false, ldacHelper: false },
  codecs: [],
  limitations: [],
};

class FakeDecodedExecutor implements NativePreparationExecutor {
  calls = 0;
  disposed = false;

  constructor(private readonly result: NativeCodecRunResult) {}

  async execute(
    _source: NativeCodecSource,
    _request: PreparationRequest,
  ): Promise<NativeCodecRunResult> {
    this.calls += 1;
    return this.result;
  }

  async capabilities(): Promise<NativeCodecCapabilities> {
    return CAPABILITIES;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function request(): PreparationRequest {
  return {
    version: 1,
    sampleRateMode: "native",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "noop_passthrough", bitrateKbps: 0 },
  };
}

function engineFor(executor: FakeDecodedExecutor): TypeScriptNativePreparationEngine {
  const options: TypeScriptNativePreparationEngineOptions = { codecExecutor: executor };
  return new TypeScriptNativePreparationEngine(options);
}

test("preflight refuses globally inverted, DC/constant and weak/unrelated decoded pairs", async (t) => {
  const bases = lcg(FRAMES, 0x1234_5678);
  const inverted = bases.map((value) => -value);
  const independent = lcg(FRAMES, 0x9abc_def0);
  const cases = [
    {
      label: "globally-inverted",
      a: pcm(bases),
      b: pcm(inverted),
      classification: "globally-inverted",
    },
    {
      label: "constant-offset",
      a: pcm(constant(FRAMES, 0.1)),
      b: pcm(constant(FRAMES, 0.125)),
      classification: "non-evidentiary",
    },
    {
      label: "independent-noise",
      a: pcm(bases),
      b: pcm(independent),
      classification: "weak-or-unrelated",
    },
  ] as const;

  for (const entry of cases) {
    const executor = new FakeDecodedExecutor(runResult(entry.a, entry.b));
    const engine = engineFor(executor);
    t.after(async () => {
      await engine.dispose();
    });
    await assert.rejects(
      engine.prepare({ path: `/unused/${entry.label}.wav` }, request()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "preparation-gate-failed");
        assert.match(error.message, /preparation-gate-failed/);
        assert.match(error.message, new RegExp(entry.classification));
        return true;
      },
      `${entry.label} must refuse before v1 preparation`,
    );
    assert.equal(executor.calls, 1, "the decoded pair was reached before refusal");
    assert.equal(executor.disposed, false);
  }
});

test("periodic preflight ambiguity is carried into v2 disclosures and notes", async (t) => {
  const tones = sine(FRAMES, 437);
  const executor = new FakeDecodedExecutor(runResult(pcm(tones), pcm(tones)));
  const engine = engineFor(executor);
  t.after(async () => {
    await engine.dispose();
  });
  const artifact = await engine.prepare({ path: "/unused/periodic.wav" }, request());
  assert.equal(artifact.validity?.policy, "delivered-validity-v2");
  const gate = artifact.validity?.policy === "delivered-validity-v2"
    ? artifact.validity.preparationGate
    : null;
  assert.ok(gate);
  assert.equal(gate.status, "passed");
  assert.equal(gate.classification, "same-polarity-periodic-ambiguous");
  assert.ok(gate.disclosure);
  assert.ok(artifact.disclosures.includes(gate.disclosure!));
  assert.ok(artifact.validity?.notes.some((note) => /no unique lag/.test(note)));
});
