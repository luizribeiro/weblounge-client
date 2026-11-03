import { expect, type Locator, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

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
});

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
