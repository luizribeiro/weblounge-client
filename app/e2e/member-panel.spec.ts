import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const channel = "#weblounge-test";
const screenshots = path.join(process.cwd(), "e2e", "screenshots");

test.describe("desktop members against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("updates groups, toggles, and opens a DM", async ({ page }) => {
    const bot = await IrcClient.connect(
      "member-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    try {
      await bot.mode("member-bot", "+B");
      await installNativeFeelInstrumentation(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      const toggle = page.getByRole("button", { name: "Toggle member list" });
      await toggle.click();
      const panel = page.getByRole("complementary", { name: "Members" });
      await expect(panel).toHaveCSS("width", "232px");
      await expect(panel.getByText("Online — 1")).toBeVisible();
      await expect(panel.getByText("Bots — 1")).toBeVisible();
      await expect(
        panel.getByRole("button", {
          name: "Open direct message with member-bot",
        }),
      ).toBeVisible();
      const desktopBoxes = await panel
        .locator("li:visible")
        .evaluateAll((rows) =>
          rows
            .map((row) => {
              const box = row.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            })
            .sort((first, second) => first.top - second.top),
        );
      for (let index = 1; index < desktopBoxes.length; index += 1)
        expect(desktopBoxes[index - 1]?.bottom).toBeLessThanOrEqual(
          desktopBoxes[index]?.top ?? 0,
        );
      const desktopStack = await panel.evaluate((element) => ({
        headerBottom:
          element.querySelector("header")?.getBoundingClientRect().bottom ?? 0,
        listTop: element.querySelector("ul")?.getBoundingClientRect().top ?? 0,
      }));
      expect(desktopStack.headerBottom).toBeLessThanOrEqual(
        desktopStack.listTop,
      );

      await bot.mode(channel, "+o", "weblounge");
      await expect(panel.getByText("Operators — 1")).toBeVisible();
      await bot.mode(channel, "-o", "weblounge");
      await expect(panel.getByText("Online — 1")).toBeVisible();

      await page.keyboard.press("Control+Period");
      await expect(panel).toHaveCount(0);
      await page.keyboard.press("Control+Period");
      await expect(panel).toBeVisible();
      await expect
        .poll(() =>
          panel.evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState === "finished"),
          ),
        )
        .toBe(true);
      await nativeFeelAudit(page);

      await mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: path.join(screenshots, "member-panel-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: path.join(screenshots, "member-panel-dark.png"),
      });

      await panel
        .getByRole("button", { name: "Open direct message with member-bot" })
        .click();
      await expect(
        page.getByRole("heading", { name: "member-bot" }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message member-bot" }),
      ).toBeFocused();
      await expect(panel).toHaveCount(0);
    } finally {
      bot.close();
    }
  });

  test("resubscribes the open panel when switching channels", async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-5);
    const garden = `#members-${suffix}`;
    const roomNick = `room${suffix}`;
    const gardenNick = `garden${suffix}`;
    const gardenExtraNick = `leaf${suffix}`;
    const roomBot = await IrcClient.connect(
      roomNick,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const gardenBot = await IrcClient.connect(
      gardenNick,
      "weblounge-bot",
      "weblounge-bot-test",
      garden,
    );
    const gardenExtraBot = await IrcClient.connect(
      gardenExtraNick,
      "weblounge-bot",
      "weblounge-bot-test",
      garden,
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      const composer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });
      await composer.fill(`/join ${garden}`);
      await composer.press("Enter");
      const gardenButton = page.getByRole("button", { name: garden });
      await expect(gardenButton).toBeVisible();
      await page.getByRole("button", { name: channel }).click();

      await page.getByRole("button", { name: "Toggle member list" }).click();
      const panel = page.getByRole("complementary", { name: "Members" });
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${roomNick}`,
        }),
      ).toBeVisible();
      await expect(panel.getByText("2", { exact: true })).toBeVisible();
      await gardenButton.click();
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${gardenNick}`,
        }),
      ).toBeVisible();
      await expect(panel.getByText("3", { exact: true })).toBeVisible();
      await expect(panel.getByText(roomNick, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: channel }).click();
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${roomNick}`,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Hide members" }).click();
      await gardenButton.click();
      await page.getByRole("button", { name: "Toggle member list" }).click();
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${gardenNick}`,
        }),
      ).toBeVisible();
    } finally {
      roomBot.close();
      gardenBot.close();
      gardenExtraBot.close();
    }
  });
});
