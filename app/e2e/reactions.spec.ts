import type { Page } from "@playwright/test";
import { messageId } from "./irc-client";
import { expect, test } from "./irc-fixture";
import { productionMessageRow, useDedicatedWorker } from "./production-ergo";

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
