import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

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
      await firstList.evaluate(scrollToStart);
      await secondList.evaluate(scrollToStart);

      const mention = `weblounge cross-device marker ${Date.now()}`;
      await bot.privmsgConfirmed("#weblounge-test", mention);
      await expect
        .poll(async () =>
          Number(await firstBuffer.getAttribute("data-mentions")),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(async () =>
          Number(await secondBuffer.getAttribute("data-mentions")),
        )
        .toBeGreaterThan(0);

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
});

async function scrollRange(
  list: import("@playwright/test").Locator,
): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
}

function scrollToStart(element: HTMLElement): void {
  element.scrollTop = 0;
  element.dispatchEvent(new Event("scroll"));
}
