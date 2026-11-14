import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { expect, test } from "./irc-fixture";
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
    irc,
  }) => {
    const channel = irc.channelNamed("close");
    const peer = await irc.peer("closed-long-peer-nick", [channel]);
    await mkdir(screenshots, { recursive: true });
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    const home = page.getByRole("button", { name: irc.channel });
    await home.click();
    const homeComposer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await homeComposer.fill(`/join ${channel}`);
    await homeComposer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await home.click();

    await peer.privmsgConfirmed(irc.account, "open direct");
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

    await closeButton.click();
    await expect(directRow()).toHaveCount(0);
    const toast = page.getByRole("status").filter({
      hasText: `Closed chat with ${peer.nickname}`,
    });
    await expect(toast).toBeVisible();
    await expectUndoToastLayout(
      toast,
      page.getByRole("complementary", { name: "Channel list" }),
    );
    await captureThemes(page, toast, "undo-toast");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toBeHidden();
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
    await expect(toast).toBeHidden();
    await expect(directRow()).toBeVisible();
    await directRow().click();

    await page.keyboard.press("Control+Shift+.");
    const palette = page.getByRole("combobox", { name: "Run a command" });
    await palette.fill(">close");
    await page.getByRole("option", { name: /Close conversation/u }).click();
    await expect(directRow()).toHaveCount(0);

    await page.goto(irc.url());
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await expect(directRow()).toHaveCount(0);
    await peer.privmsgConfirmed(irc.account, "reopen direct");
    await expect(directRow()).toHaveAccessibleName(
      `${peer.nickname}, 1 unread, including mentions, online`,
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
    const parted = peer.waitForNextPart(channel, irc.account);
    await confirmation.getByRole("button", { name: "Leave" }).click();
    await parted;
    await expect(channelRow).toHaveCount(0);
  });

  test("middle-click closes a DM with undo, asks before leaving a channel, and ignores the network row", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("middle-peer");
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    const channelRow = page.getByRole("button", {
      name: irc.channel,
      exact: true,
    });
    await channelRow.click();
    await peer.privmsgConfirmed(irc.account, "middle direct");
    const directRow = page.getByRole("button", {
      name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
    });
    const networkRow = page.locator("[data-network-state]");
    await expect(directRow).toBeVisible();

    await networkRow.click({ button: "middle" });
    await directRow.click({ button: "middle" });
    await expect(directRow).toHaveCount(0);
    const toast = page.getByRole("status").filter({
      hasText: `Closed chat with ${peer.nickname}`,
    });
    await expect(toast).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(networkRow).toBeVisible();
    await expect(networkRow).not.toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(directRow).toBeVisible();

    await channelRow.click({ button: "middle" });
    const confirmation = page.getByRole("alertdialog", {
      name: `Leave ${irc.channel}?`,
    });
    await expect(confirmation).toBeVisible();
    await nativeFeelAudit(page);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toBeHidden();
    await expect(channelRow).toBeVisible();
  });
});

async function expectUndoToastLayout(
  toast: Locator,
  sidebar: Locator,
): Promise<void> {
  const [toastBox, sidebarBox, undoBox] = await Promise.all([
    toast.boundingBox(),
    sidebar.boundingBox(),
    toast.getByRole("button", { name: "Undo" }).boundingBox(),
  ]);
  if (toastBox === null || sidebarBox === null || undoBox === null)
    throw new Error("undo toast, its button or the sidebar is not rendered");
  expect(undoBox.x + undoBox.width).toBeLessThanOrEqual(
    toastBox.x + toastBox.width,
  );
  expect(toastBox.x - sidebarBox.x).toBeCloseTo(8, 0);
  expect(
    sidebarBox.x + sidebarBox.width - (toastBox.x + toastBox.width),
  ).toBeCloseTo(9, 0);
  expect(
    sidebarBox.y + sidebarBox.height - (toastBox.y + toastBox.height),
  ).toBeCloseTo(10, 0);
}

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
