import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

const UNPROVEN_ACCOUNT =
  "This nick is logged in, but this connection can't prove which account it is, so weblounge can't confirm it's the same person as before.";

test("explains an unverified sender's mark and closes the explanation with Escape", async ({
  page,
  irc,
}) => {
  const peer = await irc.peer("unproven");
  const text = `who is this ${irc.id}`;
  await installNativeFeelInstrumentation(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await peer.privmsgConfirmed(irc.account, text);
  await page
    .locator("[data-buffer-id]")
    .filter({ hasText: peer.nickname })
    .click();
  await expectSettled(page, { conversation: peer.nickname });

  const row = page.locator("[data-message-row]").filter({ hasText: text });
  const mark = row.getByRole("button", { name: "Unverified sender" });
  await mark.hover();
  await expect(row.getByRole("tooltip")).toBeVisible();
  await expect(mark).toHaveAccessibleDescription(
    "Unverified sender. Click to see why.",
  );

  await mark.focus();
  await page.keyboard.press("Escape");
  await expect(row.getByRole("tooltip")).toBeHidden();

  await mark.click();
  const explanation = page.getByRole("dialog", { name: "Unverified sender" });
  await expect(explanation).toContainText(UNPROVEN_ACCOUNT);
  await expect(explanation).toBeFocused();
  await expect(row.getByRole("tooltip")).toBeHidden();
  await screenshot(page);

  await page.keyboard.press("Escape");
  await expect(explanation).toHaveCount(0);
  await expect(mark).toBeFocused();
  await expect(
    page.getByRole("heading", { name: peer.nickname }),
  ).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(explanation).toBeVisible();
  await page.mouse.click(640, 40);
  await expect(explanation).toHaveCount(0);
  await nativeFeelAudit(page);
});

test.describe("on the phone", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 402, height: 874 },
  });

  test("opens the explanation as a sheet and closes it with Escape", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("unproven-phone");
    const text = `phone who is this ${irc.id}`;
    await page.goto(irc.url());
    await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();
    await peer.privmsgConfirmed(irc.account, text);
    await page
      .locator("[data-buffer-id]")
      .filter({ hasText: peer.nickname })
      .tap();
    await expectSettled(page, { conversation: peer.nickname });

    const row = page.locator("[data-message-row]").filter({ hasText: text });
    await row.getByRole("button", { name: "Unverified sender" }).tap();
    const sheet = page.getByRole("dialog", { name: "Unverified sender" });
    await expect(sheet).toContainText(UNPROVEN_ACCOUNT);
    await expect(page.locator("[data-message-sheet]")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Unverified sender" }),
    ).toBeFocused();
  });
});

async function screenshot(page: Page): Promise<void> {
  const path = process.env.WEBLOUNGE_F46_SCREENSHOT;
  if (path !== undefined) await page.screenshot({ path });
}
