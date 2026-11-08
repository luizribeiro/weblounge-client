import { createConnection } from "node:net";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import {
  captureHistoryWire,
  heldHistoryRequestCount,
  historyMessageUpdateCount,
  releaseHeldHistoryRequest,
} from "./history-wire-fixture";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { expectEqualAtDevicePixelPrecision } from "./motion-assertions";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { visibleMessageAnchor } from "./visible-message-anchor";

const channel = "#weblounge-test";

test.describe("connection resilience against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.beforeEach(async () => {
    await setAppAlwaysOn(false);
    await setAppAlwaysOn(true);
  });
  test.afterAll(async () => setAppAlwaysOn(false));

  test("keeps the same screen, scroll, and draft through background socket loss", async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.WEBLOUNGE_ERGO_CONTROL_PID === undefined,
      "requires the restartable Ergo fixture",
    );
    await installNativeFeelInstrumentation(page);
    let bot = await connectBot("resume");
    let ergoStopped = false;
    try {
      const composer = await openChannel(page, testInfo.project.name);
      const list = page.locator("[data-message-list]");
      const mobile = isMobile(testInfo.project.name);
      const seedCount = 20;
      const seedTail = mobile ? "" : " wrapped message".repeat(10);
      for (let index = 0; index < seedCount; index += 1)
        await bot.privmsgConfirmed(channel, `resume seed ${index}${seedTail}`);
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
        : await scrollDesktopBetweenEdges(list, scrollDistance);
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

      bot.close();
      bot = await connectBot("resumed");
      await list.press("End");
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toHaveCount(0);
      await sendAndExpectEcho(page, bot, `after resume ${Date.now()}`);
      await expectShellToRemain(page, channel);
    } finally {
      if (ergoStopped) {
        process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
        await expectErgoReady();
      }
      bot.close();
    }
  });

  test("queues offline sends in order and confirms them after reconnect", async ({
    context,
    page,
  }, testInfo) => {
    await installNativeFeelInstrumentation(page);
    const composer = await openChannel(page, testInfo.project.name);
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
      const composer = await openChannel(page, testInfo.project.name);
      await controlForwarder("drop");
      dropped = true;

      const text = `queued on dead socket ${Date.now()}`;
      await composer.fill(text);
      await composer.press("Enter");
      await expect(messageRow(page, text, "optimistic")).toHaveCount(1);

      await setVisibility(page, true);
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      await expectTransientConnectionPresentation(
        page,
        isMobile(testInfo.project.name),
      );
      await controlForwarder("restore");
      dropped = false;

      await expect.poll(() => currentNetworkState(page)).not.toBe("online");
      await expectOnline(page, testInfo.project.name);
      await expect.poll(() => sentWireLineCount(page, text)).toBe(1);
      await expect(messageRow(page, text, "failed")).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "Failed · Retry" }),
      ).toHaveCount(1);
    } finally {
      if (dropped) await controlForwarder("restore");
    }
  });

  test("reconciles a send when its first server echo is lost", async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    await installNativeFeelInstrumentation(page);
    await captureHistoryWire(page);
    const bot = await connectBot("lost-echo");
    try {
      const composer = await openChannel(page, testInfo.project.name);
      const text = `lost first echo ${Date.now()}`;
      await dropIncomingContaining(text);

      await composer.fill(text);
      await composer.press("Enter");
      await expect(messageRow(page, text, "optimistic")).toHaveCount(1);
      await bot.waitForPrivmsg(channel, text, "weblounge");

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
    } finally {
      bot.close();
    }
  });

  test("keeps the online wasm engine alive through a foreground probe", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
    await installWorkerControl(page);
    await installNativeFeelInstrumentation(page);
    const bot = await connectBot("probe");
    try {
      await openChannel(page, testInfo.project.name);
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
        `after foreground probe ${Date.now()}`,
      );

      expect(
        await page.evaluate(() =>
          Number(Reflect.get(globalThis, "engineWorkerGeneration") ?? 0),
        ),
      ).toBe(1);
    } finally {
      bot.close();
    }
  });

  test("catches up an opened DM and channel after a silently dead socket", async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    await installNativeFeelInstrumentation(page);
    const bot = await connectBot("gap");
    const mobile = isMobile(testInfo.project.name);
    let dropped = false;
    try {
      await openChannel(page, testInfo.project.name);
      const suffix = Date.now();
      const beforeChannel = `before channel gap ${suffix}`;
      await bot.privmsgConfirmed(channel, beforeChannel);
      await expect(transcriptRow(page, beforeChannel)).toHaveCount(1);

      const beforeDm = `before direct gap ${suffix}`;
      await bot.privmsgConfirmed("weblounge", beforeDm);
      if (mobile)
        await page.getByRole("button", { name: "Back to chats" }).click();
      await page
        .getByRole("button", { name: new RegExp(`^${bot.nickname}`) })
        .click();
      await expect(transcriptRow(page, beforeDm)).toHaveCount(1);

      await controlForwarder("drop");
      dropped = true;
      const gapDm = `missed direct ${suffix}`;
      const gapChannel = `missed channel ${suffix}`;
      await bot.privmsgConfirmed("weblounge", gapDm);
      await bot.privmsgConfirmed(channel, gapChannel);

      await setVisibility(page, true);
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      await expectTransientConnectionPresentation(page, mobile);
      await controlForwarder("restore");
      dropped = false;

      await expectOnline(page, testInfo.project.name);
      await expect(transcriptRow(page, gapDm)).toHaveCount(1);
      if (mobile)
        await page.getByRole("button", { name: "Back to chats" }).click();
      await page.getByRole("button", { name: channel }).first().click();
      await expect(transcriptRow(page, gapChannel)).toHaveCount(1);
    } finally {
      if (dropped) await controlForwarder("restore");
      bot.close();
    }
  });

  test("marks a push-only read before authoritative history arrives", async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
      "requires the controllable socket forwarder",
    );
    const suffix = Date.now().toString(36);
    const pushedChannel = `#pushed-read-${suffix}`;
    const text = `read before history ${suffix}`;
    const appUrl = `/?irc-password=weblounge-test&irc-autojoin=${encodeURIComponent(pushedChannel)}`;
    const bot = await IrcClient.connect(
      `push${suffix.slice(-6)}`,
      "weblounge-bot",
      "weblounge-bot-test",
      pushedChannel,
    );
    const leaveBot = await connectBot("leave");
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
      await controlForwarder("drop");
      dropped = true;
      const identity = messageIdentity(
        await bot.privmsgConfirmed(pushedChannel, text),
      );
      await seedPushedMessage(page, {
        sender: bot.nickname,
        target: pushedChannel,
        text,
        ...identity,
      });
      const leaveText = `other pushed row ${suffix}`;
      await seedPushedMessage(page, {
        sender: leaveBot.nickname,
        target: "weblounge",
        text: leaveText,
        ...messageIdentity(
          await leaveBot.privmsgConfirmed("weblounge", leaveText),
        ),
      });
      markerReader = await IrcClient.connect(
        `reader${suffix.slice(-6)}`,
        "weblounge",
        "weblounge-test",
        pushedChannel,
      );

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

      await controlForwarder("restore");
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
      if (dropped) await controlForwarder("restore");
      markerReader?.close();
      leaveBot.close();
      bot.close();
    }
  });

  test("recovers transparently after the dedicated worker is terminated", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
    await installWorkerControl(page);
    await installNativeFeelInstrumentation(page);
    const bot = await connectBot("worker");
    try {
      const composer = await openChannel(page, testInfo.project.name);
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
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
      await expect(composer).toHaveValue(draft);

      await sendAndExpectEcho(page, bot, `after worker restart ${Date.now()}`);
      await expectShellToRemain(page, channel);
    } finally {
      bot.close();
    }
  });

  test("recovers after the Ergo process restarts", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
    test.skip(
      process.env.WEBLOUNGE_ERGO_CONTROL_PID === undefined,
      "requires the restartable Ergo fixture",
    );
    await openChannel(page, testInfo.project.name);

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
      const bot = await connectBot("ergo");
      try {
        await sendAndExpectEcho(page, bot, `after Ergo restart ${Date.now()}`);
        await expectShellToRemain(page, channel);
      } finally {
        bot.close();
      }
    } finally {
      if (ergoStopped) {
        process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
        await expectErgoReady();
      }
    }
  });
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

async function openChannel(page: Page, projectName: string) {
  await expectErgoReady();
  await page.goto("/?irc-password=weblounge-test");
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

async function connectBot(label: string): Promise<IrcClient> {
  const suffix = Date.now().toString().slice(-6);
  return IrcClient.connect(
    `${label}${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
}

async function setAppAlwaysOn(enabled: boolean): Promise<void> {
  const client = await IrcClient.connect(
    "always-on-control",
    "weblounge",
    "weblounge-test",
    channel,
  );
  try {
    if (client.nickname !== "weblounge") {
      await client.waitForNickDeparture("weblounge");
      await client.nick("weblounge");
    }
    await client.setAlwaysOn(enabled);
  } finally {
    client.close();
  }
}

async function sendAndExpectEcho(
  page: Page,
  bot: IrcClient,
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
  return page
    .locator("[data-message-row]")
    .filter({ has: page.getByText(text, { exact: true }) });
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

function currentNetworkState(page: Page): Promise<string | null> {
  return page
    .locator("[data-network-state]")
    .first()
    .getAttribute("data-network-state");
}

async function scrollDesktopBetweenEdges(
  list: Locator,
  minimumMargin: number,
): Promise<number> {
  const range = await messageListScrollRange(list);
  const target = range / 2;
  await list.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
  }, target);
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
  const online = isMobile(projectName)
    ? page.locator('[data-mobile-chat][data-network-state="online"]')
    : page.locator('[data-network-state="online"]');
  await expect(online).toHaveCount(1);
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

async function controlForwarder(action: "drop" | "restore"): Promise<void> {
  const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
  if (base === undefined) throw new Error("socket forwarder is unavailable");
  const response = await fetch(`${base}/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(`socket forwarder ${action} failed`);
}

async function dropIncomingContaining(text: string): Promise<void> {
  const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
  if (base === undefined) throw new Error("socket forwarder is unavailable");
  const endpoint = new URL("/drop-incoming", base);
  endpoint.searchParams.set("contains", text);
  const response = await fetch(endpoint, { method: "POST" });
  if (!response.ok) throw new Error("socket forwarder incoming drop failed");
}

function messageIdentity(line: string): {
  readonly msgid: string;
  readonly time: string;
} {
  const tags = new Map(
    line
      .slice(1, line.indexOf(" "))
      .split(";")
      .map((tag) => {
        const separator = tag.indexOf("=");
        return [tag.slice(0, separator), tag.slice(separator + 1)] as const;
      }),
  );
  const msgid = tags.get("msgid");
  const time = tags.get("time");
  if (msgid === undefined || time === undefined)
    throw new Error(`message has no server identity: ${line}`);
  return { msgid, time };
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
    await database.evaluate(async (value, pushed) => {
      await new Promise<void>((resolve, reject) => {
        const encoder = new TextEncoder();
        const transaction = value.transaction("cache", "readwrite");
        transaction.objectStore("cache").put(
          encoder.encode(
            JSON.stringify({
              schema: 1,
              network_label: "Local Ergo",
              nickname: "weblounge",
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
