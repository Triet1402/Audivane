import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function wav(rate = 48_000, channels: 1 | 2 = 1, seconds = 0.8): Buffer {
  const frames = Math.round(rate * seconds);
  const size = frames * channels * 2;
  const bytes = Buffer.alloc(size + 44);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(size + 36, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(size, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.round(
        6500 * Math.sin((2 * Math.PI * (channel === 0 ? 440 : 660) * frame) / rate),
      );
      bytes.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
    }
  }
  return bytes;
}

async function recentExport(directory: string, marker: string): Promise<string | null> {
  const entries = await fs.readdir(directory);
  const matches = entries
    .filter((name) => name.includes(marker) && name.endsWith(".json"))
    .sort();
  return matches.length === 0 ? null : path.join(directory, matches[matches.length - 1]!);
}

test("built Electron app performs native preparation, exact-N listening, export and cleanup", async () => {
  test.setTimeout(300_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-desktop-ui-"));
  const sourcePath = path.join(directory, "listening-fixture.wav");
  await fs.writeFile(sourcePath, wav());
  const downloads = path.join(directory, "downloads");
  await fs.mkdir(downloads);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.ELECTRON_RUN_AS_NODE;

  let app: ElectronApplication | null = null;
  try {
  app = await electron.launch({
    args: [path.join(root, "apps/desktop")],
    cwd: root,
    env: environment,
    chromiumSandbox: true,
  });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toBe("codec-abx://app/index.html");

    // Capture the existing runtime worker only through a test-injected Node
    // prototype wrapper. No production globals, IPC channels or flags are added.
    await app.evaluate(() => {
      const { Worker } = process.getBuiltinModule("worker_threads");
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args: Parameters<typeof post>) {
        (globalThis as unknown as { __runtimeWorker: import("node:worker_threads").Worker }).__runtimeWorker = this;
        return post.apply(this, args);
      };
    });

    // Test-only OS-dialog seam in the Electron main process. No production
    // test endpoint or global is added.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, sourcePath);
    // Test-only save-path seam: the production will-download handler keeps its
    // origin/mime validation and receives a deterministic local path here.
    await app.evaluate(({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      let sequence = 0;
      contents.session.on("will-download", (_event, item) => {
        const safe = item.getFilename().replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 120);
        item.setSavePath(`${target}/${String(++sequence).padStart(3, "0")}-${safe}`);
      });
    }, downloads);

    await expect(page.locator("main.app")).toHaveAttribute("data-runtime", "desktop");
    const capabilityPanel = page.locator('section[aria-labelledby="capabilities-heading"]');
    await expect(capabilityPanel).toContainText("desktop-native", { timeout: 120_000 });
    await expect(capabilityPanel).toContainText("engine-native-typescript");
    await expect(capabilityPanel).toContainText("aligned-gain-matched-v1");
    await expect(capabilityPanel).toContainText("available");

    // Count any Worker construction and local ffmpeg asset requests. Desktop
    // native preparation and listening must not instantiate either.
    await page.evaluate(() => {
      const scope = window as unknown as {
        __codecAbxTestWorkers: string[];
        Worker: typeof Worker;
      };
      scope.__codecAbxTestWorkers = [];
      const RealWorker = scope.Worker;
      if (typeof RealWorker === "function") {
        scope.Worker = class extends RealWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            scope.__codecAbxTestWorkers.push(String(url));
            super(url, options);
          }
        } as typeof Worker;
      }
    });

    await page.getByRole("button", { name: "Choose local audio…" }).click();
    await expect(page.locator(".file-summary")).toContainText("listening-fixture.wav");
    await expect(page.locator(".file-summary")).toContainText("MiB");
    // Manual diagnostic preparation lives behind the advanced disclosure.
    await page.locator(".advanced-preparation").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.locator("#canary-enabled").check();
    await page.getByRole("button", { name: "Prepare native artifacts" }).click();
    await expect(page.getByText("Native artifacts ready.")).toBeVisible({ timeout: 120_000 });

    const artifactText = await page
      .locator("details", { hasText: "Raw diagnostic artifact JSON" })
      .locator("pre")
      .textContent();
    const artifact = JSON.parse(artifactText ?? "{}") as {
      engine: { engineId: string; location: string; build: string; preparationPolicy: string };
      measurements: { policy: string };
      preparation?: { policy: string };
      a: { actualBitrateKbps: number | null; encodedSampleRate: number | null };
      b: { actualBitrateKbps: number | null; encodedSampleRate: number | null };
      canary?: { audio: unknown };
    };
    expect(artifact.engine.engineId).toBe("engine-native-typescript");
    expect(artifact.engine.location).toBe("desktop-native");
    expect(artifact.engine.preparationPolicy).toBe("aligned-gain-matched-v1");
    expect(artifact.engine.build).toMatch(/TypeScript native|ffmpeg/i);
    expect(artifact.measurements.policy).toBe("aligned-gain-matched-v1");
    expect(artifact.preparation?.policy).toBe("aligned-gain-matched-v1");
    expect(artifact.a.actualBitrateKbps).toBeNull();
    expect(artifact.b.actualBitrateKbps).toBeGreaterThan(0);
    expect(artifact.b.encodedSampleRate).toBe(48_000);
    expect(artifact.canary?.audio).not.toBeNull();
    await expect(page.getByText("Applied preparation", { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() =>
      (window as unknown as { __codecAbxTestWorkers: string[] }).__codecAbxTestWorkers,
    )).toEqual([]);
    expect(await page.evaluate(() =>
      performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes("ffmpeg-core")),
    )).toEqual([]);

    // Diagnostic JSON is a real renderer download through the main save path.
    await page.getByRole("button", { name: "Download JSON diagnostics" }).click();
    await expect.poll(() => recentExport(downloads, "codec-abx-diagnostic")).not.toBeNull();
    const diagnosticFile = await recentExport(downloads, "codec-abx-diagnostic");
    const diagnostic = JSON.parse(await fs.readFile(diagnosticFile!, "utf8")) as {
      engineLocation: string;
      preparationPolicy: string;
      measurementPolicy: string;
      scientificStatus: { preparationPolicyExecuted: boolean };
      runtimeCustody: { experimentRuntime: string; playbackOutputChannels: string };
      deliveredMeasurements: { policy: string } | null;
      appliedOperations: { policy: string } | null;
    };
    expect(diagnostic.engineLocation).toBe("desktop-native");
    expect(diagnostic.preparationPolicy).toBe("aligned-gain-matched-v1");
    expect(diagnostic.measurementPolicy).toBe("aligned-gain-matched-v1");
    expect(diagnostic.scientificStatus.preparationPolicyExecuted).toBe(true);
    expect(diagnostic.appliedOperations?.policy).toBe("aligned-gain-matched-v1");
    expect(diagnostic.deliveredMeasurements?.policy).toBe("delivered-pcm-measurements-v1");
    expect(diagnostic.runtimeCustody.playbackOutputChannels).toMatch(/unknown/);

    await page.locator(".listening-test-plan").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByLabel("Planned scored trials N (1–1000)").fill("2");
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    // Prepare test moves directly to the Listen view while the pair is
    // prepared and trial 1 is staged paused.
    await expect(page.locator("#listen-view")).toBeVisible();
    const trial = page.locator("article.listening-trial");
    await expect(trial).toBeVisible({ timeout: 120_000 });
    // Source and preparation stay frozen while the listening session exists.
    await expect(page.getByRole("button", { name: "Choose local audio…" })).toBeDisabled();
    await page.getByRole("button", { name: "Setup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Prepare native artifacts" })).toBeDisabled();
    await page.getByRole("button", { name: "Listen", exact: true }).click();

    await expect(trial).toHaveAttribute("data-kind", "calibration");
    await expect(trial).toContainText("Calibration");
    const calibrationToken = await trial.getAttribute("data-token");
    expect(calibrationToken).toBeTruthy();
    // First trial is paused and the transport is one Play/Pause toggle.
    const play = page.getByRole("button", { name: "Play", exact: true });
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(play).toBeEnabled();
    await expect(pause).toHaveCount(0);

    // Selection, seek and loop are the shared player controls.
    const labelA = page.getByRole("button", { name: "Monitor playback label A" });
    await labelA.click();
    await expect(labelA).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Shared timeline position").evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "0.1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // The compact loop control opens its editor only while the loop is on.
    await page.getByRole("button", { name: "Enable loop" }).click();
    await expect(page.getByLabel("Loop start (s)")).toBeVisible();
    await page.getByLabel("Loop start (s)").fill("0.05");
    await page.getByLabel("Loop end (s)").fill("0.4");
    await page.getByRole("button", { name: "Apply loop range" }).click();
    await expect(page.getByRole("button", { name: "Disable loop" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Loop start (s)")).toHaveValue("0.05");
    await expect(page.getByLabel("Loop end (s)")).toHaveValue("0.4");

    await play.click();
    await expect(pause).toBeEnabled();
    await pause.click();
    await expect(play).toBeEnabled();

    // Byte-consistent listener simulation: compare the runtime-served A/B/X
    // bytes for the current public token and answer the matching display label.
    const answerFor = async (token: string): Promise<"A" | "B"> =>
      page.evaluate(async (current) => {
        const bridge = (window as unknown as {
          codecAbxDesktop: {
            experiment: { readAudio(token: string, label: "A" | "B" | "X"): Promise<ArrayBuffer> };
          };
        }).codecAbxDesktop;
        const read = async (label: "A" | "B" | "X"): Promise<Uint8Array> =>
          new Uint8Array(await bridge.experiment.readAudio(current, label));
        const [a, b, x] = await Promise.all([read("A"), read("B"), read("X")]);
        const equal = (left: Uint8Array, right: Uint8Array): boolean =>
          left.length === right.length && left.every((value, index) => value === right[index]);
        if (equal(x, a)) return "A";
        if (equal(x, b)) return "B";
        throw new Error("X bytes match neither display A nor B");
      }, token);
    const answer = async (token: string): Promise<void> => {
      const label = await answerFor(token);
      const button = page.getByRole("button", { name: `Answer ${label}`, exact: true });
      await expect(button).toBeEnabled();
      await button.click();
    };
    const tokenAfter = async (previous: string): Promise<string> => {
      await expect.poll(async () => {
        const value = await trial.getAttribute("data-token");
        return value !== null && value !== previous ? value : null;
      }, { timeout: 120_000 }).not.toBeNull();
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

    // The accepted calibration receipt auto-advances. A paused trial stays
    // paused and the new token has no current A/B/X mapping until a repick.
    await answer(calibrationToken!);
    const firstScored = await tokenAfter(calibrationToken!);
    await expect(trial).toHaveAttribute("data-kind", "scored");
    await expect(page.getByText("Choose A, B or X", { exact: true })).toBeVisible();
    await expectNoLabelSelected();
    await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Answer B", exact: true })).toBeDisabled();
    await selectAndPlay("A");

    // Answering while the loop keeps the graph alive auto-advances and carries
    // the previous trial until the new label is explicitly selected.
    await answer(firstScored);
    const secondScored = await tokenAfter(firstScored);
    await expect(trial).toHaveAttribute("data-kind", "scored");
    await expect(page.getByText("Previous trial audio", { exact: true })).toBeVisible();
    await expectNoLabelSelected();
    await expect(page.getByRole("button", { name: "Answer A", exact: true })).toBeDisabled();

    // Active export stays redacted; it never reveals pending/future mappings.
    await page.getByRole("button", { name: "Download listening export" }).click();
    await expect.poll(() => recentExport(downloads, "codec-abx-listening")).not.toBeNull();
    const activeFile = await recentExport(downloads, "codec-abx-listening");
    const active = JSON.parse(await fs.readFile(activeFile!, "utf8")) as {
      schema: string;
      experiment: {
        reveal: { redacted: boolean; xSequence: string[] };
        trials: { kind: string; correct: boolean }[];
      };
      listening: { runtime: { preparation: string; experiment: string; outputChannels: string }; localCustody: string };
      prepared: { measurementPolicy: string; preparation: { policy: string } | null };
      playback: { actualOutputSampleRate: number | null; outputChannels: null };
    };
    expect(active.schema).toBe("codec-abx-browser-listening-v1");
    expect(active.experiment.reveal.redacted).toBe(true);
    // Both answered rows were derived from the exact served A/B/X bytes.
    expect(active.experiment.trials).toHaveLength(2);
    expect(active.experiment.trials.every((row) => row.correct)).toBe(true);
    expect(active.listening.runtime).toMatchObject({
      preparation: "desktop-native",
      experiment: "electron-main",
      outputChannels: "unknown",
    });
    expect(active.listening.localCustody).toContain("not tamper-proof");
    expect(active.prepared.preparation?.policy).toBe("aligned-gain-matched-v1");
    expect(active.prepared.measurementPolicy).toBe("aligned-gain-matched-v1");
    expect(active.playback.actualOutputSampleRate).toBeGreaterThan(0);
    expect(active.playback.outputChannels).toBeNull();

    // The carried previous trial is still sounding; an explicit label repick
    // activates the next token, and the final accepted answer stops playback.
    await selectAndPlay("A");
    await answer(secondScored);
    await expect(page.getByText("Terminal lifecycle: completed")).toBeVisible();
    await expect(page.getByText(/Reached the pre-registered N/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Download listening export" }).click();
    await expect.poll(async () => {
      const files = (await fs.readdir(downloads))
        .filter((name) => name.includes("codec-abx-listening"))
        .sort();
      return files.length >= 2;
    }).toBe(true);
    const listeningFiles = (await fs.readdir(downloads))
      .filter((name) => name.includes("codec-abx-listening"))
      .sort();
    const terminal = JSON.parse(
      await fs.readFile(path.join(downloads, listeningFiles[listeningFiles.length - 1]!), "utf8"),
    ) as {
      experiment: {
        reveal: { redacted: boolean; secretHex: string | null; xSequence: string[] };
        trials: { kind: string; correct: boolean }[];
        snapshot: { statistics: { scoredTrials: number } };
      };
    };
    expect(terminal.experiment.reveal.redacted).toBe(false);
    expect(terminal.experiment.reveal.secretHex).toMatch(/^[a-f0-9]{64}$/);
    expect(terminal.experiment.reveal.xSequence.length).toBeGreaterThanOrEqual(2);
    expect(terminal.experiment.trials).toHaveLength(3);
    expect(terminal.experiment.trials.every((row) => row.correct)).toBe(true);
    expect(terminal.experiment.snapshot.statistics.scoredTrials).toBe(2);

    // Reset retains the pair and unlocks the plan; explicit Seal remains
    // terminal but is not a final result.
    await page.getByRole("button", { name: "Reset listening run" }).click();
    await expect(page.getByRole("button", { name: "Seal run (not a final result)" })).toBeVisible();
    await page.getByRole("button", { name: "Seal run (not a final result)" }).click();
    await expect(page.getByText("Terminal lifecycle: sealed")).toBeVisible();

    await page.getByRole("button", { name: "Close listening run" }).click();
    await expect(page.getByRole("button", { name: "Choose local audio…" })).toBeEnabled();

    await page.getByRole("button", { name: "Evidence", exact: true }).click();
    await page.getByRole("button", { name: "Release artifacts and reset" }).click();
    await expect(page.locator(".file-summary")).toContainText("No file selected");
    await page.getByRole("button", { name: "Setup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Prepare native artifacts" })).toBeDisabled();
    expect(await page.evaluate(() =>
      (window as unknown as { __codecAbxTestWorkers: string[] }).__codecAbxTestWorkers,
    )).toEqual([]);

    // Retry a fresh preparation after release; no engine was recreated silently.
    await page.getByRole("button", { name: "Choose local audio…" }).click();
    await expect(page.locator(".file-summary")).toContainText("listening-fixture.wav");
    await page.locator(".advanced-preparation").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByRole("button", { name: "Prepare native artifacts" }).click();
    await expect(page.getByText("Native artifacts ready.")).toBeVisible({ timeout: 120_000 });
    // A worker can fail while no request is in flight. Start playback, terminate
    // that worker through the trusted test seam, and require immediate fatal UI.
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    await expect(page.locator("article.listening-trial")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Monitor playback label A" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    await app.evaluate(async () => {
      const worker = (globalThis as unknown as { __runtimeWorker: import("node:worker_threads").Worker }).__runtimeWorker;
      if (!worker) throw new Error("Test did not capture the production worker");
      await worker.terminate();
    });
    await expect(page.getByText("This listening run is unavailable.", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard unavailable run" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
