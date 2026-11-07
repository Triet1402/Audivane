import { test, expect, _electron as electron } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function wav(rate = 96_000, channels: 1 | 2 = 2, seconds = 0.7): Buffer {
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

async function recent(directory: string, marker: string): Promise<string | null> {
  const matches = (await fs.readdir(directory))
    .filter((name) => name.includes(marker) && name.endsWith(".json"))
    .sort();
  return matches.length === 0 ? null : path.join(directory, matches[matches.length - 1]!);
}

test("native ordered codec chain prepares, binds, plays and exports through the real worker", async () => {
  test.setTimeout(300_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codec-abx-desktop-chain-"));
  const sourcePath = path.join(directory, "chain-fixture-96k-stereo.wav");
  await fs.writeFile(sourcePath, wav());
  const downloads = path.join(directory, "downloads");
  await fs.mkdir(downloads);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.ELECTRON_RUN_AS_NODE;

  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
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

    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, sourcePath);
    await app.evaluate(({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      let sequence = 0;
      contents.session.on("will-download", (_event, item) => {
        const safe = item.getFilename().replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 120);
        item.setSavePath(`${target}/${String(++sequence).padStart(3, "0")}-${safe}`);
      });
    }, downloads);

    await expect(page.locator("main.app")).toHaveAttribute("data-runtime", "desktop");
    await expect(page.locator('section[aria-labelledby="capabilities-heading"]'))
      .toContainText("desktop-native", { timeout: 120_000 });

    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => Array.from(document.fonts).some(
      font => font.family === "IBM Plex Sans" && font.status === "loaded",
    ))).toBe(true);
    await page.getByRole("button", { name: "Choose local audio…" }).click();
    await expect(page.locator(".file-summary")).toContainText("chain-fixture-96k-stereo.wav");

    // Side A: Opus 96 → MP3 128. Side B: AAC 128 → Opus 96.
    await page.selectOption("#codec-a", "opus");
    await page.selectOption("#bitrate-a", "96");
    await page.getByRole("button", { name: "Add side A stage" }).click();
    await page.selectOption("#codec-a-2", "mp3");
    await page.selectOption("#bitrate-a-2", "128");
    await page.selectOption("#codec-b", "aac");
    await page.selectOption("#bitrate-b", "128");
    await page.getByRole("button", { name: "Add side B stage" }).click();
    await page.selectOption("#codec-b-2", "opus");
    await page.selectOption("#bitrate-b-2", "96");

    await page.locator(".advanced-preparation").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByRole("button", { name: "Prepare native artifacts" }).click();
    await expect(page.getByText("Native artifacts ready.")).toBeVisible({ timeout: 150_000 });

    const artifactText = await page
      .locator("details", { hasText: "Raw diagnostic artifact JSON" })
      .locator("pre")
      .textContent();
    const artifact = JSON.parse(artifactText ?? "{}") as {
      request: { version: number; a: { codecId: string; bitrateKbps: number }[]; b: { codecId: string; bitrateKbps: number }[] };
      engine: { location: string; preparationPolicy: string };
      a: { stages?: { stageIndex: number; requested: { codecId: string; bitrateKbps: number }; actualBitrateKbps: number | null }[] };
      b: { stages?: { stageIndex: number; requested: { codecId: string; bitrateKbps: number }; actualBitrateKbps: number | null }[] };
    };
    expect(artifact.engine.location).toBe("desktop-native");
    expect(artifact.engine.preparationPolicy).toBe("aligned-gain-matched-v1");
    expect(artifact.request.version).toBe(2);
    expect(artifact.request.a).toEqual([
      { codecId: "opus", bitrateKbps: 96 },
      { codecId: "mp3", bitrateKbps: 128 },
    ]);
    expect(artifact.request.b).toEqual([
      { codecId: "aac", bitrateKbps: 128 },
      { codecId: "opus", bitrateKbps: 96 },
    ]);
    expect(artifact.a.stages?.map((stage) => stage.requested.codecId)).toEqual(["opus", "mp3"]);
    expect(artifact.b.stages?.map((stage) => stage.requested.codecId)).toEqual(["aac", "opus"]);
    for (const stage of [...artifact.a.stages!, ...artifact.b.stages!]) {
      expect(stage.stageIndex).toBeGreaterThan(0);
      expect(stage.actualBitrateKbps).not.toBeNull();
      expect(stage.actualBitrateKbps!).toBeGreaterThan(0);
    }
    await expect(page.locator('section[aria-label="Side A stage provenance"]'))
      .toContainText("libmp3lame");

    // Diagnostic JSON carries the complete ordered request and both stage arrays.
    await page.getByRole("button", { name: "Download JSON diagnostics" }).click();
    await expect.poll(() => recent(downloads, "codec-abx-diagnostic")).not.toBeNull();
    const diagnostic = JSON.parse(
      await fs.readFile((await recent(downloads, "codec-abx-diagnostic"))!, "utf8"),
    ) as { artifact: { request: { version: number } }; stageProvenance: { a: unknown[]; b: unknown[] } };
    expect(diagnostic.artifact.request.version).toBe(2);
    expect(diagnostic.stageProvenance.a).toHaveLength(2);
    expect(diagnostic.stageProvenance.b).toHaveLength(2);

    // Bind the chain into the real main-owned service and exercise playback.
    await page.locator("#canary-enabled").uncheck();
    await page.getByRole("button", { name: "Prepare test", exact: true }).click();
    await expect(page.locator("#listen-view")).toBeVisible();
    const trial = page.locator("article.listening-trial");
    await expect(trial).toBeVisible({ timeout: 180_000 });
    await expect(page.locator("#codec-a-2")).toBeDisabled();
    await page.getByRole("button", { name: "Monitor playback label A" }).click();
    // The first staged trial is paused behind one Play/Pause transport toggle.
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Download listening export" }).click();
    await expect.poll(() => recent(downloads, "codec-abx-listening")).not.toBeNull();
    const exported = JSON.parse(
      await fs.readFile((await recent(downloads, "codec-abx-listening"))!, "utf8"),
    ) as {
      schema: string;
      prepared: {
        request: { version: number };
        tracks: {
          a: { stageCount: number; stages: { requested: { codecId: string } }[] };
          b: { stageCount: number; stages: { requested: { codecId: string } }[] };
        };
      };
      playback: { actualOutputSampleRate: number | null };
    };
    expect(exported.schema).toBe("codec-abx-browser-listening-v1");
    expect(exported.prepared.request.version).toBe(2);
    expect(exported.prepared.tracks.a.stageCount).toBe(2);
    expect(exported.prepared.tracks.a.stages.map((stage) => stage.requested.codecId))
      .toEqual(["opus", "mp3"]);
    expect(exported.prepared.tracks.b.stages.map((stage) => stage.requested.codecId))
      .toEqual(["aac", "opus"]);
    expect(exported.playback.actualOutputSampleRate).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Close listening run" }).click();
    await expect(page.getByRole("button", { name: "Choose local audio…" })).toBeEnabled();
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
