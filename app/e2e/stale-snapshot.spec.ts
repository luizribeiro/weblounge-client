import {
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import {
  captureHistoryWire,
  heldHistoryRequestCount,
  heldLatestHistoryCount,
  releaseHeldHistoryRequest,
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

  test("drops a beta transcript gap that has no restored timeline range", async ({
    baseURL,
    page,
  }) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const nick = `stuck-gap-${Date.now().toString(36)}`;
    let forwarderDropped = false;
    try {
      await page.goto("/config.json");
      await seedUnreadDirectSnapshot(
        page,
        baseURL,
        nick,
        `${nick}: cached message`,
        [],
        [],
        1,
        1_800_000_000_000,
        7,
        100,
      );
      await useDedicatedWorker(page);
      await controlForwarder("drop");
      forwarderDropped = true;

      await page.goto(startUrl());

      await expect(bufferRow(page, nick)).toHaveAccessibleName(
        new RegExp(`^${nick}(?:$|, 1 unread, including mentions$)`, "u"),
      );
    } finally {
      if (forwarderDropped) await controlForwarder("restore");
    }
  });

  test("first paint retains an own send after immediate relaunch", async ({
    baseURL,
    browser,
    browserName,
  }) => {
    const { defaultBrowserType: _browser, ...device } =
      devices[browserName === "webkit" ? "iPhone 16 Pro" : "Pixel 7"];
    const context = await browser.newContext({ ...device, baseURL });
    const suffix = Date.now().toString(36).slice(-6);
    const channels = [`#own-send-${suffix}`, `#other-${suffix}`];
    const [target, other] = channels;
    if (target === undefined || other === undefined)
      throw new Error("relaunch channels are missing");
    const appAccount = `own-send-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const keeper = await IrcClient.connectIsolated(appAccount, target);
    await keeper.joinAll([other]);
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const bot = await IrcClient.connect(
      `own-send-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      other,
    );
    let current = await context.newPage();
    let forwarderDropped = false;
    try {
      await useDedicatedWorker(current);
      await current.goto(
        startUrlForAccount(appAccount, appPassword, ...channels),
      );
      for (const channel of channels)
        await expect(bufferRow(current, channel)).toBeVisible();
      await bot.privmsgConfirmed(other, `newer other ${suffix}`);

      await bufferRow(current, target).click();
      const own = `own relaunch preview ${suffix}`;
      const composer = current.getByRole("textbox", {
        name: `Message ${target}`,
      });
      await composer.fill(own);
      await composer.press("Enter");
      await expect(messageRow(current, own, "confirmed")).toHaveCount(1);
      await expect
        .poll(() => selectedChatRows(current, channels))
        .toEqual([
          {
            title: target,
            preview: `${appAccount}: ${own}`,
            time: expect.stringMatching(/\S/u),
          },
          expect.objectContaining({ title: other }),
        ]);
      const finalRows = await selectedChatRows(current, channels);

      await controlForwarder("drop");
      forwarderDropped = true;
      await backgroundPage(current);
      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordFirstChatRows(current, channels);
      await current.goto(
        startUrlForAccount(appAccount, appPassword, ...channels),
      );
      await expect.poll(() => firstChatRows(current)).toEqual(finalRows);
    } finally {
      if (forwarderDropped) await controlForwarder("restore");
      if (!current.isClosed()) await current.close();
      await context.close();
      bot.close();
    }
  });

  test("first paint retains an own send from a loading cached DM", async ({
    baseURL,
    browser,
    browserName,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const { defaultBrowserType: _browser, ...device } =
      devices[browserName === "webkit" ? "iPhone 16 Pro" : "Pixel 7"];
    const context = await browser.newContext({ ...device, baseURL });
    const suffix = Date.now().toString(36).slice(-6);
    const appAccount = `own-dm-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const keeper = await IrcClient.connectIsolated(
      appAccount,
      "#weblounge-test",
    );
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const target = await IrcClient.connect(
      `own-dm-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const other = await IrcClient.connect(
      `other-dm-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const titles = [target.nickname, other.nickname];
    let current = await context.newPage();
    let forwarderDropped = false;
    try {
      await current.goto("/config.json");
      await seedUnreadDirectSnapshot(
        current,
        baseURL,
        target.nickname,
        `stale direct ${suffix}`,
        [],
        [],
        0,
        100,
      );
      await captureHistoryWire(current, {
        holdRequest: `CHATHISTORY LATEST ${target.nickname} `,
      });
      await useDedicatedWorker(current);
      await current.goto(startUrlForAccount(appAccount, appPassword));
      await other.privmsgConfirmed(appAccount, `newer other ${suffix}`);
      await expect(bufferRow(current, other.nickname)).toBeVisible();

      await bufferRow(current, target.nickname).click();
      await expect.poll(() => heldHistoryRequestCount(current)).toBe(1);
      const own = `own cached direct ${suffix}`;
      const composer = current.getByRole("textbox", {
        name: `Message ${target.nickname}`,
      });
      await composer.fill(own);
      await composer.press("Enter");
      await expect(messageRow(current, own, "confirmed")).toHaveCount(1);
      await expect
        .poll(() => selectedChatRows(current, titles))
        .toEqual([
          {
            title: target.nickname,
            preview: `You: ${own}`,
            time: expect.stringMatching(/\S/u),
          },
          expect.objectContaining({ title: other.nickname }),
        ]);
      const finalRows = await selectedChatRows(current, titles);

      await controlForwarder("drop");
      forwarderDropped = true;
      await backgroundPage(current);
      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordFirstChatRows(current, titles);
      await current.goto(startUrlForAccount(appAccount, appPassword));
      await expect.poll(() => firstChatRows(current)).toEqual(finalRows);
    } finally {
      if (forwarderDropped) await controlForwarder("restore");
      if (!current.isClosed()) await current.close();
      await context.close();
      target.close();
      other.close();
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
        .poll(() => snapshotReadState(current, channel))
        .toEqual({ gap: false, mentions: 0, unread: history.length });
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ preview: snapshotPreview });

      const markerReader = await IrcClient.connect(
        appAccount,
        appAccount,
        appPassword,
        channel,
      );
      try {
        await closeAppUntilDetached(current, markerReader);
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
        .poll(() => snapshotReadState(current, channel))
        .toEqual({ gap: false, mentions: 0, unread: history.length });
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
        .poll(() => snapshotReadState(current, channel))
        .toEqual({ gap: false, mentions: 0, unread: 0 });

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
        .poll(() => snapshotReadState(current, bot.nickname))
        .toEqual({ gap: true, mentions: 100, unread: 100 });
      await installStorageWriteFailureControl(current);
      await observeVisibleCountIncrease(current, bot.nickname);
      await recordCachedRow(current, bot.nickname);
      await controlForwarder("drop");
      forwarderDropped = true;
      await current.goto(startUrl());
      await expect(bufferRow(current, bot.nickname)).toHaveAttribute(
        "data-unread",
        "0",
      );
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          unread: "0",
        });
      await failNextStorageWrite(current);
      await controlForwarder("restore");
      forwarderDropped = false;
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
      await expect(bufferRow(current, bot.nickname)).toHaveAttribute(
        "data-unread",
        "0",
      );
      expect(await visibleCountIncreased(current)).toBe(false);

      await expect
        .poll(() => snapshotReadState(current, bot.nickname))
        .toEqual({ gap: false, mentions: 0, unread: 0 });
      await current.close();

      current = await context.newPage();
      await useFreshSharedWorker(current);
      await recordCachedRow(current, bot.nickname);
      await controlForwarder("drop");
      forwarderDropped = true;
      await current.goto(startUrl());
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({ unread: "0" });
      await controlForwarder("restore");
      forwarderDropped = false;
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
    const text = `snapshot direct ${suffix}`;
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
      const latest = await bot.privmsgConfirmed("weblounge", text);
      const latestTime = messageTag(latest, "time");
      const row = bufferRow(current, bot.nickname);
      await expectUnreadCount(row, bot.nickname, 1);
      await expect
        .poll(() => snapshotReadState(current, bot.nickname))
        .toEqual({ gap: false, mentions: 1, unread: 1 });

      await failNextStorageWrite(current);
      await row.click();
      await expect(
        current.getByRole("heading", { name: bot.nickname }),
      ).toBeVisible();
      await expect(current.getByText(text, { exact: true })).toBeVisible();
      await expectRead(row, bot.nickname);
      await expect.poll(() => markReadRequestCount(current)).toBeGreaterThan(0);
      await expect
        .poll(() => storageWriteAbortCount(current))
        .toBeGreaterThan(0);
      await expect
        .poll(() => markerReader.readMarker(bot.nickname))
        .toBe(latestTime);

      await expect
        .poll(() => snapshotReadState(current, bot.nickname))
        .toEqual({ gap: false, mentions: 0, unread: 0 });
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

  test("keeps a remotely read DM clear across an immediate reload", async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#immediate-read-${suffix}`;
    const appAccount = `immediate-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const text = `immediate read ${suffix}`;
    const keeper = await IrcClient.connectIsolated(appAccount, channel);
    const bot = await IrcClient.connect(
      `immediate-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    let markerReader: IrcClient | undefined;
    try {
      await keeper.setAlwaysOn(true);
      keeper.close();
      await keeper.waitForDisconnect();
      await useDedicatedWorker(page);
      await recordCachedRow(page, bot.nickname);
      await page.goto(startUrlForAccount(appAccount, appPassword, channel));
      await expect(bufferRow(page, channel)).toBeVisible();
      const line = await bot.privmsgConfirmed(appAccount, text);
      await expectUnreadCount(bufferRow(page, bot.nickname), bot.nickname, 1);
      await expect
        .poll(() => snapshotReadState(page, bot.nickname))
        .toEqual({ gap: false, mentions: 1, unread: 1 });

      markerReader = await IrcClient.connect(
        appAccount,
        appAccount,
        appPassword,
        channel,
      );
      await markerReader.markRead(bot.nickname, messageTag(line, "time"));
      await expectRead(bufferRow(page, bot.nickname), bot.nickname);
      await backgroundPage(page);
      await expect
        .poll(() => snapshotReadState(page, bot.nickname))
        .toEqual({ gap: false, mentions: 0, unread: 0 });

      await page.goto(startUrlForAccount(appAccount, appPassword, channel));
      await expect
        .poll(() => cachedRow(page))
        .toMatchObject({
          label: bot.nickname,
          unread: isMobile(page) ? null : "0",
        });
    } finally {
      markerReader?.close();
      keeper.close();
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

  test("persists restored pushed rows before an immediate background relaunch", async ({
    baseURL,
    browser,
    browserName,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const { defaultBrowserType: _browser, ...device } =
      devices[browserName === "webkit" ? "iPhone 16 Pro" : "Pixel 7"];
    const context = await browser.newContext({ ...device, baseURL });
    const suffix = Date.now().toString(36).slice(-6);
    const channels = Array.from(
      { length: 3 },
      (_, index) => `#relaunch-${index}-${suffix}`,
    );
    const firstChannel = channels[0];
    if (firstChannel === undefined) throw new Error("first channel is missing");
    const appAccount = `relaunch-user-${suffix}`;
    const appPassword = `test-${appAccount}`;
    const keeper = await IrcClient.connectIsolated(appAccount, firstChannel);
    await keeper.joinAll(channels.slice(1));
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const bots = await Promise.all(
      channels.map((channel, index) =>
        IrcClient.connect(
          `relaunch-${index}-${suffix}`,
          "weblounge-bot",
          "weblounge-bot-test",
          channel,
        ),
      ),
    );
    let current = await context.newPage();
    let forwarderDropped = false;
    try {
      await installWorkerControl(current);
      await useDedicatedWorker(current);
      await current.goto(
        startUrlForAccount(appAccount, appPassword, ...channels),
      );
      for (const channel of channels)
        await expect(bufferRow(current, channel)).toBeVisible();

      const initialPreviews = channels.map(
        (channel, index) => `initial ${index} ${channel} ${suffix}`,
      );
      for (const [index, channel] of channels.entries()) {
        const preview = initialPreviews[index];
        if (preview === undefined)
          throw new Error("initial preview is missing");
        const bot = bots[index];
        if (bot === undefined) throw new Error("initial bot is missing");
        await bot.privmsgConfirmed(channel, preview);
      }
      for (const [index, channel] of channels.entries()) {
        const preview = initialPreviews[index];
        if (preview === undefined)
          throw new Error("initial preview is missing");
        await expect(bufferRow(current, channel)).toContainText(preview);
        await expect
          .poll(() => snapshotRow(current, channel))
          .toMatchObject({ preview: expect.stringContaining(preview) });
      }

      const finalPreviews = channels.map(
        (channel, index) => `final ${index} ${channel} ${suffix}`,
      );
      const activityBase = Date.now() + 1_000;
      await controlForwarder("drop");
      forwarderDropped = true;
      for (const [index, channel] of channels.entries()) {
        const preview = finalPreviews[index];
        if (preview === undefined) throw new Error("final preview is missing");
        const bot = bots[index];
        if (bot === undefined) throw new Error("final bot is missing");
        const line = await bot.privmsgConfirmed(channel, preview);
        await seedPushedMessage(current, {
          nickname: appAccount,
          sender: bot.nickname,
          target: channel,
          text: preview,
          msgid: messageTag(line, "msgid"),
          time: new Date(activityBase + index * 1_000).toISOString(),
        });
      }
      await controlledEngineRequest(current, {
        type: "load_pushed_messages",
        network_id: 1,
      });

      const expectedOrder = [...channels].reverse();
      await expect
        .poll(() => selectedChatRows(current, channels))
        .toEqual(
          expectedOrder.map((title, index) => ({
            title,
            preview: `${bots[bots.length - index - 1]?.nickname}: ${finalPreviews[finalPreviews.length - index - 1]}`,
            time: expect.stringMatching(/\S/u),
          })),
        );
      const finalRows = await selectedChatRows(current, channels);
      await deletePushedMessages(current);
      await backgroundPage(current);
      await current.close();

      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordFirstChatRows(current, channels);
      await current.goto(
        startUrlForAccount(appAccount, appPassword, ...channels),
      );
      await expect.poll(() => firstChatRows(current)).toEqual(finalRows);
    } finally {
      if (forwarderDropped) await controlForwarder("restore");
      if (!current.isClosed()) await current.close();
      await context.close();
      keeper.close();
      for (const bot of bots) bot.close();
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
        .poll(() => snapshotReadState(current, bot.nickname))
        .toEqual({ gap: false, mentions: 2, unread: 2 });
      await expect
        .poll(() => snapshotRows(current, titles))
        .toEqual(await visibleRows(current, titles));

      await closeAppUntilDetached(current, markerReader);
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
      await captureHistoryWire(current, {
        holdRequest: `CHATHISTORY LATEST ${channel} `,
      });
      await useDedicatedWorker(current);
      await observeMarkReadRequests(current);
      await current.goto(
        startUrlForAccount(
          appAccount,
          appPassword,
          homeChannel,
          channel,
          emptyChannel,
        ),
      );
      let catchupState: "complete" | "held" | undefined;
      await expect
        .poll(async () => {
          if ((await heldHistoryRequestCount(current)) === 1)
            catchupState = "held";
          else if (
            (
              await bufferRow(current, channel).getAttribute("aria-label")
            )?.startsWith(`${channel}, 3 unread`) === true
          )
            catchupState = "complete";
          return catchupState;
        })
        .not.toBeUndefined();
      if (catchupState === "held") {
        await expectRead(bufferRow(current, channel), channel);
        await releaseHeldHistoryRequest(current);
      }
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
      await expectRead(bufferRow(current, channel), channel);
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
    } finally {
      if (!current.isClosed()) await current.close();
      keeper.close();
      markerReader.close();
      bot.close();
    }
  });

  test("flushes a cleared restored DM while another row is still syncing", async ({
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
      await expect
        .poll(() => snapshotReadState(current, bot.nickname))
        .toEqual({ gap: false, mentions: 0, unread: 0 });
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

// Page close resolves before the engine worker's IRC socket detaches, so lines
// sent in between still reach the closing app and its snapshot.
async function closeAppUntilDetached(
  page: Page,
  sameAccount: IrcClient,
): Promise<void> {
  const attached = await sameAccount.attachedClientCount();
  await page.close();
  await expect.poll(() => sameAccount.attachedClientCount()).toBe(attached - 1);
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

async function snapshotReadState(
  page: Page,
  title: string,
): Promise<{ gap: boolean; mentions: number; unread: number } | undefined> {
  const row = await snapshotRow(page, title);
  if (row === undefined) return undefined;
  return snapshotFacts(title, row);
}

function snapshotLabel(title: string, value: unknown): string {
  const facts = snapshotFacts(title, value);
  if (facts.unread === 0 && !facts.gap) return title;
  const count = facts.gap || facts.unread > 99 ? "99+" : facts.unread;
  return facts.mentions > 0
    ? `${title}, ${count} unread, including mentions`
    : `${title}, ${count} unread`;
}

function snapshotFacts(
  title: string,
  value: unknown,
): { gap: boolean; mentions: number; unread: number } {
  if (typeof value !== "object" || value === null || !("stubs" in value))
    throw new Error(`Snapshot row missing stubs for ${title}`);
  if (!Array.isArray(value.stubs))
    throw new Error(`Snapshot row has invalid stubs for ${title}`);
  const mentions = value.stubs.filter(
    (stub) =>
      typeof stub === "object" &&
      stub !== null &&
      "mention" in stub &&
      stub.mention === true,
  ).length;
  return {
    gap: "gap_until" in value && typeof value.gap_until === "number",
    mentions,
    unread: value.stubs.length,
  };
}

async function recordCachedRow(page: Page, channel: string): Promise<void> {
  await page.addInitScript((title) => {
    Reflect.set(globalThis, "staleSnapshotCachedRow", undefined);
    new MutationObserver(() => {
      if (Reflect.get(globalThis, "staleSnapshotCachedRow") !== undefined)
        return;
      const row = [
        ...document.querySelectorAll<HTMLElement>("[data-buffer-id]"),
      ].find((candidate) => candidate.textContent?.includes(title));
      if (row !== undefined)
        Reflect.set(globalThis, "staleSnapshotCachedRow", {
          label: row.getAttribute("aria-label"),
          text: row.textContent ?? "",
          unread: row.getAttribute("data-unread"),
        });
    }).observe(document, {
      attributeFilter: ["aria-label", "data-unread"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, channel);
}

function cachedRow(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "staleSnapshotCachedRow"));
}

async function observeVisibleCountIncrease(
  page: Page,
  title: string,
): Promise<void> {
  await page.addInitScript((title) => {
    Reflect.set(globalThis, "staleSnapshotVisibleCountIncreased", false);
    new MutationObserver(() => {
      const row = [...document.querySelectorAll("[data-buffer-id]")].find(
        (candidate) => candidate.textContent?.includes(title),
      );
      if (Number(row?.getAttribute("data-unread")) > 0)
        Reflect.set(globalThis, "staleSnapshotVisibleCountIncreased", true);
    }).observe(document, {
      attributeFilter: ["data-unread"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, title);
}

function visibleCountIncreased(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      Reflect.get(globalThis, "staleSnapshotVisibleCountIncreased") === true,
  );
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
  lastActivityMs = 1_800_000_000_000,
  schema = 6,
  gapUntil?: number,
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
        schema,
        fingerprint,
        rows: [
          {
            conversation: { kind: "direct", key: nick },
            title: nick,
            last_activity_ms: lastActivityMs,
            stubs: Array.from({ length: Math.min(count, 100) }, (_, index) => ({
              mention: true,
              msgid: `cached-${nick}-${index}`,
              time: index + 1,
            })),
            ...(gapUntil !== undefined
              ? { gap_until: gapUntil }
              : count > 100
                ? { gap_until: 100 }
                : {}),
            preview,
          },
          ...backgroundDirects.map((backgroundNick, index) => ({
            conversation: { kind: "direct", key: backgroundNick },
            title: backgroundNick,
            last_activity_ms: 1_799_999_999_999 - index,
            stubs: [],
            preview: `cached ${backgroundNick}`,
          })),
          ...channels.map((channel, index) => ({
            conversation: { kind: "channel", key: channel },
            title: channel,
            last_activity_ms:
              1_799_999_999_999 - backgroundDirects.length - index,
            stubs: [],
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
        Reflect.set(globalThis, "staleSnapshotFailNextWrite", () => {
          this.port.postMessage({ type: "storage_write_test_fail_next" });
        });
      }
    }
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: StorageFailureSharedWorker,
    });
  });
}

async function installWorkerControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    class ControlledWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const results = new Map<string, string>();
        Reflect.set(globalThis, "controlledEngineResults", results);
        this.addEventListener("message", (event) => {
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "id" in event.data &&
            typeof event.data.id === "string" &&
            results.has(event.data.id) &&
            "type" in event.data &&
            typeof event.data.type === "string"
          )
            results.set(event.data.id, event.data.type);
        });
        Reflect.set(
          globalThis,
          "sendControlledEngineRequest",
          (request: Readonly<Record<string, unknown>>) => {
            const id = crypto.randomUUID();
            results.set(id, "pending");
            this.postMessage({ type: "request", payload: { id, request } });
            return id;
          },
        );
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: ControlledWorker,
    });
  });
}

async function controlledEngineRequest(
  page: Page,
  request: Readonly<Record<string, unknown>>,
): Promise<void> {
  const requestId = await page.evaluate((engineRequest) => {
    const send = Reflect.get(globalThis, "sendControlledEngineRequest");
    if (typeof send !== "function")
      throw new Error("engine control was not installed");
    return String(send(engineRequest));
  }, request);
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const results = Reflect.get(globalThis, "controlledEngineResults");
        return results instanceof Map ? results.get(id) : undefined;
      }, requestId),
    )
    .toBe("command_result");
}

async function seedPushedMessage(
  page: Page,
  message: {
    readonly nickname: string;
    readonly msgid: string;
    readonly sender: string;
    readonly target: string;
    readonly text: string;
    readonly time: string;
  },
): Promise<void> {
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(async (value, pushed) => {
      await new Promise<void>((resolve, reject) => {
        const encoder = new TextEncoder();
        const transaction = value.transaction("cache", "readwrite");
        transaction.objectStore("cache").put(
          encoder.encode(
            JSON.stringify({
              schema: 1,
              network_label: "Local Ergo",
              nickname: pushed.nickname,
              sender: pushed.sender,
              target: pushed.target,
              msgid: pushed.msgid,
              time: pushed.time,
              text: pushed.text,
              kind: "message",
            }),
          ),
          encoder.encode(`pushed-message\0Local Ergo\0${pushed.msgid}`),
        );
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }, message);
  } finally {
    await closeEngineDatabase(database);
  }
}

async function deletePushedMessages(page: Page): Promise<void> {
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(async (value) => {
      await new Promise<void>((resolve, reject) => {
        const transaction = value.transaction("cache", "readwrite");
        const store = transaction.objectStore("cache");
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          const key = new TextDecoder().decode(cursor.key as Uint8Array);
          if (key.startsWith("pushed-message\0")) cursor.delete();
          cursor.continue();
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    });
  } finally {
    await closeEngineDatabase(database);
  }
}

function storageWriteAbortCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const count = Reflect.get(globalThis, "staleSnapshotWriteAbortCount");
    return typeof count === "number" ? count : 0;
  });
}

async function failNextStorageWrite(page: Page): Promise<void> {
  await page.evaluate(() => {
    const failNext = Reflect.get(globalThis, "staleSnapshotFailNextWrite");
    if (typeof failNext !== "function")
      throw new Error("storage write failure control is unavailable");
    failNext();
  });
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
      const rows = [
        ...document.querySelectorAll<HTMLElement>("[data-buffer-id]"),
      ];
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
    }).observe(document, {
      attributeFilter: ["aria-label"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, requiredTitles);
}

interface SelectedChatRow {
  readonly title: string;
  readonly preview: string;
  readonly time: string;
}

async function selectedChatRows(
  page: Page,
  titles: readonly string[],
): Promise<readonly SelectedChatRow[]> {
  return page.locator("[data-mobile-chat-list] [data-buffer-id]").evaluateAll(
    (rows, expectedTitles) =>
      rows.flatMap((row) => {
        const label = row.getAttribute("aria-label") ?? "";
        const title = expectedTitles.find(
          (candidate) =>
            label === candidate || label.startsWith(`${candidate},`),
        );
        if (title === undefined) return [];
        const preview =
          row.querySelector("time")?.parentElement?.nextElementSibling
            ?.textContent;
        return [
          {
            title,
            preview: preview ?? "",
            time: row.querySelector("time")?.textContent ?? "",
          },
        ];
      }),
    titles,
  );
}

async function recordFirstChatRows(
  page: Page,
  requiredTitles: readonly string[],
): Promise<void> {
  await page.addInitScript((titles) => {
    Reflect.set(globalThis, "firstRelaunchChatRows", undefined);
    const capture = () => {
      if (Reflect.get(globalThis, "firstRelaunchChatRows") !== undefined)
        return;
      const rows = [
        ...document.querySelectorAll(
          "[data-mobile-chat-list] [data-buffer-id]",
        ),
      ];
      const selected = rows.flatMap((row) => {
        const label = row.getAttribute("aria-label") ?? "";
        const title = titles.find(
          (candidate) =>
            label === candidate || label.startsWith(`${candidate},`),
        );
        if (title === undefined) return [];
        const preview =
          row.querySelector("time")?.parentElement?.nextElementSibling
            ?.textContent;
        return [
          {
            title,
            preview: preview ?? "",
            time: row.querySelector("time")?.textContent ?? "",
          },
        ];
      });
      if (selected.length === titles.length)
        Reflect.set(globalThis, "firstRelaunchChatRows", selected);
    };
    new MutationObserver(capture).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, requiredTitles);
}

function firstChatRows(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "firstRelaunchChatRows"));
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
