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
  "switcher",
);

test.describe("buffer switcher against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens, filters, switches, restores focus, and launches", async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#switcher-${suffix}`;
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

    await page.keyboard.press("Control+K");
    const query = page.getByRole("combobox", { name: "Jump to" });
    await expect(query).toBeFocused();
    await query.fill(`switcher-${suffix}`);
    const result = page.getByRole("option", { name: new RegExp(channel, "u") });
    await expect(result).toHaveCount(1);
    await query.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    const channelComposer = page.getByRole("textbox", {
      name: `Message ${channel}`,
    });
    await channelComposer.focus();
    await page.keyboard.press("Control+K");
    await expect(query).toBeFocused();
    await query.press("Escape");
    await expect(channelComposer).toBeFocused();

    const launcher = page.getByRole("button", { name: "Jump to" });
    await launcher.click();
    await expect(query).toBeFocused();
    await nativeFeelAudit(page);
    await mkdir(screenshotDirectory, { recursive: true });
    await screenshotWithInter(
      page.getByRole("dialog", { name: "Quick switcher" }),
      {
        path: path.join(screenshotDirectory, "overlay-light.png"),
      },
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await screenshotWithInter(
      page.getByRole("dialog", { name: "Quick switcher" }),
      {
        path: path.join(screenshotDirectory, "overlay-dark.png"),
      },
    );
    const variant = await launcher.getAttribute("data-switcher-launcher");
    await screenshotWithInter(
      page.getByRole("complementary", { name: "Channel list" }),
      {
        path: path.join(
          screenshotDirectory,
          `launcher-${variant ?? "unknown"}.png`,
        ),
      },
    );

    await query.fill("weblounge-test");
    await page.getByRole("option", { name: /#weblounge-test/u }).click();
    await expect(
      page.getByRole("heading", { name: "#weblounge-test" }),
    ).toBeVisible();
  });
});
