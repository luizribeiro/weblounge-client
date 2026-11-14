import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { emulateStandalone } from "./mobile-platform";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { choice, settingsScreenshot } from "./settings-fixture";
import { expectSettled } from "./settled";

test.beforeEach(async ({ irc, page }) => {
  await emulateStandalone(page);
  await installNativeFeelInstrumentation(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(irc.url());
  await expect(page.getByRole("button", { name: irc.channel })).toBeVisible();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expectSettled(page);
});

test("opens Settings from Chats and changes appearance live", async ({
  page,
}) => {
  const chats = page.getByRole("region", { name: "Chats" });
  const gear = chats.getByRole("button", { name: "Settings" });
  const gearBox = await gear.boundingBox();
  if (gearBox === null) throw new Error("the Settings button is not rendered");
  expect(Math.abs(gearBox.width - 44)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(gearBox.height - 44)).toBeLessThanOrEqual(0.5);
  await settingsScreenshot(chats, "phone-chats-light");

  await gear.tap();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expectSettled(page);
  await settingsScreenshot(settingsPage(page), "phone-root-light");
  await openAppearance(page);
  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  await nativeFeelAudit(page);

  await choice(page, "Lounge Night").tap();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "lounge-night",
  );
  await choice(page, "Comfortable").tap();
  await expect(page.locator("html")).toHaveAttribute(
    "data-message-density",
    "comfortable",
  );
  await settingsScreenshot(settingsPage(page), "phone-appearance-dark");
});

test("goes back with Back, then swipes back to Chats", async ({ page }) => {
  await openSettings(page);
  await openAppearance(page);
  await choice(page, "Compact").tap();

  await page.getByRole("button", { name: "Back to Settings" }).tap();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /System · Compact/u }),
  ).toBeVisible();
  await expectSettled(page);

  await swipeBack(page);
  await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
  await expectSettled(page);
  await nativeFeelAudit(page);
});

test("swipes back from the Appearance page to the Settings root", async ({
  page,
}) => {
  await openSettings(page);
  await openAppearance(page);

  await swipeBack(page);

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Appearance" })).toHaveCount(
    0,
  );
  await expectSettled(page);
  await page.getByRole("button", { name: "Back to chats" }).tap();
  await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();
});

function settingsPage(page: Page) {
  return page.locator("[data-mobile-settings]");
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole("region", { name: "Chats" })
    .getByRole("button", { name: "Settings" })
    .tap();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expectSettled(page);
}

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Appearance/u }).tap();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expectSettled(page);
}

async function swipeBack(page: Page): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  const pointer = { isPrimary: true, pointerId: 41, pointerType: "touch" };
  for (const [type, clientX] of [
    ["pointerdown", 5],
    ["pointermove", 20],
    ["pointermove", 360],
    ["pointerup", 360],
  ] as const)
    await shell.dispatchEvent(type, { ...pointer, clientX, clientY: 400 });
}
