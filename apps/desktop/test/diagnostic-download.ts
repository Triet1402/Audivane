import { expect, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PreparedArtifact, StageProvenance } from "@codec-abx/contracts";

interface DiagnosticExport {
  readonly artifact: PreparedArtifact;
  readonly stageProvenance: { readonly a: readonly StageProvenance[]; readonly b: readonly StageProvenance[] };
}

export async function downloadDiagnostics(page: Page, directory: string): Promise<DiagnosticExport> {
  const before = new Set(await readdir(directory));
  const button = page.getByRole("button", { name: "Download results", exact: true });
  await button.evaluate(element => {
    const disclosure = element.closest("details");
    if (disclosure) disclosure.open = true;
  });
  await button.click();
  let filename: string | undefined;
  await expect.poll(async () => {
    filename = (await readdir(directory)).find(name => !before.has(name) && /codec-abx-(diagnostic|listening)/.test(name) && name.endsWith(".json"));
    return filename;
  }).toBeTruthy();
  const payload = JSON.parse(await readFile(path.join(directory, filename!), "utf8"));
  return (payload.diagnostics ?? payload) as DiagnosticExport;
}
