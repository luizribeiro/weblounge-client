import { mkdir } from "node:fs/promises";
import path from "node:path";
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
  "switcher",
);

test.describe("buffer switcher against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens, filters, switches, restores focus, and launches", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("switcher");
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

    await page.keyboard.press("Control+K");
    const query = page.getByRole("combobox", { name: "Jump to" });
    await expect(query).toBeFocused();
    await query.fill(channel.slice(1));
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

    await query.fill(irc.channel.slice(1));
    await page
      .getByRole("option", { name: new RegExp(irc.channel, "u") })
      .click();
    await expect(
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
  });
});
