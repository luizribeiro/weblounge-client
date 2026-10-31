import { randomUUID } from "node:crypto";
import { devices, expect, type Locator, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

test("opens a mobile channel at the live edge and respects a user scroll away", async ({
  baseURL,
  browser,
}) => {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const channel = `#opening-${suffix}`;
  const owner = await IrcClient.connect(
    `opening-own-${suffix}`,
    "weblounge",
    "weblounge-test",
    channel,
  );
  const bots = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      IrcClient.connect(
        `open-bot-${index}-${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      ),
    ),
  );
  const context = await browser.newContext({
    ...devices["iPhone 16 Pro"],
    baseURL,
  });
  const page = await context.newPage();
  const newest = `newest opening message ${suffix}`;
  try {
    for (let index = 0; index < 20; index += bots.length)
      await Promise.all(
        bots.map((bot, offset) =>
          bot.privmsgConfirmed(
            channel,
            `opening backlog ${suffix} ${index + offset} ${"long wrapping history ".repeat(10)}`,
          ),
        ),
      );
    const bot = bots[0];
    if (bot === undefined) throw new Error("no history sender");

    await useDedicatedWorker(page);
    await page.goto("/?irc-password=weblounge-test");
    const row = page.locator("[data-buffer-id]").filter({ hasText: channel });
    await expect(row).toBeVisible();
    const unreadBeforeLive = await unreadCount(row);
    for (let index = 20; index < 110; index += bots.length)
      await Promise.all(
        bots.map((sender, offset) =>
          sender.privmsgConfirmed(
            channel,
            `opening backlog ${suffix} ${index + offset} ${"long wrapping history ".repeat(10)}`,
          ),
        ),
      );
    await bot.privmsgConfirmed(channel, newest);
    await expect.poll(() => unreadCount(row)).toBe(unreadBeforeLive + 91);
    await row.click();

    const list = page.locator("[data-message-list]");
    await expect(list).toBeVisible();
    await expect(page.getByText(newest, { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight / element.clientHeight),
      )
      .toBeGreaterThan(4);
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);

    await list.press("Home");
    await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(100);
    await bot.privmsgConfirmed(channel, `later live message ${suffix}`);
    await expect(
      page.getByRole("button", { name: /1 new message/ }),
    ).toBeVisible();
    await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(100);
  } finally {
    await context.close();
    for (const bot of bots) bot.close();
    await owner.part(channel);
    owner.close();
  }
});

async function unreadCount(row: Locator): Promise<number> {
  const label =
    (await row.getByRole("status").getAttribute("aria-label")) ?? "0";
  return Number.parseInt(label, 10);
}

function distanceFromBottom(list: Locator): Promise<number> {
  return list.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}
