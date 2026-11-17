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

export async function choosePhoneAppearance(
  page: Page,
  names: readonly string[],
): Promise<void> {
  await page
    .getByRole("region", { name: "Chats" })
    .getByRole("button", { name: "Settings" })
    .tap();
  await page.getByRole("button", { name: /^Appearance/u }).tap();
  for (const name of names) {
    await choice(page, name).tap();
    await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
  }
  await page.getByRole("button", { name: "Back to Settings" }).tap();
  await page.getByRole("button", { name: "Back to chats" }).tap();
  await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();
}

export async function openNotificationSettings(page: Page): Promise<void> {
  await page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("button", { name: "Settings" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const section = dialog.getByRole("button", { name: "Notifications" });
  await section.click();
  await expect(section).toHaveAttribute("aria-current", "page");
  await expect(
    dialog.getByRole("region", { name: "Notifications" }),
  ).toBeVisible();
}

type AboutFacts = Readonly<Record<string, string>>;

const fullCommitTail = "[0-9a-f]{33}";

export async function expectAboutFacts(
  about: Locator,
  platform: string,
): Promise<AboutFacts> {
  await expect(
    about.getByRole("heading", { name: "weblounge", exact: true }),
  ).toBeVisible();
  const labels = await about.locator("dt").allInnerTexts();
  const values = await about.locator("dd").allInnerTexts();
  const facts = Object.fromEntries(
    labels.map((label, index) => [label, values[index] ?? ""]),
  );
  expect(labels).toEqual(["Version", "Commit", "Built", "Channel", "Platform"]);
  expect(facts.Version).toMatch(/^(?:[0-9a-f]{7}|ci|dirty)$/u);
  expect(facts.Commit).toBe(facts.Version);
  expect(facts.Built).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u);
  expect(facts.Channel).toBe("Release");
  expect(facts.Platform).toBe(platform);
  return facts;
}

export async function expectCopyDebugInfo(
  page: Page,
  about: Locator,
  facts: AboutFacts,
  press: (button: Locator) => Promise<void>,
  copied: () => Promise<string | undefined>,
): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await press(about.getByRole("button", { name: "Copy debug info" }));
  await expect(about.getByRole("status")).toHaveText("Copied");
  await expect
    .poll(async () => (await copied())?.split("\n"))
    .toEqual([
      "weblounge debug info",
      `Version: ${facts.Version}`,
      expect.stringMatching(
        new RegExp(`^Commit: ${facts.Commit}(?:${fullCommitTail})?$`, "u"),
      ),
      `Built: ${facts.Built}`,
      `Channel: ${facts.Channel}`,
      `Platform: ${facts.Platform}`,
      `User agent: ${userAgent}`,
    ]);
}
