import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePcm16Wav } from "../../../tests/e2e/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const extension = process.platform === "win32" ? ".exe" : "";
const packagedExecutable = process.env.CODEC_ABX_PACKAGED_EXECUTABLE
  ?? (process.platform === "win32"
    ? path.join(root, "dist/desktop/Audivane-win32-x64/Audivane.exe")
    : path.join(root, "dist/desktop/Codec ABX-linux-x64/codec-abx"));
const packagedRoot = path.dirname(packagedExecutable);
const packagedResources = path.join(packagedRoot, "resources");
// An installed package (CODEC_ABX_PACKAGED_EXECUTABLE) or a package carrying
// the explicit native manifest must resolve its tools from its own resources.
const portableBundle = Boolean(process.env.CODEC_ABX_NATIVE_BUNDLE_DIR)
  || Boolean(process.env.CODEC_ABX_PACKAGED_EXECUTABLE)
  || existsSync(path.join(packagedResources, "native-bundle-manifest.json"));
const nativeRoot = portableBundle ? packagedResources : root;
const runtimeFfmpeg = path.join(nativeRoot, `third_party/ffmpeg/bin/ffmpeg${extension}`);
const runtimeFfprobe = path.join(nativeRoot, `third_party/ffmpeg/bin/ffprobe${extension}`);
const runtimeLdacHelper = path.join(nativeRoot, `third_party/ldac/bin/ldac_helper${extension}`);
const fixtureFfmpeg = portableBundle ? runtimeFfmpeg : path.join(root, `third_party/ffmpeg/bin/ffmpeg${extension}`);
const spawnAudit = path.join(root, "apps/desktop/test/spawn-audit.cjs");
const systemTaskkill = process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
  : null;
const processHost = process.platform === "win32"
  ? path.join(packagedResources, "process-host", "audivane-process-host.exe")
  : null;
const allowedNativeTools = [runtimeFfmpeg, runtimeFfprobe, runtimeLdacHelper,
  ...(systemTaskkill ? [systemTaskkill] : []), ...(processHost ? [processHost] : [])];

test("packaged Audivane completes FLAC listening and exports from a foreign CWD/path", async () => {
  test.setTimeout(180_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec abx package test üß "));
  const auditLog = path.join(directory, "spawns.jsonl");
  const unapprovedMarker = path.join(directory, "unapproved-was-spawned");
  let app: ElectronApplication | null = null;
  try {
    const bytes = makePcm16Wav({ sampleRate: 96000, channels: 2, seconds: 0.8 });
    const wavSource = path.join(directory, "package fixture.wav");
    const source = path.join(directory, "package fixture.flac");
    await fs.writeFile(wavSource, bytes);
    // Real native FLAC generation.
    execFileSync(fixtureFfmpeg, ["-y", "-loglevel", "error", "-i", wavSource, "-c:a", "flac", source]);

    // A generic executable outside the explicit native allowlist. The spawn
    // audit must deny it before it can run.
    const unapprovedExecutable = path.join(directory, "unapproved-tool");
    await fs.writeFile(unapprovedExecutable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(unapprovedMarker)}, 'unexpected execution');\n`, { mode: 0o755 });

    const env = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    if (portableBundle) {
      // The package must find its own resources with no developer/PATH tools.
      delete env.CODEC_ABX_FFMPEG;
      delete env.CODEC_ABX_FFPROBE;
      delete env.CODEC_ABX_LDAC_HELPER;
      // Keep only Windows' own system directory so Electron can locate
      // system facilities; no developer/scoop/chocolatey codec can be found
      // through PATH. The spawn allowlist independently proves the exact
      // native tools used.
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
      env.PATH = process.platform === "win32"
        ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
        : "";
    } else {
      env.CODEC_ABX_FFMPEG = runtimeFfmpeg;
      env.CODEC_ABX_FFPROBE = runtimeFfprobe;
      env.CODEC_ABX_LDAC_HELPER = runtimeLdacHelper;
    }
    env.CODEC_ABX_TEST_SPAWN_AUDIT = spawnAudit;
    env.CODEC_ABX_SPAWN_AUDIT_LOG = auditLog;
    env.CODEC_ABX_SPAWN_ALLOWLIST = allowedNativeTools.join(path.delimiter);
    if (processHost) env.CODEC_ABX_TEST_PROCESS_HOST = processHost;

    app = await electron.launch({
      executablePath: packagedExecutable,
      args: [], cwd: directory, env, chromiumSandbox: true,
    });
    const facts = await app.evaluate(({ app: application, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      // Electron exposes getLastWebPreferences at runtime but its bundled .d.ts
      // for this pinned version does not declare it.
      const preferences = (window.webContents as unknown as {
        getLastWebPreferences(): { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean; webSecurity?: boolean };
      }).getLastWebPreferences();
      return {
        packaged: application.isPackaged, cwd: process.cwd(), name: application.getName(),
        resources: process.resourcesPath, applicationPath: application.getAppPath(), version: application.getVersion(),
        sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration, webSecurity: preferences.webSecurity,
      };
    });
    expect(facts.packaged).toBe(true);
    expect(facts.cwd).toBe(directory);
    expect(facts.name).toBe("Audivane");
    // Launching with chromiumSandbox:true is only a request; assert the
    // effective packaged WebContents policy as well.
    expect(facts.sandbox).toBe(true);
    expect(facts.contextIsolation).toBe(true);
    expect(facts.nodeIntegration).toBe(false);
    expect(facts.webSecurity).toBe(true);
    const expectedPlatform = process.platform === "win32" ? "win32" : "linux";
    const distribution = JSON.parse(await fs.readFile(path.join(facts.resources, "distribution.json"), "utf8"));
    expect(distribution).toMatchObject({
      product: "Audivane", subtitle: "Blind audio comparisons.", platform: expectedPlatform,
      arch: "x64", browserCodecAssets: "excluded-native-only",
      executable: path.basename(packagedExecutable),
    });
    if (portableBundle) {
      const bundleManifest = JSON.parse(await fs.readFile(path.join(facts.resources, "native-bundle-manifest.json"), "utf8"));
      expect(bundleManifest.mode).toBe("portable-native-bundle-v1");
      expect(bundleManifest.platform).toBe(expectedPlatform);
      expect(bundleManifest.ldacHelperIncluded).toBe(true);
      for (const relative of [`third_party/ffmpeg/bin/ffmpeg${extension}`, `third_party/ffmpeg/bin/ffprobe${extension}`,
        `third_party/ldac/bin/ldac_helper${extension}`]) {
        expect(bundleManifest.files.find((file: { path: string }) => file.path === relative).sha256)
          .toBe(createHash("sha256").update(await fs.readFile(path.join(facts.resources, relative))).digest("hex"));
      }
      expect(distribution.nativeBundle.ldacHelperIncluded).toBe(true);
    }
    expect(path.basename(facts.applicationPath)).toBe("app");
    expect(path.basename(path.dirname(facts.applicationPath))).toBe("resources");
    // Negative controls establish that the audit is active before trusting a
    // log containing only native tools. Denied attempts are labelled separately.
    const controls = await app.evaluate((_electron, unapproved) => {
      const child = process.getBuiltinModule("child_process");
      const denied = (operation: () => unknown) => {
        try { operation(); return false; }
        catch (error) { return /spawn denied by test audit/.test(String(error)); }
      };
      return [denied(() => child.spawnSync(unapproved, [])),
        denied(() => child.fork("nonexistent-test-fixture.cjs"))];
    }, unapprovedExecutable);
    expect(controls).toEqual([true, true]);

    const resourceEntries = (await fs.readdir(facts.resources, { recursive: true }) as string[])
      .map(name => name.split(path.sep).join("/"));
    // Desktop execution is native: browser codec WASM/glue is deliberately
    // absent, while the packaged materials and self-hosted fonts remain.
    expect(resourceEntries.filter((name) => /(^|[\\/])(codec-assets\/|ffmpeg-core\.(js|wasm)$|lc3_codec\.(js|wasm)$|ldac_codec\.(js|wasm)$)|\.wasm$/i.test(name))).toEqual([]);
    expect(resourceEntries.some((name) => /\.woff2$/i.test(name))).toBe(true);
    expect(resourceEntries).toContain("icons/audivane-512.png");
    expect(resourceEntries).toContain(process.platform === "win32" ? "icons/audivane.ico" : "icons/audivane-256.png");
    if (process.platform === "win32") {
      expect(resourceEntries).toContain("process-host/audivane-process-host.exe");
      expect(distribution.processHost).toMatchObject({ path: "process-host/audivane-process-host.exe" });
      expect(distribution.processHost.sha256).toBe(createHash("sha256")
        .update(await fs.readFile(path.join(facts.resources, "process-host/audivane-process-host.exe"))).digest("hex"));
    }
    const manifest = JSON.parse(await fs.readFile(path.join(facts.applicationPath, "package.json"), "utf8")) as { dependencies?: Record<string, string>; productName?: string };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
    const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ version: workspace.version, license: "MIT", productName: "Audivane" });
    expect(facts.version).toBe(workspace.version);
    for (const [source, packaged] of [["LICENSE", "LICENSE"],
      ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["packages/measurements/NOTICE.md", "measurements-NOTICE.md"]] as const) {
      expect(await fs.readFile(path.join(facts.applicationPath, packaged), "utf8"))
        .toBe(await fs.readFile(path.join(root, source), "utf8"));
    }
    await fs.access(path.join(facts.applicationPath, "dist/runtime-worker.cjs"));

    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, source);
    const page = await app.firstWindow();
    const downloads = path.join(directory, "downloads");
    await fs.mkdir(downloads);
    await app.evaluate(({ BrowserWindow }, target) => {
      let sequence = 0;
      BrowserWindow.getAllWindows()[0]!.webContents.session.on("will-download", (_event, item) => {
        const name = item.getFilename().replace(/[^a-zA-Z0-9_. -]/g, "_");
        item.setSavePath(`${target}/${++sequence}-${name}`);
      });
    }, downloads);
    await expect(page.locator("main.app")).toHaveAttribute("data-runtime", "desktop");
    await expect(page.getByRole("heading", { name: "Audivane", exact: true })).toBeVisible();
    expect(await page.title()).toContain("Audivane");
    await expect(page.locator('section[aria-labelledby="capabilities-heading"]')).toContainText("available");
    await expect(page.locator('section[aria-labelledby="capabilities-heading"]')).toContainText("engine-native-typescript");
    await page.getByRole("button", { name: "Choose local audio…" }).click();
    await expect(page.locator(".file-summary")).toContainText("package fixture.flac");
    await page.locator(".advanced-preparation").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByLabel("Sample-rate policy").selectOption("force_48k");
    await page.locator("#canary-enabled").check();
    await page.getByRole("button", { name: "Prepare native artifacts" }).click();
    await expect(page.getByText("Native artifacts ready.")).toBeVisible({ timeout: 120_000 });
    const artifact = JSON.parse(await page.locator("details", { hasText: "Raw diagnostic artifact JSON" })
      .locator("pre").textContent() ?? "{}");
    expect(artifact.engine.engineId).toBe("engine-native-typescript");
    expect(artifact.engine.location).toBe("desktop-native");
    expect(artifact.engine.preparationPolicy).toBe("aligned-gain-matched-v1");
    expect(artifact.measurements.policy).toBe("aligned-gain-matched-v1");
    expect(artifact.preparation.policy).toBe("aligned-gain-matched-v1");
    expect(artifact.sourceSha256).toBe(createHash("sha256").update(await fs.readFile(source)).digest("hex"));
    expect(artifact.a.delivered).toMatchObject({ sampleRate: 48000, channels: 2 });
    expect(artifact.b.encodedSampleRate).toBe(48000);
    const originalSource = "Original source: FLAC, 96000 Hz, 2 channels. Session: 48000 Hz, 2 channels (force_48k).";
    expect(artifact.disclosures).toContain(originalSource);
    await page.locator("summary").filter({ hasText: /^Disclosures$/ }).click();
    await expect(page.getByText(originalSource, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Source", exact: true })).toBeVisible();
    expect(artifact.canary.audio).not.toBeNull();
    await page.getByRole("button", { name: "Download JSON diagnostics" }).click();
    const diagnosticFiles = async () => (await fs.readdir(downloads)).filter(name => name.includes("codec-abx-diagnostic"));
    await expect.poll(async () => (await diagnosticFiles()).length).toBe(1);
    const diagnostic = JSON.parse(await fs.readFile(path.join(downloads, (await diagnosticFiles())[0]!), "utf8"));
    expect(diagnostic.artifact.disclosures).toContain(originalSource);

    // The installed application, under the same spawn-denial audit, must run
    // calibration and scored trials rather than stop at successful preparation.
    await page.locator(".listening-test-plan").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByLabel("Planned scored trials N (1–1000)").fill("2");
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    await expect(page.locator("#listen-view")).toBeVisible();
    const trial = page.locator("article.listening-trial");
    await expect(trial).toBeVisible({ timeout: 180_000 });
    await expect(trial).toHaveAttribute("data-kind", "calibration");
    await expect(trial).toContainText("Calibration");
    // One Play/Pause toggle; the first trial starts paused.
    const play = page.getByRole("button", { name: "Play", exact: true });
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(play).toBeEnabled();
    await expect(pause).toHaveCount(0);
    await page.getByRole("button", { name: "Monitor playback label A" }).click();
    // Loop the short fixture so a playing trial cannot end while the exact
    // served bytes are compared and the receipt auto-advances.
    await page.getByRole("button", { name: "Enable loop" }).click();
    await page.getByLabel("Loop start (s)").fill("0.05");
    await page.getByLabel("Loop end (s)").fill("0.4");
    await page.getByRole("button", { name: "Apply loop range" }).click();
    await play.click();
    await expect(pause).toBeEnabled();
    await pause.click();
    await expect(play).toBeEnabled();

    const answerFor = async (token: string): Promise<"A" | "B"> =>
      page.evaluate(async current => {
        const bridge = window.codecAbxDesktop!;
        const [a, b, x] = await Promise.all(["A", "B", "X"].map(label =>
          bridge.experiment.readAudio(current, label as "A" | "B" | "X")));
        const same = (left: ArrayBuffer, right: ArrayBuffer) => {
          const l = new Uint8Array(left), r = new Uint8Array(right);
          return l.length === r.length && l.every((value, index) => value === r[index]);
        };
        if (same(x!, a!)) return "A";
        if (same(x!, b!)) return "B";
        throw new Error("Served X matches neither A nor B");
      }, token);
    const answerCurrent = async (): Promise<void> => {
      const token = await trial.getAttribute("data-token");
      if (!token) throw new Error("No loaded trial token");
      const answer = await answerFor(token);
      const button = page.getByRole("button", { name: `Answer ${answer}`, exact: true });
      await expect(button).toBeEnabled();
      await button.click();
    };
    const tokenAfter = async (previous: string): Promise<string> => {
      await expect.poll(async () => {
        const value = await trial.getAttribute("data-token");
        return value !== null && value !== previous ? value : null;
      }, { timeout: 180_000 }).not.toBeNull();
      const value = await trial.getAttribute("data-token");
      if (!value) throw new Error("A trial token disappeared before the next trial was staged");
      return value;
    };
    const expectNoLabelSelected = async (): Promise<void> => {
      for (const label of ["A", "B", "X"] as const) {
        await expect(page.getByRole("button", { name: `Monitor playback label ${label}` }))
          .toHaveAttribute("aria-pressed", "false");
      }
    };
    const selectAndPlay = async (label: "A" | "B" | "X"): Promise<void> => {
      const button = page.getByRole("button", { name: `Monitor playback label ${label}` });
      await expect(button).toBeEnabled();
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      if (await pause.count() === 0) {
        await expect(play).toBeEnabled();
        await play.click();
        await expect(pause).toBeEnabled();
      }
    };
    const savedExport = async (number: number) => {
      await page.getByRole("button", { name: "Download listening export" }).click();
      await expect.poll(async () => (await fs.readdir(downloads)).filter(name => name.includes("codec-abx-listening")).length)
        .toBe(number);
      const files = (await fs.readdir(downloads)).filter(name => name.includes("codec-abx-listening")).sort();
      return JSON.parse(await fs.readFile(path.join(downloads, files[number - 1]!), "utf8"));
    };

    const calibrationToken = await trial.getAttribute("data-token");
    if (!calibrationToken) throw new Error("No calibration token was staged");
    await answerCurrent();
    const firstScored = await tokenAfter(calibrationToken);
    await expect(trial).toHaveAttribute("data-kind", "scored");
    await expect(page.getByText("Choose A, B or X", { exact: true })).toBeVisible();
    await expectNoLabelSelected();
    await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeDisabled();
    await selectAndPlay("A");
    await answerCurrent();
    const secondScored = await tokenAfter(firstScored);
    await expect(trial).toHaveAttribute("data-kind", "scored");
    await expect(page.getByText("Previous trial audio", { exact: true })).toBeVisible();
    await expectNoLabelSelected();
    await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeDisabled();
    const active = await savedExport(1);
    expect(active.experiment.reveal.redacted).toBe(true);
    expect(active.experiment.reveal.secretHex).toBeNull();
    expect(active.experiment.trials).toHaveLength(2);
    expect(active.experiment.trials.every((row: { correct: boolean }) => row.correct)).toBe(true);
    expect(active.prepared.engine.engineId).toBe("engine-native-typescript");
    expect(active.prepared.preparation.policy).toBe("aligned-gain-matched-v1");
    expect(active.prepared.disclosures).toContain(originalSource);
    await selectAndPlay("A");
    await answerCurrent();
    await expect(page.getByText("Terminal lifecycle: completed")).toBeVisible();
    const terminal = await savedExport(2);
    expect(terminal.experiment.reveal.redacted).toBe(false);
    expect(terminal.experiment.reveal.secretHex).toMatch(/^[a-f0-9]{64}$/);
    expect(terminal.experiment.snapshot.statistics.scoredTrials).toBe(2);
    expect(terminal.experiment.trials).toHaveLength(3);
    expect(terminal.experiment.trials.every((row: { correct: boolean }) => row.correct)).toBe(true);
    await page.getByRole("button", { name: "Close listening run" }).click();
    await page.getByRole("button", { name: "Evidence", exact: true }).click();
    await page.getByRole("button", { name: "Release artifacts and reset" }).click();
    await expect(page.locator(".file-summary")).toContainText("No file selected");

    // Audit every Node-visible child spawn: only the explicitly allowed native
    // executables may appear.
    const audit = (await fs.readFile(auditLog, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; command: string; args: string[]; denied: boolean });
    expect(audit.length).toBeGreaterThan(0);
    const denied = audit.filter(entry => entry.denied);
    expect(denied).toHaveLength(2);
    expect(denied.map(entry => entry.kind).sort()).toEqual(["fork", "spawnSync"]);
    expect(denied.find(entry => entry.kind === "spawnSync")?.command).toBe(unapprovedExecutable);
    const spawned = audit.filter(entry => !entry.denied);
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned.every((entry) => allowedNativeTools.includes(path.resolve(entry.command)))).toBe(true);
    if (systemTaskkill) {
      const cleanups = spawned.filter((entry) => path.resolve(entry.command) === systemTaskkill);
      // Windows cleanup runs taskkill even when the process leader exits on its
      // own; the audit accepts only the exact bounded /pid ... /T [/F] form.
      expect(cleanups.length).toBeGreaterThan(0);
      expect(cleanups.every((entry) => entry.kind === "spawn" && entry.args.length >= 3 && entry.args.length <= 4 &&
        entry.args[0]?.toLowerCase() === "/pid" && /^[0-9]+$/.test(entry.args[1] ?? "") &&
        entry.args[2]?.toLowerCase() === "/t" && (entry.args.length === 3 || entry.args[3]?.toLowerCase() === "/f"))).toBe(true);
      const hosts = spawned.filter((entry) => path.resolve(entry.command) === processHost);
      expect(hosts.length).toBeGreaterThan(0);
      expect(hosts.every((entry) => entry.kind === "spawn" &&
        ((entry.args[0] === "--guard" && /^[0-9]+$/.test(entry.args[1] ?? "")) ||
          (entry.args[0] === "--run" && allowedNativeTools.includes(path.resolve(entry.args[1] ?? "")))))).toBe(true);
    } else {
      expect(spawned.some((entry) => /taskkill/i.test(path.basename(entry.command)))).toBe(false);
    }
    await expect(fs.access(unapprovedMarker)).rejects.toThrow();
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
