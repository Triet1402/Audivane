import { expect, test } from "@playwright/test";

import {
  expectContentCsp,
  measureOverflow,
} from "./helpers.js";

// Content routes must stand on their own: no application scripts, no codec
// materials, and no page-level horizontal overflow at narrow and wide widths.
const routes = [
  { path: "/", name: "home" },
  { path: "/docs/", name: "docs index" },
  { path: "/guides/", name: "guides index" },
  { path: "/downloads/", name: "downloads" },
] as const;

const widths = [320, 390, 768, 1440] as const;

function isCodecOrDemoRequest(raw: string): boolean {
  const url = new URL(raw);
  const pathname = url.pathname.toLowerCase();
  return pathname.startsWith("/demo/")
    || pathname.includes("codec-assets")
    || pathname.endsWith(".wasm")
    || /(?:^|\/)(?:ffmpeg|lc3|ldac|codec)[^/]*\.(?:js|mjs|wasm)$/.test(pathname);
}

for (const route of routes) {
  test(`${route.name} is responsive, content-CSP locked, and never loads the demo runtime`, async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(route.path, { waitUntil: "load" });
      expect(response, `${route.path} response`).not.toBeNull();
      expect(response!.status(), `${route.path} at ${width}px status`).toBe(200);
      expectContentCsp(response!.headers()["content-security-policy"]);
      expect(response!.headers()["x-content-type-options"]).toBe("nosniff");

      // Fonts change metrics; wait for the real face before measuring overflow.
      await page.evaluate(async () => { await document.fonts.ready; });
      const overflow = await measureOverflow(page);
      expect(overflow.innerWidth, `${route.path} viewport`).toBe(width);
      expect(
        overflow.scrollWidth,
        `${route.path} at ${width}px document scrollWidth ${overflow.scrollWidth} > viewport ${overflow.innerWidth}`,
      ).toBeLessThanOrEqual(overflow.innerWidth + 1);
      expect(
        overflow.bodyScrollWidth,
        `${route.path} at ${width}px body scrollWidth ${overflow.bodyScrollWidth} > viewport ${overflow.innerWidth}`,
      ).toBeLessThanOrEqual(overflow.innerWidth + 1);
      expect(overflow.scrollX, `${route.path} starts horizontally scrolled`).toBe(0);

      // Static content pages must not execute an application bundle.
      expect(
        await page.locator("script[src], iframe, object, embed").count(),
        `${route.path} at ${width}px contains an active embedded resource`,
      ).toBe(0);
    }

    const codecRequests = requests.filter(isCodecOrDemoRequest);
    expect(codecRequests, `${route.path} accidentally loaded demo/codec assets`).toEqual([]);
    const crossOrigin = requests.filter((raw) => new URL(raw).origin !== origin);
    expect(crossOrigin, `${route.path} made a cross-origin request`).toEqual([]);
  });
}

test("keyboard users can skip to content and reach every primary site link", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip")).toBeFocused();
  const skipStyle = await page.locator(".skip").evaluate((element) => {
    const style = getComputedStyle(element);
    return { top: style.top, outlineStyle: style.outlineStyle };
  });
  expect(skipStyle.top, "focused skip link should become visible").toBe("12px");
  expect(skipStyle.outlineStyle, "focused skip link needs a visible focus ring").not.toBe("none");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await expect(page.locator("#main")).toBeVisible();

  await page.goto("/", { waitUntil: "load" });
  const focused: Array<{
    text: string;
    href: string | null;
    inHeader: boolean;
    outlineStyle: string;
    outlineWidth: string;
  }> = [];
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    focused.push(await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const style = element === null ? null : getComputedStyle(element);
      return {
        text: element?.textContent?.trim().replace(/\s+/g, " ") ?? "",
        href: element?.getAttribute("href") ?? null,
        inHeader: element?.closest("header") !== null,
        outlineStyle: style?.outlineStyle ?? "none",
        outlineWidth: style?.outlineWidth ?? "0px",
      };
    }));
  }

  const expectedNav = ["/docs/", "/guides/", "/downloads/", "/demo/"];
  const primaryLinks = focused.filter((entry) =>
    entry.inHeader && entry.href !== null && expectedNav.includes(entry.href));
  expect(
    primaryLinks.map((entry) => entry.href),
    "primary navigation links should be reachable in order with Tab",
  ).toEqual(expectedNav);
  for (const entry of primaryLinks) {
    expect(entry.outlineStyle, `${entry.href} needs a visible keyboard focus ring`).not.toBe("none");
    expect(entry.outlineWidth, `${entry.href} focus ring should have width`).not.toBe("0px");
  }
});

test("documentation index opens a real article and keeps navigation current", async ({ page }) => {
  await page.goto("/docs/", { waitUntil: "load" });

  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(mainNav.getByRole("link", { name: "Docs" })).toHaveAttribute("aria-current", "page");

  const items = page.locator(".content-index-item");
  expect(await items.count(), "documentation index should list real pages").toBeGreaterThan(0);
  const first = items.first();
  const href = await first.getAttribute("href");
  const title = (await first.locator("h2").textContent())?.trim();
  expect(href, "first documentation link").toMatch(/^\/docs\/[^/]+\/$/);
  expect(title, "first documentation title").toBeTruthy();

  await first.click();
  await expect(page).toHaveURL(new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.locator("#main h1")).toHaveText(title!);
  await expect(page.locator(".doc-rail a[aria-current='page']")).toHaveText(title!);
  await expect(page.locator(".breadcrumbs")).toContainText(title!);
  await expect(page.locator(".doc-article .prose").first()).toBeVisible();
  // Every page in this collection has at least one in-section pager target.
  expect(await page.locator(".doc-pager a").count()).toBeGreaterThan(0);
});

test("the primary home action and header link open the built demo, not a preview", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "load" });

  const primary = page.locator(".hero-actions a.button[href='/demo/']");
  await expect(primary).toHaveAttribute("href", "/demo/");
  const headerApp = page
    .getByRole("navigation", { name: "Main navigation" })
    .locator("a[href='/demo/']");
  await expect(headerApp).toHaveAttribute("href", "/demo/");

  await primary.click();
  await expect(page).toHaveURL(/\/demo\/$/);
  await expect(page.locator("main.app")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#capabilities-heading")).toBeVisible();
  const assets = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes("/assets/") || name.includes("/codec-assets/")));
  expect(assets.length, "the demo should load its own built assets").toBeGreaterThan(0);
  expect(assets.some((name) => name.includes("/@vite/")), "Vite dev marker found").toBe(false);
  expect(assets.every((name) => new URL(name).pathname.startsWith("/demo/")),
    "the demo loaded an asset outside /demo/").toBe(true);
});


test("theme choice persists across content navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  for (const theme of ["studio", "dark", "light", "system"]) {
    await page.goto("/");
    await page.locator("#site-theme").selectOption(theme);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath(`theme-${theme}.png`) });
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Docs", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#site-theme")).toHaveValue(theme);
  }
});
