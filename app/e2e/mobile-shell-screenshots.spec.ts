import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");

test.use({
  colorScheme: "light",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 402, height: 874 },
});

test.describe("mobile shell screenshots against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("captures the chats list and pushed conversation", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByText("connected · 1 network", { exact: true }),
    ).toBeVisible();
    const bots: IrcClient[] = [];
    try {
      for (const nick of ["ana-mobile", "tomo-mobile", "mel-mobile"]) {
        bots.push(
          await IrcClient.connect(
            nick,
            "weblounge-bot",
            "weblounge-bot-test",
            "#weblounge-test",
          ),
        );
      }
      await bots[0]?.privmsgConfirmed(
        "#weblounge-test",
        "The garden is looking especially cozy today",
      );
      await bots[1]?.actionConfirmed(
        "#weblounge-test",
        "puts a fresh pot of coffee on",
      );
      await bots[2]?.privmsgConfirmed(
        "#weblounge-test",
        "Mobile history is ready for the lounge",
      );
      await bots[0]?.privmsgConfirmed(
        "weblounge",
        "Are you joining the garden chat later?",
      );
      await bots[1]?.privmsgConfirmed(
        "weblounge",
        "I saved you the window seat",
      );
      await bots[2]?.privmsgConfirmed(
        "weblounge",
        "The mobile shell feels delightfully calm",
      );

      await expect(
        page.getByRole("button", { name: "mel-mobile" }),
      ).toContainText("delightfully calm");
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDirectory, "mobile-chats-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: path.join(screenshotDirectory, "mobile-chats-dark.png"),
      });

      await page.emulateMedia({ colorScheme: "light" });
      await page.getByRole("button", { name: "#weblounge-test" }).click();
      await expect(
        page.getByText("Mobile history is ready for the lounge", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("[data-mobile-chats]")).toHaveCount(0);
      const composerBox = await page
        .getByRole("textbox", { name: "Message #weblounge-test" })
        .boundingBox();
      expect(composerBox?.y).toBeGreaterThan(760);
      await expect
        .poll(() =>
          page.locator("[data-message-row]").evaluateAll((rows) =>
            rows.some((row, index) => {
              const next = rows[index + 1];
              return (
                next !== undefined &&
                row.getBoundingClientRect().bottom >
                  next.getBoundingClientRect().top + 0.5
              );
            }),
          ),
        )
        .toBe(false);
      await page.screenshot({
        path: path.join(screenshotDirectory, "mobile-chat-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: path.join(screenshotDirectory, "mobile-chat-dark.png"),
      });
      await page.getByRole("button", { name: "Show members" }).click();
      await expect(
        page.getByRole("button", {
          name: "Open direct message with mel-mobile",
        }),
      ).toBeVisible();
      await page
        .getByRole("dialog", { name: "Members" })
        .evaluate(async (dialog) =>
          Promise.all(
            dialog
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished),
          ),
        );
      await page.emulateMedia({ colorScheme: "light" });
      await page.screenshot({
        path: path.join(screenshotDirectory, "mobile-members-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: path.join(screenshotDirectory, "mobile-members-dark.png"),
      });
    } finally {
      for (const bot of bots) bot.close();
    }
  });
});
