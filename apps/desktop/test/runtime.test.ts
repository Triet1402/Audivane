import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineCapabilities, PreparedArtifact, PreparationRequest, Side } from "@codec-abx/contracts";
import type { PreparationEngine, PrepareOptions } from "@codec-abx/preparation";
import type { NativeCodecSource } from "@codec-abx/engine-native/typescript";
import { buildArtifact, makeReaders, deferred } from "../../../packages/experiment/test/fixtures.js";
import { DesktopRuntime } from "../src/runtime.js";
const plan = { version: 1 as const, plannedTrials: 2, alpha: 0.05, labelMode: "fixed" as const, calibrationEnabled: false };
class Engine implements PreparationEngine<NativeCodecSource> {
  readonly built = buildArtifact({ id: "artifact0123456789abcdef" });
  readonly readers = makeReaders(this.built);
  readonly released: string[] = [];
  disposed = false;
  prepareWork: ((options: PrepareOptions) => Promise<PreparedArtifact>) | null = null;
  capabilities(): Promise<EngineCapabilities> { return Promise.resolve(this.built.artifact.engine); }
  prepare(_source: NativeCodecSource, _request: PreparationRequest, options: PrepareOptions = {}): Promise<PreparedArtifact> { return this.prepareWork?.(options) ?? Promise.resolve(structuredClone(this.built.artifact)); }
  readAudio(id: string, side: Side): Promise<ArrayBuffer> { return this.readers.readAudio(id, side); }
  async release(id: string): Promise<void> { this.released.push(id); }
  async dispose(): Promise<void> { this.disposed = true; }
}
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-source-"));
  const filename = path.join(directory, "private-source.wav"); await fs.writeFile(filename, "placeholder");
  const engine = new Engine();
  const runtime = new DesktopRuntime({ engine, pickSource: () => Promise.resolve(filename), progress: () => undefined });
  const source = (await runtime.pickSource())!;
  return { engine, runtime, source, directory, filename, cleanup: async () => { await runtime.dispose(); await fs.rm(directory, { recursive: true, force: true }); } };
}
test("source handles expose basename/size only and cannot read arbitrary files", async () => {
  const f = await setup();
  try {
    assert.deepEqual(Object.keys(f.source).sort(), ["id", "name", "size"]);
    assert.equal(f.source.name, "private-source.wav"); assert.equal(JSON.stringify(f.source).includes(f.directory), false);
    await assert.rejects(f.runtime.prepare(f.filename, f.engine.built.artifact.request, "job1"), { code: "source-invalid" });
    await f.runtime.pickSource();
    await assert.rejects(f.runtime.prepare(f.source.id, f.engine.built.artifact.request, "job2"), { code: "source-invalid" });
    await assert.rejects(f.runtime.invoke("readAudio", ["unknown-artifact", "a"]), { code: "artifact-invalid" });
  } finally { await f.cleanup(); }
});
test("main-owned metadata binding is atomic and retains active artifacts until explicit close", async () => {
  const f = await setup();
  try {
    const publicArtifact = await f.runtime.prepare(f.source.id, f.engine.built.artifact.request, "job1");
    (publicArtifact as { sourceSha256: string }).sourceSha256 = "renderer-forgery";
    await f.runtime.invoke("configure", [plan]);
    const bound = await f.runtime.bind(publicArtifact.id);
    assert.equal(bound.prepared?.sourceSha256, f.engine.built.artifact.sourceSha256);
    await assert.rejects(f.runtime.release(publicArtifact.id), { code: "artifact-in-use" });
    const corrupt = structuredClone(f.engine.built.artifact); (corrupt as { id: string }).id = "corrupt0123456789abcdef"; (corrupt as { sourceSha256: string }).sourceSha256 = "bad";
    f.engine.prepareWork = () => Promise.resolve(corrupt);
    await f.runtime.prepare(f.source.id, corrupt.request, "job2");
    await assert.rejects(f.runtime.bind(corrupt.id));
    assert.equal((await f.runtime.invoke("snapshot", []) as typeof bound).prepared?.artifactId, publicArtifact.id);
    await f.runtime.release(corrupt.id);
    await assert.rejects(f.runtime.release(publicArtifact.id), { code: "artifact-in-use" });
    await f.runtime.disposeExperiment(); await f.runtime.release(publicArtifact.id);
    assert.deepEqual(f.engine.released, [corrupt.id, publicArtifact.id]);
    await assert.rejects(f.runtime.invoke("snapshot", []), { code: "not-configured" });
    const next = await f.runtime.invoke("configure", [plan]) as typeof bound;
    assert.notEqual(next.runId, bound.runId); assert.equal(next.prepared, null);
  } finally { await f.cleanup(); }
});
test("cancel waits for owned cleanup and a late success is released rather than published", async () => {
  const f = await setup(); const gate = deferred(); const started = deferred();
  try {
    let signal: AbortSignal | undefined;
    f.engine.prepareWork = async options => { signal = options.signal; started.resolve(); await gate.promise; return f.engine.built.artifact; };
    const work = f.runtime.prepare(f.source.id, f.engine.built.artifact.request, "job1");
    const rejected = assert.rejects(work, { code: "cancelled" });
    await started.promise;
    let cancelled = false; const cancellation = f.runtime.cancel("job1").then(() => { cancelled = true; });
    assert.equal(signal?.aborted, true); await Promise.resolve(); assert.equal(cancelled, false);
    gate.resolve(); await cancellation; await rejected;
    assert.deepEqual(f.engine.released, [f.engine.built.artifact.id]);
    await assert.rejects(f.runtime.bind(f.engine.built.artifact.id), { code: "not-configured" });
    await assert.rejects(f.runtime.prepare(f.source.id, f.engine.built.artifact.request, "job1"), { code: "job-conflict" });
  } finally { gate.resolve(); await f.cleanup(); }
});
test("renderer disposal invalidates late dialogs and waits for engine disposal", async () => {
  const engine = new Engine(); const gate = deferred(); const engineDone = deferred();
  engine.dispose = async () => { await engineDone.promise; engine.disposed = true; };
  const runtime = new DesktopRuntime({ engine, pickSource: async () => { await gate.promise; return "/tmp/never-served.wav"; }, progress: () => undefined });
  const pick = runtime.pickSource(); const refused = assert.rejects(pick, { code: "disposed" });
  let cleaned = false; const cleanup = runtime.dispose().then(() => { cleaned = true; });
  gate.resolve(); await refused; assert.equal(cleaned, false);
  engineDone.resolve(); await cleanup; assert.equal(engine.disposed, true);
  await assert.rejects(runtime.invoke("configure", [plan]), { code: "disposed" });
});

test("cancel and prepare both disclose a main-side cleanup failure after abort", async () => {
  const f = await setup(); const started = deferred(); const gate = deferred();
  try {
    f.engine.prepareWork = async () => {
      started.resolve(); await gate.promise;
      throw new Error("cleanup failed: rm EACCES");
    };
    const work = f.runtime.prepare(f.source.id, f.engine.built.artifact.request, "cleanup-failure");
    const rejected = assert.rejects(work, { code: "cleanup-unconfirmed" });
    await started.promise;
    const cancellation = assert.rejects(f.runtime.cancel("cleanup-failure"), { code: "cleanup-unconfirmed" });
    gate.resolve();
    await Promise.all([rejected, cancellation]);
  } finally { gate.resolve(); await f.cleanup(); }
});

test("failed main artifact release retains ownership and retries the engine operation", async () => {
  const f = await setup();
  try {
    const artifact = await f.runtime.prepare(f.source.id, f.engine.built.artifact.request, "release-failure");
    let attempts = 0;
    f.engine.release = async id => {
      f.engine.released.push(id);
      if (++attempts === 1) throw new Error("temporary release failure");
    };
    await assert.rejects(f.runtime.release(artifact.id), /temporary release failure/);
    await f.runtime.release(artifact.id);
    assert.equal(attempts, 2);
    await assert.rejects(f.runtime.invoke("readAudio", [artifact.id, "a"]), { code: "artifact-invalid" });
    await f.runtime.release(artifact.id);
    assert.equal(attempts, 2, "successful release remains idempotent");
  } finally { await f.cleanup(); }
});
