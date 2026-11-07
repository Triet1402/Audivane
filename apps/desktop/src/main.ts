import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_URL, IPC_PREFIX, OPERATIONS, SOURCE_EXTENSIONS, allowedDocument, allowedResource, assetPath, allowedDownload, correlationId, fail, validateRequest } from "./boundary.js";
import { WorkerDesktopRuntime } from "./worker-runtime.js";
import { publicError } from "./worker-protocol.js";
import { resolveWindowsProcessHost, startWindowsLifetime } from "./lifetime.js";
import { ZOOM_STATE_FILE, readZoomState, writeZoomState, zoomActionForKey, zoomFactorForAction, type ZoomAction } from "./zoom.js";

// Trusted test/audit seam, never exposed to the renderer. The private worker
// receives the same --require flag through WorkerRuntime's execArgv.
const spawnAuditPath = process.env.CODEC_ABX_TEST_SPAWN_AUDIT;
if (spawnAuditPath) require(spawnAuditPath);

protocol.registerSchemesAsPrivileged([{ scheme: "codec-abx", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName("Audivane");
if (process.platform === "win32") app.setAppUserModelId("Audivane");
app.enableSandbox();

/**
 * Start the whole-desktop lifetime guard as early as the bundled main script
 * allows. Readiness means the Electron main process is already a member of a
 * kill-on-close Job Object, so every renderer, worker and codec descendant
 * created afterwards inherits it. Windows startup fails closed if this cannot
 * be established; there is no uncontained fallback.
 */
const windowsLifetime = (async () => {
  if (process.platform !== "win32") return null;
  const hostPath = resolveWindowsProcessHost({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repositoryRoot: app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../.."),
  });
  if (hostPath === null) throw new Error("Windows process lifetime host could not be resolved");
  return startWindowsLifetime({ hostPath, mainPid: process.pid });
})();
void windowsLifetime.catch(() => undefined);

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".wasm": "application/wasm", ".json": "application/json", ".woff2": "font/woff2" };
let window: BrowserWindow | null = null;
let runtime: WorkerDesktopRuntime | null = null;
let shutdown: Promise<void> | null = null;
let quitReady = false;

function clean(): Promise<void> {
  if (shutdown) return shutdown;
  const owned = runtime; runtime = null;
  shutdown = owned?.dispose() ?? Promise.resolve();
  return shutdown;
}
const safeError = publicError;

/**
 * Trusted launcher overrides for the native codec executables. Renderer
 * requests can never change these. An explicit path is authoritative in the
 * engine: an unusable value disables that tool instead of borrowing another.
 */
function nativeExecutable(environmentVariable: string): string | undefined {
  const value = process.env[environmentVariable];
  if (value === undefined || value === "") return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${environmentVariable} must be an absolute trusted executable path`);
  return value;
}

/**
 * A package carrying the provenance-controlled native bundle names those exact
 * executables. That keeps release packages off PATH discovery; a missing or
 * damaged bundled tool is reported unavailable instead of being replaced by an
 * unrelated host binary.
 */
async function bundledExecutable(name: "ffmpeg" | "ffprobe" | "ldac_helper"): Promise<string | undefined> {
  if (!app.isPackaged) return undefined;
  const manifest = path.join(process.resourcesPath, "native-bundle-manifest.json");
  if (!await fs.access(manifest).then(() => true, () => false)) return undefined;
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.join(process.resourcesPath, "third_party", name === "ldac_helper" ? "ldac" : "ffmpeg", "bin", `${name}${suffix}`);
}

/**
 * The old shell removed the window menu on Linux/Windows. Supply only the
 * standard View zoom actions: no reload, DevTools, navigation or other
 * privileged entries. The accelerators are display-only; the main process
 * handles the key variants through before-input-event, so a keypress cannot
 * zoom twice.
 */
function zoomMenu(apply: (action: ZoomAction) => void): Menu {
  const view: MenuItemConstructorOptions[] = [
    { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+Plus", registerAccelerator: false, click: () => apply("in") },
    { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => apply("out") },
    { id: "zoom-actual-size", label: "Actual Size", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => apply("reset") },
  ];
  const template: MenuItemConstructorOptions[] = process.platform === "darwin"
    // macOS dispatches standard editing shortcuts through the application
    // menu. Retain them when installing View so Cmd+C/V and window commands
    // continue working in source/plan fields.
    ? [{ role: "appMenu" }, { role: "editMenu" }, { label: "View", submenu: view }, { role: "windowMenu" }]
    : [{ label: "View", submenu: view }];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(async () => {
  const lifetime = await windowsLifetime;
  const assets = path.join(__dirname, "client");
  const icons = app.isPackaged ? path.join(process.resourcesPath, "icons") : path.resolve(__dirname, "../../../assets/brand/icons");
  // Developer checkouts may use vendored builds; the packaged app looks only at
  // explicit trusted paths and PATH. It never reaches back into the checkout.
  const repositoryRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../..");
  const ffmpegPath = nativeExecutable("CODEC_ABX_FFMPEG") ?? await bundledExecutable("ffmpeg");
  const ffprobePath = nativeExecutable("CODEC_ABX_FFPROBE") ?? await bundledExecutable("ffprobe");
  const ldacHelperPath = nativeExecutable("CODEC_ABX_LDAC_HELPER") ?? await bundledExecutable("ldac_helper");
  const engine = {
    repositoryRoot,
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
    ...(ldacHelperPath === undefined ? {} : { ldacHelperPath }),
    ...(lifetime === null ? {} : { windowsProcessHost: lifetime.hostPath }),
  };
  const isolatedSession = session.fromPartition("codec-abx-desktop");
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const localBlob = /^blob:codec-abx:\/\/app\//.test(details.url);
    callback({ cancel: !allowedResource(details.url) && !localBlob });
  });
  isolatedSession.protocol.handle("codec-abx", async request => {
    try {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const file = await assetPath(assets, request.url);
      return new Response(await fs.readFile(file), { headers: { "Content-Type": mimeTypes[path.extname(file)] ?? "application/octet-stream", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store" } });
    } catch { return new Response(null, { status: 404, headers: { "Content-Security-Policy": CSP } }); }
  });
  window = new BrowserWindow({ width: 1440, height: 1050, show: false, title: "Audivane", icon: path.join(icons, "audivane-512.png"), webPreferences: {
    preload: path.join(__dirname, "preload.cjs"), session: isolatedSession,
    contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false,
  } });
  const contents = window.webContents;
  const zoomStatePath = path.join(app.getPath("userData"), ZOOM_STATE_FILE);
  let zoomFactor = readZoomState(zoomStatePath);
  const applyZoom = (action: ZoomAction): void => {
    if (!window || window.isDestroyed() || contents.isDestroyed()) return;
    const next = zoomFactorForAction(zoomFactor, action);
    if (next === zoomFactor) return;
    zoomFactor = next;
    contents.setZoomFactor(zoomFactor);
    try { writeZoomState(zoomStatePath, zoomFactor); }
    catch { console.error("Desktop zoom preference could not be saved"); }
  };
  Menu.setApplicationMenu(zoomMenu(applyZoom));
  contents.on("before-input-event", (event, input) => {
    const action = zoomActionForKey(input, process.platform);
    if (!action) return;
    event.preventDefault();
    applyZoom(action);
  });
  runtime = new WorkerDesktopRuntime({
    workerPath: path.join(__dirname, "runtime-worker.cjs"),
    engine,
    fatal: failure => { if (!contents.isDestroyed()) contents.send(IPC_PREFIX + "fatal", failure); },
    pickSource: async () => {
      if (!window || window.isDestroyed()) fail("disposed");
      const result = await dialog.showOpenDialog(window, { title: "Select local audio", properties: ["openFile"], filters: [{ name: "Audio", extensions: [...SOURCE_EXTENSIONS] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    progress: (jobId, progress) => { if (!contents.isDestroyed()) contents.send(IPC_PREFIX + "progress", { jobId, progress }); },
  });
  const activeRequests = new Set<string>();
  for (const operation of OPERATIONS) ipcMain.handle(IPC_PREFIX + operation, async (event, ...incoming: unknown[]) => {
    let id = "invalid-request-id";
    try {
      if (incoming.length !== 1) fail();
      id = correlationId(incoming[0]);
      if (event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || !allowedDocument(event.senderFrame.url)) fail("forbidden", "Desktop requests require the bundled main frame");
      const request = validateRequest(operation, incoming[0]); id = request.id;
      if (activeRequests.has(id) || activeRequests.size >= 64) fail("request-conflict", "Duplicate or excessive desktop request");
      if (!runtime) fail("disposed", "Desktop renderer is closed");
      activeRequests.add(id);
      try { const value = await runtime.invoke(operation, request.args); return { version: 1, id, ok: true, value }; }
      finally { activeRequests.delete(id); }
    } catch (error: unknown) { return { version: 1, id, ok: false, error: safeError(error, operation === "answer") }; }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("will-navigate", event => { event.preventDefault(); void clean().catch(() => app.quit()); });
  contents.on("will-frame-navigate", event => event.preventDefault());
  // Any second document load invalidates the lifetime, including a reload.
  let documentLoaded = false;
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace && documentLoaded) void clean().catch(() => app.quit());
  });
  contents.on("did-finish-load", () => { documentLoaded = true; });
  contents.on("render-process-gone", () => { void clean().catch(() => console.error("Desktop resource cleanup failed")).finally(() => app.quit()); });
  contents.on("destroyed", () => { void clean().catch(() => undefined); });
  isolatedSession.on("will-download", (event, item, downloadContents) => {
    if (downloadContents !== contents || !allowedDownload(item.getURL(), item.getMimeType(), item.getURLChain())) { event.preventDefault(); return; }
    // Blob contents originate in this renderer; no remote URL/native read is offered.
    const extension = item.getMimeType().includes("wav") ? ".wav" : item.getMimeType() === "application/json" ? ".json" : ".txt";
    const basename = path.basename(item.getFilename()).replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 100).replace(/\.[^.]*$/, "");
    item.setSaveDialogOptions({ title: "Save local export", defaultPath: `${basename || "codec-abx-export"}${extension}`, filters: [{ name: "Local export", extensions: [extension.slice(1)] }] });
  });
  window.on("close", event => {
    if (quitReady) return;
    event.preventDefault();
    void clean().then(() => { quitReady = true; window?.destroy(); app.quit(); }).catch(() => { dialog.showErrorBox("Cleanup failed", "Native resources could not be fully removed. Close the application and check temporary storage."); quitReady = true; app.quit(); });
  });
  await window.loadURL(APP_URL); contents.setZoomFactor(zoomFactor); window.show();
}).catch(error => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  console.error("Desktop startup failed:", message);
  // Containment is a startup precondition on Windows. Refuse to keep running
  // unconfined rather than silently dropping the Job Object authority.
  if (app.isReady()) dialog.showErrorBox("Audivane could not start", `Audivane did not start a contained desktop process.\n\n${message}`);
  void clean().catch(() => console.error("Desktop resource cleanup failed")).finally(() => { quitReady = true; app.quit(); });
});
app.on("before-quit", event => {
  if (quitReady) return;
  event.preventDefault();
  void clean().catch(() => undefined).finally(() => { quitReady = true; app.quit(); });
});
app.on("window-all-closed", () => app.quit());
