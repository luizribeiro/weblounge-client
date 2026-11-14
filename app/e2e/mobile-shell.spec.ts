import type { IrcClient } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { expectSettled } from "./settled";
import { armMessageTime } from "./time-rewrite";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 402, height: 874 },
});

test.describe("mobile shell against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("toggles viewport diagnostics from the hidden debug command", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });

    await composer.fill("/deb");
    await expect(page.locator("[data-composer-suggestions]")).toHaveCount(0);
    await composer.fill("/debug");
    await expect(page.getByRole("option", { name: /\/debug/u })).toBeVisible();
    await composer.fill("/debug viewport");
    await composer.press("Enter");
    const debugOverlay = page.locator("[data-debug-overlay]");
    await expect(debugOverlay).toBeVisible();
    await expect(debugOverlay).toContainText("[viewport]");

    await composer.fill("/debug off");
    await composer.press("Enter");
    await expect(debugOverlay).toHaveCount(0);
  });

  test("shows foreground lifecycle events in default debug diagnostics", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });

    await page.evaluate(() => {
      const state = {
        focused: true,
        hidden: false,
        visibility: "visible" as DocumentVisibilityState,
      };
      Object.defineProperties(document, {
        hasFocus: { configurable: true, value: () => state.focused },
        hidden: { configurable: true, get: () => state.hidden },
        visibilityState: {
          configurable: true,
          get: () => state.visibility,
        },
      });
      state.focused = false;
      window.dispatchEvent(new Event("blur"));
      state.hidden = true;
      state.visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      state.focused = true;
      state.hidden = false;
      state.visibility = "visible";
      window.dispatchEvent(new Event("focus"));
    });

    await composer.fill("/debug");
    await composer.press("Enter");
    const debugOverlay = page.locator("[data-debug-overlay]");
    await expect(debugOverlay).toBeVisible();
    await expect(debugOverlay).toContainText(
      "focus visibility=visible focus=true hidden=false",
    );
    await expect(debugOverlay).toContainText(
      "visibilitychange visibility=hidden focus=false hidden=true",
    );
    await expect(debugOverlay).toContainText(
      "blur visibility=visible focus=false hidden=false",
    );
    await expect(
      debugOverlay.getByRole("button", { name: "Copy" }),
    ).toBeVisible();

    const contents = (await debugOverlay.textContent()) ?? "";
    expect(contents.indexOf("focus visibility=visible")).toBeLessThan(
      contents.indexOf("visibilitychange visibility=hidden"),
    );
    expect(contents.indexOf("visibilitychange visibility=hidden")).toBeLessThan(
      contents.indexOf("blur visibility=visible"),
    );
  });

  test("confirms typed quit before mobile execution", async ({ page, irc }) => {
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await composer.fill("/quit later");
    await composer.press("Enter");

    const confirmation = page.getByRole("alertdialog", {
      name: "Confirm /quit",
    });
    await expect(confirmation).toBeVisible();
    await expect(
      confirmation.getByText("Disconnect from this network?"),
    ).toBeVisible();
    await expect(
      confirmation.getByRole("button", { name: "Disconnect" }),
    ).toBeVisible();
    await expect(composer).toBeFocused();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(composer).toHaveValue("/quit later");
    await expect(composer).toBeFocused();
    await expect(
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
  });

  test("keeps the chats list mounted throughout back navigation", async ({
    page,
    irc,
  }, testInfo) => {
    await page.goto(irc.url());
    const row = page.getByRole("button", { name: irc.channel });
    await expect(row).toBeVisible();
    const originalRow = await row.elementHandle();
    if (originalRow === null) throw new Error("chat row is missing");

    await row.click();
    await expect(
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
    await expect(page.locator("[data-mobile-chats]")).toHaveCount(1);
    await expect(
      page.locator("[data-retained] [data-buffer-id]"),
    ).not.toHaveCount(0);

    await page.getByRole("button", { name: "Back to chats" }).click();
    for (let frame = 0; frame < 3; frame += 1) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      await expect(
        page.locator("[data-mobile-chats] [data-buffer-id]"),
      ).not.toHaveCount(0);
      await testInfo.attach(`chat-list-back-frame-${frame + 1}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }

    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    expect(
      await row.evaluate(
        (current, original) => current === original,
        originalRow,
      ),
    ).toBe(true);
  });

  test("keeps an opened conversation's rows mounted when its history edge arrives", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("edge");
    const text = `before opening ${irc.id}`;
    const selector = `[data-message-row][data-message-text="${text}"]`;
    await page.addInitScript((rowSelector) => {
      new MutationObserver((_records, observer) => {
        const row = document.querySelector(rowSelector);
        if (row === null) return;
        Object.assign(window, { firstMountedRow: row });
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    }, selector);
    await page.goto(irc.url());
    await peer.privmsgConfirmed(irc.channel, text);
    const chatRow = page.getByRole("button", { name: irc.channel });
    await expect(chatRow).toContainText(text);

    await chatRow.click();
    await expect(
      page.getByText(`Beginning of ${irc.channel}`, { exact: true }),
    ).toBeVisible();
    const messageRow = page.locator(selector);
    await expect(messageRow).toBeVisible();
    expect(
      await messageRow.evaluate(
        (current) =>
          current ===
          (window as Window & { firstMountedRow?: Element }).firstMountedRow,
      ),
    ).toBe(true);
  });

  test("navigates, swipes, and keeps state across shells", async ({
    page,
    irc,
  }) => {
    await test.step("open the mobile chats shell", async () => {
      await installNativeFeelInstrumentation(page);
      await page.setViewportSize({ width: 402, height: 874 });
      await page.goto(irc.url());
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();
      await expect(
        page.getByRole("button", { name: irc.channel }),
      ).toBeVisible();
    });

    let bots: IrcClient[] = [];
    const targetNick = irc.nickNamed("mobile09");
    const suffix = targetNick.slice("mobile09".length);
    const target = page.getByRole("button", {
      name: new RegExp(`^${targetNick}(?:,|$)`),
    });
    await test.step("connect IRC bots and seed direct previews", async () => {
      bots = await Promise.all(
        Array.from({ length: 11 }, async (_, index) => {
          const bot = await irc.peer(
            `mobile${index.toString().padStart(2, "0")}`,
          );
          await bot.privmsgConfirmed(
            irc.account,
            `preview from ${bot.nickname}`,
          );
          return bot;
        }),
      );
      await expect(target).toContainText(`preview from ${targetNick}`);
      await expect(
        page.locator("[data-mobile-chat-list] button").filter({
          hasText: new RegExp(`preview from mobile\\d{2}${suffix}`),
        }),
      ).toHaveCount(11);
    });

    await test.step("audit the member drawer and return to chats", async () => {
      await page.getByRole("button", { name: irc.channel }).click();
      await page.getByRole("button", { name: "Show members" }).click();
      const drawerMember = page.getByRole("button", {
        name: `Open direct message with ${targetNick}`,
      });
      await expect(drawerMember).toBeVisible();
      const drawer = page.getByRole("dialog", { name: "Members" });
      await expect(
        drawer.getByRole("button", {
          name: new RegExp(`Open direct message with mobile\\d{2}${suffix}`),
        }),
      ).toHaveCount(11);
      const mobileBoxes = await drawer
        .locator("li:visible")
        .evaluateAll((rows) =>
          rows
            .map((row) => {
              const box = row.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            })
            .sort((first, second) => first.top - second.top),
        );
      for (let index = 1; index < mobileBoxes.length; index += 1)
        expect(mobileBoxes[index - 1]?.bottom).toBeLessThanOrEqual(
          mobileBoxes[index]?.top ?? 0,
        );
      const mobileStack = await drawer.evaluate((element) => ({
        headerBottom:
          element.querySelector("header")?.getBoundingClientRect().bottom ?? 0,
        listTop: element.querySelector("ul")?.getBoundingClientRect().top ?? 0,
      }));
      expect(mobileStack.headerBottom).toBeLessThanOrEqual(mobileStack.listTop);
      await page
        .getByRole("searchbox", { name: "Filter members" })
        .fill(targetNick);
      await expect(drawerMember).toBeVisible();
      await resetNativeFeelLayoutShift(page);
      await nativeFeelAudit(page);
      await page.goBack();
      await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("heading", { name: irc.channel }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Show members" }).click();
      await page
        .getByRole("searchbox", { name: "Filter members" })
        .fill(targetNick);
      await page
        .getByRole("button", {
          name: `Open direct message with ${targetNick}`,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      await page
        .locator(`[data-mobile-chat]`)
        .filter({ has: page.getByRole("heading", { name: targetNick }) })
        .getByRole("button", { name: "Back to chats" })
        .click();
      await expect(
        page.getByRole("heading", { name: irc.channel }),
      ).toBeVisible();
      await page
        .locator(`[data-mobile-chat]`)
        .filter({
          has: page.getByRole("heading", { name: irc.channel }),
        })
        .getByRole("button", { name: "Back to chats" })
        .click();
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    });

    const scrollTop =
      await test.step("filter chats, join a channel, and restore the direct chat", async () => {
        await page.getByRole("button", { name: "Direct" }).click();
        await page
          .getByRole("searchbox", { name: "Search chats" })
          .fill(targetNick);
        await expect(
          page.locator("[data-mobile-chats] [data-buffer-id]"),
        ).toHaveCount(1);
        await page.getByRole("searchbox", { name: "Search chats" }).fill("");

        const savedScrollTop = await target.evaluate((row) => {
          const list = row.closest("[data-mobile-chat-list]");
          if (!(list instanceof HTMLElement))
            throw new Error("chat list missing");
          list.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: 1 }),
          );
          list.scrollTop = list.scrollHeight;
          list.dispatchEvent(new Event("scroll"));
          return list.scrollTop;
        });
        expect(savedScrollTop).toBeGreaterThan(0);
        await target.click();
        await expect(
          page.getByRole("heading", { name: targetNick }),
        ).toBeVisible();
        const chatHistoryLength = await page.evaluate(() => history.length);
        const joinedChannel = irc.channelNamed("mobile-back");
        const joinComposer = page.getByRole("textbox", {
          name: `Message ${targetNick}`,
        });
        await joinComposer.fill(`/join ${joinedChannel}`);
        await joinComposer.press("Enter");
        await expect(
          page.getByRole("heading", { name: joinedChannel }),
        ).toBeVisible();
        await expectSettled(page);
        expect(await page.evaluate(() => history.length)).toBe(
          chatHistoryLength,
        );
        await page.goBack();
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
        await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
        await page
          .getByRole("button", {
            name: new RegExp(`^${targetNick}(?:,|$)`),
          })
          .click();
        await expect(
          page.getByRole("heading", { name: targetNick }),
        ).toBeVisible();
        await expect(
          page
            .locator("[data-mobile-chat]")
            .getByText(`preview from ${targetNick}`, { exact: true }),
        ).toBeVisible();
        return savedScrollTop;
      });

    await test.step("render and send wrapped direct messages", async () => {
      const wrappingText =
        "A deliberately long mobile message wraps beneath itself instead of reserving desktop columns on this narrow screen.";
      const groupedText = "A same-minute follow-up uses the full text width.";
      const transcript = page.getByRole("list", { name: "Messages" });
      const composer = page.getByRole("textbox", {
        name: `Message ${targetNick}`,
      });
      await composer.fill("/version");
      await composer.press("Enter");
      await expect(
        transcript.locator("[data-notice-row]").last(),
      ).toBeVisible();
      const groupedMinute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
      await Promise.all([
        armMessageTime(wrappingText, groupedMinute + 1_000),
        armMessageTime(groupedText, groupedMinute + 2_000),
      ]);
      await bots[9]?.privmsgConfirmed(irc.account, wrappingText);
      const wrappedMessage = transcript.getByText(wrappingText, {
        exact: true,
      });
      await expect(wrappedMessage).toBeVisible();
      const wrappedRow = wrappedMessage.locator(
        "xpath=ancestor::*[@data-message-row]",
      );
      await expect(wrappedRow).toHaveAttribute(
        "data-unverified-sender",
        "true",
      );
      await expect(wrappedRow).toHaveAttribute(
        "data-message-group-start",
        "true",
      );
      const geometry = await wrappedMessage.evaluate((text) => {
        const row = text.closest<HTMLElement>("[data-message-row]");
        const nick = row?.querySelector<HTMLElement>("[title]");
        if (row === null || nick === null)
          throw new Error("message geometry is missing");
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = [...range.getClientRects()];
        const lastTop = Math.max(...lines.map((line) => line.top));
        const rowStyle = getComputedStyle(row);
        return {
          contentLeft:
            row.getBoundingClientRect().left +
            Number.parseFloat(rowStyle.paddingLeft),
          firstLeft: lines[0]?.left,
          firstTop: lines[0]?.top,
          lastLeft: Math.min(
            ...lines
              .filter((line) => Math.abs(line.top - lastTop) < 0.5)
              .map((line) => line.left),
          ),
          lineCount: lines.length,
          nickBottom: nick.getBoundingClientRect().bottom,
        };
      });
      expect(geometry.lineCount).toBeGreaterThan(1);
      expect(geometry.firstTop).toBeGreaterThanOrEqual(geometry.nickBottom);
      expect(geometry.firstLeft).toBeCloseTo(geometry.contentLeft, 0);
      expect(geometry.lastLeft).toBeCloseTo(geometry.contentLeft, 0);
      await bots[9]?.privmsgConfirmed(irc.account, groupedText);
      const groupedMessage = transcript.getByText(groupedText, {
        exact: true,
      });
      const groupedRow = groupedMessage.locator(
        "xpath=ancestor::*[@data-message-row]",
      );
      await expect(groupedRow).toHaveAttribute(
        "data-message-group-start",
        "false",
      );
      await expect(groupedRow.locator("time")).toBeHidden();
      expect(
        await groupedMessage.evaluate((text) => {
          const row = text.closest<HTMLElement>("[data-message-row]");
          if (row === null) throw new Error("message row is missing");
          const rowStyle = getComputedStyle(row);
          return (
            text.getBoundingClientRect().left -
            row.getBoundingClientRect().left -
            Number.parseFloat(rowStyle.paddingLeft)
          );
        }),
      ).toBeCloseTo(0, 0);
      await composer.fill("mobile reply");
      await composer.press("Enter");
      await expect(
        page.getByText("mobile reply", { exact: true }),
      ).toBeVisible();
    });

    await test.step("restore list state and exercise swipe navigation", async () => {
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Direct" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() =>
          target.evaluate(
            (row) =>
              row.closest<HTMLElement>("[data-mobile-chat-list]")?.scrollTop,
          ),
        )
        .toBe(scrollTop);

      await target.click();
      await expect(
        page.locator("[data-mobile-chats]").locator(".."),
      ).toHaveAttribute("aria-hidden", "true");
      await expectSettled(page);
      const shell = page.locator("[data-mobile-shell]");
      await shell.dispatchEvent("pointerdown", {
        clientX: 5,
        clientY: 300,
        isPrimary: true,
        pointerId: 7,
      });
      await shell.dispatchEvent("pointermove", {
        clientX: 20,
        clientY: 300,
        isPrimary: true,
        pointerId: 7,
      });
      await shell.dispatchEvent("pointermove", {
        clientX: 150,
        clientY: 300,
        isPrimary: true,
        pointerId: 7,
      });
      await page.waitForTimeout(150); // wait-ok: hold sets low velocity for returning-swipe coverage.
      await shell.dispatchEvent("pointerup", {
        clientX: 150,
        clientY: 300,
        isPrimary: true,
        pointerId: 7,
      });
      const returningScreen = page.locator('[data-motion="returning"]');
      await expect(returningScreen).toHaveCSS(
        "transition-property",
        "transform",
      );
      await expectSettled(page);
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      await shell.dispatchEvent("pointerdown", {
        clientX: 5,
        clientY: 300,
        isPrimary: true,
        pointerId: 8,
      });
      await shell.dispatchEvent("pointermove", {
        clientX: 20,
        clientY: 300,
        isPrimary: true,
        pointerId: 8,
      });
      await shell.dispatchEvent("pointermove", {
        clientX: 260,
        clientY: 300,
        isPrimary: true,
        pointerId: 8,
      });
      await shell.dispatchEvent("pointerup", {
        clientX: 260,
        clientY: 300,
        isPrimary: true,
        pointerId: 8,
      });
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    });

    await test.step("preserve the mobile shell across viewport changes", async () => {
      await target.click();
      await page.setViewportSize({ width: 900, height: 874 });
      await expect(page.locator("[data-mobile-shell]")).toBeVisible();
      await expect(page.locator("[data-desktop-shell]")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      await page.setViewportSize({ width: 402, height: 874 });
      await expect(page.locator("[data-mobile-chat]")).toBeVisible();
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
    });
  });
});
