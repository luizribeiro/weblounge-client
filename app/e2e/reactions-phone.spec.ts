import type { BrowserContext, Locator, Page } from "@playwright/test";
import { messageId } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { longPressMessage } from "./message-sheet";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { dispatchPersistedPageShow } from "./page-lifecycle";
import { productionMessageRow } from "./production-ergo";
import { expectSettled } from "./settled";
import { isChromium, tap, touchDown } from "./touch";

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

test("long-pressing a message opens the sheet and its reaction reaches the peer", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const text = "hold me to react";
  const bot = await irc.peer("hold");
  await openChat(page, irc);
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  const row = productionMessageRow(page, text);
  await expect(row).toBeVisible();

  const sheet = await longPressMessage(page, row, bot.nickname);
  await expect(row).toHaveAttribute("data-held", "true");
  await expect(sheet).toContainText(text);
  expect(await page.evaluate(() => getSelection()?.isCollapsed ?? true)).toBe(
    true,
  );
  await expect(sheet.getByRole("button", { name: /^React with / })).toHaveText([
    "👍",
    "❤️",
    "😂",
    "🎉",
    "👀",
    "✅",
  ]);
  await expect(sheet.getByRole("button", { name: "Copy text" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Reply" })).toHaveCount(0);

  await irc.forwarder.pauseIncoming();
  await tap(page, sheet.getByRole("button", { name: "React with 🎉" }));
  await expect(sheet).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-held");
  const chip = row.locator('[data-reaction="🎉"]');
  await expect(chip).toHaveAttribute("data-reaction-delivery", "sending");
  await expect(chip).toHaveCSS("border-top-style", "dashed");
  await bot.waitForReaction(irc.channel, id, "🎉", irc.account);
  await irc.forwarder.resumeIncoming();
  await expectConfirmedOwn(chip, "1");
  await expect(chip).toHaveCSS("border-top-style", "solid");

  await openChat(page, irc);
  await expectConfirmedOwn(chip, "1");
  await expectSettled(page, { conversation: irc.channel });
  await nativeFeelAudit(page);
});

test("picks any emoji from the phone sheet's searchable picker", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const text = "something deserves a rocket";
  const bot = await irc.peer("picker");
  await openChat(page, irc);
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  const row = productionMessageRow(page, text);

  const sheet = await longPressMessage(page, row, bot.nickname);
  await tap(page, sheet.getByRole("button", { name: "Add reaction" }));
  const search = sheet.getByPlaceholder("Search emoji");
  await expect(search).toBeVisible();
  await expect(search).toHaveCSS("font-size", "16px");
  await expect(sheet.getByRole("button", { name: "Copy text" })).toHaveCount(0);
  await search.fill("rocket");
  await tap(page, sheet.getByRole("button", { name: "rocket ship" }));
  await expect(sheet).toHaveCount(0);
  await bot.waitForReaction(irc.channel, id, "🚀", irc.account);
  await expectConfirmedOwn(row.locator('[data-reaction="🚀"]'), "1");

  await longPressMessage(page, row, bot.nickname);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expectSettled(page, { conversation: irc.channel });
  await nativeFeelAudit(page);
});

test("copies a message's text from the phone sheet and closes from the scrim", async ({
  context,
  page,
  irc,
}) => {
  await prepareClipboard(context);
  const text = "copy this exact line, please";
  const bot = await irc.peer("copy");
  await openChat(page, irc);
  await bot.privmsgConfirmed(irc.channel, text);
  const row = productionMessageRow(page, text);

  const sheet = await longPressMessage(page, row, bot.nickname);
  await tap(page, sheet.getByRole("button", { name: "Copy text" }));
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => copiedText(page)).toBe(text);

  await longPressMessage(page, row, bot.nickname);
  await tap(page, page.locator("[data-mobile-sheet] > button").first());
  await expect(sheet).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-held");
});

test("scrolling over messages never opens the sheet", async ({ page, irc }) => {
  const bot = await irc.peer("scroll");
  for (let index = 0; index < 30; index += 1)
    await bot.privmsgConfirmed(irc.channel, `scroll line ${index}`);
  await openChat(page, irc);
  const list = page.locator("[data-message-list]");
  const row = productionMessageRow(page, "scroll line 27");
  await expect(row).toBeVisible();
  const before = await list.evaluate((element) => element.scrollTop);

  const finger = await touchDown(page, row);
  await expect(row).toHaveAttribute("data-pressing", "true");
  await finger.moveBy(0, 160);
  await expect(row).not.toHaveAttribute("data-pressing");
  await finger.lift();
  await expect(page.locator("[data-mobile-sheet]")).toHaveCount(0);
  await expect(page.locator("[data-message-row][data-pressing]")).toHaveCount(
    0,
  );
  if (isChromium(page.context()))
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeLessThan(before);
});

test("the back swipe starting on a message never opens the sheet", async ({
  page,
  irc,
}) => {
  const bot = await irc.peer("swipe");
  const text = "swipe back across me";
  await bot.privmsgConfirmed(irc.channel, text);
  await openChat(page, irc);
  const box = await productionMessageRow(page, text).boundingBox();
  if (box === null) throw new Error("the message is not visible");

  const finger = await touchDown(page, { x: 6, y: box.y + box.height / 2 });
  await finger.moveBy(20, 0);
  await finger.moveBy(240, 0);
  await finger.lift();
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expect(page.locator("[data-mobile-sheet]")).toHaveCount(0);
});

test("reacts from the sheet in a DM after a reconnect while its peer stays quiet", async ({
  context,
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const keeper = await irc.self();
  await keeper.setAlwaysOn(true);
  const peer = await irc.peer("quiet-dm");
  await peer.mode(peer.nickname, "+B");
  const text = `see https://github.com/luizribeiro/weblounge-client/pull/1234 ${"and more words".repeat(14)}`;
  await openChat(page, irc);
  const id = messageId(await peer.privmsgConfirmed(irc.account, text));
  await page.goto(irc.url({ path: `/Local%20Ergo/@${peer.nickname}` }));
  const online = page.locator('[data-network-state="online"]');
  await expect(online).toHaveCount(1);
  const row = page.locator(`[data-message-row][data-message-text="${text}"]`);
  await expect(row).toBeVisible();
  await expectSettled(page, { conversation: peer.nickname });

  await context.setOffline(true);
  await expect(online).toHaveCount(0);
  await context.setOffline(false);
  await dispatchPersistedPageShow(page);
  await expect(online).toHaveCount(1);
  await expectSettled(page, { conversation: peer.nickname });

  const sheet = await longPressMessage(page, row, peer.nickname);
  await tap(page, sheet.getByRole("button", { name: "React with 😂" }));
  await peer.waitForReaction(peer.nickname, id, "😂", irc.account);
  await expectConfirmedOwn(row.locator('[data-reaction="😂"]'), "1");
  await expectSettled(page, { conversation: peer.nickname });
  await nativeFeelAudit(page);
});

/**
 * Playwright can grant reading Chromium's clipboard; WebKit's stays write-only to tests, so there
 * the test records what the app hands the clipboard instead.
 */
async function prepareClipboard(context: BrowserContext): Promise<void> {
  if (isChromium(context)) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    return;
  }
  await context.addInitScript(() => {
    const clipboard = navigator.clipboard;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text: string) => {
      (window as Window & { __copiedText?: string }).__copiedText = text;
      return write(text);
    };
  });
}

async function copiedText(page: Page): Promise<string | undefined> {
  return isChromium(page.context())
    ? page.evaluate(() => navigator.clipboard.readText())
    : page.evaluate(
        () => (window as Window & { __copiedText?: string }).__copiedText,
      );
}

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
