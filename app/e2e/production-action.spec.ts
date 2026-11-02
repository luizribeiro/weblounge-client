import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { productionChannel, useDedicatedWorker } from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

test("renders own channel and direct actions before and after reload", async ({
  page,
}) => {
  await useDedicatedWorker(page);
  const suffix = Date.now().toString(36).slice(-6);
  const channelAction = `hides in channel ${suffix}`;
  const directAction = `hides in direct ${suffix}`;
  const peer = await IrcClient.connect(
    `action-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    productionChannel,
  );
  try {
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/me ${channelAction}`);
    await composer.press("Enter");
    await expectActionRow(page, channelAction, "confirmed");

    peer.privmsg("weblounge", `open direct ${suffix}`);
    await page
      .getByRole("button", { name: new RegExp(`^${peer.nickname}(?:,|$)`) })
      .click();
    const directComposer = page.getByRole("textbox", {
      name: `Message ${peer.nickname}`,
    });
    await directComposer.fill(`/me ${directAction}`);
    await directComposer.press("Enter");
    await expectActionRow(page, directAction, "confirmed");

    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await expectActionRow(page, channelAction, "received");
    await page
      .getByRole("button", { name: new RegExp(`^${peer.nickname}(?:,|$)`) })
      .click();
    await expectActionRow(page, directAction, "received");
  } finally {
    peer.close();
  }
});

async function expectActionRow(
  page: Page,
  text: string,
  delivery: "confirmed" | "received",
): Promise<void> {
  const row = page.locator(`[data-message-row][data-message-text="${text}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-delivery", delivery);
  await expect(row).toHaveClass(/action/u);
  await expect(row).not.toContainText("ACTION");
  await expect(row).not.toContainText("\u0001");
}
