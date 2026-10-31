import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  distanceFromBottom,
  scrollAwayFromLiveEdge,
} from "./message-list-scroll";

const ready = "Engine ready: wasm worker round trip complete";
const fixtureChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

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

  test("keeps an ordinary incoming DM row unhighlighted", async ({ page }) => {
    const bot = await IrcClient.connect(
      "plain-dm",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const text = `ordinary direct message ${Date.now()}`;
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: /#weblounge-test/u }),
      ).toBeVisible();
      bot.privmsg("weblounge", text);
      const direct = page.getByRole("button", {
        name: /^plain-dm, 1 mentions$/u,
      });
      await expect(direct).toBeVisible();
      await direct.click();
      const colors = await page
        .getByText(text, { exact: true })
        .evaluate((node) => {
          const row = node.closest<HTMLElement>("[data-message-row]");
          if (row === null) throw new Error("direct-message row is missing");
          const highlight = document.createElement("span");
          highlight.style.background = "var(--wl-color-mention-bg)";
          document.body.append(highlight);
          const expected = getComputedStyle(highlight).backgroundColor;
          highlight.remove();
          return { expected, row: getComputedStyle(row).backgroundColor };
        });

      expect(colors.row).not.toBe(colors.expected);
    } finally {
      bot.close();
    }
  });

  test("keeps our operator prefix through send confirmation", async ({
    page,
  }) => {
    const operator = await IrcClient.connect(
      `operator${Date.now().toString().slice(-6)}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: /#weblounge-test/ }),
      ).toBeVisible();
      await operator.mode("#weblounge-test", "+o", "weblounge");
      await page.getByRole("button", { name: "Toggle member list" }).click();
      await expect(
        page.getByRole("button", {
          name: "Open direct message with weblounge",
        }),
      ).toContainText("@");

      const text = `operator send ${Date.now()}`;
      await observeDeliveries(page, text);
      await page.getByRole("textbox", { name: "Message" }).fill(text);
      await page.getByRole("button", { name: "Send" }).click();
      await expect
        .poll(() => observedDeliveryModes(page))
        .toEqual(expect.arrayContaining(["optimistic:@", "confirmed:@"]));
    } finally {
      operator.close();
    }
  });

  test("preserves a long single-line message when confirmed", async ({
    page,
  }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    const text = `${"deployment update crossed every regional queue without changing the submitted text. ".repeat(8)}${Date.now()}`;
    expect(text.length).toBeGreaterThan(512);

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(text);
    await composer.press("Enter");
    const confirmed = page
      .locator('[data-message-row][data-delivery="confirmed"]')
      .filter({ has: page.getByText(text, { exact: true }) });
    await expect(confirmed).toHaveCount(1);
    await expect(confirmed).toHaveAttribute("data-message-text", text);
    expect(text).not.toContain("\n");
  });

  test("measures received history and live wrapped messages", async ({
    page,
  }) => {
    const prose = `wrapped dogfood ${"several words need a real measured row ".repeat(10)}${Date.now()}`;
    const url = `https://example.com/${"unbroken-segment".repeat(20)}?${Date.now()}`;
    const live = `live wrapped dogfood ${"incoming words must resize their row ".repeat(10)}${Date.now()}`;
    expect(prose.length).toBeGreaterThan(350);
    const bot = await IrcClient.connect(
      "wrapped-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await bot.privmsgConfirmed("#weblounge-test", prose);
      await bot.privmsgConfirmed("#weblounge-test", url);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: /#weblounge-test/ }),
      ).toBeVisible();
      await expect(
        page.locator("[data-message-row]").filter({ hasText: prose }),
      ).toBeVisible();
      await expect(
        page.locator("[data-message-row]").filter({ hasText: url }),
      ).toBeVisible();
      await expectMeasuredTimeline(page);

      await bot.privmsgConfirmed("#weblounge-test", live);
      await expect(
        page.locator("[data-message-row]").filter({ hasText: live }),
      ).toBeVisible();
      await expectMeasuredTimeline(page);

      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: /#weblounge-test/ }),
      ).toBeVisible();
      await expect(
        page.locator("[data-message-row]").filter({ hasText: live }),
      ).toBeVisible();
      await expectMeasuredTimeline(page);
      await page.setViewportSize({ width: 800, height: 900 });
      await expectMeasuredTimeline(page);

      await page.setViewportSize({ width: 402, height: 874 });
      await expect(page.locator("[data-desktop-shell]")).toBeVisible();
      await expectMeasuredTimeline(page);
    } finally {
      bot.close();
    }
  });

  test("confirms typed quit before desktop execution", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("/quit later");
    await composer.press("Enter");

    const confirmation = page.getByRole("alertdialog", {
      name: "Confirm /quit",
    });
    await expect(confirmation).toBeVisible();
    await expect(
      confirmation.getByText("Disconnect from this network?"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Disconnect" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(composer).toHaveValue("/quit later");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
  });

  test("shows the cached topic as a notice", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message" });
    const topic = `browser topic ${Date.now()}`;

    await composer.fill(`/topic ${topic}`);
    await composer.press("Enter");
    await expect(page.getByText(topic, { exact: true })).toBeVisible();

    await composer.fill("/topic");
    await composer.press("Enter");
    const notice = page.locator("[data-notice-row]").filter({
      hasText: `Topic: ${topic}`,
    });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/set by weblounge/);
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
    const suffix = Date.now();
    const older = `existing history older ${suffix}`;
    const newer = `existing history newer ${suffix}`;
    try {
      await seed.privmsgConfirmed("#weblounge-test", older);
      await seed.privmsgConfirmed("#weblounge-test", newer);
      const resumedAt = Date.now() + 24 * 60 * 60 * 1_000;
      await page.clock.setFixedTime(resumedAt);
      await page.goto("/?irc-password=weblounge-test");
      const olderRow = page
        .getByText(older, { exact: true })
        .locator("xpath=ancestor::*[@data-message-row]");
      const newerRow = page
        .getByText(newer, { exact: true })
        .locator("xpath=ancestor::*[@data-message-row]");
      await expect(olderRow).toBeVisible();
      await expect(newerRow).toBeVisible();
      await expect(page.getByText("Yesterday", { exact: true })).toBeVisible();
      const renderedOrder = await page
        .locator("[data-message-row]")
        .evaluateAll((rows) =>
          rows.map((row) => (row as HTMLElement).dataset.messageText),
        );
      expect(renderedOrder.indexOf(older)).toBeLessThan(
        renderedOrder.indexOf(newer),
      );
      for (const row of [olderRow, newerRow]) {
        const dateTime = await row.locator("time").getAttribute("datetime");
        expect(dateTime).not.toBeNull();
        expect(new Date(dateTime ?? 0).getTime()).toBeLessThan(
          resumedAt - 12 * 60 * 60 * 1_000,
        );
      }
    } finally {
      seed.close();
    }
  });

  test("restores an earlier direct conversation in fresh desktop and mobile sessions", async ({
    baseURL,
    browser,
    context,
    page,
  }) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
      "requires the production-shaped always-on Ergo profile",
    );
    const suffix = Date.now().toString().slice(-6);
    const requestedNick = `dm-seed-${suffix}`;
    const text = `earlier direct ${suffix}`;
    const bot = await IrcClient.connect(
      requestedNick,
      "weblounge-bot",
      "weblounge-bot-test",
      fixtureChannel,
    );
    const nick = bot.nickname;
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "SharedWorker", {
        configurable: true,
        value: undefined,
      });
    });
    let mobileContext: import("@playwright/test").BrowserContext | undefined;
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
      await bot.privmsgConfirmed("weblounge", text);
      await expect(
        page.getByRole("button", { name: new RegExp(`^${nick}`) }),
      ).toBeVisible();
      await page.close();

      const desktop = await context.newPage();
      await desktop.goto("/?irc-password=weblounge-test");
      const restoredDesktop = desktop.getByRole("button", {
        name: new RegExp(`^${nick}`),
      });
      await expect(restoredDesktop).toBeVisible();
      await restoredDesktop.click();
      await expect(desktop.getByText(text, { exact: true })).toBeVisible();
      await desktop.close();

      mobileContext = await browser.newContext({
        baseURL,
        hasTouch: true,
        isMobile: true,
        ignoreHTTPSErrors: process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1",
        viewport: { width: 402, height: 874 },
      });
      await mobileContext.addInitScript(() => {
        Object.defineProperty(globalThis, "SharedWorker", {
          configurable: true,
          value: undefined,
        });
      });
      const mobile = await mobileContext.newPage();
      await mobile.goto("/?irc-password=weblounge-test");
      await expect(mobile.locator("[data-mobile-chats]")).toBeVisible();
      const restoredMobile = mobile.getByRole("button", {
        name: new RegExp(`^${nick}`),
      });
      await expect(restoredMobile).toBeVisible();
      await expect(restoredMobile).toContainText(text);
    } finally {
      await mobileContext?.close();
      bot.close();
    }
  });

  test("anchors live messages and preserves the away boundary", async ({
    page,
  }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const channel = `#timeline-${Date.now()}`;
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const bot = await IrcClient.connect(
      "timeline-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const list = page.locator("[data-message-list]");
    const active = page.locator('[data-buffer-id][aria-current="page"]');
    try {
      await expect(
        page.getByRole("button", { name: "Toggle member list" }),
      ).toContainText("2");
      const liveEdgeReady = `live edge ready ${Date.now()}`;
      await bot.privmsgConfirmed(channel, liveEdgeReady);
      await list.press("End");
      await expect(
        page.getByText(liveEdgeReady, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toHaveCount(0);
      await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);
      const seeds = Array.from(
        { length: 30 },
        (_, index) =>
          `timeline seed ${index} ${"wrapped history makes the list scroll ".repeat(6)}`,
      );
      for (const seed of seeds) {
        await bot.privmsgConfirmed(channel, seed);
      }
      await expect(
        page.getByText(seeds.at(-1) ?? "", { exact: true }),
      ).toBeVisible();
      await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);
      await expect(active).toHaveAttribute("data-unread", "0", {
        timeout: 3_000,
      });

      await scrollAwayFromLiveEdge(page, list);
      const away = `while away ${Date.now()}`;
      await bot.privmsgConfirmed(channel, away);
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
      const scrollSeeds = Array.from(
        { length: 12 },
        (_, index) =>
          `shared read seed ${index} ${"wrapped message ".repeat(12)}`,
      );
      for (const seed of scrollSeeds)
        await bot.privmsgConfirmed("#weblounge-test", seed);
      await expect(
        secondTab.getByText(scrollSeeds.at(-1) ?? "", { exact: true }),
      ).toBeVisible();
      await scrollAwayFromLiveEdge(
        secondTab,
        secondTab.locator("[data-message-list]"),
        { distance: 40 },
      );
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
    const state = window as Window & {
      observedDeliveries?: string[];
      observedDeliveryModes?: string[];
    };
    state.observedDeliveries = [];
    state.observedDeliveryModes = [];
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
        const deliveryMode = `${delivery ?? ""}:${row.dataset.modeSymbol ?? ""}`;
        if (!state.observedDeliveryModes?.includes(deliveryMode))
          state.observedDeliveryModes?.push(deliveryMode);
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

async function observedDeliveryModes(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as Window & { observedDeliveryModes?: string[] })
        .observedDeliveryModes ?? [],
  );
}

async function expectMeasuredTimeline(
  page: import("@playwright/test").Page,
): Promise<void> {
  const list = page.locator("[data-message-list]");
  await expect(list).toBeVisible();
  await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);
  await expect
    .poll(() =>
      list.locator("li[data-index]").evaluateAll((elements) => {
        const boxes = elements
          .map((element) => element.getBoundingClientRect())
          .filter((box) => box.height > 0)
          .sort((left, right) => left.top - right.top);
        return boxes.every(
          (box, index) =>
            index === 0 ||
            (boxes[index - 1]?.bottom ?? Number.NEGATIVE_INFINITY) <=
              box.top + 0.5,
        );
      }),
    )
    .toBe(true);
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
