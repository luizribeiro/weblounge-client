import { expect, test } from "./irc-fixture";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { expectSettled } from "./settled";

test.describe("IRCv3 read markers", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("reading in one browser context clears the other", async ({
    baseURL,
    browser,
    irc,
  }) => {
    const firstContext = await browser.newContext({ baseURL });
    const secondContext = await browser.newContext({ baseURL });
    await irc.scope(firstContext);
    await irc.scope(secondContext);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const bot = await irc.peer("marker-bot");
    try {
      await Promise.all([first.goto(irc.url()), second.goto(irc.url())]);
      await Promise.all([
        first.getByRole("button", { name: irc.channel }).click(),
        second.getByRole("button", { name: irc.channel }).click(),
      ]);
      await Promise.all([
        expectSettled(first, { conversation: irc.channel }),
        expectSettled(second, { conversation: irc.channel }),
      ]);

      const firstBuffer = first.locator(
        '[data-buffer-id][aria-current="page"]',
      );
      const secondBuffer = second.locator(
        '[data-buffer-id][aria-current="page"]',
      );
      await expect(firstBuffer).toHaveAttribute("data-unread", "0");
      await expect(secondBuffer).toHaveAttribute("data-unread", "0");

      const seed = "read marker scroll seed";
      for (let index = 0; index < 30; index += 1) {
        await bot.privmsgConfirmed(
          irc.channel,
          `${seed} ${index} ${"wrapped line ".repeat(8)}`,
        );
      }
      const firstList = first.locator("[data-message-list]");
      const secondList = second.locator("[data-message-list]");
      await expect.poll(() => scrollRange(firstList)).toBeGreaterThan(100);
      await expect.poll(() => scrollRange(secondList)).toBeGreaterThan(100);
      await scrollAwayFromLiveEdge(first, firstList);
      await scrollAwayFromLiveEdge(second, secondList);

      const mention = `${irc.account} cross-device marker`;
      await bot.privmsgConfirmed(irc.channel, mention);
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
      await firstContext.close();
      await secondContext.close();
    }
  });

  test("keeps the open conversation count suppressed at the focused live edge", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("active");
    const text = "focused arrival";
    await page.goto(irc.url());
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const bot = await irc.peer("active", [channel]);
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
    const ownText = "settled focused arrival";
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
  });

  test("an own action from another device advances the unread boundary", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("own");
    await page.goto(irc.url());
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const peer = await irc.peer("peer", [channel]);
    const ownDevice = await irc.self([channel]);
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

    const unread = "unread before own action";
    await peer.privmsgConfirmed(channel, unread);
    await expect(active).toHaveAttribute("data-unread", "0");
    await expect(
      page.getByRole("button", { name: /new message/ }),
    ).toBeVisible();

    const action = "marks this read";
    await ownDevice.actionConfirmed(channel, action);
    await expect(active).toHaveAttribute("data-unread", "0");
    await list.press("End");
    await expect(
      page.locator("[data-message-row]").filter({ hasText: action }),
    ).toBeVisible();
    await expect(page.getByText("New", { exact: true })).toHaveCount(0);
  });
});

async function scrollRange(
  list: import("@playwright/test").Locator,
): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
}
