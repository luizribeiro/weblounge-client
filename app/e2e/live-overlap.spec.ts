import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { firstLongMessage, secondLongMessage } from "./timeline-fixtures";
import {
  framesPerSecond,
  messageRow,
  timelineOverlapsOverFrames,
} from "./timeline-geometry";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo",
);

test("keeps long live messages apart when the read boundary passes one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?irc-password=weblounge-test");
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  const channel = `#overlap-${Date.now()}`;
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  const bot = await IrcClient.connect(
    "overlap-bot",
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const list = page.locator("[data-message-list]");
  const active = page.locator('[data-buffer-id][aria-current="page"]');
  try {
    for (let index = 0; index < 30; index += 1)
      await bot.privmsgConfirmed(channel, `earlier chatter ${index}`);
    await expect(page.getByText("earlier chatter 29")).toBeVisible();
    await list.press("End");
    await expect(active).toHaveAttribute("data-unread", "0");

    await scrollAwayFromLiveEdge(page, list, {
      distance: 3,
      wheelDelta: 40,
    });
    await bot.privmsgConfirmed(channel, firstLongMessage);
    await expect(messageRow(page, firstLongMessage)).toBeVisible();
    await expect(page.getByText("New", { exact: true })).toBeVisible();

    await list.press("End");
    await expect(active).toHaveAttribute("data-unread", "0");
    await scrollAwayFromLiveEdge(page, list, {
      distance: 3,
      wheelDelta: 40,
    });
    await bot.privmsgConfirmed(channel, secondLongMessage);

    await expect(
      page.getByRole("button", { name: /new message/ }),
    ).toBeVisible();
    await expect(messageRow(page, secondLongMessage)).toBeAttached();
    await expectNewDividerBetween(page, firstLongMessage, secondLongMessage);
    expect(await timelineOverlapsOverFrames(list, framesPerSecond)).toEqual([]);
  } finally {
    bot.close();
  }
});

async function expectNewDividerBetween(
  page: Page,
  before: string,
  after: string,
): Promise<void> {
  const index = (locator: Locator) =>
    locator.evaluate((element) => Number(element.closest("li")?.dataset.index));
  const divider = await index(page.locator("[data-new-line]"));
  expect(divider).toBe((await index(messageRow(page, before))) + 1);
  expect(divider).toBe((await index(messageRow(page, after))) - 1);
}
