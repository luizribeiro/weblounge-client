import type { Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { settingsScreenshot } from "./settings-fixture";
import { expectSettled } from "./settled";

const narrow = { width: 720, height: 800 };

test.describe("Settings section rail in a narrow desktop window", () => {
  test("keeps the content clear at rest and floats the labels over it on hover", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize(narrow);
    await page.emulateMedia({ colorScheme: "light" });
    const { nav, pane } = await openSettings(page, irc);
    const rest = await geometry(page);

    await expect(nav).toHaveAttribute("data-rail", "true");
    expect(rest.navWidth).toBeGreaterThanOrEqual(48);
    expect(rest.navWidth).toBeLessThanOrEqual(56);
    expect(rest.paneLeft).toBeGreaterThanOrEqual(rest.panelRight - 1);
    await expect(
      page.getByRole("button", { name: "Appearance" }),
    ).toHaveAttribute("title", "Appearance");
    const label = nav.locator('[data-section="appearance"] span');
    await expect(label).toHaveCSS("opacity", "0");
    await nativeFeelAudit(page);
    await settingsScreenshot(pane, "rail-narrow-collapsed-light");

    await page.getByRole("button", { name: "Appearance" }).hover();
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await expectSettledPanel(page);
    await expect(label).toHaveCSS("opacity", "1");
    await nativeFeelAudit(page);
    const open = await geometry(page);
    expect(open.navWidth).toBe(rest.navWidth);
    expect(open.paneLeft).toBe(rest.paneLeft);
    expect(open.panelRight).toBeGreaterThan(open.paneLeft + 100);
    expect(open.topmostInsideContent).toBe(true);
    await settingsScreenshot(pane, "rail-narrow-expanded-light");

    await page.mouse.move(narrow.width - 20, narrow.height / 2);
    await expect(nav).not.toHaveAttribute("data-expanded");
  });

  test("expands on keyboard focus and collapses on Escape before closing", async ({
    irc,
    page,
  }) => {
    await page.setViewportSize(narrow);
    const { dialog, nav } = await openSettings(page, irc);
    const appearance = page.getByRole("button", { name: "Appearance" });

    await appearance.focus();
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(nav).not.toHaveAttribute("data-expanded");
    await expect(dialog).toBeVisible();
    await expect(appearance).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("selects a section in one click and collapses", async ({
    irc,
    page,
  }) => {
    await page.setViewportSize(narrow);
    const { nav } = await openSettings(page, irc);
    const appearance = page.getByRole("button", { name: "Appearance" });

    await appearance.click();

    await expect(appearance).toHaveAttribute("aria-current", "page");
    await expect(nav).not.toHaveAttribute("data-expanded");
    await expect(
      page.getByRole("region", { name: "Appearance" }),
    ).toBeVisible();
  });

  test("shows the labelled list in a wide window", async ({ irc, page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    const { nav, pane } = await openSettings(page, irc);

    await expect(nav).not.toHaveAttribute("data-rail");
    const appearance = page.getByRole("button", { name: "Appearance" });
    await expect(appearance).not.toHaveAttribute("title");
    await appearance.hover();
    await appearance.focus();
    await expect(nav).not.toHaveAttribute("data-expanded");
    await settingsScreenshot(pane, "rail-wide-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await settingsScreenshot(pane, "rail-wide-dark");
  });

  test("draws the rail in the dark theme", async ({ irc, page }) => {
    await page.setViewportSize(narrow);
    await page.emulateMedia({ colorScheme: "dark" });
    const { nav, pane } = await openSettings(page, irc);

    await settingsScreenshot(pane, "rail-narrow-collapsed-dark");
    await page.getByRole("button", { name: "Appearance" }).hover();
    await expect(nav).toHaveAttribute("data-expanded", "true");
    await expectSettledPanel(page);
    await settingsScreenshot(pane, "rail-narrow-expanded-dark");
  });
});

async function openSettings(page: Page, irc: IrcTestAccount) {
  await page.goto(irc.url());
  const composer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  await composer.focus();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  await expectSettled(page);
  await page.keyboard.press("Control+Shift+Comma");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeFocused();
  return {
    dialog,
    nav: page.getByRole("navigation", { name: "Settings sections" }),
    pane: page.getByRole("region", { name: "Appearance" }),
  };
}

async function expectSettledPanel(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByRole("navigation", { name: "Settings sections" })
        .evaluate((nav) => nav.firstElementChild?.getAnimations().length ?? 0),
    )
    .toBe(0);
}

async function geometry(page: Page) {
  return page
    .getByRole("navigation", { name: "Settings sections" })
    .evaluate((nav) => {
      const panel = nav.firstElementChild;
      const pane = nav.nextElementSibling;
      if (!(panel instanceof HTMLElement) || !(pane instanceof HTMLElement))
        throw new Error("the Settings body is not rendered");
      const panelBox = panel.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      const probe = document.elementFromPoint(
        (paneBox.left + panelBox.right) / 2,
        panelBox.top + 20,
      );
      return {
        navWidth: nav.getBoundingClientRect().width,
        paneLeft: paneBox.left,
        panelRight: panelBox.right,
        topmostInsideContent: probe !== null && panel.contains(probe),
      };
    });
}
