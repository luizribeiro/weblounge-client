import { expect, type Locator, type Page, test } from "@playwright/test";
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
          progress: progress.length,
          statusCopy: /Connecting|Reconnecting|Offline/u.test(
            document.body.innerText,
          ),
          visible: mobileShell || visible,
        };
      }, mobile),
    )
    .toEqual({
      errors: 0,
      indicators: 0,
      progress: 1,
      statusCopy: false,
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
    .poll(async () => {
      try {
        await fetch("http://127.0.0.1:8089/");
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
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

function isMobile(projectName: string): boolean {
  return projectName.includes("mobile");
}

function conversationColumn(page: Page, projectName: string): Locator {
  return isMobile(projectName)
    ? page.locator("[data-mobile-chat]")
    : page.locator("[data-buffer-title]");
}
