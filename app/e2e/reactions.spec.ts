import type { Locator, Page } from "@playwright/test";
import { messageId } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow, useDedicatedWorker } from "./production-ergo";
import { expectSettled } from "./settled";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("shows received reactions through live updates, history, and removal", async ({
  page,
  irc,
}) => {
  await useDedicatedWorker(page);
  const channel = irc.channel;
  const text = "react to this";
  const bot = await irc.peer("react");
  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  const echoed = await bot.privmsgConfirmed(channel, text);
  const row = productionMessageRow(page, text);
  await expect(row).toBeVisible();
  await expectAtLiveEdge(page);

  const id = messageId(echoed);
  await bot.reactionConfirmed(channel, id, "👍");
  const chip = row.locator('[data-reaction="👍"]');
  await expect(chip).toContainText("1");
  await expectAtLiveEdge(page);
  await chip.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    `${bot.nickname} reacted with 👍`,
  );

  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  const historyRow = productionMessageRow(page, text);
  await expect(historyRow.locator('[data-reaction="👍"]')).toContainText("1");

  await bot.unreactionConfirmed(channel, id, "👍");
  await expect(historyRow.locator('[data-reaction="👍"]')).toHaveCount(0);

  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  const reloadedRow = productionMessageRow(page, text);
  await expect(reloadedRow).toBeVisible();
  await expect(reloadedRow.locator('[data-reaction="👍"]')).toHaveCount(0);
});

test("toggles your reaction from a chip through sending, confirmation and reload", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const text = "toggle my reaction";
  const bot = await irc.peer("chip");
  await openOnline(page, irc);
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  await bot.reactionConfirmed(irc.channel, id, "👍");
  const chip = productionMessageRow(page, text).locator('[data-reaction="👍"]');
  await expect(chip).toContainText("1");

  await irc.forwarder.pauseIncoming();
  await chip.click();
  await expect(chip).toHaveAttribute("data-reaction-delivery", "sending");
  await expect(chip).toContainText("2");
  await bot.waitForReaction(irc.channel, id, "👍", irc.account);
  await irc.forwarder.resumeIncoming();
  await expectConfirmedOwn(chip);

  await openOnline(page, irc);
  await expectConfirmedOwn(chip);
  await chip.click();
  await bot.waitForReaction(irc.channel, id, "👍", irc.account, "unreact");
  await expect(chip).not.toHaveAttribute("data-reaction-own");
  await expect(chip).toContainText("1");

  await openOnline(page, irc);
  await expect(chip).toContainText("1");
  await expect(chip).not.toHaveAttribute("data-reaction-own");
  await expectIdle(page);
  await nativeFeelAudit(page);
});

test("shows a refused own reaction as failed and retries it from the chip", async ({
  page,
  irc,
}) => {
  const text = "retry my reaction";
  const bot = await irc.peer("refuse");
  await openOnline(page, irc);
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  await bot.reactionConfirmed(irc.channel, id, "👍");
  const chip = productionMessageRow(page, text).locator('[data-reaction="👍"]');
  await expect(chip).toContainText("1");

  await bot.mode(irc.channel, "+m");
  await chip.click();
  await expect(chip).toHaveAttribute("data-reaction-delivery", "failed");
  await expect(chip).toContainText("!");

  await bot.mode(irc.channel, "-m");
  await chip.click();
  await bot.waitForReaction(irc.channel, id, "👍", irc.account);
  await expectConfirmedOwn(chip);
});

test("reacts from the hover toolbar and its keyboard path without moving the transcript", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const text = "react from the toolbar";
  const bot = await irc.peer("toolbar");
  await openOnline(page, irc);
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  await bot.privmsgConfirmed(irc.channel, "a later line");
  const row = productionMessageRow(page, text);
  await expect(row).toBeVisible();
  await expectSettled(page);
  const before = await transcriptGeometry(page);

  await row.hover();
  const toolbar = row.getByRole("toolbar", { name: "Message actions" });
  await expect(toolbar).toBeVisible();
  expect(await transcriptGeometry(page)).toEqual(before);
  await toolbar.getByRole("button", { name: "React with 😂" }).click();
  await bot.waitForReaction(irc.channel, id, "😂", irc.account);
  await expect(row.locator('[data-reaction="😂"]')).toHaveAttribute(
    "data-reaction-own",
    "true",
  );
  await expect(
    toolbar.getByRole("button", { name: "React with 😂" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.mouse.move(0, 0);
  await expect(toolbar).toHaveCount(0);
  // Chromium shows focus rings for programmatic focus only after keyboard input.
  await page.keyboard.press("Shift");
  await row.focus();
  await expect(toolbar).toBeVisible();
  await page.keyboard.press("Tab");
  const thumbs = toolbar.getByRole("button", { name: "React with 👍" });
  await expect(thumbs).toBeFocused();
  await page.keyboard.press("Enter");
  await bot.waitForReaction(irc.channel, id, "👍", irc.account);
  await expect(
    toolbar.getByRole("button", { name: "React with 👍" }),
  ).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await page.locator("[data-message-list]").focus();
  await expect(toolbar).toHaveCount(0);
  await expectIdle(page);
  await nativeFeelAudit(page);
});

async function transcriptGeometry(page: Page) {
  return page.locator("[data-message-list]").evaluate((list) => ({
    scrollTop: list.scrollTop,
    rows: [...list.querySelectorAll("[data-message-row]")].map((row) => {
      const box = row.getBoundingClientRect();
      return [box.top, box.height];
    }),
  }));
}

async function expectIdle(page: Page) {
  await page.mouse.move(0, 0);
  await expect(
    page.locator('[data-buffer-id][aria-current="page"]'),
  ).toHaveAttribute("data-unread", "0");
  await expectSettled(page);
}

async function openOnline(page: Page, irc: IrcTestAccount) {
  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
}

async function expectConfirmedOwn(chip: Locator) {
  await expect(chip).toHaveAttribute("data-reaction-own", "true");
  await expect(chip).not.toHaveAttribute("data-reaction-delivery");
  await expect(chip).toContainText("2");
}

async function expectAtLiveEdge(page: Page) {
  await expect
    .poll(() =>
      page.locator("[data-message-list]").evaluate((element) => {
        const list = element as HTMLElement;
        return list.scrollHeight - list.scrollTop - list.clientHeight;
      }),
    )
    .toBeLessThanOrEqual(2);
}
