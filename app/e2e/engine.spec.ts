import { devices, type Page } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { IrcClient, isolatedPassword, registerAccount } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  distanceFromBottom,
  scrollAwayFromLiveEdge,
} from "./message-list-scroll";
import { expectSettled } from "./settled";
import { rowName } from "./sidebar-rows";

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

  test("sends, receives, and counts a mention", async ({ page, irc }) => {
    await page.goto(irc.url());
    await expect(page).toHaveURL(/^(?!.*irc-password)/);
    await expectSettled(page, { conversation: irc.channel });

    const ownText = `from browser ${Date.now()}`;
    await observeDeliveries(page, ownText);
    await page.getByRole("textbox", { name: "Message" }).fill(ownText);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(ownText, { exact: true })).toBeVisible();
    await expect
      .poll(() => observedDeliveries(page))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));

    const bot = await irc.peer("test-bot");
    bot.privmsg(irc.channel, "hello from the test bot");
    await expect(
      page.getByText("hello from the test bot", { exact: true }),
    ).toBeVisible();
    bot.privmsg(irc.channel, `hello ${irc.account}, this is a mention`);
    const activeChannel = page.locator('[data-buffer-id][aria-current="page"]');
    await expect(activeChannel).toHaveAttribute("data-mentions", "0");
    await expect(activeChannel).toHaveAccessibleName(irc.channel);
  });

  test("shows a clear notice at the server channel limit", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const channels = Array.from({ length: 8 }, (_, index) =>
      irc.channelNamed(`cap-${index}`),
    );
    const channelButton = (index: number) => {
      const channel = channels[index];
      if (channel === undefined) throw new Error("test channel missing");
      return page.getByRole("button", { name: channel.slice(1) });
    };
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channels.slice(0, 4).join(",")}`);
    await composer.press("Enter");
    await expect(channelButton(3)).toBeVisible();
    await composer.fill(`/join ${channels.slice(4, 6).join(",")}`);
    await composer.press("Enter");
    await expect(channelButton(5)).toBeVisible();
    await composer.fill(`/join ${channels.slice(6, 7).join(",")}`);
    await composer.press("Enter");
    await expect(channelButton(6)).toBeVisible();
    await composer.fill(`/join ${channels.slice(7).join(",")}`);
    await composer.press("Enter");

    await expect(page.getByRole("note")).toHaveText(
      "You're in the maximum number of channels for this server.",
    );
    for (const [index, channel] of channels.slice(0, 7).entries()) {
      await composer.fill(`/part ${channel}`);
      await composer.press("Enter");
      await expect(channelButton(index)).toHaveCount(0);
    }
  });

  test("keeps an ordinary incoming DM row unhighlighted", async ({
    page,
    irc,
  }) => {
    const bot = await irc.peer("plain-dm");
    const text = "ordinary direct message";
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    bot.privmsg(irc.account, text);
    const direct = page.getByRole("button", {
      name: rowName(bot.nickname, "1 unread, including mentions"),
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
  });

  test("keeps a reconnecting direct failure out of channels", async ({
    context,
    page,
    irc,
  }) => {
    const bot = await irc.peer("resume-dm");
    await page.setViewportSize({ height: 874, width: 402 });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const opening = "open before reconnect";
    await bot.privmsgConfirmed(irc.account, opening);
    await page.getByRole("button", { name: "Toggle channel list" }).click();
    const direct = page.getByRole("button", {
      name: new RegExp(`^${bot.nickname}`),
    });
    await expect(direct).toBeVisible();
    await direct.click();
    await expect(page.getByText(opening, { exact: true })).toBeVisible();

    await context.setOffline(true);
    const queued = "queued before peer leaves";
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
    await page.getByRole("button", { name: irc.channel }).click();
    await expectSettled(page, { conversation: irc.channel });
    await expect(gone).toHaveCount(0);
  });

  test("resolves cached direct history on desktop and mobile", async ({
    baseURL,
    browser,
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
    let mobileContext: import("@playwright/test").BrowserContext | undefined;
    try {
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "SharedWorker", {
          configurable: true,
          value: undefined,
        });
      });
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
      await bot.privmsgConfirmed("weblounge", text);
      await expect(
        page.getByRole("button", { name: new RegExp(`^${bot.nickname}`) }),
      ).toBeVisible();
      await openCachedDirect(page, baseURL, bot.nickname, text);
      await page.close();

      mobileContext = await browser.newContext({
        ...devices["iPhone 16 Pro"],
        baseURL,
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
      await openCachedDirect(mobile, baseURL, bot.nickname, text);
    } finally {
      await mobileContext?.close();
      bot.close();
    }
  });

  test("blocks a reused nick until its new account is trusted", async ({
    baseURL,
    browser,
    page,
    irc,
  }) => {
    const alias = irc.nickNamed("pin");
    const first = await irc.peer("pina");
    const replacement = await irc.peer("pinb");
    const mobileContext = await browser.newContext({
      baseURL,
      colorScheme: "dark",
      hasTouch: true,
      ignoreHTTPSErrors: process.env.WEBLOUNGE_E2E_SECURE_ERGO === "1",
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });
    await irc.scope(mobileContext);
    const mobile = await mobileContext.newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await Promise.all([page.goto(irc.url()), mobile.goto(irc.url())]);
      await expectSettled(page, { conversation: irc.channel });
      await expect(mobile.locator("[data-mobile-chats]")).toBeVisible();
      await first.nick(alias);
      first.privmsg(irc.account, "first account");
      await page
        .getByRole("button", { name: new RegExp(`^${alias}(?:,|$)`) })
        .click();
      await mobile
        .getByRole("button", { name: new RegExp(`^${alias}(?:,|$)`) })
        .click();
      await expectSettled(mobile, { conversation: alias });
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

      await first.nick(irc.nickNamed("away"));
      await replacement.nick(alias);
      replacement.privmsg(irc.account, "replacement account");

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
      const reply = "trusted reply";
      await observeDeliveries(page, reply);
      await page.getByRole("textbox", { name: `Message ${alias}` }).fill(reply);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await expect.poll(() => observedDeliveries(page)).toContain("confirmed");
    } finally {
      await mobileContext.close();
    }
  });

  test("keeps two nicks on one account as separate direct threads", async ({
    page,
    irc,
  }) => {
    const desktopNick = irc.nickNamed("desk");
    const phoneNick = irc.nickNamed("phone");
    const sharedAccount = irc.nickNamed("pair");
    const sharedPassword = isolatedPassword(sharedAccount);
    await registerAccount(sharedAccount, sharedPassword);
    const desktop = await IrcClient.connect(
      desktopNick,
      sharedAccount,
      sharedPassword,
      irc.channel,
    );
    const phone = await IrcClient.connect(
      phoneNick,
      sharedAccount,
      sharedPassword,
      irc.channel,
    );
    try {
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });
      desktop.privmsg(irc.account, "from desktop nick");
      phone.privmsg(irc.account, "from phone nick");

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
    irc,
  }) => {
    const operator = await irc.peer("operator");
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await operator.mode(irc.channel, "+o", irc.account);
    await page.getByRole("button", { name: "Toggle member list" }).click();
    await expect(
      page.getByRole("button", {
        name: `Open direct message with ${irc.account}`,
      }),
    ).toContainText("@");

    const text = "operator send";
    await observeDeliveries(page, text);
    await page.getByRole("textbox", { name: "Message" }).fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(() => observedDeliveries(page))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));
    const row = page.locator(`[data-message-row][data-message-text="${text}"]`);
    await expect(row).toContainText(irc.account);
    await expect(row).not.toContainText(`@${irc.account}`);
  });

  test("preserves a long single-line message when confirmed", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
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
    irc,
  }) => {
    const prose = `wrapped dogfood ${"several words need a real measured row ".repeat(10)}${Date.now()}`;
    const url = `https://example.com/${"unbroken-segment".repeat(20)}?${Date.now()}`;
    const live = `live wrapped dogfood ${"incoming words must resize their row ".repeat(10)}${Date.now()}`;
    expect(prose.length).toBeGreaterThan(350);
    const bot = await irc.peer("wrapped-bot");
    await bot.privmsgConfirmed(irc.channel, prose);
    await bot.privmsgConfirmed(irc.channel, url);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await expect(
      page.locator("[data-message-row]").filter({ hasText: prose }),
    ).toBeVisible();
    await expect(
      page.locator("[data-message-row]").filter({ hasText: url }),
    ).toBeVisible();
    await expectMeasuredTimeline(page);

    await bot.privmsgConfirmed(irc.channel, live);
    await expect(
      page.locator("[data-message-row]").filter({ hasText: live }),
    ).toBeVisible();
    await expectMeasuredTimeline(page);

    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await expect(
      page.locator("[data-message-row]").filter({ hasText: live }),
    ).toBeVisible();
    await expectMeasuredTimeline(page);
    await page.setViewportSize({ width: 800, height: 900 });
    await expectMeasuredTimeline(page);

    await page.setViewportSize({ width: 402, height: 874 });
    await expect(page.locator("[data-desktop-shell]")).toBeVisible();
    await expectMeasuredTimeline(page);
  });

  test("confirms typed quit before desktop execution", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
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
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
  });

  test("distinguishes version info from a cached topic", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const composer = page.getByRole("textbox", { name: "Message" });
    const topic = "browser topic";

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
    await expect(notice).toContainText(`set by ${irc.account}`);
  });

  test("shows existing channel history in a fresh browser", async ({
    page,
    irc,
  }) => {
    const seed = await irc.peer("history-seed");
    const older = "existing history older";
    const newer = "existing history newer";
    await seed.privmsgConfirmed(irc.channel, older);
    await seed.privmsgConfirmed(irc.channel, newer);
    const resumedAt = Date.now() + 24 * 60 * 60 * 1_000;
    await page.clock.setFixedTime(resumedAt);
    await page.goto(irc.url());
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
    irc,
  }) => {
    await page.goto(irc.url());
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const channel = irc.channelNamed("timeline");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const bot = await irc.peer("timeline-bot", [channel]);
    const list = page.locator("[data-message-list]");
    const active = page.locator('[data-buffer-id][aria-current="page"]');
    await expect(
      page.getByRole("button", { name: "Toggle member list" }),
    ).toContainText("2");
    const liveEdgeReady = "live edge ready";
    await bot.privmsgConfirmed(channel, liveEdgeReady);
    await list.press("End");
    await expect(page.getByText(liveEdgeReady, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(
      0,
    );
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
    const away = "while away";
    await bot.privmsgConfirmed(channel, away);
    await expect(
      page.getByRole("button", { name: /new message/ }),
    ).toBeVisible();
    await expect(active).toHaveAttribute("data-unread", "0");

    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(
      0,
    );
    await expect(page.getByText(away, { exact: true })).toBeVisible();
    await expect(page.getByText("New", { exact: true })).toBeVisible();
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);
    await expect(active).toHaveAttribute("data-unread", "0", {
      timeout: 3_000,
    });
  });

  test("broadcasts pending and confirmed sends to a second tab", async ({
    context,
    page: secondTab,
    irc,
  }) => {
    await secondTab.goto("/");
    await expect(secondTab.getByRole("status")).toHaveText(ready);
    const firstTab = await context.newPage();
    await firstTab.goto(irc.url());
    await expectSettled(firstTab, { conversation: irc.channel });
    await expectSettled(secondTab, { conversation: irc.channel });

    const text = "shared send";
    await observeDeliveries(secondTab, text);
    await firstTab.getByRole("textbox", { name: "Message" }).fill(text);
    await firstTab.getByRole("button", { name: "Send" }).click();
    await expect(secondTab.getByText(text, { exact: true })).toBeVisible();

    await expect
      .poll(() => observedDeliveries(secondTab))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));

    const bot = await irc.peer("read-sync-bot");
    const scrollSeeds = Array.from(
      { length: 12 },
      (_, index) =>
        `shared read seed ${index} ${"wrapped message ".repeat(12)}`,
    );
    for (const seed of scrollSeeds)
      await bot.privmsgConfirmed(irc.channel, seed);
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
    const incoming = "read sync";
    bot.privmsg(irc.channel, incoming);
    const secondActive = secondTab.locator(
      '[data-buffer-id][aria-current="page"]',
    );
    const jump = secondTab.getByRole("button", { name: /1 new message/u });
    await expect(jump).toBeVisible();
    await expect(secondActive).toHaveAttribute("data-unread", "0", {
      timeout: 3_000,
    });
    await jump.click();
    await expect(secondTab.getByText(incoming, { exact: true })).toBeVisible();
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
  nick: string,
  text: string,
): Promise<void> {
  await seedCachedDirect(page, baseURL, nick, text);

  await page.goto("/?irc-password=weblounge-test");
  const row = page.getByRole("button", { name: new RegExp(`^${nick}`) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("[data-message-list]")).toBeVisible();

  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await expect(
    page.locator("[data-message-list]").getByText(text, { exact: true }),
  ).toBeVisible();
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
                schema: 6,
                fingerprint,
                rows: [
                  {
                    conversation: { kind: "direct", key: nick },
                    title: nick,
                    last_activity_ms: Date.now(),
                    stubs: [
                      {
                        msgid: `${nick}-cached-1`,
                        time: Date.now() - 1,
                        mention: true,
                      },
                      {
                        msgid: `${nick}-cached-2`,
                        time: Date.now(),
                        mention: true,
                      },
                    ],
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
