import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";

test.describe("IRCv3 read markers", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("reading in one browser context clears the other", async ({
    baseURL,
    browser,
  }) => {
    const firstContext = await browser.newContext({ baseURL });
    const secondContext = await browser.newContext({ baseURL });
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const bot = await IrcClient.connect(
      `marker-bot-${Date.now().toString().slice(-6)}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await Promise.all([
        first.goto("/?irc-password=weblounge-test"),
        second.goto("/?irc-password=weblounge-test"),
      ]);
      await Promise.all([
        first.getByRole("button", { name: /^#weblounge-test(?:,|$)/u }).click(),
        second
          .getByRole("button", { name: /^#weblounge-test(?:,|$)/u })
          .click(),
      ]);
      await Promise.all([
        expect(
          first.getByRole("heading", { name: /#weblounge-test/ }),
        ).toBeVisible(),
        expect(
          second.getByRole("heading", { name: /#weblounge-test/ }),
        ).toBeVisible(),
      ]);

      const firstBuffer = first.locator(
        '[data-buffer-id][aria-current="page"]',
      );
      const secondBuffer = second.locator(
        '[data-buffer-id][aria-current="page"]',
      );
      await expect(firstBuffer).toHaveAttribute("data-unread", "0");
      await expect(secondBuffer).toHaveAttribute("data-unread", "0");

      const seed = `read marker scroll seed ${Date.now()}`;
      for (let index = 0; index < 30; index += 1) {
        await bot.privmsgConfirmed(
          "#weblounge-test",
          `${seed} ${index} ${"wrapped line ".repeat(8)}`,
        );
      }
      const firstList = first.locator("[data-message-list]");
      const secondList = second.locator("[data-message-list]");
      await expect.poll(() => scrollRange(firstList)).toBeGreaterThan(100);
      await expect.poll(() => scrollRange(secondList)).toBeGreaterThan(100);
      await scrollAwayFromLiveEdge(first, firstList);
      await scrollAwayFromLiveEdge(second, secondList);

      const mention = `weblounge cross-device marker ${Date.now()}`;
      await bot.privmsgConfirmed("#weblounge-test", mention);
      await expect(firstBuffer).toHaveAttribute("data-mentions", "0");
      await expect(secondBuffer).toHaveAttribute("data-mentions", "0");
      await expect(
        first.getByRole("button", { name: /new message/ }),
      ).toBeVisible();
      await expect(
        second.getByRole("button", { name: /new message/ }),
      ).toBeVisible();

      await first.bringToFront();
      await firstList.press("End");
      await expect(firstBuffer).toHaveAttribute("data-unread", "0");
      await expect(secondBuffer).toHaveAttribute("data-unread", "0");
      await expect(secondBuffer).toHaveAttribute("data-mentions", "0");
    } finally {
      bot.close();
      await firstContext.close();
      await secondContext.close();
    }
  });

  test("keeps the open conversation count suppressed at the focused live edge", async ({
    page,
  }) => {
    const channel = `#active-${Date.now().toString(36)}`;
    const text = `focused arrival ${Date.now()}`;
    await page.goto("/?irc-password=weblounge-test");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const bot = await IrcClient.connect(
      `active-${Date.now().toString(36).slice(-6)}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    try {
      const active = page.locator('[data-buffer-id][aria-current="page"]');
      await expect(active).toHaveAttribute("data-unread", "0");
      await page.locator("[data-message-list]").evaluate(() => {
        Object.assign(window, { openConversationCountAppeared: false });
        new MutationObserver(() => {
          const active = document.querySelector(
            '[data-buffer-id][aria-current="page"]',
          );
          if (Number(active?.getAttribute("data-unread")) > 0)
            Object.assign(window, { openConversationCountAppeared: true });
        }).observe(document.body, {
          attributeFilter: ["data-unread"],
          childList: true,
          subtree: true,
        });
      });

      await bot.privmsgConfirmed(channel, text);
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      const ownText = `settled focused arrival ${Date.now()}`;
      await composer.fill(ownText);
      await composer.press("Enter");
      await expect(page.getByText(ownText, { exact: true })).toBeVisible();
      await expect(active).toHaveAttribute("data-unread", "0");
      expect(
        await page.evaluate(
          () =>
            (
              window as Window & {
                openConversationCountAppeared?: boolean;
              }
            ).openConversationCountAppeared,
        ),
      ).toBe(false);
    } finally {
      bot.close();
    }
  });

  test("an own action from another device advances the unread boundary", async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#own-${suffix}`;
    await page.goto("/?irc-password=weblounge-test");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const peer = await IrcClient.connect(
      `peer-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const ownDevice = await IrcClient.connect(
      `own-${suffix}`,
      "weblounge",
      "weblounge-test",
      channel,
    );
    try {
      const list = page.locator("[data-message-list]");
      const active = page.locator('[data-buffer-id][aria-current="page"]');
      for (let index = 0; index < 30; index += 1)
        await peer.privmsgConfirmed(
          channel,
          `own marker seed ${index} ${"wrapped line ".repeat(8)}`,
        );
      await expect.poll(() => scrollRange(list)).toBeGreaterThan(100);
      await expect(active).toHaveAttribute("data-unread", "0");
      await scrollAwayFromLiveEdge(page, list);

      const unread = `unread before own action ${suffix}`;
      await peer.privmsgConfirmed(channel, unread);
      await expect(active).toHaveAttribute("data-unread", "0");
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toBeVisible();

      const action = `marks this read ${suffix}`;
      await ownDevice.actionConfirmed(channel, action);
      await expect(active).toHaveAttribute("data-unread", "0");
      await list.press("End");
      await expect(
        page.locator("[data-message-row]").filter({ hasText: action }),
      ).toBeVisible();
      await expect(page.getByText("New", { exact: true })).toHaveCount(0);
    } finally {
      peer.close();
      ownDevice.close();
    }
  });
});

async function scrollRange(
  list: import("@playwright/test").Locator,
): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
}
