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

  test("keeps a mark-read failure in diagnostics instead of a toast", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.assign(window, { markReadFailureInjected: false });
      const postMessage = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (...arguments_) {
        const result = Reflect.apply(postMessage, this, arguments_);
        const message = arguments_[0];
        const state = window as Window & { markReadFailureInjected: boolean };
        if (
          !state.markReadFailureInjected &&
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "request" &&
          "payload" in message &&
          typeof message.payload === "object" &&
          message.payload !== null &&
          "request" in message.payload &&
          typeof message.payload.request === "object" &&
          message.payload.request !== null &&
          "type" in message.payload.request &&
          message.payload.request.type === "mark_read"
        ) {
          state.markReadFailureInjected = true;
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  type: "diagnostic",
                  command_id: "mark-read",
                  message: "engine.mark_read_failed",
                },
              }),
            );
          });
        }
        return result;
      };
    });
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    const bot = await IrcClient.connect(
      `marker-failure-${Date.now().toString(36).slice(-6)}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      const text = `diagnostic marker ${Date.now()}`;
      await bot.privmsgConfirmed("#weblounge-test", text);
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { markReadFailureInjected: boolean })
                .markReadFailureInjected,
          ),
        )
        .toBe(true);
      await expect(page.getByRole("note")).toHaveCount(0);

      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("/debug");
      await composer.press("Enter");
      await expect(page.locator("[data-debug-overlay]")).toContainText(
        "engine: Couldn't mark this conversation as read.",
      );
    } finally {
      bot.close();
    }
  });

  test("does not flash New for an arrival at the focused live edge", async ({
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
      await page.locator("[data-message-list]").evaluate((list) => {
        Object.assign(window, {
          unreadCountAppeared: false,
          unreadDividerAppeared: false,
        });
        new MutationObserver(() => {
          if (list.querySelector("[data-new-line]") !== null)
            Object.assign(window, { unreadDividerAppeared: true });
        }).observe(list, { childList: true, subtree: true });
        new MutationObserver(() => {
          const active = document.querySelector(
            '[data-buffer-id][aria-current="page"]',
          );
          if (Number(active?.getAttribute("data-unread")) > 0)
            Object.assign(window, { unreadCountAppeared: true });
        }).observe(document.body, {
          attributeFilter: ["data-unread"],
          childList: true,
          subtree: true,
        });
      });

      await bot.privmsgConfirmed(channel, text);
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { unreadCountAppeared?: boolean })
                .unreadCountAppeared,
          ),
        )
        .toBe(true);
      await expect(active).toHaveAttribute("data-unread", "0");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { unreadDividerAppeared?: boolean })
                .unreadDividerAppeared,
          ),
        )
        .toBe(false);
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
      await expect
        .poll(async () => Number(await active.getAttribute("data-unread")))
        .toBeGreaterThan(0);

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
