import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const screenshots = path.join(process.cwd(), "..", "screenshots", "close");

test.describe("desktop conversation closing against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("closes DMs through every surface, persists them, and confirms PART", async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#close-${suffix}`;
    const peer = await IrcClient.connect(
      `close-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    try {
      await mkdir(screenshots, { recursive: true });
      await installNativeFeelInstrumentation(page);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/?irc-password=weblounge-test");
      const home = page.getByRole("button", { name: /^#weblounge-test/u });
      await home.click();
      const homeComposer = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });
      await homeComposer.fill(`/join ${channel}`);
      await homeComposer.press("Enter");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      await home.click();

      await peer.privmsgConfirmed("weblounge", `open direct ${suffix}`);
      const directRow = () =>
        page.getByRole("button", {
          name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
        });
      await expect(directRow()).toBeVisible();
      await directRow().click();
      await directRow().hover();
      const closeButton = page.getByRole("button", {
        name: `Close conversation with ${peer.nickname}`,
      });
      await expect(closeButton).toBeVisible();
      await captureThemes(
        page,
        page.getByRole("complementary", { name: "Channel list" }),
        "dm-hover",
      );
      await nativeFeelAudit(page);

      await closeButton.click();
      await expect(directRow()).toHaveCount(0);
      const toast = page.getByRole("status").filter({
        hasText: `Closed chat with ${peer.nickname}`,
      });
      await expect(toast).toBeVisible();
      await captureThemes(page, toast, "undo-toast");
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(directRow()).toBeVisible();

      await directRow().click({ button: "right" });
      const closeMenu = page.getByRole("menu", {
        name: `Actions for ${peer.nickname}`,
      });
      await expect(
        closeMenu.getByRole("menuitem", { name: "Close conversation" }),
      ).toBeVisible();
      await captureThemes(page, closeMenu, "menu-close");
      await closeMenu
        .getByRole("menuitem", { name: "Close conversation" })
        .click();
      await expect(directRow()).toHaveCount(0);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(directRow()).toBeVisible();
      await directRow().click();

      await page.keyboard.press("Control+Shift+.");
      const palette = page.getByRole("combobox", { name: "Run a command" });
      await palette.fill(">close");
      await page.getByRole("option", { name: /Close conversation/u }).click();
      await expect(directRow()).toHaveCount(0);

      await page.goto("/?irc-password=weblounge-test");
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
      await expect(directRow()).toHaveCount(0);
      await peer.privmsgConfirmed("weblounge", `reopen direct ${suffix}`);
      await expect(directRow()).toHaveAccessibleName(
        `${peer.nickname}, 1 unread, including mentions`,
      );

      await home.click();
      await homeComposer.fill(`/join ${channel}`);
      await homeComposer.press("Enter");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      const channelRow = page.getByRole("button", { name: channel });
      await channelRow.click({ button: "right" });
      const leaveMenu = page.getByRole("menu", {
        name: `Actions for ${channel}`,
      });
      await expect(
        leaveMenu.getByRole("menuitem", { name: "Leave channel" }),
      ).toBeVisible();
      await captureThemes(page, leaveMenu, "menu-leave");
      await leaveMenu.getByRole("menuitem", { name: "Leave channel" }).click();
      const confirmation = page.getByRole("alertdialog", {
        name: `Leave ${channel}?`,
      });
      await expect(confirmation).toBeVisible();
      await nativeFeelAudit(page);
      await captureThemes(page, confirmation, "leave-confirm");
      const parted = peer.waitForNextPart(channel, "weblounge");
      await confirmation.getByRole("button", { name: "Leave" }).click();
      await parted;
      await expect(channelRow).toHaveCount(0);
    } finally {
      peer.close();
    }
  });
});

async function captureThemes(
  page: Page,
  target: Locator,
  name: string,
): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "lounge" : "lounge-night",
    );
    await screenshotWithInter(target, {
      path: path.join(screenshots, `${name}-${theme}.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
