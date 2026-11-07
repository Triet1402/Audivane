import { parentPort, workerData } from "node:worker_threads";
import { TypeScriptNativePreparationEngine } from "@codec-abx/engine-native/typescript";
import { OPERATIONS, validateRequest } from "./boundary.js";
import { DesktopRuntime } from "./runtime.js";
import { WORKER_VERSION, envelope, publicError } from "./worker-protocol.js";
if (!parentPort) throw new Error("Desktop runtime requires a private worker port");
const port = parentPort;
const { session, engine: options } = workerData;
const send = (type: string, fields: object = {}, transfer: ArrayBuffer[] = []) => port.postMessage({ version: WORKER_VERSION, session, type, ...fields }, transfer);
let closed = false, fatalSent = false, picker = 0, lastRequest = 0;
const picks = new Map<number, { resolve: (value: string | null) => void; reject: (error: unknown) => void }>();
const runtime = new DesktopRuntime({
  engine: new TypeScriptNativePreparationEngine({ ...options, processObserver: event => {
    // Register ownership before the engine continues. Main acknowledges via
    // shared memory, so terminating a blocked worker cannot outrun PID custody.
    try {
      if (event.type === "spawn") {
        const acknowledgement = new SharedArrayBuffer(4);
        send("child", { event, acknowledgement });
        Atomics.wait(new Int32Array(acknowledgement), 0, 0, 10_000);
        if (Atomics.load(new Int32Array(acknowledgement), 0) !== 1) throw new Error("Supervisor did not acknowledge native child");
      } else send("child", { event, acknowledgement: null });
    } catch (error) {
      // Native observers deliberately swallow callback exceptions. Signal fatal
      // and start cleanup explicitly, including when the parent port is gone.
      if (event.type === "spawn") {
        try { process.kill(event.detached && process.platform !== "win32" ? -event.pid : event.pid, "SIGKILL"); } catch { /* Main also retains announced ownership. */ }
      }
      void fatal(); throw error;
    }
  } }),
  pickSource: () => new Promise((resolve, reject) => { const id = ++picker; picks.set(id, { resolve, reject }); send("pick", { id }); }),
  progress: (jobId, progress) => send("progress", { jobId, progress }),
});
let cleaning: Promise<void> | null = null;
function cleanup() {
  if (cleaning) return cleaning;
  closed = true;
  for (const pick of picks.values()) pick.reject(new Error("Desktop runtime closed"));
  picks.clear();
  cleaning = runtime.dispose(); return cleaning;
}
async function fatal() {
  if (!fatalSent) { fatalSent = true; try { send("fatal"); } catch { /* Parent port may already be gone. */ } }
  try { await cleanup(); } catch { /* Main must still supervise owned children. */ }
  port.close();
}
port.on("message", (input: unknown) => {
  void (async () => {
    if (closed) return;
    if (!input || typeof input !== "object" || !("type" in input)) throw new Error("Invalid private message");
    const value = input as Record<string, unknown>;
    if (value.type === "pickResult") {
      envelope(value, session, ["id", "path"]);
      if (typeof value.id !== "number" || !picks.has(value.id) || !(value.path === null || typeof value.path === "string")) throw new Error("Invalid picker correlation");
      const pick = picks.get(value.id)!; picks.delete(value.id); pick.resolve(value.path); return;
    }
    if (value.type === "shutdown") {
      envelope(value, session, []);
      try { await cleanup(); send("closed", { ok: true, error: null }); }
      catch (error) { send("closed", { ok: false, error: publicError(error) }); }
      port.close(); return;
    }
    envelope(value, session, ["id", "operation", "args"]);
    if (value.type !== "invoke" || !Number.isSafeInteger(value.id) || (value.id as number) <= lastRequest || !OPERATIONS.includes(value.operation as never)) throw new Error("Invalid command correlation");
    lastRequest = value.id as number;
    const operation = value.operation as typeof OPERATIONS[number];
    const validated = validateRequest(operation, { version: 1, id: `private_request_${value.id}`, args: value.args });
    try {
      const result = await runtime.invoke(operation, validated.args);
      if (closed) return;
      // Copy exact bytes: never detach an engine/service-owned buffer or a Buffer pool.
      const owned = result instanceof ArrayBuffer ? result.slice(0) : result;
      send("result", { id: value.id, operation, ok: true, value: owned }, owned instanceof ArrayBuffer ? [owned] : []);
    } catch (error) { if (!closed) send("result", { id: value.id, operation, ok: false, error: publicError(error, operation === "answer") }); }
  })().catch(() => void fatal());
});
process.on("uncaughtException", () => void fatal());
process.on("unhandledRejection", () => void fatal());
send("ready");
