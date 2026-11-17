import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { settledScreenshot } from "./filehost-peer";
import { messageId } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { longPressMessage } from "./message-sheet";
import { productionMessageRow } from "./production-ergo";
import { expectConfirmedOwn } from "./reaction-chip";
import { choose } from "./settings-fixture";
import { expectSettled } from "./settled";
import { tap } from "./touch";

const screenshots = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "reactions-phone",
);
const themes = [
  { name: "Lounge", id: "lounge", sending: "😂" },
  { name: "Lounge Night", id: "lounge-night", sending: "👀" },
  { name: "Black", id: "black", sending: "✅" },
] as const;

test("captures the phone sheet, picker and chip states in Lounge, Lounge Night and Black", async ({
  page,
  irc,
}) => {
  const text = "the relay never sees plaintext, it only forwards ciphertext";
  const bot = await irc.peer("bruno");
  await bot.privmsgConfirmed(
    irc.channel,
    "pushed the relay fix, try it on iOS",
  );
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  await bot.privmsgConfirmed(
    irc.channel,
    "notification arrived with the phone locked",
  );
  await bot.reactionConfirmed(irc.channel, id, "👍");
  await bot.reactionConfirmed(irc.channel, id, "❤️");
  const row = productionMessageRow(page, text);
  const chip = (reaction: string) =>
    row.locator(`[data-reaction="${reaction}"]`);

  for (const theme of themes) {
    await useTheme(page, irc, theme.name, theme.id);
    if (theme.id === "lounge") {
      await tap(page, chip("❤️"));
      await bot.waitForReaction(irc.channel, id, "❤️", irc.account);
      await expectConfirmedOwn(chip("❤️"), "2");
    }

    await bot.mode(irc.channel, "+m");
    await react(page, row, bot.nickname, "🎉");
    await expect(chip("🎉")).toHaveAttribute(
      "data-reaction-delivery",
      "failed",
    );
    await bot.mode(irc.channel, "-m");

    await irc.forwarder.pauseIncoming();
    try {
      await react(page, row, bot.nickname, theme.sending);
      await expect(chip(theme.sending)).toHaveAttribute(
        "data-reaction-delivery",
        "sending",
      );
      await settledScreenshot(page, screenshots, `chips-${theme.id}`);

      const sheet = await longPressMessage(page, row, bot.nickname);
      await settledScreenshot(page, screenshots, `sheet-${theme.id}`);
      await tap(page, sheet.getByRole("button", { name: "Add reaction" }));
      await expect(sheet.getByPlaceholder("Search emoji")).toBeVisible();
      await settledScreenshot(page, screenshots, `picker-${theme.id}`);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    } finally {
      await irc.forwarder.resumeIncoming();
    }
    await bot.waitForReaction(irc.channel, id, theme.sending, irc.account);
  }
});

async function useTheme(
  page: Page,
  irc: IrcTestAccount,
  name: string,
  id: string,
): Promise<void> {
  await page.goto(irc.url());
  await page
    .getByRole("region", { name: "Chats" })
    .getByRole("button", { name: "Settings" })
    .tap();
  await page.getByRole("button", { name: /^Appearance/u }).tap();
  await choose(page, name);
  await expect(page.locator("html")).toHaveAttribute("data-theme", id);
  await page.goto(irc.url({ path: `/Local%20Ergo/${irc.channel.slice(1)}` }));
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("data-theme", id);
  await expectSettled(page, { conversation: irc.channel });
}

async function react(
  page: Page,
  row: Locator,
  author: string,
  reaction: string,
): Promise<void> {
  const sheet = await longPressMessage(page, row, author);
  await tap(
    page,
    sheet.getByRole("button", { name: `React with ${reaction}` }),
  );
  await expect(sheet).toHaveCount(0);
}
