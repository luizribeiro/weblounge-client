import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
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
    test.slow();
    await installNativeFeelInstrumentation(page);
    let bot = await connectBot("resume");
    try {
      const composer = await openChannel(page, testInfo.project.name);
      const list = page.locator("[data-message-list]");
      for (let index = 0; index < 24; index += 1) {
        const text = `resume seed ${index}`;
        await bot.privmsgConfirmed(channel, text);
        await expect(page.getByText(text, { exact: true })).toHaveCount(1, {
          timeout: 10_000,
        });
      }
      const scrollTop = await list.evaluate((element) => {
        element.scrollTop = Math.floor(element.scrollHeight / 3);
        element.dispatchEvent(new Event("scroll"));
        return element.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(0);
      const scrollAnchor = await visibleScrollAnchor(list);
      const draft = `draft survives ${Date.now()}`;
      await composer.fill(draft);

      await setVisibility(page, true);
      process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR1");
      await page.waitForTimeout(250);
      await setVisibility(page, false);
      await dispatchPersistedPageShow(page);
      await expect(
        page.getByText("Reconnecting…", { exact: true }).first(),
      ).toBeVisible();
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
      bot.close();
    }
  });

  test("queues offline sends in order and confirms them after reconnect", async ({
    context,
    page,
  }, testInfo) => {
    test.slow();
    await installNativeFeelInstrumentation(page);
    const composer = await openChannel(page, testInfo.project.name);

    await context.setOffline(true);
    await expect(
      page.getByText("Offline", { exact: true }).first(),
    ).toBeVisible();
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
      await expect(messageRow(page, text, "confirmed")).toHaveCount(1, {
        timeout: 15_000,
      });
    const order = await page
      .locator("[data-message-row]")
      .evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.messageText ?? ""),
      );
    expect(order.indexOf(texts[0] ?? "")).toBeLessThan(
      order.indexOf(texts[1] ?? ""),
    );
    await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);
    await expectShellToRemain(page, channel);
  });

  test("recovers transparently after the dedicated worker is terminated", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "covered in desktop WebKit");
    test.slow();
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
        .poll(
          () =>
            page.evaluate(() =>
              Number(Reflect.get(globalThis, "engineWorkerGeneration") ?? 0),
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(1);
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
        {
          timeout: 15_000,
        },
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
    test.slow();
    await openChannel(page, testInfo.project.name);

    process.kill(Number(process.env.WEBLOUNGE_ERGO_CONTROL_PID), "SIGUSR1");
    await expect(
      page.getByText("Reconnecting…", { exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expectOnline(page, testInfo.project.name);
    const bot = await connectBot("ergo");
    try {
      await sendUntilReceived(page, bot, `after Ergo restart ${Date.now()}`);
      await expectShellToRemain(page, channel);
    } finally {
      bot.close();
    }
  });
});

async function openChannel(page: Page, projectName: string) {
  await page.goto("/?irc-password=weblounge-test");
  if (isMobile(projectName))
    await page.getByRole("button", { name: channel }).click();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible({
    timeout: 15_000,
  });
  if (!isMobile(projectName))
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  return page.getByRole("textbox", {
    name: isMobile(projectName) ? `Message ${channel}` : "Message",
  });
}

async function connectBot(label: string): Promise<IrcClient> {
  const suffix = Date.now().toString().slice(-6);
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await IrcClient.connect(
        `${label}${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      );
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function sendUntilReceived(
  page: Page,
  bot: IrcClient,
  prefix: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const text = `${prefix} ${attempt}`;
    await bot.privmsgConfirmed(channel, text);
    try {
      await expect(page.getByText(text, { exact: true })).toHaveCount(1, {
        timeout: 2_500,
      });
      return;
    } catch {
      // Autojoin follows protocol-online; retry until the channel is joined.
    }
  }
  throw new Error("reconnected client did not receive a channel message");
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

async function expectShellToRemain(page: Page, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.locator("[data-hosted-status]")).toHaveCount(0);
  await expect(page.getByText("Couldn't connect to the server")).toHaveCount(0);
}

async function expectOnline(page: Page, projectName: string): Promise<void> {
  const online = isMobile(projectName)
    ? page.locator('[data-mobile-chat][data-network-state="online"]')
    : page.locator('[data-network-state="online"]');
  await expect(online).toHaveCount(1, { timeout: 20_000 });
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
        Reflect.set(globalThis, "terminateEngineWorker", () =>
          this.terminate(),
        );
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
