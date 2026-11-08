import { expect, type Locator, type Page, test } from "@playwright/test";
import { captureHistoryWire } from "./history-wire-fixture";
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
  await captureHistoryWire(page);
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
    await expect.poll(() => projectedUnread(page, channel)).toBeGreaterThan(0);

    await list.press("End");
    await expect.poll(() => projectedUnread(page, channel)).toBe(0);
    await scrollAwayFromLiveEdge(page, list, {
      distance: 3,
      wheelDelta: 40,
    });
    await bot.privmsgConfirmed(channel, secondLongMessage);

    await expect(
      page.getByRole("button", { name: /new message/ }),
    ).toBeVisible();
    await expect(messageRow(page, secondLongMessage)).toBeAttached();
    await expectNewDividerBefore(page, firstLongMessage);
    expect(await timelineOverlapsOverFrames(list, framesPerSecond)).toEqual([]);
  } finally {
    bot.close();
  }
});

async function expectNewDividerBefore(
  page: Page,
  message: string,
): Promise<void> {
  const index = (locator: Locator) =>
    locator.evaluate((element) => Number(element.closest("li")?.dataset.index));
  const divider = await index(page.locator("[data-new-line]"));
  expect(divider).toBe((await index(messageRow(page, message))) - 1);
}

function projectedUnread(
  page: Page,
  title: string,
): Promise<number | undefined> {
  return page.evaluate((title) => {
    const events = Reflect.get(globalThis, "historyProjectionTimeline");
    if (!Array.isArray(events)) return undefined;
    const entry = events.findLast(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "event" in entry &&
        typeof entry.event === "object" &&
        entry.event !== null &&
        "buffer" in entry.event &&
        typeof entry.event.buffer === "object" &&
        entry.event.buffer !== null &&
        Reflect.get(entry.event.buffer, "title") === title,
    );
    if (typeof entry !== "object" || entry === null) return undefined;
    const event = Reflect.get(entry, "event");
    if (typeof event !== "object" || event === null) return undefined;
    const buffer = Reflect.get(event, "buffer");
    if (typeof buffer !== "object" || buffer === null) return undefined;
    const unread = Reflect.get(buffer, "unread");
    return typeof unread === "number" ? unread : undefined;
  }, title);
}
