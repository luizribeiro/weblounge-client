import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
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
  }) => {
    const suffix = Date.now().toString(36).slice(-6);
    const nick = `${"W".repeat(25)}-${suffix}`;
    const bot = await IrcClient.connect(
      nick,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("button", { name: "#weblounge-test" }),
      ).toBeVisible();
      const row = page.locator(`[data-buffer-id][aria-label^="${nick},"]`);

      bot.privmsg("weblounge", "message 1");
      await expectCentredBadge(row, "1");
      for (let count = 2; count <= 10; count += 1)
        bot.privmsg("weblounge", `message ${count}`);
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
    } finally {
      bot.close();
    }
  });

  test("moves the most recently active chat to the top", async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-6);
    const channel = `#recent-${suffix}`;
    const nick = `recent-${suffix}`;
    let bot: IrcClient | undefined;
    try {
      await page.goto("/?irc-password=weblounge-test");
      await page.getByRole("button", { name: "#weblounge-test" }).click();
      const composer = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });
      await composer.fill(`/join ${channel}`);
      await composer.press("Enter");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      bot = await IrcClient.connect(
        nick,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      );
      await page.getByRole("button", { name: "Back to chats" }).click();
      bot.privmsg("weblounge", "direct activity first");
      await expect(page.getByText("direct activity first")).toBeVisible();
      await expectChatOrder(page.locator("[data-buffer-id]"), [nick, channel]);

      bot.privmsg(channel, "channel activity second");
      await expect(
        page.getByText("channel activity second", { exact: true }),
      ).toBeVisible();
      await expectChatOrder(page.locator("[data-buffer-id]"), [channel, nick]);
    } finally {
      bot?.close();
    }
  });

  test("uses the newest visible message after reaction-only TARGETS activity", async ({
    context,
    page,
  }) => {
    await useDedicatedWorker(page);
    await setAppAlwaysOn(true);
    const suffix = Date.now().toString(36).slice(-6);
    const bot = await IrcClient.connect(
      `reaction-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const text = `before reaction ${suffix}`;
    let current = page;
    try {
      await current.goto("/?irc-password=weblounge-test");
      await expect(
        current.getByRole("button", { name: "#weblounge-test" }),
      ).toBeVisible();
      const echoed = await bot.privmsgConfirmed("weblounge", text);
      let row = directRow(current, bot.nickname);
      await expect(row).toContainText(text);
      await bot.reactionConfirmed("weblounge", messageId(echoed), "thumbsup");

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await current.goto("/?irc-password=weblounge-test");
      row = directRow(current, bot.nickname);
      await expect(row).toContainText(text);
      await row.click();
      await expect(messageRow(current, text)).toBeVisible();
      await current.getByRole("button", { name: "Back to chats" }).click();

      await expect(row.locator("time")).toHaveAttribute(
        "datetime",
        serverTime(echoed),
      );
    } finally {
      if (!current.isClosed()) await current.close();
      bot.close();
      await setAppAlwaysOn(false);
    }
  });
});

function directRow(page: Page, nick: string) {
  return page.locator(`[data-buffer-id][aria-label^="${nick}"]`);
}

function messageRow(page: Page, text: string) {
  return page.locator("[data-message-row]", { hasText: text });
}

function messageId(line: string): string {
  const value = /(?:^@|;)msgid=([^; ]+)/u.exec(line)?.[1];
  if (value === undefined) throw new Error(`IRC line has no msgid: ${line}`);
  return value;
}

function serverTime(line: string): string {
  const value = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
  if (value === undefined)
    throw new Error(`IRC line has no server time: ${line}`);
  return new Date(value).toISOString();
}

async function setAppAlwaysOn(enabled: boolean): Promise<void> {
  const control = await IrcClient.connect(
    "weblounge",
    "weblounge",
    "weblounge-test",
    "#weblounge-test",
  );
  try {
    if (control.nickname !== "weblounge") {
      await control.waitForNickDeparture("weblounge");
      await control.nick("weblounge");
    }
    await control.setAlwaysOn(enabled);
  } finally {
    control.close();
  }
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
