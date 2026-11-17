import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { expectSettled } from "./settled";
import {
  emulateSeamlessMacApp,
  expectClearOfWindowControls,
  releaseFullScreenAnswers,
  setFakeFullScreen,
  windowCalls,
  windowControls,
} from "./window-controls";

const plainHeaderInset = 10;

function chrome(page: Page) {
  return {
    root: page.locator("#root"),
    lightsRow: page.locator("[data-sidebar-lights-row]"),
    brand: page.locator("[data-connection-brand]"),
    header: page.locator("[data-main-header]"),
    dragRegions: page.locator("[data-tauri-drag-region]"),
    drawer: page.getByRole("dialog", { name: "Channels" }),
    sidebarToggle: page.getByRole("button", { name: "Toggle channel list" }),
    settings: page.getByRole("button", { name: "Settings" }),
  };
}

function bounds(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, height: box.height };
  });
}

async function expectBandAtTop(locator: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const { top, height } = await bounds(locator);
      return { top, height };
    })
    .toEqual({ top: 0, height: windowControls.blockSize });
}

async function expectHeaderInset(page: Page, inset: number): Promise<void> {
  const { header, sidebarToggle } = chrome(page);
  await expect(header).toHaveCSS("padding-left", `${inset}px`);
  await expect
    .poll(
      async () =>
        (await bounds(sidebarToggle)).left - (await bounds(header)).left,
    )
    .toBe(inset);
}

async function openSeamless(
  page: Page,
  url: string,
  conversation: string,
  options: Parameters<typeof emulateSeamlessMacApp>[1] = {},
): Promise<void> {
  await installNativeFeelInstrumentation(page);
  await emulateSeamlessMacApp(page, options);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await expectSettled(page, { conversation });
}

async function openDrawer(page: Page): Promise<Locator> {
  const { drawer, sidebarToggle } = chrome(page);
  await page.setViewportSize({ width: 600, height: 800 });
  await expectSettled(page);
  await sidebarToggle.click();
  await expect(drawer).toBeVisible();
  await expectSettled(page);
  return drawer;
}

async function expectNoWindowControls(page: Page): Promise<void> {
  const { lightsRow, brand, dragRegions, settings, sidebarToggle } =
    chrome(page);
  await expect(lightsRow).toHaveCount(0);
  await expect(brand).toBeVisible();
  await expect(brand.locator(settings)).toBeVisible();
  await expect(dragRegions).toHaveCount(0);
  await sidebarToggle.click();
  await expectHeaderInset(page, plainHeaderInset);
  await sidebarToggle.click();
  await expectSettled(page);
  const drawer = await openDrawer(page);
  await expect(drawer.locator(brand).locator(settings)).toBeVisible();
  await expect(drawer.locator("[data-sidebar-lights-row]")).toHaveCount(0);
  await expect(dragRegions).toHaveCount(0);
}

test.describe("seamless macOS title bar against local Ergo", () => {
  test("reserves the traffic lights' band across sidebar layouts", async ({
    page,
    irc,
  }) => {
    await openSeamless(page, irc.url(), irc.channel);
    const { root, lightsRow, brand, header, dragRegions, sidebarToggle } =
      chrome(page);
    const settings = lightsRow.getByRole("button", { name: "Settings" });

    await expect(root).toHaveAttribute("data-window-controls", "overlay");
    await expectBandAtTop(lightsRow);
    await expectBandAtTop(header);
    await expect(lightsRow).toHaveAttribute("data-tauri-drag-region", "deep");
    await expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
    await expect(dragRegions).toHaveCount(2);
    await expect(settings).toBeVisible();
    await expect(lightsRow.locator("[data-switcher-launcher]")).toBeVisible();
    await expect(brand).toBeVisible();
    await expect(brand.getByRole("button")).toHaveCount(0);
    expect((await bounds(settings)).left).toBeGreaterThan(
      windowControls.inlineStart,
    );
    await nativeFeelAudit(page);

    await settings.click();
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settingsDialog).toBeHidden();

    await sidebarToggle.click();
    await expect(lightsRow).toHaveCount(0);
    await expectHeaderInset(page, windowControls.inlineStart);
    await expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
    await sidebarToggle.click();
    await expectHeaderInset(page, plainHeaderInset);

    const drawer = await openDrawer(page);
    await expectHeaderInset(page, windowControls.inlineStart);
    const drawerRow = drawer.locator("[data-sidebar-lights-row]");
    await expectBandAtTop(drawerRow);
    await expect(drawerRow).toHaveAttribute("data-tauri-drag-region", "deep");
    await expect(
      drawerRow.getByRole("button", { name: "Settings" }),
    ).toBeVisible();
  });

  for (const width of [600, 800]) {
    test(`keeps Settings' header clear of the traffic lights at ${width}px`, async ({
      page,
      irc,
    }) => {
      await openSeamless(page, irc.url(), irc.channel);
      await chrome(page)
        .lightsRow.getByRole("button", { name: "Settings" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      await page.setViewportSize({ width, height: 600 });
      await expectSettled(page);

      await expectClearOfWindowControls(
        dialog.getByRole("heading", { name: "Settings" }),
      );
      await expectClearOfWindowControls(
        dialog.getByRole("button", { name: "Close settings" }),
      );
      await resetNativeFeelLayoutShift(page);
      await nativeFeelAudit(page);
    });
  }

  test("matches the window's appearance and background to the theme", async ({
    page,
    irc,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openSeamless(page, irc.url(), irc.channel);
    const themeCalls = async (appearance: string) => {
      const background = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--wl-color-bg")
          .trim(),
      );
      return [
        { command: "plugin:window|set_theme", value: appearance },
        { command: "plugin:window|set_background_color", value: background },
        {
          command: "plugin:webview|set_webview_background_color",
          value: background,
        },
      ];
    };

    const light = await themeCalls("light");
    await expect
      .poll(() => windowCalls(page))
      .toEqual(expect.arrayContaining(light));

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "lounge-night",
    );
    const dark = await themeCalls("dark");
    expect(dark[1]?.value).not.toBe(light[1]?.value);
    await expect
      .poll(() => windowCalls(page))
      .toEqual(expect.arrayContaining(dark));
  });

  test("gives the band back in full screen", async ({ page, irc }) => {
    await openSeamless(page, irc.url(), irc.channel);
    const { root, lightsRow, drawer } = chrome(page);
    await expectBandAtTop(lightsRow);

    await setFakeFullScreen(page, true);
    await expect(root).toHaveAttribute("data-window-controls", "hidden");
    await expectSettled(page);
    await resetNativeFeelLayoutShift(page);
    await nativeFeelAudit(page);
    await expectNoWindowControls(page);

    await setFakeFullScreen(page, false);
    await expect(root).toHaveAttribute("data-window-controls", "overlay");
    await expectBandAtTop(drawer.locator("[data-sidebar-lights-row]"));
  });

  test("launches straight into full screen without the band", async ({
    page,
    irc,
  }) => {
    await openSeamless(page, irc.url(), irc.channel, { fullScreen: true });

    await expect(chrome(page).root).toHaveAttribute(
      "data-window-controls",
      "hidden",
    );
    await expectNoWindowControls(page);
  });

  test("paints nothing until the window says whether it is in full screen", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await emulateSeamlessMacApp(page, {
      fullScreen: true,
      holdFullScreenAnswers: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(irc.url());
    const { root } = chrome(page);
    await expect(root).toHaveAttribute("data-window-controls", "pending");
    await expect(root).toHaveCSS("opacity", "0");

    await releaseFullScreenAnswers(page);
    await expect(root).toHaveAttribute("data-window-controls", "hidden");
    await expect(root).toHaveCSS("opacity", "1");
    await expectSettled(page, { conversation: irc.channel });
    await expectNoWindowControls(page);
  });

  test("leaves a plain browser unchanged", async ({ page, irc }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const { root } = chrome(page);

    await expect(root).not.toHaveAttribute("data-window-controls");
    expect(
      await root.evaluate((element) => [
        element.style.getPropertyValue("--wl-window-controls-inline"),
        element.style.getPropertyValue("--wl-window-controls-block"),
      ]),
    ).toEqual(["", ""]);
    await nativeFeelAudit(page);
    await expectNoWindowControls(page);
  });
});
