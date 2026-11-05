import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
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

  test("shows a clear notice at the server channel limit", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/u }),
    ).toBeVisible();
    const suffix = Date.now().toString(36);
    const channels = Array.from(
      { length: 4 },
      (_, index) => `#cap-${suffix}-${index}`,
    );
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channels.join(",")}`);
    await composer.press("Enter");

    await expect(page.getByRole("note")).toHaveText(
      "You're in the maximum number of channels for this server.",
    );
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
        name: /^plain-dm, 1 unread, including mentions$/u,
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

  test("keeps a reconnecting direct failure out of channels", async ({
    context,
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const bot = await IrcClient.connect(
      `resume-dm-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      fixtureChannel,
    );
    try {
      await page.setViewportSize({ height: 874, width: 402 });
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: fixtureChannel }),
      ).toBeVisible();
      const opening = `open before reconnect ${suffix}`;
      await bot.privmsgConfirmed("weblounge", opening);
      await page.getByRole("button", { name: "Toggle channel list" }).click();
      const direct = page.getByRole("button", {
        name: new RegExp(`^${bot.nickname}`),
      });
      await expect(direct).toBeVisible();
      await direct.click();
      await expect(page.getByText(opening, { exact: true })).toBeVisible();

      await context.setOffline(true);
      const queued = `queued before peer leaves ${suffix}`;
      const composer = page.getByRole("textbox", {
        name: `Message ${bot.nickname}`,
      });
      await composer.fill(queued);
      await composer.press("Enter");
      await expect(page.getByText(queued, { exact: true })).toBeVisible();
      bot.close();
      await bot.waitForDisconnect();

      await context.setOffline(false);
      await page.evaluate(() => {
        const event = new Event("pageshow");
        Object.defineProperty(event, "persisted", { value: true });
        window.dispatchEvent(event);
      });
      const gone = page.getByText(
        /That person left or the nickname now belongs/u,
      );
      await expect(gone).toBeVisible();

      await page.getByRole("button", { name: "Toggle channel list" }).click();
      await page.getByRole("button", { name: fixtureChannel }).click();
      await expect(
        page.getByRole("heading", { name: fixtureChannel }),
      ).toBeVisible();
      await expect(gone).toHaveCount(0);
    } finally {
      bot.close();
    }
  });

  test("opens a cached direct with an active typing peer on mobile", async ({
    baseURL,
    context,
    page,
  }) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
      "requires the production-shaped local Ergo history profile",
    );
    const suffix = Date.now().toString().slice(-6);
    const bot = await IrcClient.connect(
      `cached-dm-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      fixtureChannel,
    );
    const text = `cached direct history ${suffix}`;
    try {
      await page.setViewportSize({ height: 874, width: 402 });
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "SharedWorker", {
          configurable: true,
          value: undefined,
        });
      });
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: fixtureChannel }),
      ).toBeVisible();
      await page.goto("/e2e/draft-key-migration.html");
      await bot.privmsgConfirmed("weblounge", text);
      await openCachedDirect(page, baseURL, bot, text);
    } finally {
      bot.close();
    }
  });

  test("blocks a reused nick until its new account is trusted", async ({
    baseURL,
    browser,
    page,
  }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const alias = `pin-${suffix}`;
    const first = await IrcClient.connectIsolated(
      `pina${suffix}`,
      fixtureChannel,
    );
    const replacement = await IrcClient.connectIsolated(
      `pinb${suffix}`,
      fixtureChannel,
    );
    const mobileContext = await browser.newContext({
      baseURL,
      colorScheme: "dark",
      hasTouch: true,
      ignoreHTTPSErrors: process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1",
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });
    const mobile = await mobileContext.newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await Promise.all([
        page.goto("/?irc-password=weblounge-test"),
        mobile.goto("/?irc-password=weblounge-test"),
      ]);
      await expect(
        page.getByRole("heading", { name: /#weblounge-test/u }),
      ).toBeVisible();
      await expect(mobile.locator("[data-mobile-chats]")).toBeVisible();
      await first.nick(alias);
      first.privmsg("weblounge", "first account");
      await page
        .getByRole("button", { name: new RegExp(`^${alias}(?:,|$)`) })
        .click();
      await mobile
        .getByRole("button", { name: new RegExp(`^${alias}(?:,|$)`) })
        .click();
      await expect(mobile.locator("[data-motion]")).toHaveCount(0);
      await expect(
        page
          .locator("[data-message-list]")
          .getByText("first account", { exact: true }),
      ).toBeVisible();
      await expect(
        mobile
          .locator("[data-message-list]")
          .getByText("first account", { exact: true }),
      ).toBeVisible();

      await first.nick(`away-${suffix}`);
      await replacement.nick(alias);
      replacement.privmsg("weblounge", "replacement account");

      const banner = page.locator("[data-direct-identity-banner]");
      const mobileBanner = mobile.locator("[data-direct-identity-banner]");
      await expect(banner).toContainText(
        `Can't verify this is the same ${alias}`,
      );
      await expect(mobileBanner).toContainText(
        `Can't verify this is the same ${alias}`,
      );
      await expectCompactIdentityBanner(page);
      await expectCompactIdentityBanner(mobile);
      await expect(
        page.getByRole("textbox", { name: `Message ${alias}` }),
      ).toBeDisabled();
      await expect(
        page.locator(
          '[data-message-row][data-message-text="replacement account"][data-unverified-sender="true"]',
        ),
      ).toBeVisible();

      await banner.getByRole("button", { name: "Trust new identity" }).click();
      await expect(banner).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: `Message ${alias}` }),
      ).toBeEnabled();
      const reply = `trusted reply ${suffix}`;
      await observeDeliveries(page, reply);
      await page.getByRole("textbox", { name: `Message ${alias}` }).fill(reply);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await expect.poll(() => observedDeliveries(page)).toContain("confirmed");
    } finally {
      await mobileContext.close();
      first.close();
      replacement.close();
    }
  });

  test("keeps two nicks on one account as separate direct threads", async ({
    page,
  }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const desktopNick = `desk-${suffix}`;
    const phoneNick = `phone-${suffix}`;
    const desktop = await IrcClient.connect(
      desktopNick,
      "weblounge-bot",
      "weblounge-bot-test",
      fixtureChannel,
    );
    const phone = await IrcClient.connect(
      phoneNick,
      "weblounge-bot",
      "weblounge-bot-test",
      fixtureChannel,
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByRole("heading", { name: /#weblounge-test/u }),
      ).toBeVisible();
      desktop.privmsg("weblounge", "from desktop nick");
      phone.privmsg("weblounge", "from phone nick");

      await expect(
        page.getByRole("button", { name: new RegExp(`^${desktopNick},`) }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: new RegExp(`^${phoneNick},`) }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: new RegExp(`^${desktopNick},`) })
        .click();
      await expect(
        page.getByText("from desktop nick", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("from phone nick", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: new RegExp(`^${phoneNick},`) })
        .click();
      await expect(
        page.getByText("from phone nick", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("from desktop nick", { exact: true }),
      ).toHaveCount(0);
    } finally {
      desktop.close();
      phone.close();
    }
  });

  test("keeps operator status in members and omits it from transcript rows", async ({
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
        .poll(() => observedDeliveries(page))
        .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));
      const row = page.locator(
        `[data-message-row][data-message-text="${text}"]`,
      );
      await expect(row).toContainText("weblounge");
      await expect(row).not.toContainText("@weblounge");
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

  test("distinguishes version info from a cached topic", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message" });
    const topic = `browser topic ${Date.now()}`;

    await composer.fill("/version");
    await composer.press("Enter");
    const version = await page.evaluate(() => window.weblounge.version);
    const info = page
      .locator('[data-notice-row][data-notice-kind="info"]')
      .filter({ hasText: version });
    await expect(info).toBeVisible();
    await expect(info).not.toContainText("Topic:");
    await expect(info).not.toContainText("set by");

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

async function expectCompactIdentityBanner(page: Page): Promise<void> {
  const banner = page.locator("[data-direct-identity-banner]");
  const list = page.locator("[data-message-list]");
  const [bannerBox, listBox, maximumHeight] = await Promise.all([
    banner.boundingBox(),
    list.boundingBox(),
    banner.evaluate((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const lineHeight =
        style.lineHeight === "normal"
          ? fontSize * 1.2
          : Number.parseFloat(style.lineHeight);
      return (
        lineHeight * 3 +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth) +
        4
      );
    }),
  ]);
  expect(bannerBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  expect(bannerBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    maximumHeight,
  );
  expect(
    Math.abs(
      (listBox?.y ?? 0) - ((bannerBox?.y ?? 0) + (bannerBox?.height ?? 0)),
    ),
  ).toBeLessThanOrEqual(1);
  expect(listBox?.height ?? 0).toBeGreaterThan(
    (page.viewportSize()?.height ?? 0) / 2,
  );
}

async function observeDeliveries(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  await page.evaluate((messageText) => {
    const state = window as Window & {
      observedDeliveries?: string[];
    };
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

async function openCachedDirect(
  page: Page,
  baseURL: string | undefined,
  peer: IrcClient,
  text: string,
): Promise<void> {
  const nick = peer.nickname;
  await seedCachedDirect(page, baseURL, nick, text);

  await page.goto("/?irc-password=weblounge-test");
  const chatsToggle = page.getByRole("button", { name: "Toggle channel list" });
  await expect(chatsToggle).toBeVisible();
  await chatsToggle.click();
  const row = page.getByRole("button", { name: new RegExp(`^${nick}`) });
  await expect(row).toBeVisible();
  peer.typing("weblounge", "active");
  await row.click();
  await expect(page.locator("[data-message-list]")).toBeVisible();

  await expect(
    page.locator("[data-message-list]").getByText(text, { exact: true }),
  ).toBeVisible();
  peer.typing("weblounge", "active");
  await expect(page.locator("[data-conversation-title]")).not.toHaveAttribute(
    "data-connection-progress",
  );
  await expect(
    page.getByText(/That person left or the nickname now belongs/u),
  ).toHaveCount(0);

  const reply = `cached direct reply ${Date.now()}`;
  await observeDeliveries(page, reply);
  await page.getByRole("textbox", { name: `Message ${nick}` }).fill(reply);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await expect.poll(() => observedDeliveries(page)).toContain("confirmed");
}

async function seedCachedDirect(
  page: Page,
  baseURL: string | undefined,
  nick: string,
  text: string,
): Promise<void> {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const endpoint = new URL("/socket", baseURL);
  if (process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1") {
    endpoint.href = "wss://127.0.0.1:8068";
  } else {
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  }
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(
      async (value, { fingerprint, nick, text }) => {
        await new Promise<void>((resolve, reject) => {
          const transaction = value.transaction("cache", "readwrite");
          transaction.objectStore("cache").put(
            new TextEncoder().encode(
              JSON.stringify({
                schema: 4,
                fingerprint,
                rows: [
                  {
                    conversation: { kind: "direct", key: nick },
                    title: nick,
                    last_activity_ms: Date.now(),
                    badge: { kind: "mentions", count: 2, mentions: 2 },
                    preview: `${nick}: ${text}`,
                  },
                ],
              }),
            ),
            new TextEncoder().encode("chat-list-snapshot"),
          );
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      },
      {
        fingerprint: `${"Local Ergo".length}:Local Ergo${endpoint.href.length}:${endpoint.href}`,
        nick,
        text,
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
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
