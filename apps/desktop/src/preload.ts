import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@codec-abx/contracts";

// No IPC object, event, arbitrary operation or channel crosses contextBridge.
const prefix = "codec-abx:desktop:v1:";
let sequence = 0;
async function call<T>(operation: string, args: unknown[]): Promise<T> {
  const id = `desktop-request-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  let response: { version: number; id: string; ok: boolean; value?: T; error?: { code: string; message: string; reasons: string[]; uncertain: boolean } };
  try { response = await ipcRenderer.invoke(prefix + operation, { version: 1, id, args }); }
  catch {
    throw { name: "DesktopError", message: "Desktop runtime did not confirm the operation", code: "transport-failed", reasons: [], uncertain: operation === "answer" };
  }
  if (!response || response.version !== 1 || response.id !== id || typeof response.ok !== "boolean") {
    throw { name: "DesktopError", message: "Invalid desktop runtime response", code: "transport-failed", reasons: [], uncertain: operation === "answer" };
  }
  if (!response.ok) {
    throw { name: "DesktopError", message: response.error?.message ?? "Desktop request refused", code: response.error?.code ?? "runtime-failed", reasons: response.error?.reasons ?? [], uncertain: response.error?.uncertain ?? operation === "answer" };
  }
  return response.value as T;
}
const bridge: DesktopBridge = {
  version: 1,
  preparation: {
    pickSource: () => call("pickSource", []),
    capabilities: () => call("capabilities", []),
    prepare: (sourceId, request, jobId) => call("prepare", [sourceId, request, jobId]),
    cancel: jobId => call("cancel", [jobId]),
    readAudio: (artifactId, side) => call("readAudio", [artifactId, side]),
    readCanaryAudio: (artifactId, side) => call("readCanaryAudio", [artifactId, side]),
    release: artifactId => call("release", [artifactId]),
    onProgress: listener => {
      const handler = (_event: unknown, payload: { jobId: string; progress: Parameters<typeof listener>[1] }): void => { listener(payload.jobId, payload.progress); };
      ipcRenderer.on(prefix + "progress", handler);
      return () => { ipcRenderer.removeListener(prefix + "progress", handler); };
    },
  },
  experiment: {
    onFatal: listener => {
      const handler = (_event: unknown, failure: { code: string; message: string; reasons: readonly string[]; uncertain: boolean }) => {
        if (!failure || !["worker-fatal", "protocol-error", "disposed"].includes(failure.code)) return;
        listener({ code: failure.code as "worker-fatal" | "protocol-error" | "disposed", message: "Desktop worker stopped. Close and restart the application.", reasons: [], uncertain: false });
      };
      ipcRenderer.on(prefix + "fatal", handler);
      return () => { ipcRenderer.removeListener(prefix + "fatal", handler); };
    },
    configure: plan => call("configure", [plan]),
    snapshot: () => call("snapshot", []),
    bindPrepared: artifactId => call("bindPrepared", [artifactId]),
    nextTrial: () => call("nextTrial", []),
    answer: (token, answer) => call("answer", [token, answer]),
    readAudio: (token, label) => call("trialAudio", [token, label]),
    seal: reason => call("seal", reason === undefined ? [] : [reason]),
    reset: () => call("reset", []),
    export: () => call("export", []),
    dispose: () => call("dispose", []),
  },
};
contextBridge.exposeInMainWorld("codecAbxDesktop", bridge);
