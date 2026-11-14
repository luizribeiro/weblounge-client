import type { Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { choose, settingsScreenshot } from "./settings-fixture";
import { expectHeaderButtonsAtEnd } from "./sidebar-geometry";

test.describe("desktop Settings against local Ergo", () => {
  test("opens from the header, changes appearance live and restores focus", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    const composer = await openHome(page, irc);
    const button = settingsButton(page);
    await expect(button).toHaveAttribute("title", "Settings (Ctrl+Shift+,)");
    await expect(button).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+Comma",
    );
    await expect(button).toHaveAttribute("aria-haspopup", "dialog");
    await settingsScreenshot(button, "desktop-1280-window-light");

    await button.click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeFocused();
    await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Cozy" })).toBeChecked();
    await nativeFeelAudit(page);
    await settingsScreenshot(dialog, "desktop-1280-light");

    await choose(page, "Lounge Night");
    await expectTheme(page, "lounge-night");
    await page.getByRole("radio", { name: "Cozy" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("radio", { name: "Comfortable" }),
    ).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-message-density",
      "comfortable",
    );
    await choose(page, "Cozy");
    await settingsScreenshot(dialog, "desktop-1280-dark");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();

    await composer.focus();
    await page.keyboard.press("Control+Comma");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Control+Shift+Comma");
    await expect(dialog).toBeFocused();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(composer).toBeFocused();

    await page.keyboard.press("Control+Shift+.");
    const palette = page.getByRole("combobox", { name: "Run a command" });
    await palette.fill(">sett");
    await expect(page.getByRole("option", { name: /Settings/u })).toContainText(
      "Ctrl+Shift+,",
    );
    await palette.press("Enter");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(composer).toBeFocused();
    await nativeFeelAudit(page);
  });

  test("follows a change made in another tab", async ({
    irc,
    context,
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openHome(page, irc);
    await settingsButton(page).click();
    await choose(page, "Lounge Night");

    const other = await context.newPage();
    await other.emulateMedia({ colorScheme: "light" });
    await openHome(other, irc);
    await expectTheme(other, "lounge-night");
    await choose(page, "Lounge");
    await expectTheme(other, "lounge");
    await choose(page, "System");
    await other.emulateMedia({ colorScheme: "dark" });
    await expectTheme(other, "lounge-night");
    await other.emulateMedia({ colorScheme: "light" });
    await expectTheme(other, "lounge");
  });

  test("paints the remembered appearance on the first frame after a reload", async ({
    irc,
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      requestAnimationFrame(() => {
        const root = document.documentElement;
        Object.assign(window, {
          __firstFrame: {
            background: getComputedStyle(root).backgroundColor,
            density: root.dataset.messageDensity,
            theme: root.dataset.theme,
          },
        });
      });
    });
    await openHome(page, irc);
    await settingsButton(page).click();
    await choose(page, "Lounge Night");
    await choose(page, "Comfortable");
    await expectTheme(page, "lounge-night");
    await expect(page.locator("html")).toHaveAttribute(
      "data-message-density",
      "comfortable",
    );
    const nightBackground = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--wl-color-bg)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });

    await page.reload();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__firstFrame")))
      .toEqual({
        background: nightBackground,
        density: "comfortable",
        theme: "lounge-night",
      });
    await settingsButton(page).click();
    await expect(
      page.getByRole("radio", { name: "Lounge Night" }),
    ).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "Comfortable" }),
    ).toBeChecked();
  });

  test("keeps the brand clear of both header buttons in the narrow drawer", async ({
    irc,
    page,
  }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    await page.getByRole("button", { name: "Toggle channel list" }).click();
    const drawer = page.getByRole("dialog", { name: "Channels" });
    const search = drawer.getByRole("button", { name: "Jump to" });
    const settings = drawer.getByRole("button", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expectHeaderButtonsAtEnd([search, settings]);
    await settingsScreenshot(drawer, "narrow-drawer-light");

    await settings.click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeFocused();
    await settingsScreenshot(dialog, "narrow-modal-light");
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
  });

  test("opens Settings from the Mac app menu and its native chord", async ({
    irc,
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__WEBLOUNGE_SHELL__", {
        value: Object.freeze({ kind: "macos-app", version: "0.1.0" }),
      });
    });
    const composer = await openHome(page, irc);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsButton(page)).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Comma",
    );

    await page.keyboard.press("Control+Comma");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(composer).toBeFocused();

    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("weblounge:action", { detail: "debug.overlay" }),
      ),
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("weblounge:action", { detail: "settings.open" }),
      ),
    );
    await expect(dialog).toBeFocused();
  });
});

async function expectTheme(page: Page, theme: string): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

function settingsButton(page: Page) {
  return page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("button", { name: "Settings" });
}

async function openHome(page: Page, irc: IrcTestAccount) {
  await page.goto(irc.url());
  await page.getByRole("button", { name: irc.channel }).click();
  const composer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  await composer.focus();
  await expect(composer).toBeFocused();
  return composer;
}
