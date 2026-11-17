import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectOmnibarColumnsAligned } from "./omnibar-geometry";
import { expectSettled } from "./settled";
import { emulatePlatform } from "./sidebar-rows";

const paletteChordPlatforms = [
  {
    name: "Linux",
    navigatorPlatform: undefined,
    openPalette: "Control+Shift+.",
    settingsCaps: ["Ctrl", "Shift", ","],
    surface: "palette",
  },
  {
    name: "macOS",
    navigatorPlatform: "MacIntel",
    openPalette: "Meta+Shift+.",
    settingsCaps: ["⇧", "⌘", ","],
    surface: "palette-macos",
  },
] as const;

const screenshotDirectory = path.join(
  process.cwd(),
  "..",
  "screenshots",
  "omnibar",
);

test.describe("omnibar rows against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("lines up switcher rows with and without a badge", async ({
    page,
    irc,
  }) => {
    const other = irc.channelNamed("rows-long-channel-names");
    const peer = await irc.peer("rosa", [irc.channel]);
    try {
      await installNativeFeelInstrumentation(page);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(irc.url({ autojoin: [other] }));
      await expectSettled(page, { conversation: irc.channel });
      await page.getByRole("button", { name: other }).click();
      await expect(page.getByRole("heading", { name: other })).toBeVisible();
      await peer.privmsgConfirmed(irc.channel, `hello ${irc.id}`);
      await expect(
        page.getByRole("button", { name: `${irc.channel}, 1 unread` }),
      ).toBeVisible();

      await page.keyboard.press("Control+K");
      const results = page.getByRole("listbox", { name: "Conversations" });
      const badged = results.getByRole("option", {
        name: new RegExp(`^${irc.channel}, .*1 unread`, "u"),
      });
      await expect(badged.locator("[data-omnibar-slot] > *")).toHaveCount(1);
      const long = results.getByRole("option", {
        name: new RegExp(`^${other}`, "u"),
      });
      await expect(long.locator("[data-omnibar-slot] > *")).toHaveCount(0);
      await nativeFeelAudit(page);
      await captureEachLook(page, "Quick switcher", "switcher");
      expect(await truncated(long)).toBe(true);
      await expect(results.locator("[data-omnibar-suffix]")).toHaveCount(0);
    } finally {
      peer.close();
    }
  });

  for (const platform of paletteChordPlatforms) {
    test(`lines up palette rows with and without ${platform.name} chords`, async ({
      page,
      irc,
    }) => {
      if (platform.navigatorPlatform !== undefined)
        await emulatePlatform(page, platform.navigatorPlatform);
      await installNativeFeelInstrumentation(page);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });

      await page.keyboard.press(platform.openPalette);
      const results = page.getByRole("listbox", { name: "Commands" });
      const settings = results.getByRole("option", { name: /^Settings/u });
      await expect(settings.locator("[data-chord] [data-key]")).toHaveText(
        platform.settingsCaps,
      );
      await expect(settings.locator("[data-omnibar-suffix]")).toHaveText(
        "View",
      );
      const leave = results.getByRole("option", {
        name: /^Leave a channel/u,
      });
      await expect(leave.locator("[data-chord]")).toHaveCount(0);
      await expect(leave.locator("[data-omnibar-suffix]")).toHaveCount(0);
      expect(
        await results
          .getByRole("option")
          .evaluateAll((rows) =>
            Math.max(
              ...rows.map((row) => row.querySelectorAll("[data-chord]").length),
            ),
          ),
      ).toBe(1);
      for (const row of await expectOmnibarColumnsAligned(results))
        expect(row.slotRight - row.slotLeft).toBeCloseTo(116, 0);
      await nativeFeelAudit(page);
      await captureEachLook(page, "Command palette", platform.surface);
    });
  }

  test("marks presence, bots and unread like the sidebar", async ({
    page,
    irc,
  }) => {
    const bot = await irc.peer("concierge", []);
    const human = await irc.peer("ana", []);
    try {
      await bot.mode(bot.nickname, "+B");
      await installNativeFeelInstrumentation(page);
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });
      await bot.privmsgConfirmed(irc.account, `beep ${irc.id}`);
      await human.privmsgConfirmed(irc.account, `hello ${irc.id}`);
      await expect(
        page.getByRole("button", {
          name: `${human.nickname}, 1 unread, including mentions, online`,
        }),
      ).toBeVisible();

      await page.keyboard.press("Control+K");
      const results = page.getByRole("listbox", { name: "Conversations" });
      const row = (name: string) =>
        results.getByRole("option", { name: new RegExp(`^${name}`, "u") });
      await expect(
        row(human.nickname).locator("[data-presence-dot]"),
      ).toHaveAttribute("data-presence", "online");
      await expect(row(bot.nickname).locator("[data-peer-bot]")).toBeVisible();
      await expect(row(irc.channel).locator("[data-channel-sign]")).toHaveText(
        "#",
      );
      await expect(
        row(human.nickname).locator("[data-omnibar-name]"),
      ).toHaveCSS("font-weight", "650");
      await expect(row(irc.channel).locator("[data-omnibar-name]")).toHaveCSS(
        "font-weight",
        "400",
      );
      await nativeFeelAudit(page);
      await captureEachLook(page, "Quick switcher", "switcher-people");
    } finally {
      bot.close();
      human.close();
    }
  });
});

async function truncated(row: Locator): Promise<boolean> {
  return row
    .locator("[data-omnibar-name]")
    .evaluate((name) => name.scrollWidth > name.clientWidth);
}

async function captureEachLook(
  page: Page,
  dialogName: string,
  surface: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: dialogName });
  await mkdir(screenshotDirectory, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await expectOmnibarColumnsAligned(dialog.getByRole("listbox"));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await screenshotWithInter(dialog, {
        path: path.join(
          screenshotDirectory,
          `${surface}-${width}-${scheme}.png`,
        ),
      });
    }
  }
}
