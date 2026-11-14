import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import {
  conversationRowIds,
  emulateMacApp,
  emulatePlatform,
  openWithExtraChannel,
  row,
} from "./sidebar-rows";

test.describe("next and previous buffer chords against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("the Mac app cycles rows with the browser tab chords, wrapping at both ends", async ({
    page,
    irc,
  }) => {
    await emulateMacApp(page);
    await installNativeFeelInstrumentation(page);
    await openWithExtraChannel(page, irc);
    const [first, second] = await conversationRowIds(page);
    const server = page.locator("[data-network-state]");
    await openRow(page, first);
    await page.locator("[data-composer] textarea").click();

    await page.keyboard.press("Control+Tab");
    await expect(row(page, second)).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Control+Tab");
    await expect(server).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Meta+Shift+BracketRight");
    await expect(row(page, first)).toHaveAttribute("aria-current", "page");

    await page.keyboard.press("Control+Shift+Tab");
    await expect(server).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Meta+Shift+BracketLeft");
    await expect(row(page, second)).toHaveAttribute("aria-current", "page");
    await nativeFeelAudit(page);

    await page.keyboard.press("Meta+Shift+P");
    await page.getByRole("combobox", { name: "Run a command" }).fill(">buffer");
    await expect(
      page.getByRole("option", { name: /^Next buffer/u }).locator("kbd"),
    ).toHaveText("⌥↓ / ⌃Tab / ⇧⌘]");
    await expect(
      page.getByRole("option", { name: /^Previous buffer/u }).locator("kbd"),
    ).toHaveText("⌥↑ / ⌃⇧Tab / ⇧⌘[");
  });

  test("the web keeps Option-arrows and leaves Control-Tab to the browser", async ({
    page,
    irc,
  }) => {
    await emulatePlatform(page, "MacIntel");
    await openWithExtraChannel(page, irc);
    const [first, second] = await conversationRowIds(page);
    await recordTabDefaults(page);
    await openRow(page, first);

    await page.keyboard.press("Control+Tab");
    await expect.poll(() => lastTabPrevented(page)).toBe(false);
    await expect(row(page, first)).toHaveAttribute("aria-current", "page");

    await row(page, first).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(row(page, second)).toHaveAttribute("aria-current", "page");
  });
});

async function openRow(page: Page, bufferId: string | undefined) {
  await row(page, bufferId).click();
  await expect(row(page, bufferId)).toHaveAttribute("aria-current", "page");
}

type TabProbe = Window & { __lastTabPrevented?: boolean };

async function recordTabDefaults(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.addEventListener("keydown", (event) => {
      if (event.key === "Tab")
        (window as TabProbe).__lastTabPrevented = event.defaultPrevented;
    });
  });
}

function lastTabPrevented(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as TabProbe).__lastTabPrevented);
}
