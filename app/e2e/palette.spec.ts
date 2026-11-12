import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const screenshotDirectory = path.join(
  process.cwd(),
  "..",
  "screenshots",
  "palette",
);

test.describe("command palette against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens with the web chord and switcher prefix, then runs an action", async ({
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: /^#weblounge-test/u }).click();
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    await composer.focus();

    await page.keyboard.press("Control+Shift+.");
    const commandQuery = page.getByRole("combobox", {
      name: "Run a command",
    });
    await expect(commandQuery).toBeFocused();
    await expect(commandQuery).toHaveValue(">");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await nativeFeelAudit(page);

    await mkdir(screenshotDirectory, { recursive: true });
    await screenshotWithInter(dialog, {
      path: path.join(screenshotDirectory, "overlay-light.png"),
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await screenshotWithInter(dialog, {
      path: path.join(screenshotDirectory, "overlay-dark.png"),
    });
    await commandQuery.press("Escape");
    await expect(composer).toBeFocused();

    await page.keyboard.press("Control+K");
    const switcherQuery = page.getByRole("combobox", { name: "Jump to" });
    await switcherQuery.fill(">member");
    await expect(
      page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    const prefixedCommandQuery = page.getByRole("combobox", {
      name: "Run a command",
    });
    const toggle = page.getByRole("option", { name: /Toggle member list/u });
    await expect(toggle).toContainText("Ctrl+.");
    await prefixedCommandQuery.press("Enter");
    await expect(
      page.getByRole("complementary", { name: "Members of #weblounge-test" }),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });
});
