import { expect, test } from "@playwright/test";
import {
  advanceEngineClock,
  installEngineClock,
  startEngineClock,
} from "./engine-clock";
import { IrcClient } from "./irc-client";

const channel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test.describe("typing indicators", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows and clears incoming channel and direct typing", async ({
    page,
  }) => {
    const peer = await IrcClient.connect(
      "typing-peer",
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const indicator = page.locator("[data-typing-indicator]");
    try {
      await installEngineClock(page);
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      await peer.typingConfirmed(channel, "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      await peer.typingConfirmed(channel, "done");
      await expect(indicator).toHaveText("");

      await peer.typingConfirmed(channel, "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      const channelMessage = `typing clear ${Date.now()}`;
      await peer.privmsgConfirmed(channel, channelMessage);
      await expect(
        page.getByText(channelMessage, { exact: true }),
      ).toBeVisible();
      await expect(indicator).toHaveText("");

      const directMessage = `open typing direct ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", directMessage);
      await page
        .getByRole("button", { name: /^typing-peer, 1 unread/u })
        .click();
      await expect(
        page.getByRole("heading", { name: "typing-peer" }),
      ).toBeVisible();
      await peer.typingConfirmed("weblounge", "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      await peer.typingConfirmed("weblounge", "done");
      await expect(indicator).toHaveText("");

      await page.getByRole("button", { name: channel, exact: true }).click();
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      await startEngineClock(page);
      await peer.typingConfirmed(channel, "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      await advanceEngineClock(page, 6_001);
      await expect(indicator).toHaveText("");
    } finally {
      peer.close();
    }
  });

  test("sends throttled active, paused, and done states", async ({ page }) => {
    const observer = await IrcClient.connect(
      "typing-observer",
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      const composer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });

      await composer.fill("h");
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "active",
      );
      await composer.fill("he");
      await composer.fill("hel");
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "paused",
      );

      const text = `hello from typing ${Date.now()}`;
      await composer.fill(text);
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "active",
      );
      await composer.press("Enter");
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "done",
      );
      await observer.waitForPrivmsg(channel, text, "weblounge");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    } finally {
      observer.close();
    }
  });
});
