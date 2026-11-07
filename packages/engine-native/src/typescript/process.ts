import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasLiveOwnedProcess } from "./process-group.js";

/** Runtime-private observation of every process this module directly spawns. */
export interface NativeProcessObservation {
  readonly type: "spawn" | "exit";
  readonly pid: number;
  readonly detached: boolean;
}

export type NativeProcessObserver = (event: NativeProcessObservation) => void;

export interface NativeProcessRunOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface NativeProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const NATIVE_PROCESS_TERM_GRACE_MS = 2_000;
export const NATIVE_PROCESS_EXIT_WAIT_MS = 5_000;
export const NATIVE_PROCESS_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const NATIVE_PROCESS_MAX_STDERR_BYTES = 256 * 1024;
export const NATIVE_PROCESS_DEFAULT_TIMEOUT_MS = 120_000;

export function nativeAbortError(): DOMException {
  return new DOMException("Native codec operation aborted", "AbortError");
}

/** A cleanup failure is never reported as an AbortError. */
export class NativeProcessCleanupError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "NativeProcessCleanupError";
    this.cause = cause;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DETACHED = process.platform !== "win32";

export interface NativeSpawnCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** True when the trusted Windows lifetime host owns the real executable. */
  readonly viaHost: boolean;
}

/**
 * Route every Windows native-codec spawn through the trusted lifetime host.
 * The host starts the real process suspended in a kill-on-close Job Object, so
 * descendants cannot survive an early leader exit or cancellation. An absent,
 * relative or empty host is a hard refusal: there is no uncontained fallback.
 * POSIX keeps its existing detached process-group semantics.
 */
export function resolveNativeSpawnCommand(
  file: string,
  args: readonly string[],
  windowsProcessHost: string | undefined,
  platform: NodeJS.Platform = process.platform,
): NativeSpawnCommand {
  if (platform !== "win32") return Object.freeze({ file, args: Object.freeze([...args]), viaHost: false });
  if (windowsProcessHost === undefined || windowsProcessHost === "") {
    throw new Error(
      "Windows native process lifetime host is required; refusing to spawn an uncontained process",
    );
  }
  if (!path.win32.isAbsolute(windowsProcessHost)) {
    throw new Error("Windows native process lifetime host path must be absolute");
  }
  return Object.freeze({
    file: windowsProcessHost,
    args: Object.freeze(["--run", file, ...args]),
    viaHost: true,
  });
}

/** Windows system tool even when PATH is deliberately empty or poisoned. */
function taskkillExecutable(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe";
}

/**
 * Windows has no process-group signal. taskkill /T walks the parent-child tree;
 * /F is the SIGKILL equivalent. Exit 128 means the process was already gone, so
 * a retired leader is a successful cleanup rather than a failure.
 */
function killWindowsTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve, reject) => {
    let killer: ChildProcess;
    try {
      killer = spawn(
        taskkillExecutable(),
        ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } catch (error: unknown) {
      reject(error);
      return;
    }
    const timeout = setTimeout(() => {
      try { killer.kill(); } catch { /* command already gone */ }
      reject(new Error("Windows process-tree termination timed out"));
    }, 5000);
    killer.once("error", error => { clearTimeout(timeout); reject(error); });
    killer.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || code === 128) resolve();
      else reject(new Error(`taskkill ${signal} exited ${String(code)}`));
    });
  });
}

/**
 * Owns direct child processes for one native codec executor.
 *
 * - spawn(file, argv) with `shell: false`; no argument string is ever parsed.
 * - POSIX children lead their own process group so descendants are signalled.
 *   Windows children are started through the trusted lifetime host, which owns
 *   a kill-on-close Job Object for the codec tree; taskkill remains a bounded
 *   targeted cancellation tool, not the lifetime authority. The system tool is
 *   resolved absolutely so a poisoned PATH cannot hide it.
 * - Output is bounded; a process that exceeds a bound is terminated.
 * - Cancellation sends SIGTERM, then SIGKILL after a bounded grace period, and
 *   waits for the child to exit before the caller observes failure.
 * - A cleanup error, not an AbortError, is thrown when owned resources could
 *   not be confirmed cleaned up.
 */
export class NativeProcessManager {
  private readonly observer: NativeProcessObserver | undefined;
  private readonly active = new Set<ChildProcess>();
  private readonly stoppers = new Map<ChildProcess, (reason: "dispose") => void>();
  private readonly windowsTerminations = new Set<Promise<void>>();
  private readonly runs = new Set<Promise<unknown>>();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    observer?: NativeProcessObserver,
    private readonly windowsProcessHost?: string,
  ) {
    this.observer = observer;
  }

  run(options: NativeProcessRunOptions): Promise<NativeProcessResult> {
    if (this.disposed) return Promise.reject(new Error("Native process manager has been disposed"));
    const run = this.runInner(options);
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run)).catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      for (const child of [...this.active]) {
        const stop = this.stoppers.get(child);
        if (stop) stop("dispose");
        else this.signalOwnedGroup(child, "SIGKILL", []);
      }
      const results = await Promise.allSettled([...this.runs]);
      // A second pass covers a process that was between spawn and registration.
      for (const child of [...this.active]) {
        this.signalOwnedGroup(child, "SIGKILL", []);
      }
      await this.awaitWindowsTerminations();
      const failedCleanup = results.find(result => result.status === "rejected" &&
        result.reason instanceof NativeProcessCleanupError);
      if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
    })();
    return this.disposal;
  }

  private async runInner(options: NativeProcessRunOptions): Promise<NativeProcessResult> {
    const signal = options.signal;
    if (signal?.aborted) throw nativeAbortError();
    if (!options.file) throw new Error("Native process executable is empty");
    if (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== "string")) {
      throw new Error("Native process arguments must be an argv array of strings");
    }

    const maxStdout = options.maxStdoutBytes ?? NATIVE_PROCESS_MAX_STDOUT_BYTES;
    const maxStderr = options.maxStderrBytes ?? NATIVE_PROCESS_MAX_STDERR_BYTES;
    const timeoutMs = options.timeoutMs ?? NATIVE_PROCESS_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Native process timeout must be a finite positive number");
    }

    let command: NativeSpawnCommand;
    try {
      command = resolveNativeSpawnCommand(options.file, options.args, this.windowsProcessHost);
    } catch (error: unknown) {
      throw new Error(`Unable to start ${options.label}: ${describeError(error)}`);
    }

    let child: ChildProcess;
    try {
      child = spawn(command.file, [...command.args], {
        shell: false,
        detached: DETACHED,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      throw new Error(`Unable to start ${options.label}: ${describeError(error)}`);
    }

    const pid = child.pid;
    const cleanupErrors: Error[] = [];
    const processState: { spawnError: Error | null } = { spawnError: null };
    let stdout = "";
    let stderr = "";
    let termination: "abort" | "timeout" | "output" | "dispose" | null = null;
    let termTimer: NodeJS.Timeout | null = null;
    let exitWaitTimer: NodeJS.Timeout | null = null;
    let rejectExitWait: ((error: Error) => void) | null = null;
    let stdoutBytes = 0, stderrBytes = 0;

    const armExitDeadline = (milliseconds: number): void => {
      if (exitWaitTimer !== null) clearTimeout(exitWaitTimer);
      exitWaitTimer = setTimeout(() => {
        this.signalOwnedGroup(child, "SIGKILL", cleanupErrors);
        rejectExitWait?.(new Error(`Timed out waiting for ${options.label} to exit`));
      }, milliseconds);
      exitWaitTimer.unref();
    };

    this.active.add(child);
    if (pid !== undefined) this.notify({ type: "spawn", pid, detached: DETACHED });

    const terminate = (reason: Exclude<typeof termination, null>): void => {
      const first = termination === null;
      if (termination === null) termination = reason;
      this.signalOwnedGroup(child, "SIGTERM", cleanupErrors);
      if (termTimer !== null) return;
      termTimer = setTimeout(() => {
        this.signalOwnedGroup(child, "SIGKILL", cleanupErrors);
      }, NATIVE_PROCESS_TERM_GRACE_MS);
      termTimer.unref();
      if (first && rejectExitWait !== null) {
        armExitDeadline(NATIVE_PROCESS_TERM_GRACE_MS + NATIVE_PROCESS_EXIT_WAIT_MS);
      }
    };

    const onAbort = (): void => terminate("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    this.stoppers.set(child, terminate);
    const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    timeoutTimer.unref();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxStdout) {
        terminate("output");
        return;
      }
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > maxStderr) {
        terminate("output");
        return;
      }
      stderr += chunk;
    });

    const closed = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("error", (error: Error) => {
        processState.spawnError = error;
        if (child.pid === undefined) finish();
      });
      child.once("close", finish);
      // A descendant can inherit stdio and keep `close` pending after its
      // leader exits. Retire the owned group at `exit`, before awaiting close.
      child.once("exit", () => this.signalOwnedGroup(child, "SIGKILL", cleanupErrors));
    });

    // Bound how long an unkillable child can keep a caller waiting. Reaching
    // this timer is itself a cleanup failure and is reported as such.
    const exitWait = new Promise<void>((_resolve, reject) => {
      rejectExitWait = reject;
      armExitDeadline(timeoutMs + NATIVE_PROCESS_TERM_GRACE_MS + NATIVE_PROCESS_EXIT_WAIT_MS);
    });

    // An observer can abort synchronously during spawn registration.
    if (signal?.aborted) onAbort();

    try {
      await Promise.race([closed, exitWait]);
    } catch (error: unknown) {
      cleanupErrors.push(error instanceof Error ? error : new Error(describeError(error)));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeoutTimer);
      if (termTimer !== null) clearTimeout(termTimer);
      if (exitWaitTimer !== null) clearTimeout(exitWaitTimer);
    }

    // Even after a successful parent exit, an owned group may contain a
    // descendant. SIGKILL the group; ESRCH means there is nothing left.
    if (pid !== undefined) {
      this.signalOwnedGroup(child, "SIGKILL", cleanupErrors);
      // Windows descendant termination is asynchronous. Let every taskkill
      // finish (including the one scheduled at exit) before confirming.
      await this.awaitWindowsTerminations(cleanupErrors);
      try { await this.confirmGroupStopped(pid); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    this.active.delete(child);
    this.stoppers.delete(child);
    if (pid !== undefined) this.notify({ type: "exit", pid, detached: DETACHED });

    const exitCode = child.exitCode;
    const exitSignal = child.signalCode;
    if (processState.spawnError !== null) {
      if (cleanupErrors.length > 0) {
        throw new NativeProcessCleanupError(
          `${options.label} failed to start and cleanup could not be confirmed`,
          processState.spawnError,
        );
      }
      throw new Error(`Unable to start ${options.label}: ${processState.spawnError.message}`);
    }
    if (cleanupErrors.length > 0) {
      throw new NativeProcessCleanupError(
        `${options.label} did not clean up its owned process group: ` +
          cleanupErrors.map(describeError).join("; "),
        termination,
      );
    }
    if (termination === "abort") throw nativeAbortError();
    if (termination === "timeout") {
      throw new Error(`${options.label} exceeded its ${String(timeoutMs)} ms time limit`);
    }
    if (termination === "output") {
      throw new Error(`${options.label} exceeded its bounded diagnostic output`);
    }
    if (termination === "dispose") throw nativeAbortError();

    return { code: exitCode, signal: exitSignal, stdout, stderr };
  }

  private signalOwnedGroup(
    child: ChildProcess,
    signal: NodeJS.Signals,
    cleanupErrors: Error[],
  ): void {
    const pid = child.pid;
    if (pid !== undefined && process.platform === "win32") {
      const pending = killWindowsTree(pid, signal).catch((error: unknown) => {
        cleanupErrors.push(
          new Error(`process-tree ${String(signal)} failed: ${describeError(error)}`),
        );
      });
      this.windowsTerminations.add(pending);
      void pending.finally(() => this.windowsTerminations.delete(pending)).catch(() => undefined);
      return;
    }
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error: unknown) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "ESRCH") return;
        cleanupErrors.push(
          new Error(`process-group ${String(signal)} failed: ${describeError(error)}`),
        );
      }
    }
    try {
      child.kill(signal);
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "ESRCH") {
        cleanupErrors.push(new Error(`${String(signal)} failed: ${describeError(error)}`));
      }
    }
  }

  private async confirmGroupStopped(pid: number): Promise<void> {
    // POSIX acceptance verifies the whole detached group. Windows verifies the
    // leader after taskkill /T has already signalled its descendants.
    const deadline = Date.now() + NATIVE_PROCESS_EXIT_WAIT_MS;
    while (await hasLiveOwnedProcess(pid, DETACHED)) {
      if (Date.now() >= deadline) throw new Error("Owned native process group has live members after cleanup");
      await delay(20);
    }
  }

  /** A hung taskkill is unconfirmed cleanup, never a successful release. */
  private async awaitWindowsTerminations(cleanupErrors?: Error[]): Promise<void> {
    const deadline = Date.now() + NATIVE_PROCESS_EXIT_WAIT_MS;
    while (this.windowsTerminations.size > 0) {
      if (Date.now() >= deadline) {
        const failure = new Error("Windows process-tree termination did not complete");
        if (cleanupErrors) { cleanupErrors.push(failure); return; }
        throw new NativeProcessCleanupError(failure.message, failure);
      }
      await Promise.race([
        Promise.allSettled([...this.windowsTerminations]),
        delay(50),
      ]);
    }
  }

  private notify(event: NativeProcessObservation): void {
    try {
      this.observer?.(event);
    } catch {
      // Observation is bookkeeping owned by the caller; a throwing observer
      // must never prevent this manager from cleaning up its own child.
    }
  }
}
