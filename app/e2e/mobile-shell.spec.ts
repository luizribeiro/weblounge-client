import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

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

  test("confirms typed quit before mobile execution", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
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
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(composer).toHaveValue("/quit later");
    await expect(
      page.getByRole("heading", { name: "#weblounge-test" }),
    ).toBeVisible();
  });

  test("navigates, swipes, and keeps state across shells", async ({ page }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 402, height: 874 });
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expect(
      page.getByText("connected · 1 network", { exact: true }),
    ).toBeVisible();

    const bots: IrcClient[] = [];
    const suffix = Date.now().toString().slice(-4);
    const targetNick = `mobile10${suffix}`;
    try {
      for (let index = 0; index < 11; index += 1) {
        const nick = `mobile${index.toString().padStart(2, "0")}${suffix}`;
        const bot = await IrcClient.connect(
          nick,
          "weblounge-bot",
          "weblounge-bot-test",
          "#weblounge-test",
        );
        bots.push(bot);
        await bot.privmsgConfirmed("weblounge", `preview from ${nick}`);
      }

      const target = page.getByRole("button", { name: targetNick });
      await expect(target).toContainText(`preview from ${targetNick}`);
      await page.getByRole("button", { name: "#weblounge-test" }).click();
      await page.getByRole("button", { name: "Show members" }).click();
      const drawerMember = page.getByRole("button", {
        name: `Open direct message with ${targetNick}`,
      });
      await expect(drawerMember).toBeVisible();
      const drawer = page.getByRole("dialog", { name: "Members" });
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
      await nativeFeelAudit(page);
      await page.goBack();
      await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("heading", { name: "#weblounge-test" }),
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
        page.getByRole("heading", { name: "#weblounge-test" }),
      ).toBeVisible();
      await page
        .locator(`[data-mobile-chat]`)
        .filter({ has: page.getByRole("heading", { name: "#weblounge-test" }) })
        .getByRole("button", { name: "Back to chats" })
        .click();
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();

      await page.getByRole("button", { name: "Direct" }).click();
      await page
        .getByRole("searchbox", { name: "Search chats" })
        .fill(targetNick);
      await expect(
        page.locator("[data-mobile-chats] [data-buffer-id]"),
      ).toHaveCount(1);
      await page.getByRole("searchbox", { name: "Search chats" }).fill("");

      const scrollTop = await target.evaluate((row) => {
        const list = row.parentElement;
        if (!(list instanceof HTMLElement))
          throw new Error("chat list missing");
        list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event("scroll"));
        return list.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(0);
      await target.click();
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      const chatHistoryLength = await page.evaluate(() => history.length);
      const joinedChannel = `#mobile-back-${suffix}`;
      const joinComposer = page.getByRole("textbox", {
        name: `Message ${targetNick}`,
      });
      await joinComposer.fill(`/join ${joinedChannel}`);
      await joinComposer.press("Enter");
      await expect(
        page.getByRole("heading", { name: joinedChannel }),
      ).toBeVisible();
      await expect(page.locator("[data-position]")).toHaveCount(0);
      expect(await page.evaluate(() => history.length)).toBe(chatHistoryLength);
      await page.goBack();
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();
      await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
      await page.getByRole("button", { name: targetNick }).click();
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      await expect(
        page
          .locator("[data-mobile-chat]")
          .getByText(`preview from ${targetNick}`, { exact: true }),
      ).toBeVisible();
      const wrappingText =
        "A deliberately long mobile message wraps beneath itself instead of reserving desktop columns on this narrow screen.";
      await bots.at(-1)?.privmsgConfirmed("weblounge", wrappingText);
      const geometry = await page
        .getByText(wrappingText, { exact: true })
        .evaluate((text) => {
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
            nickRight: nick.getBoundingClientRect().right,
            nickTop: nick.getBoundingClientRect().top,
          };
        });
      expect(geometry.lineCount).toBeGreaterThan(1);
      expect(geometry.firstTop).toBeCloseTo(geometry.nickTop, 0);
      expect(geometry.firstLeft).toBeGreaterThan(geometry.nickRight);
      expect(geometry.firstLeft - geometry.nickRight).toBeLessThan(12);
      expect(geometry.lastLeft).toBeCloseTo(geometry.contentLeft, 0);
      const composer = page.getByRole("textbox", {
        name: `Message ${targetNick}`,
      });
      await composer.fill("mobile reply");
      await composer.press("Enter");
      await expect(
        page.getByText("mobile reply", { exact: true }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Direct" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() => target.evaluate((row) => row.parentElement?.scrollTop))
        .toBe(scrollTop);

      await target.click();
      await expect(page.locator("[data-mobile-chats]")).toHaveCount(0);
      const shell = page.locator("[data-mobile-shell]");
      await shell.dispatchEvent("pointerdown", {
        clientX: 5,
        clientY: 300,
        pointerId: 7,
      });
      await shell.dispatchEvent("pointermove", {
        clientX: 45,
        clientY: 300,
        pointerId: 7,
      });
      await page.waitForTimeout(150);
      await shell.dispatchEvent("pointerup", {
        clientX: 45,
        clientY: 300,
        pointerId: 7,
      });
      const returningScreen = page.locator(
        '[data-swipe="chat"][data-swipe-returning="true"]',
      );
      await expect(returningScreen).toHaveCSS(
        "transition-property",
        "transform",
      );
      await expect(page.locator("[data-swipe]")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      await shell.dispatchEvent("pointerdown", {
        clientX: 5,
        clientY: 300,
        pointerId: 8,
      });
      await shell.dispatchEvent("pointermove", {
        clientX: 260,
        clientY: 300,
        pointerId: 8,
      });
      await shell.dispatchEvent("pointerup", {
        clientX: 260,
        clientY: 300,
        pointerId: 8,
      });
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();

      await target.click();
      await page.setViewportSize({ width: 900, height: 874 });
      await expect(page.locator("[data-sidebar]")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: targetNick }),
      ).toBeVisible();
      await page.setViewportSize({ width: 402, height: 874 });
      await expect(page.locator("[data-mobile-chat]")).toBeVisible();
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
    } finally {
      for (const bot of bots) bot.close();
    }
  });
});
