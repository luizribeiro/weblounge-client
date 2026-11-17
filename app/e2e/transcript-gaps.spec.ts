import path from "node:path";
import {
  type Browser,
  devices,
  type Locator,
  type Page,
} from "@playwright/test";
import { expectInterFont } from "./inter-font";
import { type IrcClient, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { scrollToTranscriptTop } from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { dispatchPersistedPageShow, setPageHidden } from "./page-lifecycle";
import { expectSettled } from "./settled";

const desktop = { viewport: { width: 1_280, height: 800 } } as const;
/** More than the catch-up page and the one page filled right after it. */
const longGapLength = 230;

test.describe("transcript gap and boundary dividers", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(
    process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
    "requires the controllable socket forwarder",
  );

  for (const layout of [
    { name: "desktop", context: desktop },
    {
      name: "phone",
      context: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
      },
    },
  ] as const) {
    test(`shows signed transcript boundaries on ${layout.name}`, async ({
      baseURL,
      browser,
      irc,
    }) => {
      await setAppAlwaysOn(irc);
      const suffix = irc.id;
      const channel = irc.channelNamed("gap");
      const bot = await irc.peer("gap", [channel]);
      const senders = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          irc.peer(`gap-${index}`, [channel]),
        ),
      );
      const seed = `gap cursor ${suffix}`;
      const seedLine = await bot.privmsgConfirmed(channel, seed);
      const page = await openApp(browser, baseURL, irc, layout.context);
      try {
        await openChannel(page, irc, channel, layout.name === "phone");
        await expect(messageText(page, seed)).toBeVisible();

        const list = activeMessageList(page);
        await scrollToTranscriptTop(list);
        const history = list.locator('[data-divider-kind="history"]');
        await expect(history).toHaveAttribute(
          "aria-label",
          `Beginning of ${channel}`,
        );
        await expect(history).toContainText(
          `Server history starts ${await formatHistoryDay(page, seedLine)}`,
        );
        await captureDivider(history, layout.name, "history");

        await runCommand(page, `/query ${bot.nickname}`);
        await expectSettled(page, { conversation: bot.nickname });
        const empty = activeMessageList(page).locator("[data-empty-row]");
        await expect(empty).toHaveAttribute("aria-label", "No messages yet");
        await expect(empty).toContainText(
          `Messages you and ${bot.nickname} send will appear here.`,
        );
        await captureDivider(empty, layout.name, "empty");

        await selectBuffer(page, channel, layout.name === "phone");
        await irc.forwarder.drop();
        const firstRetainedLine = await sendCappedGap(senders, channel, suffix);

        await irc.forwarder.holdIncomingContaining(`missing ${suffix}`);
        await reconnect(page, irc);

        const caughtUpList = activeMessageList(page);
        await scrollToTranscriptTop(caughtUpList);
        const gap = caughtUpList.locator("[data-gap-row]");
        const expectedGap = `Messages may be missing · ${await formatLineTime(page, seedLine)} to ${await formatLineTime(page, firstRetainedLine)}`;
        await expect(gap).toHaveAttribute("aria-label", expectedGap);
        await captureDivider(gap, layout.name, "gap");

        await expect.poll(() => irc.forwarder.isHoldingIncoming()).toBe(true);
        await irc.forwarder.resumeIncoming();
        await expect(gap).toHaveCount(0);
        await expectEachOnce(page, [
          seed,
          ...cappedGapTexts(suffix).slice(0, 4),
        ]);
        await expectSettled(page, { conversation: channel });
      } finally {
        await page.context().close();
      }
    });
  }

  test("fills the gap a failed catch-up leaves once it reconnects", async ({
    baseURL,
    browser,
    irc,
  }) => {
    await setAppAlwaysOn(irc);
    const channel = irc.channelNamed("failed");
    const bot = await irc.peer("failed", [channel]);
    const seed = `failed cursor ${irc.id}`;
    await bot.privmsgConfirmed(channel, seed);
    const page = await openApp(browser, baseURL, irc, desktop);
    try {
      await openChannel(page, irc, channel, false);
      await expect(messageText(page, seed)).toBeVisible();

      await irc.forwarder.drop();
      const missed = [1, 2, 3].map((index) => `outage ${irc.id} ${index}`);
      for (const text of missed) await bot.privmsgConfirmed(channel, text);
      await irc.forwarder.holdIncomingContaining(`outage ${irc.id}`);
      await reconnect(page, irc);
      await expect.poll(() => irc.forwarder.isHoldingIncoming()).toBe(true);

      await goOffline(page, irc);
      const gap = activeMessageList(page).locator("[data-gap-row]");
      await expect(gap).toHaveCount(1);
      await irc.forwarder.resumeIncoming();
      await reconnect(page, irc);

      await expect(gap).toHaveCount(0);
      await expectEachOnce(page, [seed, ...missed]);
      await expectSettled(page, { conversation: channel });
    } finally {
      await page.context().close();
    }
  });

  test("leaves no gap after an empty catch-up", async ({
    baseURL,
    browser,
    irc,
  }) => {
    await setAppAlwaysOn(irc);
    const channel = irc.channelNamed("empty");
    const bot = await irc.peer("empty", [channel]);
    const seed = `empty cursor ${irc.id}`;
    await bot.privmsgConfirmed(channel, seed);
    const page = await openApp(browser, baseURL, irc, desktop);
    try {
      await openChannel(page, irc, channel, false);
      await expect(messageText(page, seed)).toBeVisible();

      await goOffline(page, irc);
      await reconnect(page, irc);
      await expectSettled(page, { conversation: channel });
      await expect(
        activeMessageList(page).locator("[data-gap-row]"),
      ).toHaveCount(0);
      await expectEachOnce(page, [seed]);
    } finally {
      await page.context().close();
    }
  });

  test("fills the rest of a long gap when its row comes into view", async ({
    baseURL,
    browser,
    irc,
  }) => {
    await setAppAlwaysOn(irc);
    const channel = irc.channelNamed("long");
    const senders = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        irc.peer(`long-${index}`, [channel]),
      ),
    );
    const seed = `long cursor ${irc.id}`;
    await senders[0]?.privmsgConfirmed(channel, seed);
    const page = await openApp(browser, baseURL, irc, desktop);
    try {
      await openChannel(page, irc, channel, false);
      await expect(messageText(page, seed)).toBeVisible();

      await irc.forwarder.drop();
      const lines = Array.from(
        { length: longGapLength },
        (_, index) => `outage ${irc.id} ${String(index).padStart(3, "0")}`,
      );
      for (const [index, text] of lines.entries())
        await senders[index % senders.length]?.privmsgConfirmed(channel, text);
      const beyondTheFirstFill = lines[10] ?? "";
      await irc.forwarder.holdIncomingContaining(beyondTheFirstFill);
      await reconnect(page, irc);

      const list = activeMessageList(page);
      await scrollToTranscriptTop(list);
      const gap = list.locator("[data-gap-row]");
      await expect(gap).toHaveCount(1);
      await expect.poll(() => irc.forwarder.isHoldingIncoming()).toBe(true);
      await irc.forwarder.resumeIncoming();
      await expect(gap).toHaveCount(0);
      await expectEachOnce(page, [seed, ...lines.slice(0, 3)]);
      await expectSettled(page, { conversation: channel });
    } finally {
      await page.context().close();
    }
  });
});

async function openApp(
  browser: Browser,
  baseURL: string | undefined,
  irc: IrcTestAccount,
  options: Parameters<Browser["newContext"]>[0],
): Promise<Page> {
  const context = await browser.newContext({ ...options, baseURL });
  await irc.scope(context);
  const page = await context.newPage();
  await installNativeFeelInstrumentation(page);
  await page.goto(irc.url());
  return page;
}

async function openChannel(
  page: Page,
  irc: IrcTestAccount,
  channel: string,
  phone: boolean,
): Promise<void> {
  if (phone) {
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await page.getByRole("button", { name: irc.channel }).click();
  }
  await expect.poll(() => currentNetworkState(page)).toBe("online");
  await runCommand(page, `/join ${channel}`);
  await expectSettled(page, { conversation: channel });
}

async function selectBuffer(
  page: Page,
  title: string,
  phone: boolean,
): Promise<void> {
  if (phone) await page.getByRole("button", { name: "Back to chats" }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${title},|^${title}$`) })
    .click();
  await expectSettled(page, { conversation: title });
}

async function runCommand(page: Page, command: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: /Message/u });
  await composer.fill(command);
  await composer.press("Enter");
}

const cappedGapLength = 102;
const missedByCatchUp = 2;

function cappedGapTexts(suffix: string): readonly string[] {
  return Array.from(
    { length: cappedGapLength },
    (_, index) =>
      `${index < missedByCatchUp ? "missing" : "retained"} ${suffix} ${index}`,
  );
}

async function sendCappedGap(
  senders: readonly IrcClient[],
  channel: string,
  suffix: string,
): Promise<string> {
  let firstRetained: string | undefined;
  for (const [index, text] of cappedGapTexts(suffix).entries()) {
    const sender = senders[index % senders.length];
    if (sender === undefined) throw new Error("gap sender pool is empty");
    const line = await sender.privmsgConfirmed(channel, text);
    if (index === missedByCatchUp) firstRetained = line;
  }
  if (firstRetained === undefined) throw new Error("no retained gap boundary");
  return firstRetained;
}

async function goOffline(page: Page, irc: IrcTestAccount): Promise<void> {
  await irc.forwarder.drop();
  await returnToForeground(page);
  await expect.poll(() => currentNetworkState(page)).not.toBe("online");
}

/** Coming back to the foreground probes a stranded socket and retries a waiting reconnect at once. */
async function reconnect(page: Page, irc: IrcTestAccount): Promise<void> {
  await returnToForeground(page);
  await expect.poll(() => currentNetworkState(page)).not.toBe("online");
  await irc.forwarder.restore();
  await returnToForeground(page);
  await expect.poll(() => currentNetworkState(page)).toBe("online");
}

async function returnToForeground(page: Page): Promise<void> {
  await setPageHidden(page, true);
  await setPageHidden(page, false);
  await dispatchPersistedPageShow(page);
}

async function expectEachOnce(
  page: Page,
  texts: readonly string[],
): Promise<void> {
  const list = activeMessageList(page);
  await scrollToTranscriptTop(list);
  for (const text of texts)
    await expect(list.getByText(text, { exact: true })).toHaveCount(1);
}

async function captureDivider(
  divider: Locator,
  layout: "desktop" | "phone",
  state: "empty" | "gap" | "history",
): Promise<void> {
  const directory = process.env.WEBLOUNGE_TRANSCRIPT_SCREENSHOT_DIR;
  if (directory === undefined) return;
  for (const theme of ["light", "dark"] as const) {
    await divider.page().emulateMedia({ colorScheme: theme });
    await expect(divider.page().locator("html")).toHaveAttribute(
      "data-theme",
      theme === "dark" ? "lounge-night" : "lounge",
    );
    await expectInterFont(divider);
    await divider.screenshot({
      path: path.join(directory, `${layout}-${state}-${theme}.png`),
    });
  }
}

async function formatHistoryDay(page: Page, line: string): Promise<string> {
  const milliseconds = Date.parse(serverTime(line));
  return page.evaluate((time) => {
    const date = new Date(time);
    const localDay = Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    );
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(localDay);
  }, milliseconds);
}

async function formatLineTime(page: Page, line: string): Promise<string> {
  return page.evaluate(
    (time) =>
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(time),
    Date.parse(serverTime(line)),
  );
}

function messageText(page: Page, text: string): Locator {
  return activeMessageList(page).getByText(text, { exact: true });
}

function activeMessageList(page: Page): Locator {
  return page.locator("[data-message-list]:visible");
}

function currentNetworkState(page: Page): Promise<string | null> {
  return page
    .locator("[data-network-state]")
    .first()
    .getAttribute("data-network-state");
}

async function setAppAlwaysOn(irc: IrcTestAccount): Promise<void> {
  const control = await irc.self();
  await control.setAlwaysOn(true);
  control.close();
  await control.waitForDisconnect();
}
