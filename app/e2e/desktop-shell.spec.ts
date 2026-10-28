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

    await network.click();
    await expect(
      page.getByRole("heading", { name: "Local Ergo" }),
    ).toBeVisible();
    await channel.click();
    await expect(
      page.getByRole("heading", { name: "#weblounge-test" }),
    ).toBeVisible();

    await page.keyboard.press("Alt+ArrowDown");
    await expect(
      page.getByRole("heading", { name: "Local Ergo" }),
    ).toBeVisible();
    await channel.click();

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
      await expect(
        screenshotPage.getByText("weblounge: history on open is working", {
          exact: true,
        }),
      ).toBeVisible();
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
