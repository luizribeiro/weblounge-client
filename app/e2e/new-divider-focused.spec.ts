import { expect, type Page, test } from "@playwright/test";
import {
  captureHistoryWire,
  historyMessageUpdateCount,
  sentWireLines,
} from "./history-wire-fixture";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import {
  installPageNotificationStub,
  postedPageNotifications,
} from "./page-notification-stub";

test.describe("New divider ownership", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.beforeEach(async ({ isMobile, page }) => {
    await captureHistoryWire(page);
    await installNativeFeelInstrumentation(page);
    if (!isMobile) return;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => false,
      });
    });
  });

  test("shows New when the DM arrives while the page is hidden", async ({
    isMobile,
    page,
  }) => {
    const peer = await openDirect(page, "hidden", isMobile);
    try {
      await setPageHidden(page, true);
      const text = `hidden DM arrival ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", text);
      await expectDeliveredToPage(page, text);

      await setPageHidden(page, false);
      await expect(messageText(page, text)).toBeVisible();
      await expect(page.locator("[data-new-line]")).toBeVisible();
    } finally {
      peer.close();
    }
  });

  test("shows New when the DM follows an own send confirmed while hidden", async ({
    isMobile,
    page,
  }) => {
    const peer = await openDirect(page, "own", isMobile);
    try {
      await setPageHidden(page, true);
      const ownText = `own send before leaving ${Date.now()}`;
      await submitComposer(page, ownText);
      const ownLine = await peer.waitForPrivmsg(
        peer.nickname,
        ownText,
        "weblounge",
      );
      await expectClockPast(serverTime(ownLine));
      const text = `hidden DM after own send ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", text);
      await expectDeliveredToPage(page, text);

      await setPageHidden(page, false);
      await expect(messageText(page, text)).toBeVisible();
      await expect(page.locator("[data-new-line]")).toBeVisible();
    } finally {
      peer.close();
    }
  });

  test("renders a DM in a visible unfocused window and shows New on return", async ({
    isMobile,
    page,
  }) => {
    test.skip(isMobile, "installed phone apps are foreground without focus");
    await installFocusControl(page);
    await installPageNotificationStub(page, {
      permission: "granted",
      requestResult: "granted",
    });
    const peer = await openDirect(page, "unfocused", isMobile);
    try {
      await setPageFocused(page, false);
      const text = `unfocused DM arrival ${Date.now()}`;
      const line = await peer.privmsgConfirmed("weblounge", text);
      await expect(messageText(page, text)).toBeVisible();
      await expect
        .poll(async () =>
          (await postedPageNotifications(page)).map(({ body }) => body),
        )
        .toContain(text);

      const refocusedAt = await setPageFocused(page, true);
      await expect(page.locator("[data-new-line]")).toBeVisible();
      await expect
        .poll(() => markReadSentAt(page, peer.nickname, serverTime(line)))
        .toBeGreaterThan(refocusedAt);
    } finally {
      peer.close();
    }
  });

  test("shows New when the reader is scrolled away from the live edge", async ({
    isMobile,
    page,
  }) => {
    const peer = await openDirect(page, "scrolled", isMobile);
    try {
      const list = page.locator("[data-message-list]");
      for (let index = 0; index < 30; index += 1)
        await peer.privmsgConfirmed(
          "weblounge",
          `scroll seed ${index} ${"wrapped transcript line ".repeat(8)}`,
        );
      await expect.poll(() => bufferUnreadCount(page, peer.nickname)).toBe(0);
      await expect.poll(() => scrollRange(list)).toBeGreaterThan(100);
      await scrollAwayFromLiveEdge(page, list, {
        input: isMobile ? "touch" : "wheel",
      });

      const text = `scrolled DM arrival ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", text);
      await expect(
        bufferRow(page, peer.nickname).getByRole("status"),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toBeVisible();
      await list.press("End");
      await expect(messageText(page, text)).toBeVisible();
      await expect(page.locator("[data-new-line]")).toBeVisible();
    } finally {
      peer.close();
    }
  });
});

async function openDirect(
  page: Page,
  scenario: string,
  isMobile: boolean,
): Promise<IrcClient> {
  const suffix = `${scenario.slice(0, 1)}${Date.now().toString(36).slice(-6)}`;
  const peer = await IrcClient.connectWithoutJoin(
    `divider-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
  );
  try {
    await page.goto("/?irc-password=weblounge-test");
    if (isMobile) {
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();
      await page
        .getByRole("button", { name: /^#weblounge-test(?:,|$)/ })
        .click();
      await expect(
        page.getByRole("heading", { name: "#weblounge-test" }),
      ).toBeVisible();
    } else
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const seed = `open focused DM ${suffix}`;
    await submitComposer(page, `/query ${peer.nickname} ${seed}`);
    await expect(
      page.getByRole("heading", { name: peer.nickname }),
    ).toBeVisible();
    if (isMobile) await expect(page.locator("[data-motion]")).toHaveCount(0);
    await expect(messageText(page, seed)).toBeVisible();
    await expect.poll(() => bufferUnreadCount(page, peer.nickname)).toBe(0);
    await expect(page.locator("[data-new-line]")).toHaveCount(0);
    return peer;
  } catch (error) {
    peer.close();
    throw error;
  }
}

function serverTime(line: string): number {
  const time = line.match(/(?:^@|;)time=([^; ]+)/u)?.[1];
  if (time === undefined) throw new Error(`no server time in ${line}`);
  return Date.parse(time);
}

// Read marks compare millisecond server times, so a reply stamped in the same
// millisecond as the own send would count as already read.
async function expectClockPast(timeMs: number): Promise<void> {
  await expect.poll(() => Date.now()).toBeGreaterThan(timeMs);
}

async function submitComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: /Message/ });
  await composer.fill(text);
  await composer.press("Enter");
}

async function expectDeliveredToPage(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => historyMessageUpdateCount(page, text))
    .toBeGreaterThan(0);
}

function bufferRow(page: Page, title: string) {
  return page.locator("[data-buffer-id]").filter({ hasText: title });
}

function messageText(page: Page, text: string) {
  return page.locator("[data-message-list]").getByText(text, { exact: true });
}

function bufferUnreadCount(page: Page, title: string): Promise<number> {
  return bufferRow(page, title).evaluate((row) => {
    const desktopCount = row.getAttribute("data-unread");
    if (desktopCount !== null) return Number(desktopCount);
    return Number(row.querySelector('[role="status"]')?.textContent ?? 0);
  });
}

async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("visibility control is missing");
    setter(nextHidden);
  }, hidden);
}

async function installFocusControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let focused = true;
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => focused,
    });
    Reflect.set(globalThis, "__setPageFocused", (next: boolean) => {
      focused = next;
      window.dispatchEvent(new Event(next ? "focus" : "blur"));
    });
  });
}

async function setPageFocused(page: Page, focused: boolean): Promise<number> {
  return page.evaluate((next) => {
    const setter = Reflect.get(globalThis, "__setPageFocused");
    if (typeof setter !== "function")
      throw new Error("focus control is missing");
    const at = performance.timeOrigin + performance.now();
    setter(next);
    return at;
  }, focused);
}

async function markReadSentAt(
  page: Page,
  target: string,
  throughMs: number,
): Promise<number | undefined> {
  const sent = await sentWireLines(page);
  return sent.find(({ line }) => {
    const marker = /(?:^| )MARKREAD (\S+) timestamp=(\S+)$/u.exec(line);
    return (
      marker?.[1]?.toLowerCase() === target.toLowerCase() &&
      Date.parse(marker[2] ?? "") >= throughMs
    );
  })?.at;
}

function scrollRange(
  list: import("@playwright/test").Locator,
): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
}
