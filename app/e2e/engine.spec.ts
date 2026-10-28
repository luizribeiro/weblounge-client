import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const ready = "Engine ready: wasm worker round trip complete";

test("handshakes through the SharedWorker", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(ready);
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => typeof SharedWorker))
    .toBe("function");
});

test("handshakes through the dedicated Worker fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(ready);
  await expect(page.getByRole("note")).toContainText("one connection per tab");
  await expect
    .poll(() => page.evaluate(() => typeof SharedWorker))
    .toBe("undefined");
});

test.describe("local Ergo user flow", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("sends, receives, and counts a mention", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(page).toHaveURL(/^(?!.*irc-password)/);
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();

    const ownText = `from browser ${Date.now()}`;
    await observeDeliveries(page, ownText);
    await page.getByRole("textbox", { name: "Message" }).fill(ownText);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(ownText, { exact: true })).toBeVisible();
    await expect
      .poll(() => observedDeliveries(page))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));

    const bot = await IrcClient.connect(
      "weblounge-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      bot.privmsg("#weblounge-test", "hello from the test bot");
      await expect(
        page.getByText("hello from the test bot", { exact: true }),
      ).toBeVisible();
      bot.privmsg("#weblounge-test", "hello weblounge, this is a mention");
      const activeChannel = page.locator(
        '[data-buffer-id][aria-current="page"]',
      );
      await expect(activeChannel).toHaveAttribute("data-mentions", "1");
      await expect(activeChannel).toHaveAccessibleName("#weblounge-test");
    } finally {
      bot.close();
    }
  });

  test("shows existing channel history in a fresh browser", async ({
    page,
  }) => {
    const seed = await IrcClient.connect(
      "history-seed",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const text = `existing history ${Date.now()}`;
    try {
      await seed.privmsgConfirmed("#weblounge-test", text);
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    } finally {
      seed.close();
    }
  });

  test("anchors live messages and preserves the away boundary", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    const bot = await IrcClient.connect(
      "timeline-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const list = page.locator("[data-message-list]");
    const active = page.locator('[data-buffer-id][aria-current="page"]');
    try {
      for (let index = 0; index < 40; index += 1) {
        await bot.privmsgConfirmed("#weblounge-test", `timeline seed ${index}`);
      }
      await expect(
        page.getByText("timeline seed 39", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => distanceFromBottom(list), { timeout: 15_000 })
        .toBeLessThanOrEqual(3);
      await expect(active).toHaveAttribute("data-unread", "0", {
        timeout: 3_000,
      });

      await list.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(100);
      const away = `while away ${Date.now()}`;
      await bot.privmsgConfirmed("#weblounge-test", away);
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toBeVisible();
      await expect
        .poll(async () => Number(await active.getAttribute("data-unread")))
        .toBeGreaterThan(0);

      await page.keyboard.press("End");
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toHaveCount(0);
      await expect(page.getByText(away, { exact: true })).toBeVisible();
      await expect(page.getByText("New", { exact: true })).toBeVisible();
      await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);
      await expect(active).toHaveAttribute("data-unread", "0", {
        timeout: 3_000,
      });
    } finally {
      bot.close();
    }
  });

  test("broadcasts pending and confirmed sends to a second tab", async ({
    context,
    page: secondTab,
  }) => {
    await secondTab.goto("/");
    await expect(secondTab.getByRole("status")).toHaveText(ready);
    const firstTab = await context.newPage();
    await firstTab.goto("/?irc-password=weblounge-test");
    await expect(
      firstTab.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    await expect(
      secondTab.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();

    const text = `shared send ${Date.now()}`;
    await observeDeliveries(secondTab, text);
    await firstTab.getByRole("textbox", { name: "Message" }).fill(text);
    await firstTab.getByRole("button", { name: "Send" }).click();
    await expect(secondTab.getByText(text, { exact: true })).toBeVisible();

    await expect
      .poll(() => observedDeliveries(secondTab))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));

    const bot = await IrcClient.connect(
      "read-sync-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await secondTab.locator("[data-message-list]").evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await firstTab.bringToFront();
      await firstTab.keyboard.press("End");
      bot.privmsg("#weblounge-test", `read sync ${Date.now()}`);
      const secondActive = secondTab.locator(
        '[data-buffer-id][aria-current="page"]',
      );
      await expect
        .poll(async () =>
          Number(await secondActive.getAttribute("data-unread")),
        )
        .toBeGreaterThan(0);
      await expect(secondActive).toHaveAttribute("data-unread", "0", {
        timeout: 3_000,
      });
    } finally {
      bot.close();
    }
  });
});

async function observeDeliveries(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  await page.evaluate((messageText) => {
    const state = window as Window & { observedDeliveries?: string[] };
    state.observedDeliveries = [];
    const record = () => {
      for (const row of document.querySelectorAll<HTMLElement>(
        `[data-message-text="${CSS.escape(messageText)}"]`,
      )) {
        const delivery = row.dataset.delivery;
        if (
          delivery !== undefined &&
          !state.observedDeliveries?.includes(delivery)
        ) {
          state.observedDeliveries?.push(delivery);
        }
      }
    };
    new MutationObserver(record).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    record();
  }, text);
}

async function observedDeliveries(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as Window & { observedDeliveries?: string[] })
        .observedDeliveries ?? [],
  );
}

async function distanceFromBottom(
  list: import("@playwright/test").Locator,
): Promise<number> {
  return list.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}
