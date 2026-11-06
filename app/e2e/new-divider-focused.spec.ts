import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";

test.describe("New divider ownership", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.beforeEach(async ({ isMobile, page }) => {
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

  test("does not show New for a focused DM arrival at the live edge", async ({
    isMobile,
    page,
  }) => {
    const peer = await openDirect(page, "focused", isMobile);
    try {
      await observeUnreadBoundary(page, peer.nickname);
      const text = `focused DM arrival ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", text);

      await expect(messageText(page, text)).toBeVisible();
      await expect(page.locator("[data-new-line]")).toHaveCount(0);
      await nextPaint(page);
      await expect(page.locator("[data-new-line]")).toHaveCount(0);
      await expect.poll(() => unreadCountAppeared(page)).toBe(true);
      await expect.poll(() => bufferUnreadCount(page, peer.nickname)).toBe(0);
      expect(await unreadBoundaryAppeared(page)).toBe(false);
    } finally {
      peer.close();
    }
  });

  test("shows New when the DM arrives while the page is hidden", async ({
    isMobile,
    page,
  }) => {
    const peer = await openDirect(page, "hidden", isMobile);
    try {
      await setVisibility(page, true);
      const text = `hidden DM arrival ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", text);

      await setVisibility(page, false);
      await expect(messageText(page, text)).toBeVisible();
      await expect(page.locator("[data-new-line]")).toBeVisible();
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
      await expect
        .poll(() => bufferUnreadCount(page, peer.nickname))
        .toBeGreaterThan(0);
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
    const composer = page.getByRole("textbox", { name: /Message/ });
    await composer.fill(`/query ${peer.nickname} ${seed}`);
    await composer.press("Enter");
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

async function observeUnreadBoundary(page: Page, title: string): Promise<void> {
  await page.locator("[data-message-list]").evaluate((list) => {
    const state = window as Window & {
      unreadBoundaryAppeared?: boolean;
      unreadCountAppeared?: boolean;
    };
    state.unreadBoundaryAppeared = false;
    state.unreadCountAppeared = false;
    new MutationObserver(() => {
      if (list.querySelector("[data-new-line]") !== null)
        state.unreadBoundaryAppeared = true;
    }).observe(list, { childList: true, subtree: true });
  });
  await bufferRow(page, title).evaluate((row) => {
    const state = window as Window & { unreadCountAppeared?: boolean };
    new MutationObserver(() => {
      const desktopCount = row.getAttribute("data-unread");
      const count =
        desktopCount === null
          ? Number(row.querySelector('[role="status"]')?.textContent ?? 0)
          : Number(desktopCount);
      if (count > 0) state.unreadCountAppeared = true;
    }).observe(row, {
      attributeFilter: ["data-unread"],
      childList: true,
      subtree: true,
    });
  });
}

function unreadBoundaryAppeared(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as Window & { unreadBoundaryAppeared?: boolean })
        .unreadBoundaryAppeared === true,
  );
}

function unreadCountAppeared(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as Window & { unreadCountAppeared?: boolean })
        .unreadCountAppeared === true,
  );
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function setVisibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("visibility control is missing");
    setter(nextHidden);
  }, hidden);
}

function scrollRange(
  list: import("@playwright/test").Locator,
): Promise<number> {
  return list.evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
}
