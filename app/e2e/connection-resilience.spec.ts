import { createConnection } from "node:net";
import type { Locator, Page } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import {
  captureHistoryWire,
  heldHistoryRequestCount,
  historyMessageUpdateCount,
  holdHistoryRequest,
  releaseHeldHistoryRequest,
} from "./history-wire-fixture";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { expectEqualAtDevicePixelPrecision } from "./motion-assertions";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { visibleMessageAnchor } from "./visible-message-anchor";

test.describe("connection resilience against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.beforeEach(async ({ irc }) => {
    await enableAppAlwaysOn(irc);
  });

  test(
    "keeps the same screen, scroll, and draft through background socket loss",
    {
      tag: "@serial",
    },
    async ({ page, irc }, testInfo) => {
      const channel = irc.channel;
      test.skip(
        process.env.WEBLOUNGE_ERGO_CONTROL_PID === undefined,
        "requires the restartable Ergo fixture",
      );
      await installNativeFeelInstrumentation(page);
      let bot = await irc.peer("resume");
      let ergoStopped = false;
      try {
        const composer = await openChannel(page, irc, testInfo.project.name);
        const list = page.locator("[data-message-list]");
        const mobile = isMobile(testInfo.project.name);
        const seedCount = 20;
        const seedTail = mobile ? "" : " wrapped message".repeat(10);
        for (let index = 0; index < seedCount; index += 1)
          await bot.privmsgConfirmed(
            channel,
            `resume seed ${index}${seedTail}`,
          );
        await expect(
          page.getByText(`resume seed ${seedCount - 1}${seedTail}`, {
            exact: true,
          }),
        ).toHaveCount(1);
        const scrollDistance = mobile ? 3 : 40;
        await expect
          .poll(() => messageListScrollRange(list))
          .toBeGreaterThan(scrollDistance * 3);
        const scrollTop = mobile
          ? await scrollAwayFromLiveEdge(page, list, {
              distance: scrollDistance,
              input: "touch",
            })
          : await scrollDesktopBetweenEdges(page, list, scrollDistance);
        expect(scrollTop).toBeGreaterThan(0);
        const scrollAnchor = await list.evaluate(visibleMessageAnchor);
        const draft = `draft survives ${Date.now()}`;
        await composer.fill(draft);

        await setVisibility(page, true);
        process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR1");
        ergoStopped = true;
        await bot.waitForDisconnect();
        await setVisibility(page, false);
        await dispatchPersistedPageShow(page);
        await expectTransientConnectionPresentation(
          page,
          isMobile(testInfo.project.name),
        );
        await expectShellToRemain(page, channel);
        await expectErgoStopped();

        if (!isMobile(testInfo.project.name)) {
          await page.emulateMedia({ colorScheme: "light" });
          await page.screenshot({
            path: "e2e/screenshots/connection-reconnecting-light.png",
          });
          await page.emulateMedia({ colorScheme: "dark" });
          await page.screenshot({
            path: "e2e/screenshots/connection-reconnecting-dark.png",
          });
        }

        process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
        await expectErgoReady();
        await dispatchPersistedPageShow(page);
        ergoStopped = false;
        await expectOnline(page, testInfo.project.name);
        await expect(composer).toHaveValue(draft);
        await expect(
          page.getByText(scrollAnchor.text, { exact: true }),
        ).toBeInViewport();
        await expect
          .poll(() => scrollAnchorOffset(list, scrollAnchor.text))
          .toBeCloseTo(scrollAnchor.offset, 0);

        bot = await irc.peer("resumed");
        await list.press("End");
        await expect(
          page.getByRole("button", { name: /new message/ }),
        ).toHaveCount(0);
        await sendAndExpectEcho(
          page,
          bot,
          channel,
          `after resume ${Date.now()}`,
        );
        await expectShellToRemain(page, channel);
      } finally {
        if (ergoStopped) {
          process.kill(
            Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID),
            "SIGUSR2",
          );
          await expectErgoReady();
        }
      }
    },
  );

  test("queues offline sends in order and confirms them after reconnect", async ({
    context,
    page,
    irc,
  }, testInfo) => {
    const channel = irc.channel;
    await installNativeFeelInstrumentation(page);
    const composer = await openChannel(page, irc, testInfo.project.name);
    const conversation = conversationColumn(page, testInfo.project.name);
    const conversationWidth = await elementWidth(conversation);
    const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    if (isMobile(testInfo.project.name))
      expectEqualAtDevicePixelPrecision(
        conversationWidth,
        await page.evaluate(() => document.documentElement.clientWidth),
        devicePixelRatio,
      );

    await context.setOffline(true);
    await expectTransientConnectionPresentation(
      page,
      isMobile(testInfo.project.name),
    );
    expectEqualAtDevicePixelPrecision(
      await elementWidth(conversation),
      conversationWidth,
      devicePixelRatio,
    );
    await expect(
      page.getByText(/Connecting|Reconnecting|Offline/u),
    ).toHaveCount(0);
    const texts = [`offline one ${Date.now()}`, `offline two ${Date.now()}`];
    for (const text of texts) {
      await composer.fill(text);
      await composer.press("Enter");
      await expect(messageRow(page, text, "optimistic")).toHaveCount(1);
    }
    await expectShellToRemain(page, channel);

    await context.setOffline(false);
    await setVisibility(page, false);
    await dispatchPersistedPageShow(page);
    for (const text of texts)
      await expect(messageRow(page, text, "confirmed")).toHaveCount(1);
    const order = await page
      .locator("[data-message-row]")
      .evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.messageText ?? ""),
      );
    expect(order.indexOf(texts[0] ?? "")).toBeLessThan(
      order.indexOf(texts[1] ?? ""),
    );
    await expectShellToRemain(page, channel);
  });

  test("bounds a send queued on a silently dead resumed socket", async ({
    page,
    irc,
  }, testInfo) => {
    test.skip(
      !isMobile(testInfo.project.name),
      "iOS suspension regression uses the mobile lifecycle",
    );
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    await installNativeFeelInstrumentation(page);
    await captureHistoryWire(page);
    let dropped = false;
    try {
      const composer = await openChannel(page, irc, testInfo.project.name);
      await irc.forwarder.drop();
      dropped = true;

      const text = `queued on dead socket ${Date.now()}`;
      await composer.fill(text);
      await composer.press("Enter");
      await expect(messageRow(page, text, "optimistic")).toHaveCount(1);

      await setVisibility(page, true);
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      await waitForForegroundProbeToGiveUp(page, testInfo.project.name);
      await expectTransientConnectionPresentation(
        page,
        isMobile(testInfo.project.name),
      );
      await irc.forwarder.restore();
      dropped = false;

      await expectOnline(page, testInfo.project.name);
      await expect.poll(() => sentWireLineCount(page, text)).toBe(1);
      await expect(messageRow(page, text, "failed")).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "Failed · Retry" }),
      ).toHaveCount(1);
    } finally {
      if (dropped) await irc.forwarder.restore();
    }
  });

  test("reconciles a send when its first server echo is lost", async ({
    page,
    irc,
  }, testInfo) => {
    const channel = irc.channel;
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    await installNativeFeelInstrumentation(page);
    await captureHistoryWire(page);
    const bot = await irc.peer("lost-echo");
    const composer = await openChannel(page, irc, testInfo.project.name);
    const text = `lost first echo ${Date.now()}`;
    await irc.forwarder.dropIncomingContaining(text);

    await composer.fill(text);
    await composer.press("Enter");
    await expect(messageRow(page, text, "optimistic")).toHaveCount(1);
    await bot.waitForPrivmsg(channel, text, irc.account);

    await expectTransientConnectionPresentation(
      page,
      isMobile(testInfo.project.name),
    );
    await expectOnline(page, testInfo.project.name);
    await expect.poll(() => sentWireLineCount(page, text)).toBe(1);
    await expect(messageRow(page, text, "confirmed")).toHaveCount(1);
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Failed · Retry" }),
    ).toHaveCount(0);
    await expectShellToRemain(page, channel);
  });

  test("keeps the online wasm engine alive through a foreground probe", async ({
    page,
    irc,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
    await installWorkerControl(page);
    await installNativeFeelInstrumentation(page);
    const bot = await irc.peer("probe");
    await openChannel(page, irc, testInfo.project.name);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(Reflect.get(globalThis, "engineWorkerGeneration") ?? 0),
        ),
      )
      .toBe(1);

    await setVisibility(page, true);
    await setVisibility(page, false);
    await dispatchPersistedPageShow(page);
    await sendAndExpectEcho(
      page,
      bot,
      irc.channel,
      `after foreground probe ${Date.now()}`,
    );

    expect(
      await page.evaluate(() =>
        Number(Reflect.get(globalThis, "engineWorkerGeneration") ?? 0),
      ),
    ).toBe(1);
  });

  test("catches up an opened DM and channel after a silently dead socket", async ({
    page,
    irc,
  }, testInfo) => {
    const channel = irc.channel;
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    await installNativeFeelInstrumentation(page);
    const bot = await irc.peer("gap");
    const mobile = isMobile(testInfo.project.name);
    let dropped = false;
    try {
      await openChannel(page, irc, testInfo.project.name);
      const suffix = Date.now();
      const beforeChannel = `before channel gap ${suffix}`;
      await bot.privmsgConfirmed(channel, beforeChannel);
      await expect(transcriptRow(page, beforeChannel)).toHaveCount(1);

      const beforeDm = `before direct gap ${suffix}`;
      await bot.privmsgConfirmed(irc.account, beforeDm);
      if (mobile)
        await page.getByRole("button", { name: "Back to chats" }).click();
      await page
        .getByRole("button", { name: new RegExp(`^${bot.nickname}`) })
        .click();
      await expect(transcriptRow(page, beforeDm)).toHaveCount(1);

      await irc.forwarder.drop();
      dropped = true;
      const gapDm = `missed direct ${suffix}`;
      const gapChannel = `missed channel ${suffix}`;
      await bot.privmsgConfirmed(irc.account, gapDm);
      await bot.privmsgConfirmed(channel, gapChannel);

      await setVisibility(page, true);
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      await expectTransientConnectionPresentation(page, mobile);
      await irc.forwarder.restore();
      dropped = false;

      await expectOnline(page, testInfo.project.name);
      await expect(transcriptRow(page, gapDm)).toHaveCount(1);
      if (mobile)
        await page.getByRole("button", { name: "Back to chats" }).click();
      await page.getByRole("button", { name: channel }).first().click();
      await expect(transcriptRow(page, gapChannel)).toHaveCount(1);
    } finally {
      if (dropped) await irc.forwarder.restore();
    }
  });

  test("shows history loading when a warm chat-list buffer reconciles a restored push", async ({
    page,
    irc,
  }, testInfo) => {
    const channel = irc.channel;
    const bot = await irc.peer("warm-push");
    const suffix = Date.now().toString(36);
    const partial = `warm push first line ${suffix}`;
    const authoritative = `${partial} and hello ${irc.account} from history`;
    let dropped = false;
    let historyHeld = false;
    try {
      await bot.mode(bot.nickname, "+B");
      await installNativeFeelInstrumentation(page);
      await installWorkerControl(page);
      await captureHistoryWire(page);
      await openChannel(page, irc, testInfo.project.name);
      await holdHistoryRequest(page, `CHATHISTORY LATEST ${channel} `);
      await expect(
        page.locator("[data-conversation-title][data-connection-progress]"),
      ).toHaveCount(0);
      if (isMobile(testInfo.project.name))
        await page.getByRole("button", { name: "Back to chats" }).click();
      else
        await page.getByRole("button", { name: "Local Ergo, online" }).click();
      const channelRows = page
        .locator("[data-buffer-id]")
        .filter({ has: page.getByText(channel, { exact: true }) });
      await expect(channelRows).toHaveCount(1);
      const bufferId = await channelRows.getAttribute("data-buffer-id");
      if (bufferId === null) throw new Error("channel buffer id is missing");
      const channelButton = page.locator(
        `[data-buffer-id=${JSON.stringify(bufferId)}]`,
      );
      await expect(channelButton).toBeVisible();

      await setVisibility(page, true);
      await irc.forwarder.drop();
      dropped = true;
      const identity = messageIdentity(
        await bot.privmsgConfirmed(channel, authoritative),
      );
      await expect(transcriptRow(page, authoritative)).toHaveCount(0);
      await seedPushedMessage(page, irc.account, {
        sender: bot.nickname,
        target: channel,
        text: partial,
        ...identity,
      });
      await controlledEngineRequest(page, {
        type: "load_pushed_messages",
        network_id: 1,
      });
      await expect(channelRows).toHaveCount(1);
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await channelButton.click();
      const title = page.locator("[data-conversation-title]");
      await expect(title).toHaveAttribute("data-connection-progress", "true");
      await expect(title).toHaveAttribute("data-connection-phase", "loading");
      await expect(title).toHaveCSS("animation-duration", "1s");
      await expect(title).toHaveCSS("animation-play-state", "running");
      await expectTransientConnectionPresentation(
        page,
        isMobile(testInfo.project.name),
      );
      const provisional = transcriptRow(page, partial);
      await expect(provisional).toHaveCount(1);
      await expect(provisional.getByRole("img", { name: "Bot" })).toHaveCount(
        0,
      );
      expect(["", "rgba(0, 0, 0, 0)"]).toContain(
        await highlightPaint(provisional),
      );

      await irc.forwarder.restore();
      dropped = false;
      await expectOnline(page, testInfo.project.name);
      await expect.poll(() => heldHistoryRequestCount(page)).toBe(1);
      historyHeld = true;
      await expect(title).toHaveAttribute("data-connection-progress", "true");
      await expect(title).toHaveAttribute("data-connection-phase", "loading");
      await expect(title).toHaveCSS("animation-play-state", "running");
      await releaseHeldHistoryRequest(page);
      historyHeld = false;
      const reconciled = transcriptRow(page, authoritative);
      await expect(reconciled).toHaveCount(1);
      await expect(reconciled.getByRole("img", { name: "Bot" })).toHaveCount(1);
      await expect
        .poll(() => highlightPaint(reconciled))
        .not.toMatch(/^(?:|rgba\(0, 0, 0, 0\))$/u);
      await expect(provisional).toHaveCount(0);
      await expect(title).not.toHaveAttribute("data-connection-progress");
      await expect(
        page.getByText("Some messages were skipped while reconnecting.", {
          exact: true,
        }),
      ).toHaveCount(0);
    } finally {
      if (historyHeld) await releaseHeldHistoryRequest(page);
      if (dropped) await irc.forwarder.restore();
    }
  });

  test("marks a push-only read before authoritative history arrives", async ({
    page,
    irc,
  }, testInfo) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    const suffix = irc.id;
    const pushedChannel = irc.channelNamed("pushed-read");
    const text = `read before history ${suffix}`;
    const appUrl = irc.url({ autojoin: [pushedChannel] });
    const bot = await irc.peer("push", [pushedChannel]);
    const leaveBot = await irc.peer("leave");
    let markerReader: IrcClient | undefined;
    let dropped = false;
    let historyHeld = false;
    try {
      await installWorkerControl(page);
      await captureHistoryWire(page, {
        holdRequest: `CHATHISTORY LATEST ${pushedChannel} `,
      });
      await observeMarkReadRequests(page);
      await page.goto("/manifest.webmanifest");
      await irc.forwarder.drop();
      dropped = true;
      const identity = messageIdentity(
        await bot.privmsgConfirmed(pushedChannel, text),
      );
      await seedPushedMessage(page, irc.account, {
        sender: bot.nickname,
        target: pushedChannel,
        text,
        ...identity,
      });
      const leaveText = `other pushed row ${suffix}`;
      await seedPushedMessage(page, irc.account, {
        sender: leaveBot.nickname,
        target: irc.account,
        text: leaveText,
        ...messageIdentity(
          await leaveBot.privmsgConfirmed(irc.account, leaveText),
        ),
      });
      markerReader = await irc.self([pushedChannel]);

      await page.goto(appUrl);
      const pushedRow = page.locator(`[data-buffer-id]`).filter({
        has: page.getByText(pushedChannel, { exact: true }),
      });
      await expect(pushedRow).toBeVisible();
      await pushedRow.click();
      await expect(transcriptRow(page, text)).toHaveCount(1);
      if (isMobile(testInfo.project.name)) {
        await expect(pushedRow).toHaveAttribute("aria-label", pushedChannel);
        await page.getByRole("button", { name: "Back to chats" }).click();
        await expect(
          page.getByRole("button", { name: pushedChannel, exact: true }),
        ).toBeVisible();
      } else {
        await expect(pushedRow).toHaveAttribute("data-unread", "0");
      }
      await expect.poll(() => markReadRequestCount(page)).toBeGreaterThan(0);
      await page
        .locator(`[data-buffer-id]`)
        .filter({ has: page.getByText(leaveBot.nickname, { exact: true }) })
        .click();

      await irc.forwarder.restore();
      dropped = false;
      await expect.poll(() => heldHistoryRequestCount(page)).toBe(1);
      historyHeld = true;
      await expect
        .poll(() => markerReader?.readMarker(pushedChannel))
        .toBe(identity.time);
      await releaseHeldHistoryRequest(page);
      historyHeld = false;
      await expect.poll(() => historyMessageUpdateCount(page, text)).toBe(1);
      await expect
        .poll(() => snapshotReadAt(page, pushedChannel))
        .toBe(Date.parse(identity.time));
      await expectOnline(page, testInfo.project.name);

      await page.goto(appUrl);
      if (!isMobile(testInfo.project.name))
        await expectOnline(page, testInfo.project.name);
      const relaunchedRow = page.locator(`[data-buffer-id]`).filter({
        has: page.getByText(pushedChannel, { exact: true }),
      });
      if (isMobile(testInfo.project.name)) {
        await expect(relaunchedRow).toHaveAttribute(
          "aria-label",
          pushedChannel,
        );
      } else {
        await expect(relaunchedRow).toHaveAttribute("data-unread", "0");
      }
    } finally {
      if (historyHeld) await releaseHeldHistoryRequest(page);
      if (dropped) await irc.forwarder.restore();
    }
  });

  test("recovers transparently after the dedicated worker is terminated", async ({
    page,
    irc,
  }, testInfo) => {
    const channel = irc.channel;
    test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
    await installWorkerControl(page);
    await installNativeFeelInstrumentation(page);
    const bot = await irc.peer("worker");
    const composer = await openChannel(page, irc, testInfo.project.name);
    const draft = `worker draft ${Date.now()}`;
    await composer.fill(draft);
    await page.evaluate(() => {
      const terminate = Reflect.get(globalThis, "terminateEngineWorker");
      if (typeof terminate !== "function")
        throw new Error("engine worker control was not installed");
      terminate();
    });
    await expectShellToRemain(page, channel);

    await setVisibility(page, true);
    await setVisibility(page, false);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(Reflect.get(globalThis, "engineWorkerGeneration") ?? 0),
        ),
      )
      .toBeGreaterThan(1);
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await expect(composer).toHaveValue(draft);

    await sendAndExpectEcho(
      page,
      bot,
      channel,
      `after worker restart ${Date.now()}`,
    );
    await expectShellToRemain(page, channel);
  });

  test(
    "recovers after the Ergo process restarts",
    {
      tag: "@serial",
    },
    async ({ page, irc }, testInfo) => {
      const channel = irc.channel;
      test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
      test.skip(
        process.env.WEBLOUNGE_ERGO_CONTROL_PID === undefined,
        "requires the restartable Ergo fixture",
      );
      await openChannel(page, irc, testInfo.project.name);

      let ergoStopped = false;
      try {
        process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR1");
        ergoStopped = true;
        await expectTransientConnectionPresentation(page, false);
        await expectErgoStopped();
        process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
        await expectErgoReady();
        await dispatchPersistedPageShow(page);
        ergoStopped = false;
        await expectOnline(page, testInfo.project.name);
        const bot = await irc.peer("ergo");
        await sendAndExpectEcho(
          page,
          bot,
          channel,
          `after Ergo restart ${Date.now()}`,
        );
        await expectShellToRemain(page, channel);
      } finally {
        if (ergoStopped) {
          process.kill(
            Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID),
            "SIGUSR2",
          );
          await expectErgoReady();
        }
      }
    },
  );
});

async function expectTransientConnectionPresentation(
  page: Page,
  mobile: boolean,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((mobileShell) => {
        const progress = document.querySelectorAll(
          "[data-connection-progress]",
        );
        const visible = [...progress].some(
          (element) => element.getClientRects().length > 0,
        );
        return {
          errors: document.querySelectorAll("[data-connection-error]").length,
          indicators: document.querySelectorAll("[data-connection-indicator]")
            .length,
          brandProgress: document.querySelectorAll(
            "[data-connection-brand][data-connection-progress]",
          ).length,
          statusCopy: /Connecting|Reconnecting|Offline/u.test(
            document.body.innerText,
          ),
          titleProgress: document.querySelectorAll(
            "[data-conversation-title][data-connection-progress]",
          ).length,
          visible: mobileShell || visible,
        };
      }, mobile),
    )
    .toEqual({
      errors: 0,
      indicators: 0,
      brandProgress: 1,
      statusCopy: false,
      titleProgress: 1,
      visible: true,
    });
}

async function openChannel(
  page: Page,
  irc: IrcTestAccount,
  projectName: string,
) {
  const channel = irc.channel;
  await expectErgoReady();
  await page.goto(irc.url());
  if (isMobile(projectName)) {
    const channelButton = page.getByRole("button", { name: channel });
    await expect
      .poll(
        async () =>
          (await channelButton.count()) +
          (await page.locator("[data-connection-progress]").count()),
      )
      .toBeGreaterThan(0);
    await expect(channelButton).toBeVisible();
    await channelButton.click();
  } else {
    await expect
      .poll(() =>
        page
          .locator("[data-network-state]")
          .first()
          .getAttribute("data-network-state"),
      )
      .toMatch(/registering|online/);
    await page.getByRole("button", { name: channel }).first().click();
  }
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await expectOnline(page, projectName);
  return page.getByRole("textbox", {
    name: isMobile(projectName) ? `Message ${channel}` : "Message",
  });
}

async function enableAppAlwaysOn(irc: IrcTestAccount): Promise<void> {
  const client = await irc.self();
  await client.setAlwaysOn(true);
}

async function sendAndExpectEcho(
  page: Page,
  bot: IrcClient,
  channel: string,
  prefix: string,
): Promise<void> {
  await bot.privmsgConfirmed(channel, prefix);
  await expect(page.getByText(prefix, { exact: true })).toHaveCount(1);
}

function messageRow(page: Page, text: string, delivery: string) {
  return page
    .locator(`[data-message-row][data-delivery="${delivery}"]`)
    .filter({ has: page.getByText(text, { exact: true }) });
}

function transcriptRow(page: Page, text: string) {
  return page.locator(
    `[data-message-row][data-message-text=${JSON.stringify(text)}]`,
  );
}

function highlightPaint(row: Locator): Promise<string> {
  return row.evaluate(
    (element) => getComputedStyle(element, "::before").backgroundColor,
  );
}

async function sentWireLineCount(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const timeline = Reflect.get(globalThis, "historyWireTimeline");
    if (!Array.isArray(timeline)) return 0;
    return timeline.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "direction" in entry &&
        entry.direction === "sent" &&
        "line" in entry &&
        typeof entry.line === "string" &&
        entry.line.includes(needle),
    ).length;
  }, text);
}

// The engine's foreground probe waits FOREGROUND_PROBE_TIMEOUT (4s) before
// reconnecting, which is when the network leaves online; the test timeout
// bounds this wait.
async function waitForForegroundProbeToGiveUp(
  page: Page,
  projectName: string,
): Promise<void> {
  await page
    .locator(
      `${networkStateSelector(projectName)}:not([data-network-state="online"])`,
    )
    .waitFor({ state: "attached" });
}

async function scrollDesktopBetweenEdges(
  page: Page,
  list: Locator,
  minimumMargin: number,
): Promise<number> {
  const range = await messageListScrollRange(list);
  await list.hover();
  await page.mouse.wheel(0, -range / 2);
  await waitForStableScrollTop(list);
  await expect
    .poll(() =>
      list.evaluate((element) =>
        Math.min(
          element.scrollTop,
          element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      ),
    )
    .toBeGreaterThan(minimumMargin);
  return list.evaluate((element) => element.scrollTop);
}

// WebKit can omit scrollend for completed scrolling, including every no-op.
async function waitForStableScrollTop(list: Locator): Promise<void> {
  await expect
    .poll(() =>
      list.evaluate(async (element) => {
        const frame = () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        await frame();
        const first = element.scrollTop;
        await frame();
        return element.scrollTop === first;
      }),
    )
    .toBe(true);
}

async function scrollAnchorOffset(
  list: Locator,
  text: string,
): Promise<number | null> {
  return list.evaluate((element, anchorText) => {
    const row = [
      ...element.querySelectorAll<HTMLElement>("[data-message-row]"),
    ].find((candidate) => candidate.dataset.messageText === anchorText);
    return row === undefined
      ? null
      : row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, text);
}

async function elementWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

async function messageListScrollRange(list: Locator): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
}

async function expectShellToRemain(page: Page, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.locator("[data-hosted-status]")).toHaveCount(0);
  await expect(page.getByText("Couldn't connect to the server")).toHaveCount(0);
}

async function expectOnline(page: Page, projectName: string): Promise<void> {
  await expect(
    page.locator(
      `${networkStateSelector(projectName)}[data-network-state="online"]`,
    ),
  ).toHaveCount(1);
}

function networkStateSelector(projectName: string): string {
  return isMobile(projectName)
    ? "[data-mobile-chat][data-network-state]"
    : "[data-network-state]";
}

async function expectErgoReady(): Promise<void> {
  await expect
    .poll(async () => (await ergoApiIsReady()) && (await ircPortIsReady()))
    .toBe(true);
}

async function expectErgoStopped(): Promise<void> {
  await expect
    .poll(async () => !(await ergoApiIsReady()) && !(await ircPortIsReady()))
    .toBe(true);
}

async function ergoApiIsReady(): Promise<boolean> {
  try {
    const registrationApi =
      process.env.WEBLOUNGE_E2E_IRC_API ??
      "http://127.0.0.1:8089/v1/saregister";
    await fetch(new URL("/", registrationApi));
    return true;
  } catch {
    return false;
  }
}

async function ircPortIsReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: process.env.WEBLOUNGE_E2E_IRC_HOST ?? "127.0.0.1",
      port: Number(process.env.WEBLOUNGE_E2E_IRC_PORT ?? 6667),
    });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function setVisibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setVisibility = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setVisibility !== "function")
      throw new Error("visibility control was not installed");
    setVisibility(nextHidden);
  }, hidden);
}

async function dispatchPersistedPageShow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
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

function messageIdentity(line: string): {
  readonly msgid: string;
  readonly time: string;
} {
  return { msgid: messageId(line), time: serverTime(line) };
}

async function snapshotReadAt(
  page: Page,
  title: string,
): Promise<number | undefined> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(
      (value, rowTitle) =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = value
            .transaction("cache", "readonly")
            .objectStore("cache")
            .get(new TextEncoder().encode("chat-list-snapshot"));
          request.onsuccess = () => {
            const bytes = request.result as Uint8Array | undefined;
            if (bytes === undefined) {
              resolve(undefined);
              return;
            }
            const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("rows" in parsed) ||
              !Array.isArray(parsed.rows)
            ) {
              resolve(undefined);
              return;
            }
            const row = parsed.rows.find(
              (candidate: unknown) =>
                typeof candidate === "object" &&
                candidate !== null &&
                "title" in candidate &&
                candidate.title === rowTitle,
            );
            resolve(
              typeof row === "object" &&
                row !== null &&
                "read_at_ms" in row &&
                typeof row.read_at_ms === "number"
                ? row.read_at_ms
                : undefined,
            );
          };
          request.onerror = () => reject(request.error);
        }),
      title,
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function seedPushedMessage(
  page: Page,
  nickname: string,
  message: {
    readonly msgid: string;
    readonly sender: string;
    readonly target: string;
    readonly text: string;
    readonly time: string;
  },
): Promise<void> {
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(
      async (value, { nickname, pushed }) => {
        await new Promise<void>((resolve, reject) => {
          const encoder = new TextEncoder();
          const transaction = value.transaction("cache", "readwrite");
          transaction.objectStore("cache").put(
            encoder.encode(
              JSON.stringify({
                schema: 1,
                network_label: "Local Ergo",
                nickname,
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
      },
      { nickname, pushed: message },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function installWorkerControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
    const NativeWorker = globalThis.Worker;
    class TrackedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const generation =
          Number(Reflect.get(globalThis, "engineWorkerGeneration") ?? 0) + 1;
        Reflect.set(globalThis, "engineWorkerGeneration", generation);
        Reflect.set(globalThis, "terminateEngineWorker", () => {
          this.dispatchEvent(new Event("error"));
          this.terminate();
        });
        const controlledEngineResults = new Map<string, string>();
        Reflect.set(
          globalThis,
          "controlledEngineResults",
          controlledEngineResults,
        );
        this.addEventListener("message", (event) => {
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "id" in event.data &&
            typeof event.data.id === "string" &&
            controlledEngineResults.has(event.data.id) &&
            "type" in event.data &&
            typeof event.data.type === "string"
          )
            controlledEngineResults.set(event.data.id, event.data.type);
        });
        Reflect.set(
          globalThis,
          "sendControlledEngineRequest",
          (request: Readonly<Record<string, unknown>>) => {
            const id = crypto.randomUUID();
            controlledEngineResults.set(id, "pending");
            this.postMessage({
              type: "request",
              payload: {
                id,
                request,
              },
            });
            return id;
          },
        );
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: TrackedWorker,
    });
  });
}

async function observeMarkReadRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "resilienceMarkReadRequests", 0);
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (
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
        const count = Reflect.get(globalThis, "resilienceMarkReadRequests");
        Reflect.set(
          globalThis,
          "resilienceMarkReadRequests",
          typeof count === "number" ? count + 1 : 1,
        );
      }
      Reflect.apply(postMessage, this, [message, options]);
    };
  });
}

function markReadRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const count = Reflect.get(globalThis, "resilienceMarkReadRequests");
    return typeof count === "number" ? count : 0;
  });
}

function isMobile(projectName: string): boolean {
  return projectName.includes("mobile");
}

function conversationColumn(page: Page, projectName: string): Locator {
  return isMobile(projectName)
    ? page.locator("[data-mobile-chat]")
    : page.locator("[data-buffer-title]");
}
