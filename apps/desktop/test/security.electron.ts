import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
test("real Electron isolates the narrow preload and refuses forged handles, senders and remote networking", async () => {
  const app = await electron.launch({ args: [path.join(root, "apps/desktop")], cwd: root, env, chromiumSandbox: true });
  try {
    const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toBe("codec-abx://app/index.html");
    const boundary = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      return { node: typeof w.require, process: typeof w.process, ipc: typeof w.ipcRenderer, version: w.codecAbxDesktop.version, keys: Object.keys(w.codecAbxDesktop).sort(), preparation: Object.keys(w.codecAbxDesktop.preparation).sort(), experiment: Object.keys(w.codecAbxDesktop.experiment).sort() };
    });
    expect(boundary).toEqual({ node: "undefined", process: "undefined", ipc: "undefined", version: 1, keys: ["experiment", "preparation", "version"], preparation: ["cancel", "capabilities", "onProgress", "pickSource", "prepare", "readAudio", "readCanaryAudio", "release"], experiment: ["answer", "bindPrepared", "configure", "dispose", "export", "nextTrial", "onFatal", "readAudio", "reset", "seal", "snapshot"] });
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = (BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webviewTag: p.webviewTag, nodeIntegrationInWorker: p.nodeIntegrationInWorker };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, nodeIntegrationInWorker: false });
    const refused = await page.evaluate(async () => {
      try { await (window as any).codecAbxDesktop.preparation.prepare("/etc/passwd", {}, "0123456789abcdef"); return null; }
      catch (error) { return error; }
    });
    expect(refused).toMatchObject({ code: "invalid-request", reasons: [], uncertain: false });
    expect(JSON.stringify(refused)).not.toContain("/etc/passwd");
    const blocked = await page.evaluate(async () => {
      try { await fetch("https://example.com/"); return false; } catch { return true; }
    }); expect(blocked).toBe(true);
    await page.evaluate(() => window.open("https://example.com/")); expect(app.windows()).toHaveLength(1);
    // A second renderer loading the same trusted asset still has no IPC authority.
    await app.evaluate(async ({ BrowserWindow }, preload) => {
      const primary = BrowserWindow.getAllWindows()[0]!;
      const secondary = new BrowserWindow({ show: false, webPreferences: { preload, session: primary.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await secondary.loadURL("codec-abx://app/index.html");
    }, path.join(root, "apps/desktop/dist/preload.cjs"));
    await expect.poll(() => app.windows().length).toBe(2);
    const secondary = app.windows()[1]!;
    const sender = await secondary.evaluate(async () => { try { await (window as any).codecAbxDesktop.preparation.pickSource(); return null; } catch (error) { return error; } });
    expect(sender).toMatchObject({ code: "forbidden", uncertain: false });
    await secondary.close();
  } finally { await app.close(); }
});

test("desktop zoom is real native window zoom, exposed only through the View menu, shortcuts and bounded local persistence", async () => {
  test.setTimeout(180_000);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-desktop-zoom-"));
  const launch = async () => {
    const launchEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    const instance = await electron.launch({ args: [path.join(root, "apps/desktop"), `--user-data-dir=${userData}`], cwd: root, env: launchEnv, chromiumSandbox: true });
    const page = await instance.firstWindow();
    await page.waitForLoadState("load");
    return { instance, page };
  };
  let app: ElectronApplication | null = null;
  try {
    let launched = await launch();
    app = launched.instance;
    let page = launched.page;
    const zoomFactor = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());
    type Modifier = "shift" | "control" | "meta" | "alt";
    const primaryModifiers: Modifier[] = process.platform === "darwin" ? ["meta"] : ["control"];
    // Playwright's CDP keyboard injection bypasses Electron's native
    // before-input-event; sendInputEvent exercises the same main-process path
    // as a physical shortcut without granting the renderer any authority.
    const pressZoom = (keyCode: string, modifiers: Modifier[]) => app!.evaluate(({ BrowserWindow }, event) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: event.keyCode, modifiers: event.modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: event.keyCode, modifiers: event.modifiers });
    }, { keyCode, modifiers });
    await expect.poll(zoomFactor).toBe(1);
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
    const initialWidth = await page.evaluate(() => window.innerWidth);
    await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.some(item => item.label === "View") ?? false)).toBe(true);

    const menu = await app.evaluate(({ Menu }) => {
      const read = (items: readonly any[]): any[] => items.map(item => ({
        id: item.id, label: item.label, role: item.role, accelerator: item.accelerator,
        submenu: item.submenu ? read(item.submenu.items) : [],
      }));
      return read(Menu.getApplicationMenu()?.items ?? []);
    });
    const view = menu.find((item: any) => item.label === "View");
    expect(view).toBeTruthy();
    expect(view.submenu.map((item: any) => item.label)).toEqual(["Zoom In", "Zoom Out", "Actual Size"]);
    for (const item of view.submenu) expect(item.accelerator).toBeTruthy();
    const flattened = (items: readonly any[]): any[] => items.flatMap(item => [item, ...flattened(item.submenu)]);
    expect(flattened(menu).filter((item: any) => /reload|devtools/i.test(`${item.label ?? ""} ${item.role ?? ""}`))).toEqual([]);
    if (process.platform !== "darwin") {
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMenuBarVisible())).toBe(true);
    }

    await pressZoom("=", primaryModifiers);
    await expect.poll(zoomFactor).toBeCloseTo(1.1, 5);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(initialWidth);
    await pressZoom("+", [...primaryModifiers, "shift"]);
    await expect.poll(zoomFactor).toBeCloseTo(1.25, 5);
    await pressZoom("numadd", primaryModifiers);
    await expect.poll(zoomFactor).toBeCloseTo(1.5, 5);
    await pressZoom("-", primaryModifiers);
    await expect.poll(zoomFactor).toBeCloseTo(1.25, 5);
    await pressZoom("numsub", primaryModifiers);
    await expect.poll(zoomFactor).toBeCloseTo(1.1, 5);
    await pressZoom("0", primaryModifiers);
    await expect.poll(zoomFactor).toBe(1);
    await pressZoom("=", primaryModifiers);
    await expect.poll(zoomFactor).toBeCloseTo(1.1, 5);
    await pressZoom("num0", primaryModifiers);
    await expect.poll(zoomFactor).toBe(1);

    const clickMenuItem = (id: string) => app!.evaluate(({ Menu, BrowserWindow }, itemId) => {
      const find = (items: readonly any[]): any => {
        for (const item of items) {
          if (item.id === itemId) return item;
          const nested = item.submenu ? find(item.submenu.items) : null;
          if (nested) return nested;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      item?.click?.(item, BrowserWindow.getAllWindows()[0], {});
    }, id);
    await clickMenuItem("zoom-in");
    await expect.poll(zoomFactor).toBeCloseTo(1.1, 5);
    await clickMenuItem("zoom-actual-size");
    await expect.poll(zoomFactor).toBe(1);
    await clickMenuItem("zoom-in");
    await expect.poll(zoomFactor).toBeCloseTo(1.1, 5);
    expect(page.url()).toBe("codec-abx://app/index.html");
    expect(app.windows()).toHaveLength(1);

    await app.close();
    app = null;
    expect(JSON.parse(await fs.readFile(path.join(userData, "zoom.json"), "utf8"))).toEqual({ version: 1, zoomFactor: 1.1 });

    launched = await launch();
    app = launched.instance;
    page = launched.page;
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBeCloseTo(1.1, 5);
    await pressZoom("0", primaryModifiers);
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1);
  } finally {
    if (app) await app.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});
