import { expect, type Locator, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import {
  captureHistoryWire,
  heldLatestHistoryCount,
  releaseHeldLatestHistory,
} from "./history-wire-fixture";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

test.describe("startup chat-list snapshot against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("sends from a snapshot-restored DM after TARGETS reconciliation", async ({
    baseURL,
    page,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const suffix = Date.now().toString(36);
    const appAccount = `send-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const keeper = await IrcClient.connectIsolated(
      appAccount,
      "#weblounge-test",
    );
    const bot = await IrcClient.connect(
      `send-dm-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const incoming = `snapshot direct ${suffix}`;
    const reply = `reply after TARGETS ${suffix}`;
    try {
      await keeper.setAlwaysOn(true);
      keeper.close();
      await keeper.waitForDisconnect();
      await bot.privmsgConfirmed(appAccount, incoming);
      await page.goto("/config.json");
      await seedUnreadDirectSnapshot(
        page,
        baseURL,
        bot.nickname,
        incoming,
        [],
        [],
      );
      await useDedicatedWorker(page);
      await page.goto(
        startUrlForAccount(appAccount, appPassword, "#weblounge-test"),
      );

      await bufferRow(page, bot.nickname).click();
      await expect(
        page
          .getByRole("list", { name: "Messages" })
          .getByText(incoming, { exact: true }),
      ).toBeVisible();
      await expect(page.locator("[data-app-root]")).not.toHaveAttribute(
        "data-chat-list-hydrating",
        "true",
      );

      const composer = page.getByRole("textbox", {
        name: `Message ${bot.nickname}`,
      });
      await composer.fill(reply);
      await composer.press("Enter");
      await expect(
        page.getByRole("button", { name: "Failed · Retry" }),
      ).toHaveCount(0);
      await expect(messageRow(page, reply, "confirmed")).toHaveCount(1);
      await bot.waitForPrivmsg(bot.nickname, reply, appAccount);
    } finally {
      keeper.close();
      bot.close();
    }
  });

  test("persists a fetched server marker before the next launch", async ({
    baseURL,
    context,
    page,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const suffix = Date.now().toString(36);
    const channel = `#snapshot-marker-${suffix}`;
    const appAccount = `marker-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const readFirst = `read marker first ${suffix}`;
    const readThrough = `read marker boundary ${suffix}`;
    const preview = `unread marker preview ${suffix}`;
    const keeper = await IrcClient.connectIsolated(appAccount, channel);
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const bot = await IrcClient.connect(
      `snapshot-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const snapshotPreview = `${bot.nickname}: ${preview}`;
    let current = page;
    try {
      await useDedicatedWorker(current);
      await current.goto(startUrlForAccount(appAccount, appPassword, channel));
      await bufferRow(current, channel).click();
      await expect(
        current.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await leaveConversation(current, channel);
      const history = [
        {
          text: readFirst,
          line: await bot.privmsgConfirmed(channel, readFirst),
        },
      ];
      const boundaryLine = await bot.privmsgConfirmed(channel, readThrough);
      history.push({ text: readThrough, line: boundaryLine });
      const boundaryTime = messageTag(boundaryLine, "time");
      for (let index = 0; index < 20; index += 1) {
        const text = `marker candidate ${index} ${suffix}`;
        const line = await bot.privmsgConfirmed(channel, text);
        history.push({ text, line });
        if (Date.parse(messageTag(line, "time")) > Date.parse(boundaryTime))
          break;
      }
      const previewLine = await bot.privmsgConfirmed(channel, preview);
      history.push({ text: preview, line: previewLine });
      const lastRead = history.findLast(
        ({ line }) =>
          Date.parse(messageTag(line, "time")) <= Date.parse(boundaryTime),
      );
      const firstUnread = history.find(
        ({ line }) =>
          Date.parse(messageTag(line, "time")) > Date.parse(boundaryTime),
      );
      if (lastRead === undefined || firstUnread === undefined)
        throw new Error("server time did not advance beyond the marker");
      await expectUnreadCount(
        bufferRow(current, channel),
        channel,
        history.length,
      );
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({
          badge: { kind: "unread", count: history.length },
          preview: snapshotPreview,
        });

      await current.close();
      const markerReader = await IrcClient.connect(
        appAccount,
        appAccount,
        appPassword,
        channel,
      );
      try {
        await markerReader.markRead(channel, boundaryTime);
        await expect
          .poll(() => markerReader.readMarker(channel))
          .toBe(boundaryTime);
      } finally {
        markerReader.close();
        await markerReader.waitForDisconnect();
      }

      current = await context.newPage();
      await openSnapshotInspector(current);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({
          badge: { kind: "unread", count: history.length },
          preview: snapshotPreview,
        });
      await captureHistoryWire(current);
      await useDedicatedWorker(current);
      await current.goto(startUrlForAccount(appAccount, appPassword, channel));
      await expect
        .poll(() => historyWire(current))
        .toContainEqual(
          expect.objectContaining({
            direction: "received",
            line: expect.stringContaining(
              ` MARKREAD ${channel} timestamp=${boundaryTime}`,
            ),
          }),
        );
      await bufferRow(current, channel).click();
      await expect(
        current.getByText(lastRead.text, { exact: true }),
      ).toBeVisible();
      await expect(
        current.getByText(firstUnread.text, { exact: true }),
      ).toBeVisible();
      await expect(current.getByText(preview, { exact: true })).toBeVisible();
      await expectNewDividerBetween(current, lastRead.text, firstUnread.text);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ badge: { kind: "none" }, preview: snapshotPreview });

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, channel);
      await current.goto(startUrlForAccount(appAccount, appPassword, channel));
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          label: channel,
        });
      if (await isMobile(current))
        await expect
          .poll(() => cachedRow(current))
          .toMatchObject({ text: expect.stringContaining(preview) });
    } finally {
      if (!current.isClosed()) await current.close();
      bot.close();
    }
  });

  test("overwrites stale SharedWorker badges before relaunch", async ({
    baseURL,
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName !== "firefox", "covers the reported Firefox failure");
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const suffix = Date.now().toString(36);
    const channel = "#weblounge-test";
    const preview = `stale Firefox preview ${suffix}`;
    const bot = await IrcClient.connect(
      `firefox-cache-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const markerReader = await IrcClient.connect(
      "weblounge",
      "weblounge",
      "weblounge-test",
      channel,
    );
    let current = page;
    let forwarderDropped = false;
    try {
      const latest = await bot.privmsgConfirmed("weblounge", preview);
      await markerReader.markRead(bot.nickname, messageTag(latest, "time"));
      await current.goto("/config.json");
      await seedUnreadDirectSnapshot(
        current,
        baseURL,
        bot.nickname,
        preview,
        [],
        [],
        417,
      );
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({
          badge: { kind: "mentions", count: 417, mentions: 417 },
        });
      await installStorageWriteFailureControl(current);
      await recordCachedRow(current, bot.nickname);
      await controlForwarder("drop");
      forwarderDropped = true;
      await current.goto(startUrl());
      await expect(bufferRow(current, bot.nickname)).toHaveAttribute(
        "data-unread",
        "417",
      );
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          unread: "417",
        });
      await setStorageWritesFailing(current, true);
      await controlForwarder("restore");
      forwarderDropped = false;
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
      await expect(bufferRow(current, bot.nickname)).toHaveAttribute(
        "data-unread",
        "0",
      );
      await expect(current.locator("[data-app-root]")).not.toHaveAttribute(
        "data-chat-list-hydrating",
        "true",
      );

      await setStorageWritesFailing(current, false);
      await backgroundPage(current);
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({ badge: { kind: "none" } });
      await current.close();

      current = await context.newPage();
      await useFreshSharedWorker(current);
      await recordCachedRow(current, bot.nickname);
      await current.goto(startUrl());
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({ unread: "0" });
    } finally {
      if (forwarderDropped) await controlForwarder("restore");
      if (!current.isClosed()) await current.close();
      markerReader.close();
      bot.close();
    }
  });

  test("keeps a newly read DM clear after a failed Firefox snapshot commit", async ({
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName !== "firefox", "covers the reported Firefox failure");
    const suffix = Date.now().toString(36);
    const channel = "#weblounge-test";
    const textPrefix = `snapshot direct ${suffix}`;
    const bot = await IrcClient.connect(
      `snapshot-read-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const markerReader = await IrcClient.connect(
      "weblounge",
      "weblounge",
      "weblounge-test",
      channel,
    );
    let current = page;
    try {
      await installStorageWriteFailureControl(current);
      await observeMarkReadRequests(current);
      await current.goto(startUrl());
      await expect(
        current.locator('[data-network-state="online"]'),
      ).toHaveCount(1);
      const cursorLine = await bot.privmsgConfirmed(
        channel,
        `snapshot cursor ${suffix}`,
      );
      const cursorTime = Date.parse(messageTag(cursorLine, "time"));
      let latest: { line: string; text: string } | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const text = `${textPrefix} ${attempt}`;
        const candidate = await bot.privmsgConfirmed("weblounge", text);
        if (Date.parse(messageTag(candidate, "time")) > cursorTime) {
          latest = { line: candidate, text };
          break;
        }
      }
      if (latest === undefined)
        throw new Error(
          "direct message time did not advance beyond the cursor",
        );
      const latestTime = messageTag(latest.line, "time");
      const row = bufferRow(current, bot.nickname);
      await expectUnreadCount(row, bot.nickname, 1);
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({ badge: { kind: "mentions", count: 1, mentions: 1 } });

      await setStorageWritesFailing(current, true);
      await row.click();
      await expect(
        current.getByRole("heading", { name: bot.nickname }),
      ).toBeVisible();
      await expect(
        current.getByText(latest.text, { exact: true }),
      ).toBeVisible();
      await expectRead(row, bot.nickname);
      await expect.poll(() => markReadRequestCount(current)).toBeGreaterThan(0);
      await expect
        .poll(() => storageWriteAbortCount(current))
        .toBeGreaterThan(0);
      await expect
        .poll(() => markerReader.readMarker(bot.nickname))
        .toBe(latestTime);

      const abortsBeforeFlush = await storageWriteAbortCount(current);
      await backgroundPage(current);
      await expect
        .poll(() => storageWriteAbortCount(current))
        .toBeGreaterThan(abortsBeforeFlush);
      await setStorageWritesFailing(current, false);
      await backgroundPage(current);
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({ badge: { kind: "none" } });
      await current.close();

      current = await context.newPage();
      await useFreshSharedWorker(current);
      await recordCachedRow(current, bot.nickname);
      await current.goto(startUrl());
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({ unread: "0" });
    } finally {
      if (!current.isClosed()) await current.close();
      markerReader.close();
      bot.close();
    }
  });

  test("keeps a newer live preview when catch-up finishes behind it", async ({
    context,
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = "#weblounge-test";
    const appAccount = `preview-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const missed = `older catch-up preview ${suffix}`;
    const live = `newer live preview ${suffix}`;
    const bot = await IrcClient.connect(
      `preview-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const keeper = await IrcClient.connectIsolated(appAccount, channel);
    let current = page;
    try {
      await keeper.setAlwaysOn(true);
      keeper.close();
      await keeper.waitForDisconnect();
      await useDedicatedWorker(current);
      await current.goto(startUrlForAccount(appAccount, appPassword, channel));
      await bufferRow(current, channel).click();
      await expect(
        current.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await current.close();
      await bot.privmsgConfirmed(channel, missed);

      current = await context.newPage();
      await useDedicatedWorker(current);
      await current.goto(startUrlForAccount(appAccount, appPassword, channel));
      await expect(current.locator("[data-app-root]")).not.toHaveAttribute(
        "data-connection-progress",
      );
      await bot.privmsgConfirmed(channel, live);
      await bufferRow(current, channel).click();
      await expect(
        current.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await expect(current.getByText(live, { exact: true })).toBeVisible();
      await expect(current.getByText(missed, { exact: true })).toBeVisible();
      await expect
        .poll(() => transcriptOrders(current, missed, live))
        .toBe(true);
      if (isMobile(current))
        await expect(bufferRow(current, channel)).toContainText(live);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ preview: expect.stringContaining(live) });

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, channel);
      await current.goto(startUrlForAccount(appAccount, appPassword, channel));
      await expect.poll(() => cachedRow(current)).not.toBeUndefined();
      if (isMobile(current))
        await expect
          .poll(() => cachedRow(current))
          .toMatchObject({ text: expect.stringContaining(live) });
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ preview: expect.stringContaining(live) });
    } finally {
      if (!current.isClosed()) await current.close();
      keeper.close();
      bot.close();
    }
  });

  test("persists a read channel and the final live rows across relaunch", async ({
    context,
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#badge-relaunch-${suffix}`;
    const emptyChannel = `#badge-empty-${suffix}`;
    const homeChannel = "#weblounge-test";
    const appAccount = `badge-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const keeper = await IrcClient.connectIsolated(appAccount, channel);
    await keeper.join(emptyChannel);
    await keeper.join(homeChannel);
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const bot = await IrcClient.connect(
      `badge-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const markerReader = await IrcClient.connect(
      appAccount,
      appAccount,
      appPassword,
      channel,
    );
    const titles = [bot.nickname, channel, emptyChannel];
    let current = page;
    try {
      await useDedicatedWorker(current);
      await current.goto(
        startUrlForAccount(
          appAccount,
          appPassword,
          homeChannel,
          channel,
          emptyChannel,
        ),
      );
      await expect(bufferRow(current, channel)).toBeVisible();
      await expect(bufferRow(current, emptyChannel)).toBeVisible();
      await bufferRow(current, homeChannel).click();
      await expect(
        current.getByRole("heading", { name: homeChannel }),
      ).toBeVisible();

      const directFirst = await bot.privmsgConfirmed(
        appAccount,
        `initial direct ${suffix}`,
      );
      const directFirstId = messageTag(directFirst, "msgid");
      const directReply = await bot.privmsgReplyConfirmed(
        appAccount,
        `reply-tagged direct ${suffix}`,
        directFirstId,
      );
      const directReplyId = messageTag(directReply, "msgid");
      await expectUnreadCount(
        bufferRow(current, bot.nickname),
        bot.nickname,
        2,
      );
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({
          badge: { kind: "mentions", count: 2, mentions: 2 },
        });

      await current.close();
      const closedDirect = await bot.privmsgReplyConfirmed(
        appAccount,
        `closed-app reply-tagged direct ${suffix}`,
        directReplyId,
      );
      await markerReader.markRead(
        bot.nickname,
        messageTag(closedDirect, "time"),
      );
      const unreadLines = await Promise.all(
        [1, 2, 3].map((index) =>
          bot.privmsgConfirmed(channel, `closed-app unread ${index} ${suffix}`),
        ),
      );
      const newestUnreadTime = messageTag(unreadLines.at(-1), "time");
      await expect.poll(() => markerReader.readMarker(channel)).toBeUndefined();

      current = await context.newPage();
      await useDedicatedWorker(current);
      await observeMarkReadRequests(current);
      await recordCachedRows(current, titles);
      await current.goto(
        startUrlForAccount(
          appAccount,
          appPassword,
          homeChannel,
          channel,
          emptyChannel,
        ),
      );
      await expect
        .poll(() => cachedRows(current))
        .toEqual([
          { label: `${bot.nickname}, 2 unread, including mentions` },
          { label: channel },
          { label: emptyChannel },
        ]);
      await expectUnreadCount(bufferRow(current, channel), channel, 3);
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);

      await bufferRow(current, channel).click();
      await expect(
        current.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await expect(
        current.getByText(`closed-app unread 3 ${suffix}`, { exact: true }),
      ).toBeVisible();
      await expect.poll(() => markReadRequestCount(current)).toBeGreaterThan(0);
      await expect
        .poll(() => markerReader.readMarker(channel))
        .toBe(newestUnreadTime);
      await leaveConversation(current, channel);
      await expectRead(bufferRow(current, channel), channel);

      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
      const finalRows = await visibleChatRows(current);
      await expect
        .poll(() => snapshotRows(current, titles))
        .toEqual(await visibleRows(current, titles));

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedChatRows(current, titles);
      await current.goto(
        startUrlForAccount(
          appAccount,
          appPassword,
          homeChannel,
          channel,
          emptyChannel,
        ),
      );
      await expect.poll(() => cachedChatRows(current)).toEqual(finalRows);
      await expect(current.locator("[data-app-root]")).not.toHaveAttribute(
        "data-chat-list-hydrating",
        "true",
      );
      await expectRead(bufferRow(current, channel), channel);
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
    } finally {
      if (!current.isClosed()) await current.close();
      keeper.close();
      markerReader.close();
      bot.close();
    }
  });

  test("flushes a cleared cached DM while another row is still hydrating", async ({
    baseURL,
    context,
    page,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const suffix = Date.now().toString(36).slice(-6);
    const appAccount = `cache-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const channels = Array.from(
      { length: 3 },
      (_, index) => `#cache-${index}-${suffix}`,
    );
    const firstChannel = channels[0];
    if (firstChannel === undefined) throw new Error("first channel is missing");
    const bot = await IrcClient.connect(
      `cache-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      firstChannel,
    );
    const keeper = await IrcClient.connectIsolated(appAccount, firstChannel);
    const backgroundBots: IrcClient[] = [];
    const directText = `cached direct ${suffix}`;
    let current = page;
    try {
      for (let index = 0; index < 15; index += 1) {
        const nick = `cache-slow-${index.toString().padStart(2, "0")}-${suffix}`;
        backgroundBots.push(
          await IrcClient.connectIsolated(nick, firstChannel),
        );
      }
      for (const [index, backgroundBot] of backgroundBots.entries())
        await backgroundBot.privmsgConfirmed(
          appAccount,
          `background direct ${index} ${suffix}`,
        );
      await current.goto("/config.json");
      await seedUnreadDirectSnapshot(
        current,
        baseURL,
        bot.nickname,
        directText,
        channels,
        backgroundBots.map((backgroundBot) => backgroundBot.nickname),
      );
      await captureHistoryWire(current, { latestExcept: bot.nickname });
      await useDedicatedWorker(current);
      await observeMarkReadRequests(current);
      await recordCachedRow(current, bot.nickname);
      await current.goto(
        startUrlForAccount(appAccount, appPassword, ...channels),
      );
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          label: `${bot.nickname}, 1 unread, including mentions`,
        });
      await bot.privmsgConfirmed(appAccount, directText);

      await bufferRow(current, bot.nickname).click();
      await expect(
        current.getByRole("heading", { name: bot.nickname }),
      ).toBeVisible();
      await expect(
        current
          .getByRole("list", { name: "Messages" })
          .getByText(directText, { exact: true }),
      ).toBeVisible();
      await expect(
        current.locator("[data-conversation-title]"),
      ).not.toHaveAttribute("data-connection-progress");
      await expect.poll(() => markReadRequestCount(current)).toBeGreaterThan(0);

      await expect
        .poll(() => heldLatestHistoryCount(current))
        .toBeGreaterThan(0);
      await expect(current.locator("[data-app-root]")).toHaveAttribute(
        "data-chat-list-hydrating",
        "true",
      );
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({ badge: { kind: "none" } });
      await backgroundPage(current);
      await releaseHeldLatestHistory(current);
      await current.close();

      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, bot.nickname);
      await current.goto(
        startUrlForAccount(appAccount, appPassword, ...channels),
      );
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({ label: bot.nickname });
    } finally {
      if (!current.isClosed()) await current.close();
      bot.close();
      keeper.close();
      for (const backgroundBot of backgroundBots) backgroundBot.close();
    }
  });
});

async function openSnapshotInspector(page: Page): Promise<void> {
  await page.route("**/__snapshot-inspector", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/__snapshot-inspector");
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1_280) < 700;
}

async function leaveConversation(page: Page, channel: string): Promise<void> {
  if (isMobile(page)) {
    await page.getByRole("button", { name: "Back to chats" }).click();
  } else {
    await page.getByRole("button", { name: "#weblounge-test" }).click();
  }
  await expect(bufferRow(page, channel)).not.toHaveAttribute(
    "aria-current",
    "page",
  );
}

function bufferRow(page: Page, channel: string) {
  return page
    .locator("[data-buffer-id]")
    .and(
      page.getByRole("button", {
        includeHidden: true,
        name: new RegExp(`^${escapeRegex(channel)}(?:,|$)`, "u"),
      }),
    )
    .first();
}

function messageRow(page: Page, text: string, delivery: string) {
  return page
    .locator(`[data-message-row][data-delivery="${delivery}"]`)
    .filter({ has: page.getByText(text, { exact: true }) });
}

async function expectRead(
  row: ReturnType<typeof bufferRow>,
  channel: string,
): Promise<void> {
  await expect(row).toHaveAttribute("aria-label", channel);
}

function startUrl(...channels: string[]): string {
  const params = new URLSearchParams({ "irc-password": "weblounge-test" });
  for (const channel of channels) params.append("irc-autojoin", channel);
  return `/?${params.toString()}`;
}

function startUrlForAccount(
  account: string,
  password: string,
  ...channels: string[]
): string {
  const params = new URLSearchParams({
    "irc-account": account,
    "irc-nickname": account,
    "irc-password": password,
  });
  for (const channel of channels) params.append("irc-autojoin", channel);
  return `/?${params.toString()}`;
}

async function snapshotRow(page: Page, channel: string): Promise<unknown> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(async (value, title) => {
      const bytes = await new Promise<unknown>((resolve, reject) => {
        const request = value
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (!(bytes instanceof Uint8Array)) return undefined;
      const snapshot: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof snapshot !== "object" ||
        snapshot === null ||
        !("rows" in snapshot) ||
        !Array.isArray(snapshot.rows)
      )
        return undefined;
      return snapshot.rows.find(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          "title" in row &&
          row.title === title,
      );
    }, channel);
  } finally {
    await closeEngineDatabase(database);
  }
}

async function snapshotRows(
  page: Page,
  titles: readonly string[],
): Promise<readonly { label: string }[] | undefined> {
  const rows = await Promise.all(
    titles.map((title) => snapshotRow(page, title)),
  );
  if (rows.some((row) => row === undefined)) return undefined;
  return rows.map((row, index) => ({
    label: snapshotLabel(titles[index] ?? "", row),
  }));
}

function snapshotLabel(title: string, value: unknown): string {
  if (typeof value !== "object" || value === null || !("badge" in value))
    throw new Error(`Snapshot row missing badge for ${title}`);
  const badge = value.badge;
  if (typeof badge !== "object" || badge === null || !("kind" in badge))
    throw new Error(`Snapshot row has an invalid badge for ${title}`);
  if (badge.kind === "none") return title;
  if (!("count" in badge) || typeof badge.count !== "number")
    throw new Error(`Snapshot row has an invalid count for ${title}`);
  return badge.kind === "mentions"
    ? `${title}, ${badge.count} unread, including mentions`
    : `${title}, ${badge.count} unread`;
}

async function recordCachedRow(page: Page, channel: string): Promise<void> {
  await page.addInitScript((title) => {
    Reflect.set(globalThis, "staleSnapshotCachedRow", undefined);
    new MutationObserver(() => {
      const root = document.querySelector("[data-chat-list-hydrating]");
      if (root === null) return;
      const row = [
        ...root.querySelectorAll<HTMLElement>("[data-buffer-id]"),
      ].find((candidate) => candidate.textContent?.includes(title));
      if (row !== undefined)
        Reflect.set(globalThis, "staleSnapshotCachedRow", {
          label: row.getAttribute("aria-label"),
          text: row.textContent ?? "",
          unread: row.getAttribute("data-unread"),
        });
    }).observe(document, {
      attributeFilter: ["aria-label", "data-chat-list-hydrating"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, channel);
}

function cachedRow(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "staleSnapshotCachedRow"));
}

function historyWire(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "historyWireTimeline"));
}

async function seedUnreadDirectSnapshot(
  page: Page,
  baseURL: string,
  nick: string,
  preview: string,
  channels: readonly string[],
  backgroundDirects: readonly string[],
  count = 1,
): Promise<void> {
  const endpoint = new URL("/socket", baseURL);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const fingerprint = `${"Local Ergo".length}:Local Ergo${endpoint.href.length}:${endpoint.href}`;
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(
      async (value, record) => {
        await new Promise<void>((resolve, reject) => {
          const transaction = value.transaction("cache", "readwrite");
          transaction
            .objectStore("cache")
            .put(
              new TextEncoder().encode(JSON.stringify(record)),
              new TextEncoder().encode("chat-list-snapshot"),
            );
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      },
      {
        schema: 4,
        fingerprint,
        rows: [
          {
            conversation: { kind: "direct", key: nick },
            title: nick,
            last_activity_ms: 1_800_000_000_000,
            badge: { kind: "mentions", count, mentions: count },
            preview,
          },
          ...backgroundDirects.map((backgroundNick, index) => ({
            conversation: { kind: "direct", key: backgroundNick },
            title: backgroundNick,
            last_activity_ms: 1_799_999_999_999 - index,
            badge: { kind: "none" },
            preview: `cached ${backgroundNick}`,
          })),
          ...channels.map((channel, index) => ({
            conversation: { kind: "channel", key: channel },
            title: channel,
            last_activity_ms:
              1_799_999_999_999 - backgroundDirects.length - index,
            badge: { kind: "none" },
            preview: `cached ${channel}`,
          })),
        ],
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function backgroundPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperties(document, {
      hidden: { configurable: true, get: () => true },
      visibilityState: { configurable: true, get: () => "hidden" },
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
}

async function controlForwarder(action: "drop" | "restore"): Promise<void> {
  const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
  if (base === undefined) throw new Error("socket forwarder is unavailable");
  const response = await fetch(`${base}/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(`socket forwarder ${action} failed`);
}

async function useFreshSharedWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeSharedWorker = globalThis.SharedWorker;
    class RelaunchedSharedWorker extends NativeSharedWorker {
      constructor(scriptURL: string | URL, options?: string | WorkerOptions) {
        const suffix = crypto.randomUUID();
        super(
          scriptURL,
          typeof options === "string"
            ? `${options}-${suffix}`
            : { ...options, name: `${options?.name ?? "worker"}-${suffix}` },
        );
      }
    }
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: RelaunchedSharedWorker,
    });
  });
}

async function installStorageWriteFailureControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeSharedWorker = globalThis.SharedWorker;
    class StorageFailureSharedWorker extends NativeSharedWorker {
      constructor(scriptURL: string | URL, options?: string | WorkerOptions) {
        super(scriptURL, options);
        this.port.addEventListener("message", (event) => {
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "type" in event.data &&
            event.data.type === "storage_write_test_aborted"
          ) {
            const count = Reflect.get(
              globalThis,
              "staleSnapshotWriteAbortCount",
            );
            Reflect.set(
              globalThis,
              "staleSnapshotWriteAbortCount",
              typeof count === "number" ? count + 1 : 1,
            );
          }
        });
        Reflect.set(
          globalThis,
          "staleSnapshotSetWriteFailure",
          (failing: boolean) => {
            this.port.postMessage({
              type: "storage_write_test_set_failure",
              failing,
            });
          },
        );
      }
    }
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: StorageFailureSharedWorker,
    });
  });
}

function storageWriteAbortCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const count = Reflect.get(globalThis, "staleSnapshotWriteAbortCount");
    return typeof count === "number" ? count : 0;
  });
}

async function setStorageWritesFailing(
  page: Page,
  failing: boolean,
): Promise<void> {
  await page.evaluate((shouldFail) => {
    const setFailure = Reflect.get(globalThis, "staleSnapshotSetWriteFailure");
    if (typeof setFailure !== "function")
      throw new Error("storage write failure control is unavailable");
    setFailure(shouldFail);
  }, failing);
}

async function recordCachedRows(
  page: Page,
  titles: readonly string[],
): Promise<void> {
  await page.addInitScript((expectedTitles) => {
    Reflect.set(globalThis, "badgePersistCachedRows", undefined);
    new MutationObserver(() => {
      if (Reflect.get(globalThis, "badgePersistCachedRows") !== undefined)
        return;
      const root = document.querySelector("[data-chat-list-hydrating]");
      if (root === null) return;
      const rows = [...root.querySelectorAll<HTMLElement>("[data-buffer-id]")];
      const captured = expectedTitles.map((title) => {
        const row = rows.find((candidate) =>
          candidate.getAttribute("aria-label")?.startsWith(title),
        );
        return row === undefined
          ? undefined
          : { label: row.getAttribute("aria-label") ?? "" };
      });
      if (captured.every((row) => row !== undefined))
        Reflect.set(globalThis, "badgePersistCachedRows", captured);
    }).observe(document, { childList: true, subtree: true });
  }, titles);
}

function cachedRows(
  page: Page,
): Promise<readonly { label: string }[] | undefined> {
  return page.evaluate(() => Reflect.get(globalThis, "badgePersistCachedRows"));
}

async function visibleRows(
  page: Page,
  titles: readonly string[],
): Promise<readonly { label: string }[]> {
  return Promise.all(
    titles.map(async (title) => ({
      label: (await bufferRow(page, title).getAttribute("aria-label")) ?? "",
    })),
  );
}

async function recordCachedChatRows(
  page: Page,
  requiredTitles: readonly string[],
): Promise<void> {
  await page.addInitScript((titles) => {
    Reflect.set(globalThis, "badgePersistCachedChatRows", undefined);
    new MutationObserver(() => {
      if (Reflect.get(globalThis, "badgePersistCachedChatRows") !== undefined)
        return;
      const root = document.querySelector("[data-chat-list-hydrating]");
      if (root === null) return;
      const rows = [...root.querySelectorAll<HTMLElement>("[data-buffer-id]")];
      if (
        !titles.every((title) =>
          rows.some((row) => row.getAttribute("aria-label")?.startsWith(title)),
        )
      )
        return;
      Reflect.set(
        globalThis,
        "badgePersistCachedChatRows",
        rows.map((row) => ({
          label: row.getAttribute("aria-label") ?? "",
          text: row.textContent ?? "",
        })),
      );
    }).observe(document, { childList: true, subtree: true });
  }, requiredTitles);
}

function cachedChatRows(
  page: Page,
): Promise<readonly { label: string; text: string }[] | undefined> {
  return page.evaluate(() =>
    Reflect.get(globalThis, "badgePersistCachedChatRows"),
  );
}

async function visibleChatRows(
  page: Page,
): Promise<readonly { label: string; text: string }[]> {
  return page.locator("[data-buffer-id]").evaluateAll((rows) =>
    rows.map((row) => ({
      label: row.getAttribute("aria-label") ?? "",
      text: row.textContent ?? "",
    })),
  );
}

async function expectUnreadCount(
  row: ReturnType<typeof bufferRow>,
  title: string,
  count: number,
): Promise<void> {
  await expect(row).toHaveAttribute(
    "aria-label",
    new RegExp(`^${escapeRegex(title)}, ${count} unread`, "u"),
  );
}

async function expectNewDividerBetween(
  page: Page,
  before: string,
  after: string,
): Promise<void> {
  const index = (locator: Locator) =>
    locator.evaluate((element) => Number(element.closest("li")?.dataset.index));
  await expect
    .poll(async () => {
      const [divider, beforeIndex, afterIndex] = await Promise.all([
        index(page.locator("[data-new-line]")),
        index(page.getByText(before, { exact: true })),
        index(page.getByText(after, { exact: true })),
      ]);
      return [divider - beforeIndex, afterIndex - divider];
    })
    .toEqual([1, 1]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function messageTag(line: string | undefined, tag: string): string {
  const value = new RegExp(`(?:^@|;)${tag}=([^; ]+)`, "u").exec(
    line ?? "",
  )?.[1];
  if (value === undefined) throw new Error(`IRC line missing ${tag}: ${line}`);
  return value;
}

async function observeMarkReadRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, { badgePersistMarkReadRequests: 0 });
    const observe = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "request" ||
        !("payload" in message) ||
        typeof message.payload !== "object" ||
        message.payload === null ||
        !("request" in message.payload) ||
        typeof message.payload.request !== "object" ||
        message.payload.request === null ||
        !("type" in message.payload.request) ||
        message.payload.request.type !== "mark_read"
      )
        return;
      const state = window as Window & {
        badgePersistMarkReadRequests: number;
      };
      state.badgePersistMarkReadRequests += 1;
    };
    const wrap = (prototype: {
      postMessage: (...arguments_: unknown[]) => unknown;
    }) => {
      const postMessage = prototype.postMessage;
      prototype.postMessage = function (...arguments_: unknown[]) {
        observe(arguments_[0]);
        return Reflect.apply(postMessage, this, arguments_);
      };
    };
    wrap(MessagePort.prototype as unknown as Parameters<typeof wrap>[0]);
    wrap(Worker.prototype as unknown as Parameters<typeof wrap>[0]);
  });
}

function markReadRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as Window & { badgePersistMarkReadRequests: number })
        .badgePersistMarkReadRequests,
  );
}

async function transcriptOrders(
  page: Page,
  earlier: string,
  later: string,
): Promise<boolean> {
  return page.locator("[data-message-row]").evaluateAll(
    (rows, [earlierText, laterText]) => {
      const earlierIndex = rows.findIndex(
        (row) => row.getAttribute("data-message-text") === earlierText,
      );
      const laterIndex = rows.findIndex(
        (row) => row.getAttribute("data-message-text") === laterText,
      );
      return earlierIndex >= 0 && earlierIndex < laterIndex;
    },
    [earlier, later],
  );
}
