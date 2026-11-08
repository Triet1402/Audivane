import { clickRunAction } from "../../tests/ui/run-actions.js";
import { readFile } from "node:fs/promises";

import { expect, type Page } from "@playwright/test";

import { guardNetwork, type NetworkGuard } from "../../tests/e2e/fixtures.js";

// Reuse the repository's independent analytical WAV writer, WAV inspector,
// hashing helper and app-driving helpers rather than growing a second policy.
export {
  chooseWav,
  collectPageErrors,
  configure,
  downloadJson,
  expectNoRemoteOrUpload,
  guardNetwork,
  inspectWav,
  makePcm16Wav,
  sha256,
} from "../../tests/e2e/fixtures.js";
export type { NetworkGuard } from "../../tests/e2e/fixtures.js";

export interface WebsiteWorker {
  readonly href: string;
  readonly name: string | null;
  readonly type: string | null;
}

export interface CspViolation {
  readonly directive: string;
  readonly blocked: string;
  readonly source: string;
  readonly line: number;
}

export interface WebsiteProbe {
  readonly workers: readonly WebsiteWorker[];
  readonly violations: readonly CspViolation[];
}

/**
 * Test-only instrumentation. It observes the real Worker constructor and CSP
 * events without changing application code or adding a production global.
 */
export function installWebsiteProbe(): void {
  const NativeWorker = window.Worker;
  const workers: WebsiteWorker[] = [];
  const violations: CspViolation[] = [];

  class TrackedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      workers.push({
        href: new URL(String(url), window.location.href).href,
        name: options?.name ?? null,
        type: options?.type ?? null,
      });
      super(url, options);
    }
  }

  Object.defineProperty(window, "Worker", {
    value: TrackedWorker,
    configurable: true,
    writable: true,
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
      source: event.sourceFile,
      line: event.lineNumber,
    });
  });

  (window as typeof window & { __codecAbxWebsiteProbe?: WebsiteProbe })
    .__codecAbxWebsiteProbe = { workers, violations };
}

export async function readWebsiteProbe(page: Page): Promise<WebsiteProbe> {
  return await page.evaluate(() => {
    const probe = (window as typeof window & { __codecAbxWebsiteProbe?: WebsiteProbe })
      .__codecAbxWebsiteProbe;
    return {
      workers: probe?.workers.map((worker) => ({ ...worker })) ?? [],
      violations: probe?.violations.map((violation) => ({ ...violation })) ?? [],
    };
  });
}

/**
 * Open the served demo. The helper mirrors openLab from tests/e2e but keeps the
 * /demo/ subpath; the guard still permits only same-origin GET/HEAD requests.
 */
export async function openDemo(page: Page, baseURL: string): Promise<NetworkGuard> {
  const origin = new URL(baseURL).origin;
  const guard = await guardNetwork(page, origin);
  await page.goto(`${origin}/demo/`);
  await expect(page.locator("#capabilities-heading")).toBeVisible();
  await expect(page.locator("#codec-a option[value=opus]")).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator("#codec-a option[value=noop_passthrough]")).toBeEnabled();
  await page.locator(".advanced-preparation > summary").click();
  await page.locator(".listening-test-plan > summary").click();
  return guard;
}

export async function downloadListeningExport(page: Page): Promise<Record<string, unknown>> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    clickRunAction(page, "Download results"),
  ]);
  expect(download.suggestedFilename()).toMatch(/^codec-abx-listening-.*\.json$/);
  const file = await download.path();
  if (!file) throw new Error("website test: listening export had no local path");
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

export const DEMO_CSP_TOKENS = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "child-src 'self'",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
] as const;

export const CONTENT_CSP_TOKENS = [
  "default-src 'none'",
  "worker-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
] as const;

export function expectDemoCsp(header: string | null | undefined): void {
  expect(header, "demo Content-Security-Policy header").toBeTruthy();
  for (const token of DEMO_CSP_TOKENS) {
    expect(header, `demo CSP should include ${token}`).toContain(token);
  }
  // Existing supplemental Emscripten factories need general evaluation.
  expect(header, "supplemental factory glue requires evaluation on the demo route").toContain("'unsafe-eval'");
}

export function expectContentCsp(header: string | null | undefined): void {
  expect(header).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'(?:;|$)/);
  expect(header).not.toContain("'unsafe-eval'");
  expect(header, "content Content-Security-Policy header").toBeTruthy();
  for (const token of CONTENT_CSP_TOKENS) {
    expect(header, `content CSP should include ${token}`).toContain(token);
  }
}

export interface OverflowFacts {
  readonly innerWidth: number;
  readonly scrollWidth: number;
  readonly bodyScrollWidth: number;
  readonly scrollX: number;
}

/** Measures the document scroller, not intentional inner scroll containers. */
export async function measureOverflow(page: Page): Promise<OverflowFacts> {
  return await page.evaluate(() => {
    const scrolling = document.scrollingElement ?? document.documentElement;
    return {
      innerWidth: window.innerWidth,
      scrollWidth: scrolling.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      scrollX: window.scrollX,
    };
  });
}
