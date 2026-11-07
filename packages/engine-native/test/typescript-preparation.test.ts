import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDIO_CANARY_EXCERPT_SECONDS,
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  AUDIO_MAX_RETAINED_BYTES,
  AUDIO_MAX_WAV_BYTES,
  type PreparationRequest,
} from "@codec-abx/contracts";
import { ExperimentService } from "@codec-abx/experiment";
import { decodePcm16, measureNullDepth } from "@codec-abx/measurements";

import {
  NATIVE_PREPARATION_MAX_RETAINED_BYTES,
  NATIVE_PREPARATION_MAX_SECONDS,
  TypeScriptNativePreparationEngine,
  type TypeScriptNativePreparationEngineOptions,
} from "@codec-abx/engine-native/typescript";
import { parseCanonicalPcm16Wav } from "../src/typescript/preparation-wav.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type SignalKind = "sine" | "nonperiodic" | "antiphase" | "silence";

function sourceSample(kind: SignalKind, rate: number, channel: number, frame: number): number {
  const t = frame / rate;
  if (kind === "silence") return 0;
  if (kind === "nonperiodic") {
    // Deterministic chirp/partial mix; deliberately not periodic at the probe.
    const value =
      0.16 * Math.sin(2 * Math.PI * (317 * t + 41 * t * t)) +
      0.09 * Math.sin(2 * Math.PI * (911 * t + 0.37)) +
      0.05 * Math.sin(2 * Math.PI * (1499 * t + 1.13));
    return Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
  }
  const value = 8_000 * Math.sin((2 * Math.PI * (437 + channel * 211) * t));
  if (kind === "antiphase" && channel === 1) return Math.round(-value);
  return Math.round(value);
}

function writePcm32Wav(
  file: string,
  format: "int" | "float",
  rate: number,
  channels: 1 | 2,
  frames: readonly (readonly number[])[],
): Buffer {
  const dataSize = frames.length * channels * 4;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(format === "float" ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  frames.forEach((frame, frameIndex) => {
    frame.forEach((value, channel) => {
      const offset = 44 + (frameIndex * channels + channel) * 4;
      if (format === "float") bytes.writeFloatLE(value, offset);
      else bytes.writeInt32LE(value, offset);
    });
  });
  writeFileSync(file, bytes);
  return bytes;
}

function writeWav(
  file: string,
  rate: number,
  channels: 1 | 2,
  seconds: number,
  kind: SignalKind = "sine",
): Buffer {
  const frames = Math.round(rate * seconds);
  const dataSize = frames * channels * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      bytes.writeInt16LE(
        sourceSample(kind, rate, channel, frame),
        44 + (frame * channels + channel) * 2,
      );
    }
  }
  writeFileSync(file, bytes);
  return bytes;
}

interface Harness {
  readonly root: string;
  readonly tempRoot: string;
  readonly engine: TypeScriptNativePreparationEngine;
  readonly observations: string[];
  readonly source: (
    rate: number,
    channels: 1 | 2,
    seconds?: number,
    kind?: SignalKind,
  ) => Promise<{ path: string; bytes: Buffer }>;
}

async function harness(
  t: TestContext,
  extra: Partial<TypeScriptNativePreparationEngineOptions> = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typescript-preparation-"));
  const tempRoot = path.join(root, "temp");
  const observations: string[] = [];
  const engine = new TypeScriptNativePreparationEngine({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot,
    processObserver: (event) => observations.push(event.type),
    ...extra,
  });
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  let index = 0;
  return {
    root,
    tempRoot,
    engine,
    observations,
    source: async (rate, channels, seconds = 0.6, kind = "sine") => {
      const file = path.join(root, `source-${String(index++)}.wav`);
      const bytes = writeWav(file, rate, channels, seconds, kind);
      return { path: file, bytes };
    },
  };
}

function noopRequest(overrides: Partial<PreparationRequest> = {}): PreparationRequest {
  return {
    version: 1,
    sampleRateMode: "native",
    a: { codecId: "noop_passthrough", bitrateKbps: 0 },
    b: { codecId: "noop_passthrough", bitrateKbps: 0 },
    ...overrides,
  } as PreparationRequest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function tempEntries(tempRoot: string): Promise<string[]> {
  return fs.readdir(tempRoot).catch(() => []);
}

function assertCanonicalArtifact(
  artifact: Awaited<ReturnType<TypeScriptNativePreparationEngine["prepare"]>>,
  bytesA: Uint8Array,
  bytesB: Uint8Array,
): void {
  const factsA = parseCanonicalPcm16Wav(bytesA);
  const factsB = parseCanonicalPcm16Wav(bytesB);
  assert.equal(factsA.sampleRate, artifact.a.delivered.sampleRate);
  assert.equal(factsB.sampleRate, artifact.b.delivered.sampleRate);
  assert.equal(factsA.channels, artifact.a.delivered.channels);
  assert.equal(factsB.channels, artifact.b.delivered.channels);
  assert.equal(factsA.frames, artifact.a.delivered.frames);
  assert.equal(factsB.frames, artifact.b.delivered.frames);
  assert.equal(sha256(bytesA), artifact.a.delivered.wavSha256);
  assert.equal(sha256(bytesB), artifact.b.delivered.wavSha256);
  assert.ok(factsA.durationSeconds >= 0.4);
  assert.ok(factsA.durationSeconds <= NATIVE_PREPARATION_MAX_SECONDS);
  assert.ok(factsB.durationSeconds >= 0.4);
  assert.ok(factsB.durationSeconds <= NATIVE_PREPARATION_MAX_SECONDS);
}

test("capabilities are truthful and unsupported policies refuse before any work", async (t) => {
  const h = await harness(t);
  const capabilities = await h.engine.capabilities();
  assert.equal(capabilities.engineId, "engine-native-typescript");
  assert.equal(capabilities.location, "desktop-native");
  assert.equal(capabilities.preparationPolicy, "aligned-gain-matched-v1");
  assert.deepEqual(capabilities.supportedPreparationPolicies, ["aligned-gain-matched-v1"]);
  assert.equal(capabilities.maxStagesPerSide, 4);
  assert.equal(capabilities.maxInputBytes, AUDIO_MAX_INPUT_BYTES);
  assert.equal(capabilities.maxDurationSeconds, AUDIO_MAX_DURATION_SECONDS);
  assert.equal(capabilities.supportsCanaryMaterial, true);
  assert.equal(capabilities.codecs.length, 11);
  assert.equal(capabilities.codecs.find((entry) => entry.codecId === "opus")?.availability, "available");
  assert.match(capabilities.build, /TypeScript native codec executor/);
  assert.doesNotMatch(capabilities.build, /unknown-policy-v0/);
  assert.ok(capabilities.limitations.some((note) => /0\.4–1800\.5 s/.test(note)));
  assert.ok(capabilities.limitations.some((note) => /M4A\/MP4/.test(note)));
  assert.ok(capabilities.limitations.some((note) => /No external interpreter/.test(note)));

  const observationsBefore = h.observations.length;
  const missing = path.join(h.root, "does-not-exist.wav");
  await assert.rejects(
    h.engine.prepare(
      { path: missing },
      noopRequest({ preparationPolicy: "unknown-policy-v0" as never }),
    ),
    /Unsupported preparation policy/,
  );
  await assert.rejects(
    h.engine.prepare(
      { path: missing },
      noopRequest({ preparationPolicy: "codec-probe-only" }),
    ),
    /supports aligned-gain-matched-v1 only/,
  );
  await assert.rejects(
    h.engine.prepare(
      { path: missing },
      noopRequest({ preparationPolicy: "aligned-gain-matched-v1" }),
    ),
    /not readable|WAV or FLAC|regular file/,
  );
  assert.equal(h.observations.length, observationsBefore, "policy refusals must not spawn native work");
});

test("32-bit integer and float mono/stereo sources deliver exact canonical PCM16 hashes and layout", async (t) => {
  const h = await harness(t);
  for (const format of ["int", "float"] as const) {
    for (const channels of [1, 2] as const) {
      const frames: number[][] = [];
      for (let frame = 0; frame < 24_000; frame += 1) {
        const base = 0.12 * Math.sin((2 * Math.PI * (317 + frame * 0.0007) * frame) / 48_000) +
          0.07 * Math.sin((2 * Math.PI * (911 + frame * 0.0013) * frame) / 48_000);
        const low = ((frame % 17) - 8) / 2 ** 24;
        const values = [base + low];
        if (channels === 2) {
          values.push(-0.6 * base + ((frame % 13) - 6) / 2 ** 24);
        }
        frames.push(format === "int"
          ? values.map((value) => Math.max(-2_147_483_648,
              Math.min(2_147_483_647, Math.round(value * 2 ** 31))))
          : values);
      }
      const source = path.join(h.root, `source-${format}-${String(channels)}.wav`);
      const sourceBytes = writePcm32Wav(source, format, 48_000, channels, frames);
      const artifact = await h.engine.prepare({ path: source }, noopRequest());
      const aBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
      const bBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "b"));
      assert.equal(artifact.sourceSha256, sha256(sourceBytes));
      assert.equal(artifact.a.delivered.sampleRate, 48_000);
      assert.equal(artifact.b.delivered.sampleRate, 48_000);
      assert.equal(artifact.a.delivered.channels, channels);
      assert.equal(artifact.b.delivered.channels, channels);
      assert.equal(artifact.a.delivered.frames, 24_000);
      assert.equal(artifact.b.delivered.frames, 24_000);
      assert.equal(artifact.a.delivered.wavSha256, sha256(aBytes));
      assert.equal(artifact.b.delivered.wavSha256, sha256(bBytes));
      const facts = parseCanonicalPcm16Wav(aBytes);
      assert.equal(facts.sampleRate, 48_000);
      assert.equal(facts.channels, channels);
      assert.equal(facts.frames, 24_000);
    }
  }
});

test("no-op pair delivers canonical PCM16, exact null, shared policy and no canary by default", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.6, "nonperiodic");
  const artifact = await h.engine.prepare({ path: source.path }, noopRequest());
  const bytesA = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const bytesB = new Uint8Array(await h.engine.readAudio(artifact.id, "b"));

  assert.equal(artifact.request.preparationPolicy, "aligned-gain-matched-v1");
  assert.equal(artifact.engine.engineId, "engine-native-typescript");
  assert.equal(artifact.engine.location, "desktop-native");
  assert.equal(artifact.engine.preparationPolicy, "aligned-gain-matched-v1");
  assert.equal(artifact.sourceSha256, sha256(source.bytes));
  assert.equal(artifact.preparation?.policy, "aligned-gain-matched-v1");
  assert.equal(artifact.measurements.policy, "aligned-gain-matched-v1");
  assert.equal(artifact.measurements.delivered?.policy, "delivered-pcm-measurements-v1");
  assert.match(artifact.measurements.delivered!.notes.join(" "), /after aligned-gain-matched-v1 preparation/);
  assert.doesNotMatch(artifact.measurements.delivered!.notes.join(" "), /without normalization|no samples were shifted/);
  assert.equal(artifact.validity?.policy, "delivered-validity-v2");
  assert.equal(artifact.canary, undefined);
  assert.equal(artifact.validity?.nullGate.status, "passed");
  assert.equal(artifact.validity?.preparationGate.status, "passed");
  assert.equal(artifact.measurements.delivered?.nullDepth.depthDb.status, "negative-infinity");
  assert.equal(artifact.measurements.nullDepthDb, null);
  assert.ok(artifact.measurements.notes.some((note) => /negative infinity/.test(note)));
  assertCanonicalArtifact(artifact, bytesA, bytesB);
  assert.equal(artifact.preparation?.alignment.outputFrames,
    artifact.measurements.delivered?.a.frames);
  assert.equal(artifact.a.stages?.length, 1);
  assert.deepEqual(Object.keys(artifact.a.stages![0]!).sort(), [
    "actualBitrateKbps",
    "decoder",
    "encodedSampleRate",
    "encoder",
    "requested",
    "stageIndex",
  ]);
  assert.ok(!JSON.stringify({
    request: artifact.request,
    engine: artifact.engine,
    a: artifact.a,
    b: artifact.b,
    disclosures: artifact.disclosures,
  }).includes(h.root));
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("Opus and representative two-/four-stage native chains keep ordered pre-crop provenance", async (t) => {
  const h = await harness(t);
  const capabilities = await h.engine.capabilities();
  const available = new Set(
    capabilities.codecs.filter((entry) => entry.availability === "available")
      .map((entry) => entry.codecId),
  );
  assert.ok(available.has("opus"), "the real Opus profile is required for this native lane");
  for (const codecId of ["mp3", "aac", "ogg_vorbis"] as const) {
    assert.ok(available.has(codecId), `real ${codecId} is required for the chain fixture`);
  }
  const source = await h.source(48_000, 1, 0.45, "nonperiodic");

  const twoStage = await h.engine.prepare(
    { path: source.path },
    {
      version: 2,
      sampleRateMode: "native",
      a: [
        { codecId: "opus", bitrateKbps: 96 },
        { codecId: "mp3", bitrateKbps: 128 },
      ],
      b: [
        { codecId: "aac", bitrateKbps: 128 },
        { codecId: "ogg_vorbis", bitrateKbps: 128 },
      ],
    },
  );
  assert.equal(twoStage.a.stages?.length, 2);
  assert.equal(twoStage.b.stages?.length, 2);
  for (const [side, stages] of [["a", twoStage.a.stages], ["b", twoStage.b.stages]] as const) {
    assert.deepEqual(stages?.map((stage) => stage.stageIndex), [1, 2]);
    for (const stage of stages ?? []) {
      assert.ok(stage.actualBitrateKbps !== null && stage.actualBitrateKbps > 0);
      assert.ok((stage.encodedSampleRate ?? 0) > 0);
      assert.deepEqual(Object.keys(stage).sort(), [
        "actualBitrateKbps",
        "decoder",
        "encodedSampleRate",
        "encoder",
        "requested",
        "stageIndex",
      ]);
    }
    const finalStage = stages?.[stages.length - 1];
    assert.equal(twoStage[side].requested.codecId, finalStage?.requested.codecId);
    assert.equal(twoStage[side].actualBitrateKbps, finalStage?.actualBitrateKbps);
  }
  assert.equal(twoStage.validity?.nullGate.status, "not-applicable");
  const twoA = new Uint8Array(await h.engine.readAudio(twoStage.id, "a"));
  const twoB = new Uint8Array(await h.engine.readAudio(twoStage.id, "b"));
  assertCanonicalArtifact(twoStage, twoA, twoB);

  const fourStage = await h.engine.prepare(
    { path: source.path },
    {
      version: 2,
      sampleRateMode: "force_48k",
      a: [
        { codecId: "opus", bitrateKbps: 96 },
        { codecId: "mp3", bitrateKbps: 128 },
        { codecId: "aac", bitrateKbps: 128 },
        { codecId: "ogg_vorbis", bitrateKbps: 128 },
      ],
      b: [
        { codecId: "opus", bitrateKbps: 96 },
        { codecId: "mp3", bitrateKbps: 128 },
        { codecId: "aac", bitrateKbps: 128 },
        { codecId: "ogg_vorbis", bitrateKbps: 128 },
      ],
    },
  );
  assert.equal(fourStage.a.stages?.length, 4);
  assert.equal(fourStage.b.stages?.length, 4);
  assert.deepEqual(fourStage.a.stages?.map((stage) => stage.stageIndex), [1, 2, 3, 4]);
  assert.equal(fourStage.a.requested.codecId, "ogg_vorbis");
  assert.equal(sha256(new Uint8Array(await h.engine.readAudio(fourStage.id, "a"))),
    fourStage.a.delivered.wavSha256);
  assert.equal(sha256(new Uint8Array(await h.engine.readAudio(fourStage.id, "b"))),
    fourStage.b.delivered.wavSha256);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("44.1/48/96 kHz mono, stereo, anti-phase and force48 layouts survive to final bytes", async (t) => {
  const h = await harness(t);
  const cases = [
    { rate: 44_100, channels: 1 as const, mode: "native" as const, expected: 44_100, kind: "sine" as const },
    { rate: 48_000, channels: 2 as const, mode: "native" as const, expected: 48_000, kind: "nonperiodic" as const },
    { rate: 96_000, channels: 2 as const, mode: "native" as const, expected: 96_000, kind: "antiphase" as const },
    { rate: 44_100, channels: 2 as const, mode: "force_48k" as const, expected: 48_000, kind: "sine" as const },
    { rate: 96_000, channels: 2 as const, mode: "force_48k" as const, expected: 48_000, kind: "nonperiodic" as const },
  ];
  for (const entry of cases) {
    const source = await h.source(entry.rate, entry.channels, 0.45, entry.kind);
    const artifact = await h.engine.prepare(
      { path: source.path },
      noopRequest({ sampleRateMode: entry.mode }),
    );
    const bytesA = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
    const bytesB = new Uint8Array(await h.engine.readAudio(artifact.id, "b"));
    assertCanonicalArtifact(artifact, bytesA, bytesB);
    assert.equal(artifact.a.delivered.sampleRate, entry.expected);
    assert.equal(artifact.b.delivered.sampleRate, entry.expected);
    assert.equal(artifact.a.delivered.channels, entry.channels);
    assert.equal(artifact.b.delivered.channels, entry.channels);
    assert.equal(artifact.request.sampleRateMode, entry.mode);
    assert.ok(artifact.disclosures.includes(
      `Original source: WAV, ${entry.rate} Hz, ${entry.channels} channels. Session: ${entry.expected} Hz, ${entry.channels} channels (${entry.mode}).`,
    ));
    assert.equal(artifact.validity?.nullGate.status, "passed");
    assert.equal(artifact.measurements.delivered?.nullDepth.depthDb.status, "negative-infinity");
    await h.engine.release(artifact.id);
    await h.engine.release(artifact.id);
    await assert.rejects(h.engine.readAudio(artifact.id, "a"), /Unknown or released/);
  }
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("independent gains, applied crop report and full-chain validity stay consistent", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.6, "nonperiodic");
  const artifact = await h.engine.prepare(
    { path: source.path },
    {
      version: 1,
      sampleRateMode: "native",
      a: { codecId: "opus", bitrateKbps: 128 },
      b: { codecId: "noop_passthrough", bitrateKbps: 0 },
    },
  );
  const report = artifact.preparation;
  assert.ok(report);
  assert.equal(report.policy, "aligned-gain-matched-v1");
  assert.equal(artifact.validity?.nullGate.status, "not-applicable");
  assert.equal(report.alignment.startFrameA, Math.max(0, -report.alignment.lagSamples));
  assert.equal(report.alignment.startFrameB, Math.max(0, report.alignment.lagSamples));
  assert.equal(report.alignment.outputFrames,
    Math.min(report.alignment.inputFramesA - report.alignment.startFrameA,
      report.alignment.inputFramesB - report.alignment.startFrameB));
  assert.equal(report.alignment.outputFrames, artifact.a.delivered.frames);
  assert.equal(report.loudness.preA.status, "finite");
  assert.equal(report.loudness.preB.status, "finite");
  if (report.loudness.preA.status === "finite") {
    assert.ok(Math.abs(report.loudness.gainADb - (-16 - report.loudness.preA.value)) < 1e-9);
  }
  if (report.loudness.preB.status === "finite") {
    assert.ok(Math.abs(report.loudness.gainBDb - (-16 - report.loudness.preB.value)) < 1e-9);
  }
  assert.ok(Number.isFinite(report.loudness.commonTrimDb));
  assert.ok(report.loudness.commonTrimDb >= 0);
  const bytesA = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const bytesB = new Uint8Array(await h.engine.readAudio(artifact.id, "b"));
  assertCanonicalArtifact(artifact, bytesA, bytesB);
  const nullDepth = measureNullDepth(
    decodePcm16(bytesA, parseCanonicalPcm16Wav(bytesA)),
    decodePcm16(bytesB, parseCanonicalPcm16Wav(bytesB)),
  );
  assert.equal(nullDepth.depthDb.status, artifact.measurements.delivered?.nullDepth.depthDb.status);
  assert.equal(nullDepth.depthDb.value, artifact.measurements.delivered?.nullDepth.depthDb.value);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("requested canary is generated from served Side A, exact-copy reads and release fail closed", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.6, "nonperiodic");
  const artifact = await h.engine.prepare(
    { path: source.path },
    noopRequest({ canaryEnabled: true }),
  );
  assert.ok(artifact.canary);
  assert.equal(artifact.canary.report.policy, "delivered-canary-v1");
  assert.equal(artifact.canary.report.usable, true);
  assert.ok(artifact.canary.audio);

  const aBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const pristine = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "pristine"));
  const degraded = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "degraded"));
  assert.equal(sha256(pristine), artifact.canary.audio.pristine.wavSha256);
  assert.equal(sha256(degraded), artifact.canary.audio.degraded.wavSha256);
  assert.deepEqual(pristine, aBytes, "canary pristine must be the exact final served Side A");
  const pristineFacts = parseCanonicalPcm16Wav(pristine);
  const degradedFacts = parseCanonicalPcm16Wav(degraded);
  assert.equal(pristineFacts.frames, artifact.canary.report.frames);
  assert.equal(pristineFacts.channels, artifact.canary.report.channels);
  assert.equal(degradedFacts.frames, artifact.canary.report.frames);

  const measured = measureNullDepth(
    decodePcm16(pristine, pristineFacts),
    decodePcm16(degraded, degradedFacts),
  );
  assert.equal(measured.depthDb.status, artifact.canary.report.depthDb.status);
  assert.equal(measured.depthDb.value, artifact.canary.report.depthDb.value);

  // Returned arrays are owned copies; mutating one cannot change the artifact.
  const firstRead = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "pristine"));
  firstRead[0] = firstRead[0]! ^ 0xff;
  const secondRead = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "pristine"));
  assert.equal(sha256(secondRead), artifact.canary.audio.pristine.wavSha256);
  await assert.rejects(h.engine.readCanaryAudio(artifact.id, "other" as never), /Unknown canary side/);

  await h.engine.release(artifact.id);
  await h.engine.release(artifact.id);
  await assert.rejects(h.engine.readAudio(artifact.id, "a"), /Unknown or released/);
  await assert.rejects(h.engine.readCanaryAudio(artifact.id, "pristine"), /Unknown or released/);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("request and source are frozen before awaits and cannot be mutated into the artifact", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.6, "sine");
  const request: PreparationRequest = {
    version: 2,
    sampleRateMode: "native",
    a: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
    b: [{ codecId: "noop_passthrough", bitrateKbps: 0 }],
  };
  const sourceRef = { path: source.path };
  const pending = h.engine.prepare(sourceRef, request);
  // Mutate after the call returns its promise; the facade already captured these.
  sourceRef.path = path.join(h.root, "replacement.wav");
  (request.a as Array<{ codecId: string; bitrateKbps: number }>)[0]!.codecId = "opus";
  (request.a as Array<{ codecId: string; bitrateKbps: number }>)[0]!.bitrateKbps = 128;
  const artifact = await pending;
  assert.equal(artifact.sourceSha256, sha256(source.bytes));
  assert.equal(artifact.a.requested.codecId, "noop_passthrough");
  assert.equal(artifact.a.stages?.[0]?.requested.codecId, "noop_passthrough");
  assert.equal(artifact.request.version, 2);
  assert.deepEqual(artifact.request.a, [{ codecId: "noop_passthrough", bitrateKbps: 0 }]);
});

test("abort and throwing progress prevent publication while retry remains usable", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.9, "nonperiodic");

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    h.engine.prepare({ path: source.path }, noopRequest(), { signal: preAborted.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const duringCodec = new AbortController();
  await assert.rejects(
    h.engine.prepare({ path: source.path }, noopRequest(), {
      signal: duringCodec.signal,
      onProgress: (progress) => {
        if (progress.phase === "encoding") duringCodec.abort();
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.ok(h.observations.includes("spawn"));
  assert.ok(h.observations.includes("exit"));
  assert.deepEqual(await tempEntries(h.tempRoot), []);

  const retry = await h.engine.prepare({ path: source.path }, noopRequest());
  assert.equal(retry.validity?.nullGate.status, "passed");

  const beforeNumerical = new AbortController();
  await assert.rejects(
    h.engine.prepare({ path: source.path }, noopRequest(), {
      signal: beforeNumerical.signal,
      onProgress: (progress) => {
        if (progress.phase === "preparing") beforeNumerical.abort();
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  await assert.rejects(
    h.engine.prepare({ path: source.path }, noopRequest(), {
      onProgress: (progress) => {
        if (progress.phase === "encoding") throw new Error("encoding listener failed");
      },
    }),
    /encoding listener failed/,
  );
  const afterEncodingThrow = await h.engine.prepare({ path: source.path }, noopRequest());
  assert.equal(afterEncodingThrow.validity?.nullGate.status, "passed");

  let sawComplete = false;
  await assert.rejects(
    h.engine.prepare({ path: source.path }, noopRequest(), {
      onProgress: (progress) => {
        if (progress.phase === "complete") {
          sawComplete = true;
          throw new Error("final listener failed");
        }
      },
    }),
    /final listener failed/,
  );
  assert.equal(sawComplete, true, "the final facade event must be the suppressed executor completion");

  const afterCallbackFailure = await h.engine.prepare({ path: source.path }, noopRequest());
  assert.equal(afterCallbackFailure.validity?.nullGate.status, "passed");
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("dispose cancels an active job, rejects late reads and preserves idempotence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "typescript-preparation-dispose-"));
  const tempRoot = path.join(root, "temp");
  const engine = new TypeScriptNativePreparationEngine({
    repositoryRoot: REPOSITORY_ROOT,
    tempRoot,
  });
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "source.wav");
  const bytes = writeWav(file, 48_000, 2, 0.9, "nonperiodic");

  const before = await engine.prepare({ path: file }, noopRequest());
  let startedResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const pending = engine.prepare({ path: file }, noopRequest(), {
    onProgress: (progress) => {
      if (progress.phase === "loading" || progress.phase === "encoding") {
        startedResolve?.();
      }
    },
  });
  await started;
  await engine.dispose();
  await assert.rejects(pending, (error: unknown) => error instanceof Error &&
    (error.name === "AbortError" || /disposed/.test(error.message)));
  await assert.rejects(engine.readAudio(before.id, "a"), /Unknown or released|disposed/);
  await assert.rejects(engine.prepare({ path: file }, noopRequest()), /disposed/);
  await engine.dispose();
  assert.equal(bytes.length > 0, true);
});

test("prepared artifact binds through the existing ExperimentService without experiment edits", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.6, "nonperiodic");
  const artifact = await h.engine.prepare({ path: source.path }, noopRequest({ canaryEnabled: false }));
  const service = new ExperimentService();
  t.after(async () => {
    await service.dispose();
  });
  await service.configure({
    version: 1,
    plannedTrials: 4,
    alpha: 0.05,
    labelMode: "blind_random",
    calibrationEnabled: false,
  });
  const snapshot = await service.bindPrepared(artifact, {
    readAudio: (artifactId, side) => h.engine.readAudio(artifactId, side),
  });
  assert.equal(snapshot.prepared?.engineId, "engine-native-typescript");
  assert.equal(snapshot.prepared?.preparationLocation, "desktop-native");
  assert.equal(snapshot.prepared?.request.preparationPolicy, "aligned-gain-matched-v1");
  assert.equal(snapshot.gates.nullStatus, "passed");

  const trial = await service.nextTrial();
  const xBytes = new Uint8Array(await service.readAudio(trial.token, "X"));
  const aBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const bBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "b"));
  assert.ok(sha256(xBytes) === sha256(aBytes) || sha256(xBytes) === sha256(bBytes));
  await service.answer(trial.token, "A");
  await h.engine.release(artifact.id);
});

test("existing short material keeps its exact canary extent and final envelope", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 0.6, "nonperiodic");
  const artifact = await h.engine.prepare(
    { path: source.path },
    noopRequest({ canaryEnabled: true }),
  );
  assert.equal(artifact.canary?.report.frames, Math.round(0.6 * 48_000));
  const aBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const pristine = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "pristine"));
  assert.deepEqual(pristine, aBytes, "short canary pristine must still be the exact full Side A");
});

test("native preparation accepts >16 MiB and >10 s material end to end", async (t) => {
  // 45 s of 96 kHz stereo PCM16 is 17.28 MB: above the old 16 MiB input bound
  // and well above the old ten-second delivery bound.
  const h = await harness(t);
  const source = await h.source(96_000, 2, 45, "nonperiodic");
  assert.ok(source.bytes.byteLength > 16 * 1024 * 1024);
  const artifact = await h.engine.prepare({ path: source.path }, noopRequest());
  const bytesA = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const bytesB = new Uint8Array(await h.engine.readAudio(artifact.id, "b"));
  assertCanonicalArtifact(artifact, bytesA, bytesB);
  assert.equal(artifact.sourceSha256, sha256(source.bytes));
  assert.equal(artifact.a.delivered.frames, 45 * 96_000);
  assert.equal(artifact.b.delivered.frames, 45 * 96_000);
  assert.ok(artifact.a.delivered.frames / 96_000 > 10);
  assert.ok(artifact.a.delivered.frames / 96_000 <= NATIVE_PREPARATION_MAX_SECONDS);
  assert.equal(artifact.request.preparationPolicy, "aligned-gain-matched-v1");
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("long-track canary uses exactly the FIRST ten seconds of served Side A", async (t) => {
  const h = await harness(t);
  const source = await h.source(48_000, 2, 12, "nonperiodic");
  const artifact = await h.engine.prepare(
    { path: source.path },
    noopRequest({ canaryEnabled: true }),
  );
  assert.ok(artifact.canary?.audio);
  const excerptFrames = AUDIO_CANARY_EXCERPT_SECONDS * 48_000;
  assert.equal(artifact.canary.report.frames, excerptFrames);
  assert.equal(artifact.canary.audio.pristine.frames, excerptFrames);
  assert.equal(artifact.canary.audio.degraded.frames, excerptFrames);
  assert.ok(
    artifact.canary.report.notes.some((note) => /Calibration excerpt: the FIRST/.test(note)),
    "the selected calibration prefix must be disclosed",
  );
  assert.ok(
    artifact.disclosures.some((note) =>
      note.includes(`FIRST ${String(excerptFrames)} frames`) && /Side A/.test(note)),
  );

  const aBytes = new Uint8Array(await h.engine.readAudio(artifact.id, "a"));
  const aFacts = parseCanonicalPcm16Wav(aBytes);
  const pristine = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "pristine"));
  const pristineFacts = parseCanonicalPcm16Wav(pristine);
  assert.equal(pristineFacts.frames, excerptFrames);
  const sideAPrefix = aBytes.subarray(
    aFacts.dataOffset,
    aFacts.dataOffset + excerptFrames * aFacts.channels * 2,
  );
  const pristinePayload = pristine.subarray(
    pristineFacts.dataOffset,
    pristineFacts.dataOffset + pristineFacts.dataSize,
  );
  assert.deepEqual(pristinePayload, sideAPrefix);
  assert.notDeepEqual(pristine, aBytes);
  assert.deepEqual(await tempEntries(h.tempRoot), []);
});

test("retained pair plus canary bytes stay inside the derived envelope", async (t) => {
  const h = await harness(t);
  const source = await h.source(96_000, 2, 2, "nonperiodic");
  const artifact = await h.engine.prepare(
    { path: source.path },
    noopRequest({ canaryEnabled: true }),
  );
  assert.equal(NATIVE_PREPARATION_MAX_RETAINED_BYTES, AUDIO_MAX_RETAINED_BYTES);
  assert.ok(NATIVE_PREPARATION_MAX_RETAINED_BYTES >= 2 * AUDIO_MAX_WAV_BYTES);
  const total = artifact.a.delivered.frames * artifact.a.delivered.channels * 2 + 44 +
    artifact.b.delivered.frames * artifact.b.delivered.channels * 2 + 44 +
    (artifact.canary?.audio
      ? artifact.canary.audio.pristine.frames * artifact.canary.audio.pristine.channels * 2 + 44 +
        artifact.canary.audio.degraded.frames * artifact.canary.audio.degraded.channels * 2 + 44
      : 0);
  assert.ok(total <= NATIVE_PREPARATION_MAX_RETAINED_BYTES);
  assert.equal(artifact.canary?.report.usable, true);
  const pristine = new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "pristine"));
  assert.ok(pristine.byteLength + new Uint8Array(await h.engine.readAudio(artifact.id, "a")).byteLength +
    new Uint8Array(await h.engine.readAudio(artifact.id, "b")).byteLength +
    new Uint8Array(await h.engine.readCanaryAudio(artifact.id, "degraded")).byteLength <=
    NATIVE_PREPARATION_MAX_RETAINED_BYTES);
});
