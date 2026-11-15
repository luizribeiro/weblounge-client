import type { Locator, Page } from "@playwright/test";
import { messageId } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import { expectSettled } from "./settled";
import { tap } from "./touch";

test("toggles your reaction from a phone chip through sending, confirmation and reload", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const text = "tap the chip to agree";
  const bot = await irc.peer("chip");
  await openChat(page, irc);
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  await bot.reactionConfirmed(irc.channel, id, "👍");
  const chip = productionMessageRow(page, text).locator('[data-reaction="👍"]');
  await expect(chip).toContainText("1");
  await expect(chip).toHaveCSS("height", "32px");

  await irc.forwarder.pauseIncoming();
  await tap(page, chip);
  await expect(chip).toHaveAttribute("data-reaction-delivery", "sending");
  await expect(chip).toContainText("2");
  await bot.waitForReaction(irc.channel, id, "👍", irc.account);
  await irc.forwarder.resumeIncoming();
  await expectConfirmedOwn(chip, "2");

  await openChat(page, irc);
  await expectConfirmedOwn(chip, "2");
  await tap(page, chip);
  await bot.waitForReaction(irc.channel, id, "👍", irc.account, "unreact");
  await expect(chip).not.toHaveAttribute("data-reaction-own");
  await expect(chip).toContainText("1");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await openChat(page, irc);
  await expect(chip).toContainText("1");
  await expect(chip).not.toHaveAttribute("data-reaction-own");
  await expectSettled(page, { conversation: irc.channel });
  await nativeFeelAudit(page);
});

async function openChat(page: Page, irc: IrcTestAccount): Promise<void> {
  await page.goto(irc.url({ path: `/Local%20Ergo/${irc.channel.slice(1)}` }));
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await expectSettled(page, { conversation: irc.channel });
}

async function expectConfirmedOwn(chip: Locator, count: string): Promise<void> {
  await expect(chip).toHaveAttribute("data-reaction-own", "true");
  await expect(chip).not.toHaveAttribute("data-reaction-delivery");
  await expect(chip).toContainText(count);
}
