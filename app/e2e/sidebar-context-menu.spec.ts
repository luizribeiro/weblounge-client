import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const screenshotDirectory = path.join(
  process.cwd(),
  "..",
  "screenshots",
  "sidebar",
);

test.describe("desktop sidebar context menu against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens from pointer and keyboard, marks read, and restores focus", async ({
    page,
    irc,
  }) => {
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "warning" && message.type() !== "error") return;
      const location = message.location();
      consoleIssues.push(
        `${location.url}:${location.lineNumber}:${location.columnNumber} ${message.text()}`,
      );
    });
    const channel = irc.channelNamed("sidebar");
    const peer = await irc.peer("sidebar", [channel]);
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    const home = page.getByRole("button", { name: irc.channel });
    await home.click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await home.click();

    await peer.privmsgConfirmed(channel, "ordinary unread for the sidebar");
    await peer.privmsgConfirmed(irc.account, "direct mention for the sidebar");
    const channelRow = page.getByRole("button", {
      name: `${channel}, 1 unread`,
    });
    const directRow = page.getByRole("button", {
      name: `${peer.nickname}, 1 unread, including mentions`,
    });
    await expect(channelRow).toBeVisible();
    await expect(directRow).toBeVisible();
    const directBufferId = await directRow.getAttribute("data-buffer-id");
    if (directBufferId === null) throw new Error("direct row has no buffer id");
    const stableDirectRow = page.locator(
      `[data-buffer-id="${directBufferId}"]`,
    );
    const sidebar = page.getByRole("complementary", { name: "Channel list" });

    await mkdir(screenshotDirectory, { recursive: true });
    await sidebarScreenshot(page, sidebar, "rest-light.png");
    await channelRow.hover();
    await sidebarScreenshot(page, sidebar, "hover-light.png");
    await channelRow.click({ button: "right" });
    const menu = page.getByRole("menu", { name: `Actions for ${channel}` });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Mark as read",
      "Leave channel",
    ]);
    await nativeFeelAudit(page);
    await sidebarScreenshot(page, sidebar, "menu-light.png");
    await page.keyboard.press("Escape");
    await expect(channelRow).toBeFocused();

    await composer.focus();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "lounge-night",
    );
    await sidebarScreenshot(page, sidebar, "rest-dark.png");
    await channelRow.hover();
    await sidebarScreenshot(page, sidebar, "hover-dark.png");
    await channelRow.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await sidebarScreenshot(page, sidebar, "menu-dark.png");
    await page.keyboard.press("Escape");
    await expect(channelRow).toBeFocused();

    await directRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as read" }).click();
    await expect(stableDirectRow).toHaveAttribute("data-unread", "0");
    await expect(stableDirectRow).toHaveAccessibleName(
      `${peer.nickname}, online`,
    );
    expect(consoleIssues).toEqual([]);
  });
});

async function sidebarScreenshot(
  page: Page,
  sidebar: Locator,
  filename: string,
): Promise<void> {
  const bounds = await sidebar.boundingBox();
  if (bounds === null) throw new Error("sidebar is not visible");
  await screenshotWithInter(sidebar, {
    path: path.join(screenshotDirectory, filename),
    clip: {
      x: 0,
      y: 0,
      width: Math.min(480, page.viewportSize()?.width ?? 480),
      height: Math.min(
        bounds.height,
        page.viewportSize()?.height ?? bounds.height,
      ),
    },
  });
}
