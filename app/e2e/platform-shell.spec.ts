import { devices } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { scrollAwayFromLiveEdge } from "./message-list-scroll";

const { defaultBrowserType: _iphoneBrowser, ...iphone } =
  devices["iPhone 16 Pro"];
const { defaultBrowserType: _androidBrowser, ...android } = devices["Pixel 7"];

test.describe("platform shell selection against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("keeps desktop state while width only changes panel presentation", async ({
    page,
    irc,
  }) => {
    const secondChannel = irc.channelNamed("platform");
    await page.setViewportSize({ width: 1440, height: 320 });
    await page.goto(irc.url());
    const firstComposer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await firstComposer.waitFor({ state: "visible" });

    const bot = await irc.peer("platform");
    for (let index = 0; index < 8; index += 1)
      bot.privmsg(irc.channel, `platform history ${index}`);
    await bot.privmsgConfirmed(irc.channel, "platform history ready");
    await page
      .getByText("platform history ready", { exact: true })
      .waitFor({ state: "visible" });
    await firstComposer.fill(`/join ${secondChannel}`);
    await firstComposer.press("Enter");
    await expect(
      page.getByRole("heading", { name: secondChannel }),
    ).toBeVisible();
    await page.getByRole("button", { name: irc.channel }).click();

    const shell = page.locator("[data-desktop-shell]");
    const messages = page.locator("[data-message-list]");
    await shell.evaluate((element) => {
      element.setAttribute("data-resize-probe", "stable");
    });
    await messages.evaluate((element) => {
      element.setAttribute("data-scroll-probe", "stable");
    });
    await firstComposer.fill("draft survives desktop resize");
    const initialScroll = await scrollAwayFromLiveEdge(page, messages, {
      distance: 3,
      wheelDelta: 10,
    });
    expect(initialScroll).toBeGreaterThan(0);

    for (const width of [900, 600, 400, 740, 780, 1440]) {
      await page.setViewportSize({ width, height: 320 });
      await expect(shell).toHaveAttribute("data-resize-probe", "stable");
      await expect(messages).toHaveAttribute("data-scroll-probe", "stable");
      await expect(page.locator("[data-mobile-shell]")).toHaveCount(0);
      await expect(firstComposer).toHaveValue("draft survives desktop resize");
      await expect
        .poll(() => messages.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }

    await page.setViewportSize({ width: 400, height: 320 });
    await page.getByRole("button", { name: "Toggle channel list" }).click();
    const channels = page.getByRole("dialog", { name: "Channels" });
    await expect(channels).toBeVisible();
    await expect(channels).toHaveCSS("width", "224px");
    await channels.getByRole("button", { name: secondChannel }).click();
    await expect(channels).toHaveCount(0);
    const secondComposer = page.getByRole("textbox", {
      name: `Message ${secondChannel}`,
    });
    await expect(secondComposer).toBeFocused();

    await page.getByRole("button", { name: "Toggle channel list" }).click();
    await expect(channels).toBeVisible();
    await channels.press("Escape");
    await expect(channels).toHaveCount(0);
    await expect(secondComposer).toBeFocused();
  });
});

test.describe("touch-primary shell selection", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.describe("iPhone", () => {
    test.use(iphone);

    test("uses mobile independent of width", async ({ page, irc }) => {
      await page.goto(irc.url());
      const shell = page.locator("[data-mobile-shell]");
      await expect(shell).toBeVisible();
      await page.setViewportSize({ width: 900, height: 874 });
      await expect(shell).toBeVisible();
      await expect(page.locator("[data-desktop-shell]")).toHaveCount(0);
    });
  });

  test.describe("Android", () => {
    test.use(android);

    test("uses the mobile shell", async ({ page, irc }) => {
      await page.goto(irc.url());
      await expect(page.locator("[data-mobile-shell]")).toBeVisible();
      await expect(page.locator("[data-desktop-shell]")).toHaveCount(0);
    });
  });
});
