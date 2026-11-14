import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";

const screenshotDirectory = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "settings",
);

export async function settingsScreenshot(
  target: Locator,
  name: string,
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await screenshotWithInter(target, {
    path: path.join(screenshotDirectory, `${name}.png`),
  });
}

export function choice(page: Page, name: string): Locator {
  return page
    .locator("label")
    .filter({ has: page.getByRole("radio", { name, exact: true }) });
}

export async function choose(page: Page, name: string): Promise<void> {
  await choice(page, name).click();
  await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
}
