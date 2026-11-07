import { Worker } from "node:worker_threads";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TypeScriptNativePreparationEngineOptions } from "@codec-abx/engine-native/typescript";
import { hasLiveOwnedProcess } from "@codec-abx/engine-native/typescript";
import {
  AUDIO_MAX_DURATION_SECONDS,
  AUDIO_MAX_INPUT_BYTES,
  type PreparationProgress,
  type DesktopRuntimeFailure,
} from "@codec-abx/contracts";
import { guardSnapshot, guardReceipt, guardPublicTrial, guardExport, guardReadAudio } from "@codec-abx/experiment-browser/protocol";
import { validateRequest, exact, handle, type Operation } from "./boundary.js";
import { DesktopWorkerError, WORKER_VERSION, envelope, errorDTO } from "./worker-protocol.js";
import { guardPreparedArtifact, guardNativeCapabilities } from "./prepared-artifact.js";
export interface WorkerRuntimeOptions {
  readonly workerPath: string;
  readonly engine: Omit<TypeScriptNativePreparationEngineOptions, "processObserver" | "tempRoot">;
  readonly pickSource: () => Promise<string | null>;
  readonly progress: (jobId: string, progress: PreparationProgress) => void;
  readonly fatal?: (failure: DesktopRuntimeFailure) => void;
  /** Trusted test/probe overrides; never renderer arguments. */
  readonly deadlines?: {
    readonly startup?: number;
    readonly operation?: number;
    readonly prepare?: number;
    readonly bind?: number;
    readonly read?: number;
    readonly dispose?: number;
  };
}
interface Pending { operation: Operation; resolve: (input: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; jobId?: string }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const WINDOWS = process.platform === "win32";
/**
 * Windows has no process-group signal. Run the system taskkill by absolute
 * path (the packaged acceptance environment deliberately empties PATH) and
 * walk descendants with /T. Exit 128 means the process was already gone.
 */
function killWindowsTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const root = process.env.SystemRoot ?? process.env.windir;
  const executable = root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe";
  return new Promise((resolve, reject) => {
    let killer: ChildProcess;
    try {
      killer = spawn(executable, ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true,
      });
    } catch (error) { reject(error); return; }
    const timeout = setTimeout(() => {
      try { killer.kill(); } catch { /* command already gone */ }
      reject(new Error("Windows process-tree termination timed out"));
    }, 5000);
    killer.once("error", error => { clearTimeout(timeout); reject(error); });
    killer.once("close", code => {
      clearTimeout(timeout);
      if (code === 0 || code === 128) resolve();
      else reject(new Error(`taskkill ${signal} exited ${String(code)}`));
    });
  });
}
// Ten-minute material with up to four stages per side cannot be supervised by
// the old three-minute desktop request deadline. Binding independently verifies
// and measures the full pair, while serving copies bounded WAV bytes; each gets
// its own deadline. Answer and short control operations keep the original 30 s.
const DEFAULT_PREPARE_DEADLINE_MS = AUDIO_MAX_DURATION_SECONDS * 3_000;
const DEFAULT_BIND_DEADLINE_MS = AUDIO_MAX_DURATION_SECONDS * 3_000;
const DEFAULT_READ_DEADLINE_MS = AUDIO_MAX_DURATION_SECONDS * 500;
const DEFAULT_OPERATION_DEADLINE_MS = 30_000;
/** One persistent worker and one experiment assignment owner per renderer lifetime. */
export class WorkerDesktopRuntime {
  private readonly session = randomBytes(32).toString("hex");
  private readonly pending = new Map<number, Pending>();
  private readonly lateAnswers = new Set<number>();
  private readonly children = new Map<number, boolean>();
  private readonly picks = new Set<number>();
  private worker: Worker | null = null;
  private temporary: string | null = null;
  private sequence = 0;
  private lastPicker = 0;
  private closed = false;
  private failed = false;
  private ready = false;
  private cleanup: Promise<void> | null = null;
  private closeResolve: ((ok: boolean) => void) | null = null;
  private readonly startup: Promise<void>;
  private readonly initialization: Promise<void>;
  private startupResolve!: () => void;
  private startupReject!: (reason: unknown) => void;
  constructor(private readonly options: WorkerRuntimeOptions) {
    this.startup = new Promise((resolve, reject) => { this.startupResolve = resolve; this.startupReject = reject; });
    // Initialization errors are observed even if no renderer request arrives.
    void this.startup.catch(() => undefined);
    this.initialization = this.start().catch(() => this.fail("worker-fatal"));
  }
  private async start() {
    this.temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-desktop-"));
    if (this.closed) { this.startupReject(new DesktopWorkerError("disposed", "Desktop runtime closed")); return; }
    const spawnAuditPath = process.env.CODEC_ABX_TEST_SPAWN_AUDIT;
    const worker = this.worker = new Worker(this.options.workerPath, {
      workerData: { session: this.session, engine: { ...this.options.engine, tempRoot: this.temporary } },
      ...(spawnAuditPath ? { execArgv: ["--require", spawnAuditPath] } : {}),
    });
    const timer = setTimeout(() => this.fail("worker-fatal"), this.options.deadlines?.startup ?? 15_000);
    worker.on("message", value => { try { this.receive(value); } catch { this.fail("protocol-error"); } });
    worker.on("messageerror", () => this.fail("protocol-error"));
    worker.on("error", () => this.fail("worker-fatal"));
    worker.on("exit", () => { clearTimeout(timer); if (!this.closed) this.fail("worker-fatal"); this.closeResolve?.(false); });
    void this.startup.finally(() => clearTimeout(timer)).catch(() => undefined);
  }
  private send(type: string, fields: object = {}) { this.worker!.postMessage({ version: WORKER_VERSION, session: this.session, type, ...fields }); }
  private receive(input: unknown) {
    if (!input || typeof input !== "object" || !("type" in input)) throw new Error("Invalid worker message");
    const value = input as Record<string, unknown>;
    switch (value.type) {
      case "ready":
        envelope(value, this.session, []);
        if (this.ready) throw new Error("Duplicate worker startup");
        this.ready = true; if (!this.closed) this.startupResolve(); return;
      case "child": {
        envelope(value, this.session, ["event", "acknowledgement"]);
        const event = value.event;
        if (!event || typeof event !== "object" || Object.keys(event).sort().join() !== "detached,pid,type" || !("pid" in event) || !("type" in event) || !("detached" in event) || !Number.isSafeInteger(event.pid) || (event.pid as number) <= 1 || typeof event.detached !== "boolean") throw new Error("Invalid owned child");
        if (event.type === "spawn") {
          if (this.children.has(event.pid as number) || !(value.acknowledgement instanceof SharedArrayBuffer) || value.acknowledgement.byteLength !== 4) throw new Error("Invalid child registration");
          this.children.set(event.pid as number, event.detached);
          if (this.closed) void this.signalChild(event.pid as number, event.detached, "SIGKILL").catch(() => this.fail("worker-fatal"));
          Atomics.store(new Int32Array(value.acknowledgement), 0, 1); Atomics.notify(new Int32Array(value.acknowledgement), 0);
        } else if (event.type === "exit" && value.acknowledgement === null && this.children.has(event.pid as number)) {
          // Kill leftover descendants even if their native leader has exited.
          void this.retireExitedChild(event.pid as number, event.detached);
        } else throw new Error("Invalid child exit");
        return;
      }
      case "pick": {
        envelope(value, this.session, ["id"]);
        if (!this.ready || this.closed || !Number.isSafeInteger(value.id) || (value.id as number) <= this.lastPicker || this.picks.has(value.id as number) || this.picks.size >= 64) throw new Error("Invalid picker request");
        const id = value.id as number; this.lastPicker = id; this.picks.add(id);
        void this.options.pickSource().then(selected => {
          if (!this.closed && this.picks.delete(id)) this.send("pickResult", { id, path: selected });
        }, () => { if (!this.closed && this.picks.delete(id)) this.send("pickResult", { id, path: null }); }).catch(() => this.fail("worker-fatal"));
        return;
      }
      case "progress":
        envelope(value, this.session, ["jobId", "progress"]);
        if (typeof value.jobId !== "string" || !value.progress || typeof value.progress !== "object" || Object.keys(value.progress).sort().join() !== "message,phase" || !("phase" in value.progress) || !["loading", "probing", "encoding", "preparing", "measuring", "complete"].includes(String(value.progress.phase)) || !("message" in value.progress) || typeof value.progress.message !== "string") throw new Error("Invalid progress");
        if (!this.closed) {
          if (![...this.pending.values()].some(pending => pending.operation === "prepare" && pending.jobId === value.jobId)) throw new Error("Unknown progress correlation");
          this.options.progress(value.jobId, value.progress as unknown as PreparationProgress);
        } return;
      case "result": {
        const record = value as Record<string, unknown>;
        envelope(value, this.session, ["id", "operation", "ok", record.ok === true ? "value" : "error"]);
        if (!this.ready || !Number.isSafeInteger(value.id) || typeof value.ok !== "boolean") throw new Error("Invalid result");
        if (this.closed) return;
        const id = value.id as number;
        const pending = this.pending.get(id);
        if (!pending) { if (value.operation === "answer" && this.lateAnswers.delete(id)) return; throw new Error("Unknown result correlation"); }
        if (pending.operation !== value.operation) throw new Error("Reflected result");
        if (value.ok === false) errorDTO(value.error);
        if (value.ok === true) this.guardResult(pending.operation, value.value);
        clearTimeout(pending.timer); this.pending.delete(id);
        if (value.ok) pending.resolve(value.value);
        else { const error = value.error as import("./worker-protocol.js").RuntimeErrorDTO; pending.reject(new DesktopWorkerError(error.code, error.message, error.reasons, error.uncertain)); }
        return;
      }
      case "closed":
        envelope(value, this.session, ["ok", "error"]);
        if (!this.closed || !this.closeResolve || typeof value.ok !== "boolean") throw new Error("Unexpected shutdown acknowledgement");
        if (value.ok === false) errorDTO(value.error); else if (value.error !== null) throw new Error("Invalid shutdown acknowledgement");
        this.closeResolve(value.ok); this.closeResolve = null; return;
      case "fatal": envelope(value, this.session, []); this.fail("worker-fatal"); return;
      default: throw new Error("Unknown worker message");
    }
  }
  private guardResult(operation: Operation, value: unknown): void {
    switch (operation) {
      case "configure": case "snapshot": case "bindPrepared": case "seal": case "reset": guardSnapshot(value); return;
      case "nextTrial": guardPublicTrial(value); return;
      case "answer": guardReceipt(value); return;
      case "export": guardExport(value); return;
      case "readAudio": case "readCanaryAudio": case "trialAudio": guardReadAudio(value); return;
      case "cancel": case "release": case "dispose": if (value !== undefined) throw new Error("Invalid empty result"); return;
      case "pickSource":
        if (value === null) return;
        exact(value, ["id", "name", "size"]); handle(value.id);
        if (typeof value.name !== "string" || /[\\/]/.test(value.name) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > AUDIO_MAX_INPUT_BYTES) throw new Error("Invalid source metadata"); return;
      case "prepare":
        guardPreparedArtifact(value); return;
      case "capabilities":
        guardNativeCapabilities(value); return;
    }
  }
  async invoke(operation: Operation, args: unknown[]): Promise<unknown> {
    if (this.closed) throw new DesktopWorkerError(this.failed ? "worker-fatal" : "disposed", "Desktop runtime is closed", [], operation === "answer");
    // Preserve the fixed allowlist even for trusted non-IPC callers and freeze the
    // complete clone before the startup await can allow caller mutation.
    const frozen = structuredClone(validateRequest(operation, { version: 1, id: "private_validation", args }).args);
    await this.startup;
    if (this.closed) throw new DesktopWorkerError("disposed", "Desktop runtime is closed", [], operation === "answer");
    if (this.pending.size >= 64) throw new DesktopWorkerError("request-conflict", "Excessive desktop request");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (operation === "answer") {
          this.pending.delete(id); this.lateAnswers.add(id);
          reject(new DesktopWorkerError("request-timeout", "Answer was not confirmed. Retry the same trial token and answer.", [], true));
          if (this.lateAnswers.size > 64) this.fail("worker-fatal");
        } else this.fail("worker-fatal");
      }, operation === "prepare"
        ? this.options.deadlines?.prepare ?? DEFAULT_PREPARE_DEADLINE_MS
        : operation === "bindPrepared"
          ? this.options.deadlines?.bind ?? DEFAULT_BIND_DEADLINE_MS
          : operation === "readAudio" || operation === "readCanaryAudio" || operation === "trialAudio"
            ? this.options.deadlines?.read ?? DEFAULT_READ_DEADLINE_MS
            : this.options.deadlines?.operation ?? DEFAULT_OPERATION_DEADLINE_MS);
      this.pending.set(id, { operation, resolve, reject, timer, ...(operation === "prepare" ? { jobId: frozen[2] as string } : {}) });
      try { this.send("invoke", { id, operation, args: frozen }); } catch { this.fail("worker-fatal"); }
    });
  }
  private fail(code: "worker-fatal" | "protocol-error") {
    if (this.failed) return;
    this.failed = true; this.closed = true;
    this.startupReject(new DesktopWorkerError(code, "Desktop worker stopped. Close and restart the application."));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DesktopWorkerError(code, "Desktop worker stopped. Close and restart the application.", [], pending.operation === "answer")); }
    this.pending.clear(); this.picks.clear();
    try { this.options.fatal?.({ code, message: "Desktop worker stopped. Close and restart the application.", reasons: [], uncertain: false }); } catch { /* Callback cannot bypass custody cleanup. */ }
    void this.dispose().catch(() => undefined);
  }
  private async signalChild(pid: number, detached: boolean, signal: NodeJS.Signals): Promise<void> {
    if (WINDOWS) { await killWindowsTree(pid, signal); return; }
    try { process.kill(detached ? -pid : pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  private async retireExitedChild(pid: number, detached: boolean): Promise<void> {
    try { await this.signalChild(pid, detached, "SIGKILL"); }
    catch { this.fail("worker-fatal"); return; }
    // Leader exit alone does not prove its descendants are gone.
    try { if (!await hasLiveOwnedProcess(pid, detached)) this.children.delete(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") { this.children.delete(pid); return; }
      this.fail("worker-fatal"); return;
    }
    if (this.children.has(pid)) await this.retireGroup(pid, detached);
  }
  private async retireGroup(pid: number, detached: boolean) {
    // Avoid retaining a dead group number until window close, when that number
    // might have been reused. A leader exit is followed by a short verified reap.
    for (let attempt = 0; attempt < 100 && this.children.has(pid); attempt++) {
      try { if (!await hasLiveOwnedProcess(pid, detached)) { this.children.delete(pid); return; } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { this.children.delete(pid); return; }
        this.fail("worker-fatal"); return;
      }
      await delay(20);
    }
    if (this.children.has(pid)) this.fail("worker-fatal");
  }
  private async cleanChildren() {
    // taskkill /T on Windows is asynchronous; await every tree kill so the
    // release cannot race descendant teardown.
    for (const [pid, detached] of this.children) {
      try { await this.signalChild(pid, detached, "SIGTERM"); } catch { /* verified below */ }
    }
    if (this.children.size) await delay(100);
    for (const [pid, detached] of this.children) {
      try { await this.signalChild(pid, detached, "SIGKILL"); } catch { /* verified below */ }
    }
    // Parent libuv owns reaping direct native processes. Wait for exit registration or
    // verify no live process remains; zombies cannot execute or retain files.
    for (let attempt = 0; attempt < 100 && this.children.size; attempt++) {
      for (const [pid, detached] of this.children) {
        try { if (!await hasLiveOwnedProcess(pid, detached)) this.children.delete(pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") this.children.delete(pid); else throw error; }
      }
      if (this.children.size) await delay(20);
    }
    if (this.children.size) throw new DesktopWorkerError("cleanup-unconfirmed", "Native child cleanup could not be confirmed");
  }
  /** Trusted supervisor diagnostics, never dispatched through renderer IPC. */
  diagnostics() { return { workers: this.worker && this.worker.threadId !== -1 ? 1 : 0, children: this.children.size, temporaryRoot: this.temporary }; }
  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.startupReject(new DesktopWorkerError("disposed", "Desktop runtime closed"));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DesktopWorkerError("disposed", "Desktop runtime closed", [], pending.operation === "answer")); }
    this.pending.clear(); this.picks.clear();
    this.cleanup = (async () => {
      try {
        // start() may still be creating the private temporary root.
        await this.initialization;
        let graceful = !this.failed;
        if (this.worker) {
          let timer: NodeJS.Timeout | undefined;
          const acknowledged = new Promise<boolean>(resolve => { this.closeResolve = resolve; timer = setTimeout(() => resolve(false), this.options.deadlines?.dispose ?? 10_000); });
          try { this.send("shutdown"); } catch { this.closeResolve?.(false); }
          graceful = (await acknowledged) && graceful; clearTimeout(timer); this.closeResolve = null;
          // Never terminate before killing every native group announced so far.
          let childFailure: unknown;
          try { await this.cleanChildren(); } catch (error) { childFailure = error; }
          let terminationTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([this.worker.terminate(), new Promise<never>((_resolve, reject) => { terminationTimer = setTimeout(() => reject(new DesktopWorkerError("cleanup-unconfirmed", "Desktop worker termination could not be confirmed")), 5_000); })]);
          } finally {
            clearTimeout(terminationTimer);
            // All worker messages precede exit. A spawn already posted at escalation
            // is registered/killed while closing and checked again after termination.
            await this.cleanChildren();
          }
          if (childFailure && this.children.size) throw childFailure;
        }
        if (!graceful || this.failed) throw new DesktopWorkerError("cleanup-unconfirmed", "Desktop worker cleanup required escalation. Close the application.");
      } finally {
        // Attempt file cleanup even when termination/child verification fails;
        // those failures still reject, rather than claiming cleanup succeeded.
        if (this.temporary) await fs.rm(this.temporary, { recursive: true, force: true });
      }
    })(); return this.cleanup;
  }
}
