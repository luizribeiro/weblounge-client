import type { Locator, Page } from "@playwright/test";
import { IrcClient, messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { useDedicatedWorker } from "./production-ergo";

test.use({
  colorScheme: "light",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 402, height: 874 },
});

test.describe("mobile chat list against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("centres unread badges on preview and compact rows", async ({
    page,
    irc,
  }) => {
    const bot = await irc.peer("W".repeat(23));
    const nick = bot.nickname;
    await page.goto(irc.url());
    await expect(page.getByRole("button", { name: irc.channel })).toBeVisible();
    const row = page.locator(`[data-buffer-id][aria-label^="${nick},"]`);

    bot.privmsg(irc.account, "message 1");
    await expectCentredBadge(row, "1");
    for (let count = 2; count <= 10; count += 1)
      bot.privmsg(irc.account, `message ${count}`);
    await expectCentredBadge(row, "10");
    await setThreeDigitBadge(row);
    await expectCentredBadge(row, "123");

    const title = row.getByText(nick, { exact: true });
    await expect(title).toBeVisible();
    expect(
      await title.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await expect(row.getByText("message 10", { exact: true })).toBeVisible();
    await expectCentredBadge(row, "123");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectCentredBadge(row, "123");

    await page.evaluate(() => {
      document.documentElement.dataset.mobileDensity = "compact";
    });
    const search = page.getByRole("searchbox", { name: "Search chats" });
    await search.fill("no matching chat");
    await expect(row).toHaveCount(0);
    await search.fill("");
    await expect(row.getByText("message 10", { exact: true })).toHaveCount(0);
    await setThreeDigitBadge(row);
    await expectCentredBadge(row, "123");
    await page.emulateMedia({ colorScheme: "light" });
    await expectCentredBadge(row, "123");
  });

  test("moves the most recently active chat to the top", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("recent");
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    const bot = await irc.peer("recent", [channel]);
    const nick = bot.nickname;
    await page.getByRole("button", { name: "Back to chats" }).click();
    bot.privmsg(irc.account, "direct activity first");
    await expect(page.getByText("direct activity first")).toBeVisible();
    await expectChatOrder(page.locator("[data-buffer-id]"), [nick, channel]);

    bot.privmsg(channel, "channel activity second");
    await expect(
      page.getByText("channel activity second", { exact: true }),
    ).toBeVisible();
    await expectChatOrder(page.locator("[data-buffer-id]"), [channel, nick]);
  });

  test("uses the newest visible message after reaction-only TARGETS activity", async ({
    context,
    page,
    irc,
  }) => {
    await useDedicatedWorker(page);
    await enableAppAlwaysOn(irc);
    const bot = await irc.peer("reaction");
    const text = "before reaction";
    let current = page;
    try {
      await current.goto(irc.url());
      await expect(
        current.getByRole("button", { name: irc.channel }),
      ).toBeVisible();
      const echoed = await bot.privmsgConfirmed(irc.account, text);
      let row = directRow(current, bot.nickname);
      await expect(row).toContainText(text);
      await bot.reactionConfirmed(irc.account, messageId(echoed), "thumbsup");

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await current.goto(irc.url());
      row = directRow(current, bot.nickname);
      await expect(row).toContainText(text);
      await row.click();
      await expect(messageRow(current, text)).toBeVisible();
      await current.getByRole("button", { name: "Back to chats" }).click();

      await expect(row.locator("time")).toHaveAttribute(
        "datetime",
        new Date(serverTime(echoed)).toISOString(),
      );
    } finally {
      if (!current.isClosed()) await current.close();
    }
  });
});

function directRow(page: Page, nick: string) {
  return page.locator(`[data-buffer-id][aria-label^="${nick}"]`);
}

function messageRow(page: Page, text: string) {
  return page.locator("[data-message-row]", { hasText: text });
}

async function enableAppAlwaysOn(irc: IrcTestAccount): Promise<void> {
  const control = await IrcClient.connectWithoutJoin(
    irc.account,
    irc.account,
    irc.password,
  );
  await control.setAlwaysOn(true);
  control.close();
  await control.waitForDisconnect();
}

async function expectChatOrder(
  rows: Locator,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(async () =>
      rows.evaluateAll(
        (elements, titles) =>
          elements.flatMap((element) => {
            const label = element.getAttribute("aria-label") ?? "";
            const title = titles.find(
              (candidate) =>
                label === candidate || label.startsWith(`${candidate},`),
            );
            return title === undefined ? [] : [title];
          }),
        expected,
      ),
    )
    .toEqual(expected);
}

async function setThreeDigitBadge(row: Locator): Promise<void> {
  await row.locator("[data-badge-kind]").evaluate((badge) => {
    badge.textContent = "123";
  });
}

async function expectCentredBadge(row: Locator, count: string): Promise<void> {
  const badge = row.locator('[data-badge-kind="mention"]');
  await expect(badge).toHaveText(count);
  const centres = await row.evaluate((element) => {
    const badge = element.querySelector<HTMLElement>("[data-badge-kind]");
    if (badge === null) throw new Error("unread badge is missing");
    const rowRect = element.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    return {
      badge: badgeRect.top + badgeRect.height / 2,
      row: rowRect.top + rowRect.height / 2,
    };
  });
  expect(Math.abs(centres.badge - centres.row)).toBeLessThanOrEqual(0.5);
}
