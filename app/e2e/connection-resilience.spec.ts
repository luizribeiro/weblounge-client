import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";

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
      const scrollTop = await scrollAwayFromLiveEdge(page, list, {
        distance: scrollDistance,
        input: mobile ? "touch" : "wheel",
        wheelDelta: scrollDistance * 2,
      });
      expect(scrollTop).toBeGreaterThan(0);
      const scrollAnchor = await visibleScrollAnchor(list);
      const draft = `draft survives ${Date.now()}`;
      await composer.fill(draft);

      await setVisibility(page, true);
      process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR1");
      ergoStopped = true;
      await bot.waitForDisconnect();
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      const reconnecting = isMobile(testInfo.project.name)
        ? page
            .locator("[data-mobile-chat]")
            .getByText("Reconnecting…", { exact: true })
        : page.locator('[data-connection-status="Reconnecting…"]');
      await expect(reconnecting).toBeVisible();
      await expect(reconnecting).toHaveCount(1);
      await expectShellToRemain(page, channel);

      if (!isMobile(testInfo.project.name)) {
        await expectMutedIndicator(
          page.locator('[data-connection-indicator="account"]'),
        );
        await expectMutedIndicator(
          page.locator('[data-connection-indicator="network"]'),
        );
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
        .poll(async () =>
          Math.abs(
            (await list.evaluate((element) => element.scrollTop)) - scrollTop,
          ),
        )
        .toBeLessThanOrEqual(40);

      bot.close();
      bot = await connectBot("resumed");
      await sendUntilReceived(page, bot, `after resume ${Date.now()}`);
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

    await context.setOffline(true);
    const offline = isMobile(testInfo.project.name)
      ? page.locator("[data-mobile-chat]").getByText("Offline", { exact: true })
      : page.locator('[data-connection-status="Offline"]');
    await expect(offline).toBeVisible();
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
    await expect(offline).toHaveCount(0);
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

      await sendUntilReceived(page, bot, `after worker restart ${Date.now()}`);
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
      await expect(
        page.locator('[data-connection-status="Reconnecting…"]'),
      ).toBeVisible();
      process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR2");
      await expectErgoReady();
      await dispatchPersistedPageShow(page);
      ergoStopped = false;
      await expectOnline(page, testInfo.project.name);
      const bot = await connectBot("ergo");
      try {
        await sendUntilReceived(page, bot, `after Ergo restart ${Date.now()}`);
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

async function expectMutedIndicator(indicator: Locator) {
  await expect(indicator).toHaveAttribute("data-connection-color", "muted");
  const [actual, expected] = await indicator.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.background = "var(--wl-color-panel-muted)";
    document.body.append(probe);
    const colors = [
      getComputedStyle(element).backgroundColor,
      getComputedStyle(probe).backgroundColor,
    ];
    probe.remove();
    return colors;
  });
  expect(actual).toBe(expected);
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
          (await page.getByText("Connecting…", { exact: true }).count()),
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

async function sendUntilReceived(
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

async function visibleScrollAnchor(list: ReturnType<Page["locator"]>) {
  return list.evaluate((element) => {
    const listTop = element.getBoundingClientRect().top;
    const row = [
      ...element.querySelectorAll<HTMLElement>("[data-message-row]"),
    ].find((candidate) => candidate.getBoundingClientRect().bottom > listTop);
    if (row === undefined) throw new Error("visible message anchor missing");
    return {
      text: row.dataset.messageText ?? "",
    };
  });
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
