import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { productionMessageRow } from "./production-ergo";

const channel = "#weblounge-test";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("a second tab sharing the engine shows the rows the first tab loaded", async ({
  context,
}) => {
  const bot = await IrcClient.connect(
    `shared-tabs-${Date.now().toString().slice(-6)}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  try {
    const history = `before both tabs ${Date.now()}`;
    await bot.privmsgConfirmed(channel, history);
    const first = await context.newPage();
    await first.goto("/?irc-password=weblounge-test");
    await expectAtLiveEdge(first, history);

    const live = `after the first tab ${Date.now()}`;
    await bot.privmsgConfirmed(channel, live);
    await expectAtLiveEdge(first, live);

    const second = await context.newPage();
    await second.goto("/?irc-password=weblounge-test");
    await expectAtLiveEdge(second, live);
    await expect(productionMessageRow(second, history)).toHaveCount(1);
  } finally {
    bot.close();
  }
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
