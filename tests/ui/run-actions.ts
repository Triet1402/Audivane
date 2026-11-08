import type { Page } from "@playwright/test";

/** Run management belongs to Evidence. Return to the task after a download/reset. */
export async function clickRunAction(page: Page, name: string): Promise<void> {
  const previousView = await page.locator(".main-content > .view:not([hidden])").getAttribute("id");
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  const button = page.getByRole("button", { name, exact: true });
  await button.evaluate(element => {
    const disclosure = element.closest("details");
    if (disclosure) disclosure.open = true;
  });
  await button.click();
  if (previousView !== "evidence-view" && await page.locator("#evidence-view").isVisible()) {
    const tab = previousView === "setup-view" ? "Setup" : "Listen";
    await page.getByRole("button", { name: tab, exact: true }).click();
  }
}
