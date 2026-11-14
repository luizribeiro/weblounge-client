import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { productionMessageRow } from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("a second tab sharing the engine shows the rows the first tab loaded", async ({
  context,
  irc,
}) => {
  const channel = irc.channel;
  const bot = await irc.peer("shared-tabs");
  const history = `before both tabs ${Date.now()}`;
  await bot.privmsgConfirmed(channel, history);
  const first = await context.newPage();
  await first.goto(irc.url());
  await expectAtLiveEdge(first, history);

  const live = `after the first tab ${Date.now()}`;
  await bot.privmsgConfirmed(channel, live);
  await expectAtLiveEdge(first, live);

  const second = await context.newPage();
  await second.goto(irc.url());
  await expectAtLiveEdge(second, live);
  await expect(productionMessageRow(second, history)).toHaveCount(1);
});

async function expectAtLiveEdge(page: Page, text: string): Promise<void> {
  const row = productionMessageRow(page, text);
  await expect
    .poll(async () => {
      await page.locator("[data-message-list]").press("End");
      return row.count();
    })
    .toBe(1);
}
