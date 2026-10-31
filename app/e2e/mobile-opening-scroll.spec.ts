import { randomUUID } from "node:crypto";
import { devices, expect, type Locator, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

test("opens a mobile channel at the live edge and respects a user scroll away", async ({
  baseURL,
  browser,
}) => {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const channel = `#opening-${suffix}`;
  const owner = await IrcClient.connect(
    `opening-own-${suffix}`,
    "weblounge",
    "weblounge-test",
    channel,
  );
  const bots = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      IrcClient.connect(
        `open-bot-${index}-${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      ),
    ),
  );
  const context = await browser.newContext({
    ...devices["iPhone 16 Pro"],
    baseURL,
  });
  const page = await context.newPage();
  const newest = `newest opening message ${suffix}`;
  try {
    for (let index = 0; index < 120; index += bots.length)
      await Promise.all(
        bots.map((bot, offset) =>
          bot.privmsgConfirmed(channel, backlogMessage(suffix, index + offset)),
        ),
      );
    const bot = bots[0];
    if (bot === undefined) throw new Error("no history sender");

    await useDedicatedWorker(page);
    await holdHistoryRequests(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?irc-password=weblounge-test");
    const row = page.locator("[data-buffer-id]").filter({ hasText: channel });
    await expect(row).toBeVisible();
    const unreadBeforeLive = await unreadCount(row);
    for (let index = 120; index < 210; index += bots.length)
      await Promise.all(
        bots.map((sender, offset) =>
          sender.privmsgConfirmed(
            channel,
            backlogMessage(suffix, index + offset),
          ),
        ),
      );
    await bot.privmsgConfirmed(channel, newest);
    await expect.poll(() => unreadCount(row)).toBe(unreadBeforeLive + 91);
    await row.click();

    const list = page.locator("[data-message-list]");
    await expect(list).toBeVisible();
    await expect(page.locator("[data-motion]")).toHaveCount(0);
    await expect.poll(() => historyRequestPending(page)).toBe(true);
    await expect.poll(() => renderedRowCount(list)).toBeGreaterThan(0);
    await expect(page.getByText(newest, { exact: true })).toBeVisible();
    await expect(page.getByText(newest, { exact: true })).toBeInViewport();
    await watchForEmptyRange(list);
    const heightBeforeHistory = await list.evaluate(
      (element) => element.scrollHeight,
    );
    await releaseHistoryRequest(page);
    await expect
      .poll(() => list.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(heightBeforeHistory + 500);
    await expect.poll(() => renderedRowCount(list)).toBeGreaterThan(0);
    await expect.poll(() => renderedRowsInViewport(list)).toBeGreaterThan(0);
    expect(await sawEmptyRange(list)).toBe(false);
    await expect(page.getByText(newest, { exact: true })).toBeVisible();
    await expect(page.getByText(newest, { exact: true })).toBeInViewport();
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight / element.clientHeight),
      )
      .toBeGreaterThan(4);
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(3);

    for (let pageUp = 1; pageUp <= 4; pageUp += 1) {
      await list.press("PageUp");
      await expect
        .poll(() => distanceFromBottom(list))
        .toBeGreaterThan(pageUp * 25);
    }
    await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(100);
    await bot.privmsgConfirmed(channel, `later live message ${suffix}`);
    await expect(
      page.getByRole("button", { name: /1 new message/ }),
    ).toBeVisible();
    await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(100);
  } finally {
    await context.close();
    for (const bot of bots) bot.close();
    await owner.part(channel);
    owner.close();
  }
});

async function unreadCount(row: Locator): Promise<number> {
  const label =
    (await row.getByRole("status").getAttribute("aria-label")) ?? "0";
  return Number.parseInt(label, 10);
}

function distanceFromBottom(list: Locator): Promise<number> {
  return list.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

function backlogMessage(suffix: string, index: number): string {
  if (index % 2 === 0)
    return `opening backlog ${suffix} ${index} ${"long wrapping history ".repeat(10)}`;
  return `opening backlog ${suffix} ${index} e${"\u0301".repeat(170)}`;
}

function renderedRowCount(list: Locator): Promise<number> {
  return list.locator("li[data-index]").count();
}

function renderedRowsInViewport(list: Locator): Promise<number> {
  return list.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll("li[data-index]")].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    }).length;
  });
}

async function watchForEmptyRange(list: Locator): Promise<void> {
  await list.evaluate((element) => {
    const state = { empty: false };
    new MutationObserver(() => {
      state.empty ||= element.querySelector("li[data-index]") === null;
    }).observe(element, { childList: true, subtree: true });
    Object.assign(element, { __emptyRangeState: state });
  });
}

function sawEmptyRange(list: Locator): Promise<boolean> {
  return list.evaluate(
    (element) =>
      (
        element as HTMLOListElement & {
          __emptyRangeState?: { empty: boolean };
        }
      ).__emptyRangeState?.empty ?? false,
  );
}

async function holdHistoryRequests(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const originalPostMessage = Worker.prototype.postMessage;
    let pending:
      | {
          worker: Worker;
          message: unknown;
          transfer: readonly Transferable[];
        }
      | undefined;
    const historyGate = {
      pending: () => pending !== undefined,
      release: () => {
        if (pending === undefined) return false;
        const request = pending;
        pending = undefined;
        originalPostMessage.call(
          request.worker,
          request.message,
          request.transfer,
        );
        return true;
      },
    };
    Object.assign(globalThis, { __webloungeHistoryGate: historyGate });
    Worker.prototype.postMessage = function (message, transfer = []) {
      const envelope = message as {
        type?: unknown;
        payload?: { request?: { type?: unknown } };
      };
      if (
        envelope.type === "request" &&
        envelope.payload?.request?.type === "load_history"
      ) {
        pending = { worker: this, message, transfer };
        return;
      }
      originalPostMessage.call(this, message, transfer);
    };
  });
}

function historyRequestPending(
  page: import("@playwright/test").Page,
): Promise<boolean> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __webloungeHistoryGate?: { pending: () => boolean };
        }
      ).__webloungeHistoryGate?.pending() ?? false,
  );
}

async function releaseHistoryRequest(
  page: import("@playwright/test").Page,
): Promise<void> {
  const released = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __webloungeHistoryGate?: { release: () => boolean };
        }
      ).__webloungeHistoryGate?.release() ?? false,
  );
  expect(released).toBe(true);
}
