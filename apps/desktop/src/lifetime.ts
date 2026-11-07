import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import path from "node:path";

/** Packaged location consumed by the guarded Electron main process. */
export const WINDOWS_PROCESS_HOST_DIRECTORY = "process-host";
export const WINDOWS_PROCESS_HOST_FILENAME = "audivane-process-host.exe";
export const WINDOWS_PROCESS_HOST_STARTUP_MS = 15_000;

export interface WindowsProcessHostResolution {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly repositoryRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Resolve the trusted lifetime host. A configured path is authoritative and
 * must be absolute; no PATH or shell discovery is attempted. Windows startup
 * fails closed when the helper is missing rather than running uncontained.
 */
export function resolveWindowsProcessHost(options: WindowsProcessHostResolution): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  const environment = options.environment ?? process.env;
  const configured = environment.CODEC_ABX_PROCESS_HOST;
  if (configured !== undefined && configured !== "") {
    if (!path.win32.isAbsolute(configured)) {
      throw new Error("CODEC_ABX_PROCESS_HOST must be an absolute trusted executable path");
    }
    return configured;
  }
  return options.packaged
    ? path.win32.join(options.resourcesPath, WINDOWS_PROCESS_HOST_DIRECTORY, WINDOWS_PROCESS_HOST_FILENAME)
    : path.win32.join(options.repositoryRoot, "build", "windows-process-host", "bin", WINDOWS_PROCESS_HOST_FILENAME);
}

export interface WindowsLifetime {
  readonly hostPath: string;
  readonly pid: number | undefined;
}

export interface StartWindowsLifetimeOptions {
  readonly hostPath: string;
  readonly mainPid?: number;
  readonly platform?: NodeJS.Platform;
  readonly startupTimeoutMs?: number;
  /** Test seam only; production uses node:child_process.spawn. */
  readonly spawnProcess?: typeof spawn;
}

function hostFailure(message: string, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(detail === "" ? message : `${message}: ${detail}`);
}

/**
 * Start the separate guard that owns the whole-desktop kill-on-close Job
 * Object. Readiness is reported only after the current main process has been
 * assigned, so the caller may not create windows, workers or codec children
 * before this promise resolves. A missing host, protocol error, timeout or
 * early exit rejects; there is no uncontained fallback.
 */
export async function startWindowsLifetime(
  options: StartWindowsLifetimeOptions,
): Promise<WindowsLifetime | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  if (!options.hostPath || !path.isAbsolute(options.hostPath)) {
    throw new Error("Windows process lifetime host path must be absolute");
  }
  try {
    accessSync(options.hostPath);
  } catch {
    throw new Error(`Windows process lifetime host is missing: ${options.hostPath}`);
  }
  const mainPid = options.mainPid ?? process.pid;
  if (!Number.isSafeInteger(mainPid) || mainPid <= 1) {
    throw new Error("Windows process lifetime guard requires a valid main-process PID");
  }
  const timeoutMs = options.startupTimeoutMs ?? WINDOWS_PROCESS_HOST_STARTUP_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Windows process lifetime startup timeout must be a positive number");
  }
  const launch = options.spawnProcess ?? spawn;
  let child: ChildProcess;
  try {
    child = launch(options.hostPath, ["--guard", String(mainPid)], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    throw hostFailure(
      "Unable to start the Windows process lifetime guard",
      error instanceof Error ? error.message : String(error),
    );
  }

  return new Promise<WindowsLifetime>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      finish(new Error(
        `Windows process lifetime guard did not become ready within ${String(timeoutMs)} ms`,
      ));
    }, timeoutMs);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        child.stdout?.on("error", () => undefined);
        child.stderr?.on("error", () => undefined);
        child.on("error", () => undefined);
        child.stdout?.destroy();
        child.stderr?.destroy();
        try { child.kill(); } catch { /* a failed helper is already gone */ }
        reject(error);
        return;
      }
      // The guard has no further protocol. Drop the pipes and let it wait
      // independently of this process's event loop; its kernel job handle is
      // the lifetime authority, not a parent/child relationship.
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      child.stdout?.on("error", () => undefined);
      child.stderr?.on("error", () => undefined);
      child.on("error", () => undefined);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(Object.freeze({ hostPath: options.hostPath, pid: child.pid }));
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4096) {
        finish(hostFailure("Windows process lifetime guard returned an invalid readiness message", stderr));
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      if (line !== "ready") {
        finish(hostFailure("Windows process lifetime guard refused containment", stderr));
        return;
      }
      finish();
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once("error", (error: Error) => {
      finish(hostFailure("Windows process lifetime guard could not be started", error.message));
    });
    child.once("exit", (code, signal) => {
      finish(hostFailure(
        `Windows process lifetime guard exited before readiness (code ${String(code)}, signal ${String(signal)})`,
        stderr,
      ));
    });
  });
}
