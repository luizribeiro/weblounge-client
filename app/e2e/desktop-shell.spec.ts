import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");

test.describe("desktop shell against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("anchors a short real conversation to the bottom", async ({ page }) => {
    const bot = await IrcClient.connect(
      "short-timeline",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await bot.privmsgConfirmed("#weblounge-test", "short line one");
      await bot.privmsgConfirmed("#weblounge-test", "short line two");
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByText("short line two", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message" })
        .fill("short line three");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText("short line three", { exact: true }),
      ).toBeVisible();

      const geometry = await page
        .locator("[data-message-list]")
        .evaluate((list) => {
          const rows = list.querySelectorAll<HTMLElement>("[data-message-row]");
          return {
            firstTop: rows[0]?.getBoundingClientRect().top ?? 0,
            lastBottom:
              rows[rows.length - 1]?.getBoundingClientRect().bottom ?? 0,
            listTop: list.getBoundingClientRect().top,
            listBottom: list.getBoundingClientRect().bottom,
          };
        });
      expect(geometry.firstTop).toBeGreaterThan(geometry.listTop + 300);
      expect(geometry.listBottom - geometry.lastBottom).toBeLessThan(30);
    } finally {
      bot.close();
    }
  });

  test("composes commands, completion, and per-buffer drafts", async ({
    page,
  }) => {
    const draftChannel = `#another-${Date.now().toString(36)}`;
    const bot = await IrcClient.connect(
      "composer",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await bot.privmsgConfirmed(
        "#weblounge-test",
        "hello from completion bot",
      );
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/?irc-password=weblounge-test");
      await expect(
        page.getByText("hello from completion bot", { exact: true }),
      ).toBeVisible();
      const composer = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });

      await composer.fill("plain composer message");
      await composer.press("Enter");
      await expect(
        page.getByText("plain composer message", { exact: true }),
      ).toBeVisible();
      await composer.fill("/me waves hello");
      await composer.press("Enter");
      await expect(
        page.locator("[data-message-row]").filter({ hasText: "waves hello" }),
      ).toBeVisible();

      await composer.fill("comp");
      await composer.press("Tab");
      await expect(composer).toHaveValue("composer ");
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDirectory, "composer-completion-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: path.join(screenshotDirectory, "composer-completion-dark.png"),
      });

      await composer.fill(`/j ${draftChannel}`);
      await composer.press("Enter");
      await expect(
        page.getByRole("heading", { name: draftChannel }),
      ).toBeVisible();
      const another = page.getByRole("textbox", {
        name: `Message ${draftChannel}`,
      });
      await another.fill("draft in another");
      await page.getByRole("button", { name: /^#weblounge-test/ }).click();
      await composer.fill("draft in home");
      await page.getByRole("button", { name: draftChannel }).click();
      await expect(another).toHaveValue("draft in another");
      await page.getByRole("button", { name: /^#weblounge-test/ }).click();
      await expect(composer).toHaveValue("draft in home");

      await page.goto("/?irc-password=weblounge-test");
      await page.getByRole("button", { name: /^#weblounge-test/ }).click();
      const reloadedHome = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });
      await expect(reloadedHome).toHaveValue("draft in home");
      await reloadedHome.fill(`/join ${draftChannel}`);
      await reloadedHome.press("Enter");
      const restoredAnother = page.getByRole("textbox", {
        name: `Message ${draftChannel}`,
      });
      await expect(restoredAnother).toHaveValue("draft in another");

      await restoredAnother.fill("/hop");
      await restoredAnother.press("Enter");
      await expect(
        page.getByRole("heading", { name: draftChannel }),
      ).toBeVisible();

      await restoredAnother.fill("/q composer hi");
      await restoredAnother.press("Enter");
      await expect(
        page.getByRole("heading", { name: "composer" }),
      ).toBeVisible();
      await expect(page.getByText("hi", { exact: true })).toBeVisible();
      const direct = page.getByRole("textbox", {
        name: "Message composer",
      });
      await direct.fill("/help join");
      await direct.press("Enter");
      await expect(
        page.getByRole("status").filter({ hasText: "/join" }),
      ).toBeVisible();

      await direct.fill("/close");
      await direct.press("Enter");
      await expect(page.getByRole("button", { name: /^composer/ })).toHaveCount(
        0,
      );
    } finally {
      bot.close();
    }
  });

  test("navigates real buffers and follows the system theme", async ({
    browser,
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?irc-password=weblounge-test");

    const sidebar = page.getByRole("complementary", { name: "Channel list" });
    const network = page.getByRole("button", { name: "Local Ergo, online" });
    const channel = page.getByRole("button", { name: /^#weblounge-test/ });
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("width", "256px");
    await expect(network).toBeVisible();
    await expect(channel).toBeVisible();

    await channel.click();
    await expect(
      page.getByRole("heading", { name: "#weblounge-test" }),
    ).toBeVisible();

    const toggle = page.getByRole("button", { name: "Toggle channel list" });
    await toggle.click();
    await expect(sidebar).toHaveCount(0);
    await expect(page.locator("main[data-chromeless='true']")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("[data-message-list]")
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThanOrEqual(880);
    await toggle.click();
    await expect(sidebar).toBeVisible();

    const bot = await IrcClient.connect(
      "shell-screenshot",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const message = `the desktop shell is live ${Date.now()}`;
    const seedClients: IrcClient[] = [];
    let screenshotContext:
      | Awaited<ReturnType<typeof browser.newContext>>
      | undefined;
    try {
      await bot.privmsgConfirmed("#weblounge-test", message);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message" })
        .fill("I like where this client is going");
      await page.getByRole("button", { name: "Send" }).click();

      for (const nick of ["ana", "tomo", "mel"]) {
        seedClients.push(
          await IrcClient.connect(
            nick,
            "weblounge-bot",
            "weblounge-bot-test",
            "#weblounge-test",
          ),
        );
      }
      await seedClients[0]?.privmsgConfirmed(
        "#weblounge-test",
        "The garden is looking especially cozy today",
      );
      await seedClients[1]?.actionConfirmed(
        "#weblounge-test",
        "puts a fresh pot of coffee on",
      );
      await seedClients[2]?.privmsgConfirmed(
        "#weblounge-test",
        "weblounge: history on open is working",
      );
      await seedClients[2]?.part("#weblounge-test");

      const origin = new URL(page.url()).origin;
      screenshotContext = await browser.newContext({
        colorScheme: "light",
        viewport: { width: 1440, height: 1300 },
      });
      const screenshotPage = await screenshotContext.newPage();
      await screenshotPage.goto(`${origin}/?irc-password=weblounge-test`);
      await screenshotPage
        .getByRole("button", { name: /^#weblounge-test/ })
        .click();
      await expect(
        screenshotPage.getByText("weblounge: history on open is working", {
          exact: true,
        }),
      ).toBeVisible();
      for (const [text, nick] of [
        ["The garden is looking especially cozy today", "ana"],
        ["puts a fresh pot of coffee on", "tomo"],
        ["weblounge: history on open is working", "mel"],
      ] as const) {
        await expect(
          screenshotPage
            .locator("[data-message-row]")
            .filter({ hasText: text }),
        ).toContainText(nick);
      }
      await mkdir(screenshotDirectory, { recursive: true });
      await screenshotPage.screenshot({
        path: path.join(screenshotDirectory, "desktop-shell-light.png"),
      });

      await screenshotPage.emulateMedia({ colorScheme: "dark" });
      await expect
        .poll(() =>
          screenshotPage.evaluate(() => ({
            background: getComputedStyle(document.documentElement)
              .getPropertyValue("--wl-color-bg")
              .trim(),
            theme: document.documentElement.dataset.theme,
          })),
        )
        .toEqual({ background: "#18221e", theme: "lounge-night" });
      await screenshotPage.screenshot({
        path: path.join(screenshotDirectory, "desktop-shell-dark.png"),
      });
    } finally {
      await screenshotContext?.close();
      for (const client of seedClients) client.close();
      bot.close();
    }
  });
});
