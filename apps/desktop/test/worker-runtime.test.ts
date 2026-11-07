import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { WorkerDesktopRuntime } from "../src/worker-runtime.js";
import { profile, signal, nativeRequest } from "../../../tools/profile-native.js";
import type { DesktopSource, PreparedArtifact, ExperimentSnapshot, PublicTrial } from "@codec-abx/contracts";
import { publicNativeArtifact } from "./artifact-fixture.js";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string, workerPath: string;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-worker-test-"));
  workerPath = path.join(directory, "runtime-worker.cjs");
  await build({ entryPoints: [path.join(repositoryRoot, "apps/desktop/src/runtime-worker.ts")], outfile: workerPath, bundle: true, platform: "node", format: "cjs", target: "node24", define: { "import.meta.url": "__bundleUrl" }, banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' } });
});
after(async () => fs.rm(directory, { recursive: true, force: true }));
const plan = { version: 1, plannedTrials: 2, alpha: .05, labelMode: "blind_random", calibrationEnabled: false };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function harness(options: Partial<ConstructorParameters<typeof WorkerDesktopRuntime>[0]> = {}) {
  const source = path.join(directory, `source-${Math.random()}.wav`); await fs.writeFile(source, signal(1).bytes);
  const runtime = new WorkerDesktopRuntime({ workerPath, engine: { repositoryRoot }, pickSource: async () => source, progress: () => undefined, ...options });
  return { runtime, source };
}
test("bundled persistent worker retains exact bytes, native identity, null decisions, redaction and token retries", async () => {
  const { runtime } = await harness();
  try {
    const source = await runtime.invoke("pickSource", []) as DesktopSource;
    assert.deepEqual(Object.keys(source).sort(), ["id", "name", "size"]);
    const artifact = await runtime.invoke("prepare", [source.id, nativeRequest, "worker_prepare_job_01"]) as PreparedArtifact;
    assert.equal(artifact.engine.engineId, "engine-native-typescript");
    assert.equal(artifact.request.preparationPolicy, "aligned-gain-matched-v1");
    assert.equal(artifact.preparation?.policy, "aligned-gain-matched-v1");
    assert.equal(artifact.measurements.policy, "aligned-gain-matched-v1");
    assert.equal(artifact.validity?.nullGate.status, "passed");
    const originalHash = artifact.sourceSha256;
    const audio = await runtime.invoke("readAudio", [artifact.id, "a"]) as ArrayBuffer;
    const originalAudio = audio.slice(0); new Uint8Array(audio).fill(0);
    assert.deepEqual(await runtime.invoke("readAudio", [artifact.id, "a"]), originalAudio);
    (artifact as { sourceSha256: string }).sourceSha256 = "renderer-forgery";
    await runtime.invoke("configure", [plan]);
    const bound = await runtime.invoke("bindPrepared", [artifact.id]) as ExperimentSnapshot;
    assert.equal(bound.prepared?.sourceSha256, originalHash);
    await assert.rejects(runtime.invoke("release", [artifact.id]), { code: "artifact-in-use" });
    const trial = await runtime.invoke("nextTrial", []) as PublicTrial;
    assert.deepEqual(Object.keys(trial).sort(), ["kind", "runId", "token", "trialIndex"]);
    const exported = await runtime.invoke("export", []) as { reveal: { redacted: boolean; secretHex: string | null; xSequence: unknown[] } };
    assert.equal(exported.reveal.redacted, true); assert.equal(exported.reveal.secretHex, null); assert.deepEqual(exported.reveal.xSequence, []);
    const served = await runtime.invoke("trialAudio", [trial.token, "X"]) as ArrayBuffer;
    assert.deepEqual(served, originalAudio);
    const receipt = await runtime.invoke("answer", [trial.token, "A"]);
    assert.deepEqual(await runtime.invoke("answer", [trial.token, "A"]), receipt);
    await runtime.invoke("reset", []);
    await assert.rejects(runtime.invoke("answer", [trial.token, "A"]));
    await runtime.invoke("seal", []);
    await assert.rejects(runtime.invoke("nextTrial", []));
    await runtime.invoke("dispose", []);
    await assert.rejects(runtime.invoke("snapshot", []), { code: "not-configured" });
    const fresh = await runtime.invoke("configure", [plan]) as ExperimentSnapshot;
    assert.notEqual(fresh.runId, bound.runId); assert.equal(fresh.prepared, null);
    await runtime.invoke("release", [artifact.id]);
  } finally { await runtime.dispose(); }
  assert.equal(runtime.diagnostics().workers, 0); assert.equal(runtime.diagnostics().children, 0);
  await assert.rejects(fs.stat(runtime.diagnostics().temporaryRoot!), { code: "ENOENT" });
});
test("actual native prepare and service verification preserve science and owned resource cleanup", async () => {
  const direct = await profile("direct", 1, repositoryRoot, workerPath);
  const worker = await profile("worker", 1, repositoryRoot, workerPath);
  assert.deepEqual(worker.scientific, direct.scientific);
  // Maximum-duration heartbeat comparisons belong to the serial Electron
  // performance phase, not the concurrently scheduled functional unit lane.
  assert.equal(worker.workersAfter, 0); assert.equal(worker.nativeChildrenAfter, 0);
});
async function fixture(code: string) {
  const filename = path.join(directory, `fixture-${Math.random()}.cjs`);
  await fs.writeFile(filename, `const {parentPort:p,workerData:d}=require('node:worker_threads'); const send=(type,fields={})=>p.postMessage({version:1,session:d.session,type,...fields}); send('ready'); ${code}`);
  return filename;
}
test("reflected/unknown result fails closed, rejects all pending calls and announces fatal only once", async () => {
  const filename = await fixture(`p.on('message',m=>{if(m.type==='invoke')send('result',{id:m.id,operation:'answer',ok:true,value:{secret:'never returned'}});if(m.type==='shutdown'){send('closed',{ok:true,error:null});p.close()}})`);
  let fatals = 0; const { runtime } = await harness({ workerPath: filename, fatal: () => fatals++, deadlines: { dispose: 200 } });
  await assert.rejects(runtime.invoke("snapshot", []), { code: "protocol-error" });
  await assert.rejects(runtime.invoke("configure", [plan]), { code: "worker-fatal" });
  await assert.rejects(runtime.dispose(), { code: "cleanup-unconfirmed" });
  assert.equal(fatals, 1); assert.equal(runtime.diagnostics().workers, 0);
});
test("answer deadline remains uncertain and permits exact-token retry without creating a run", async () => {
  const filename = await fixture(`let answer; p.on('message',m=>{if(m.type==='invoke'){if(!answer){answer=m;setTimeout(()=>send('result',{id:m.id,operation:m.operation,ok:true,value:{runId:'run001',token:m.args[0],trialIndex:1,kind:'scored',answer:m.args[1],correct:true,answeredAtUtc:'2026-10-29T00:00:00Z'}}),80)}else send('result',{id:m.id,operation:m.operation,ok:true,value:{runId:'run001',token:m.args[0],trialIndex:1,kind:'scored',answer:m.args[1],correct:true,answeredAtUtc:'2026-10-29T00:00:00Z'}})}if(m.type==='shutdown'){send('closed',{ok:true,error:null});p.close()}})`);
  const { runtime } = await harness({ workerPath: filename, deadlines: { operation: 30 } });
  try {
    await assert.rejects(runtime.invoke("answer", ["exact_trial_token_001", "A"]), { code: "request-timeout", uncertain: true });
    assert.equal((await runtime.invoke("answer", ["exact_trial_token_001", "A"]) as { token: string }).token, "exact_trial_token_001");
    await sleep(100); assert.equal(runtime.diagnostics().workers, 1);
  } finally { await runtime.dispose(); }
});
test("long-track bind and read watchdogs use their own bounded deadlines", async () => {
  for (const [operation, args] of [
    ["bindPrepared", ["artifact_unit_001"]],
    ["readAudio", ["artifact_unit_001", "a"]],
  ] as const) {
    const filename = await fixture("");
    const started = Date.now();
    const { runtime } = await harness({
      workerPath: filename,
      fatal: () => undefined,
      deadlines: { bind: 40, read: 40, operation: 5_000, dispose: 200 },
    });
    try {
      await assert.rejects(runtime.invoke(operation, [...args]), { code: "worker-fatal" });
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < 2_000,
        `${operation} should use its long-track category deadline, observed ${String(elapsed)} ms`,
      );
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  }
});

test("close invalidates a late native dialog and refuses queued invocations", async () => {
  let select!: (value: string | null) => void, opened!: () => void;
  const shown = new Promise<void>(resolve => { opened = resolve; });
  const { runtime, source } = await harness({ pickSource: () => { opened(); return new Promise(resolve => { select = resolve; }); } });
  const pending = assert.rejects(runtime.invoke("pickSource", []), { code: "disposed" });
  await shown; const cleanup = runtime.dispose(); select(source); await pending; await cleanup;
  await assert.rejects(runtime.invoke("configure", [plan]), { code: "disposed" });
  assert.equal(runtime.diagnostics().workers, 0);
});
test("worker refuses malformed private commands rather than reflecting arbitrary methods", async () => {
  const session = "protocol_test_session";
  const worker = new Worker(workerPath, { workerData: { session, engine: { repositoryRoot, tempRoot: directory } } });
  try {
    await new Promise<void>((resolve, reject) => { worker.on("error", reject); worker.on("message", message => { if (message.type === "ready") resolve(); }); });
    const refused = new Promise<void>((resolve, reject) => { worker.on("error", reject); worker.on("message", message => { if (message.type === "fatal") resolve(); }); });
    worker.postMessage({ version: 1, session, type: "invoke", id: 1, operation: "constructor", args: [] });
    await refused;
  } finally { await worker.terminate(); }
});
test("fatal worker escalation kills its announced native child group and removes its private temporary root", {
  // The fake native executable is a POSIX shell script and the descendant
  // ownership check relies on POSIX process groups. Windows tree custody is
  // exercised only on a real Windows runner, which this host does not provide.
  skip: process.platform === "win32" ? "POSIX process-group fixture; Windows tree custody needs a Windows runner" : false,
  timeout: 20_000,
}, async () => {
  const fake = path.join(directory, "hanging-ffprobe.cjs"), recorded = path.join(directory, "child.pid"), descendant = path.join(directory, "descendant.pid");
  // A real Node-owned native executable: it accepts the ffprobe argv, starts a
  // descendant in its own process group, ignores SIGTERM and never reports.
  await fs.writeFile(fake, `#!/usr/bin/env node
const { spawn } = require("node:child_process");

const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
fs.writeFileSync(${JSON.stringify(recorded)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(descendant)}, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  let fatals = 0;
  const { runtime } = await harness({ engine: { repositoryRoot, ffprobePath: fake }, deadlines: { prepare: 500, dispose: 50 }, fatal: () => fatals++ });
  const source = await runtime.invoke("pickSource", []) as DesktopSource;
  await assert.rejects(runtime.invoke("prepare", [source.id, nativeRequest, "fatal_native_job_01"]), { code: "worker-fatal" });
  await assert.rejects(runtime.dispose(), { code: "cleanup-unconfirmed" });
  const pid = Number(await fs.readFile(recorded, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const grandchild = Number(await fs.readFile(descendant, "utf8")); assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
  assert.equal(runtime.diagnostics().workers, 0); assert.equal(runtime.diagnostics().children, 0); assert.equal(fatals, 1);
  await assert.rejects(fs.stat(runtime.diagnostics().temporaryRoot!), { code: "ENOENT" });
});

test("idle worker exit emits a public fatal notification without a subsequent invocation", async () => {
  const filename = await fixture(`setTimeout(()=>process.exit(23),100);`);
  let notified!: () => void; const notification = new Promise<void>(resolve => { notified = resolve; });
  const { runtime } = await harness({ workerPath: filename, fatal: notified, deadlines: { dispose: 50 } });
  await notification;
  await assert.rejects(runtime.dispose(), { code: "cleanup-unconfirmed" });
  assert.equal(runtime.diagnostics().workers, 0);
});

test("a correctly correlated forged snapshot cannot expose additional assignment fields", async () => {
  const filename = await fixture(`p.on('message',m=>{if(m.type==='invoke')send('result',{id:m.id,operation:m.operation,ok:true,value:{secretHex:'forged-secret'}});if(m.type==='shutdown'){send('closed',{ok:true,error:null});p.close()}})`);
  const { runtime } = await harness({ workerPath: filename, deadlines: { dispose: 100 } });
  await assert.rejects(runtime.invoke("snapshot", []), { code: "protocol-error" });
  await assert.rejects(runtime.dispose(), { code: "cleanup-unconfirmed" });
});

test("correlated prepare replies reject nested private fields and malformed requests/stages", async () => {
  const artifact = publicNativeArtifact();
  const forged = [
    { ...artifact, a: { ...artifact.a, sourcePath: "/private/source.wav" } },
    { ...artifact, request: { ...artifact.request, privatePath: "/private" } },
    { ...artifact, a: { ...artifact.a, stages: [{ stageIndex: 1, ...artifact.a, sourcePath: "/private" }] } },
  ];
  for (const value of forged) {
    const filename = await fixture(`p.on('message',m=>{if(m.type==='invoke')send('result',{id:m.id,operation:m.operation,ok:true,value:${JSON.stringify(value)}});if(m.type==='shutdown'){send('closed',{ok:true,error:null});p.close()}})`);
    const { runtime } = await harness({ workerPath: filename, deadlines: { dispose: 100 } });
    await assert.rejects(runtime.invoke("prepare", ["public_source_handle_001", nativeRequest, "forged_prepare_job_001"]), { code: "protocol-error" });
    await assert.rejects(runtime.dispose(), { code: "cleanup-unconfirmed" });
  }
});

test("termination failure still attempts private directory cleanup and remains a failure", async () => {
  const filename = await fixture(`p.on('message',m=>{if(m.type==='shutdown')send('closed',{ok:true,error:null});if(m.type==='invoke')send('result',{id:m.id,operation:m.operation,ok:true,value:undefined})})`);
  const { runtime } = await harness({ workerPath: filename });
  await runtime.invoke("cancel", ["ready_cancellation_job_001"]);
  const worker = (runtime as unknown as { worker: Worker }).worker;
  const terminate = worker.terminate.bind(worker);
  worker.terminate = async () => { throw new Error("injected termination failure"); };
  try {
    await assert.rejects(runtime.dispose(), /injected termination failure/);
    assert.equal(runtime.diagnostics().workers, 1);
    await assert.rejects(fs.stat(runtime.diagnostics().temporaryRoot!), { code: "ENOENT" });
  } finally { await terminate(); }
});

test("dispose during worker initialization removes its root and starts no replacement worker", async () => {
  const { runtime } = await harness();
  await runtime.dispose();
  assert.equal(runtime.diagnostics().workers, 0);
  await assert.rejects(fs.stat(runtime.diagnostics().temporaryRoot!), { code: "ENOENT" });
  await assert.rejects(runtime.invoke("capabilities", []), { code: "disposed" });
});

test("missing child ownership acknowledgement explicitly fails the worker and cleans the real child", { timeout: 20_000 }, async () => {
  const session = "missing_child_ack_session", tempRoot = path.join(directory, "unacknowledged-temp");
  await fs.mkdir(tempRoot);
  const source = path.join(directory, "unacknowledged-source.wav"); await fs.writeFile(source, signal(1).bytes);
  const worker = new Worker(workerPath, { workerData: { session, engine: { repositoryRoot, tempRoot } } });
  let pid: number | null = null;
  try {
    const fatal = new Promise<void>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", message => {
        const send = (type: string, fields: object) => worker.postMessage({ version: 1, session, type, ...fields });
        if (message.type === "ready") send("invoke", { id: 1, operation: "pickSource", args: [] });
        else if (message.type === "pick") send("pickResult", { id: message.id, path: source });
        else if (message.type === "result" && message.operation === "pickSource") send("invoke", { id: 2, operation: "prepare", args: [message.value.id, nativeRequest, "missing_ack_job_001"] });
        else if (message.type === "child" && message.event.type === "spawn") pid = message.event.pid; // Deliberately do not acknowledge.
        else if (message.type === "fatal") resolve();
      });
    });
    const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
    await fatal; await exited;
    assert.notEqual(pid, null); assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    assert.deepEqual(await fs.readdir(tempRoot), []);
  } finally {
    if (pid) { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {} }
    await worker.terminate();
  }
});
