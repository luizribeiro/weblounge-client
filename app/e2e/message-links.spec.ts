import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

test.describe("message links and nicknames against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens desktop URLs and channel links", async ({ page, irc }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1200, height: 800 });
    await exerciseLinks(page, irc, "desktop", false, true);
  });

  test("opens desktop nickname authors and mentions accessibly", async ({
    page,
    irc,
  }) => {
    const author = await irc.peer("clicka");
    const mentioned = await irc.peer("clickb");
    const authorNick = author.nickname;
    const mentionNick = mentioned.nickname;
    const marker = "clickable nick";
    await mentioned.privmsgConfirmed(irc.channel, "known nick");
    await author.privmsgConfirmed(irc.channel, `${marker} ${mentionNick}`);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(irc.url());

    const authorRow = page.locator("[data-message-row]").filter({
      has: page.getByText(marker, { exact: false }),
    });
    const authorAction = authorRow.getByRole("button", {
      name: `Open direct message with ${authorNick}`,
    });
    await expect(authorAction).toHaveCSS("cursor", "pointer");
    await authorAction.click();
    await expect(page.getByRole("heading", { name: authorNick })).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: `Message ${authorNick}` }),
    ).toBeFocused();

    await page.getByRole("button", { name: irc.channel }).click();
    const mentionAction = authorRow.getByRole("button", {
      name: `Open direct message with ${mentionNick}`,
    });
    await mentionAction.click();
    await expect(
      page.getByRole("textbox", { name: `Message ${mentionNick}` }),
    ).toBeFocused();

    await page.getByRole("button", { name: irc.channel }).click();
    await mentionAction.focus();
    await mentionAction.press("Space");
    await expect(
      page.getByRole("heading", { name: mentionNick }),
    ).toBeVisible();

    await page.getByRole("button", { name: irc.channel }).click();
    const ownMarker = "own nick inert";
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await composer.fill(`${ownMarker} ${irc.account}`);
    await composer.press("Enter");
    const ownRow = page.locator("[data-message-row]").filter({
      has: page.getByText(ownMarker, { exact: false }),
    });
    await expect(ownRow).toBeVisible();
    await expect(
      ownRow.getByRole("button", {
        name: `Open direct message with ${irc.account}`,
      }),
    ).toHaveCount(0);
  });

  test.describe("touch-primary rendering", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });

    test("opens mobile URLs and channel links without overflowing", async ({
      page,
      irc,
    }) => {
      await exerciseLinks(page, irc, "mobile", true);
    });

    test("opens a mobile nickname without raising the keyboard", async ({
      page,
      irc,
    }) => {
      const bot = await irc.peer("tapnick");
      const nick = bot.nickname;
      const marker = "tap nick";
      await bot.privmsgConfirmed(irc.channel, marker);
      await page.goto(irc.url());
      await page.getByRole("button", { name: irc.channel }).tap();
      const row = page.locator("[data-message-row]").filter({
        has: page.getByText(marker, { exact: true }),
      });
      await row
        .getByRole("button", {
          name: `Open direct message with ${nick}`,
        })
        .tap();

      await expect(page.getByRole("heading", { name: nick })).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: `Message ${nick}` }),
      ).not.toBeFocused();
      await expect(page.locator("#root")).toHaveAttribute(
        "data-keyboard",
        "closed",
      );
    });
  });
});

async function exerciseLinks(
  page: import("@playwright/test").Page,
  irc: IrcTestAccount,
  label: string,
  longUrl: boolean,
  audit = false,
): Promise<void> {
  const target = irc.channelNamed(`links-${label}`);
  const url = `http://127.0.0.1:4174/${longUrl ? "unbroken-segment".repeat(12) : `message-${irc.id}`}`;
  const source = await irc.peer("source");
  await irc.peer("target", [target]);
  await source.privmsgConfirmed(
    irc.channel,
    `visit ${url}. then open ${target}`,
  );
  await page.goto(irc.url());
  if (label === "mobile")
    await page.getByRole("button", { name: irc.channel }).click();

  const external = page
    .locator("[data-message-list]")
    .getByRole("link", { name: url });
  await expect(external).toHaveAttribute("href", url);
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).toHaveAttribute("rel", "noopener noreferrer");
  await expect(external).toHaveCSS("cursor", "pointer");
  if (audit) {
    await expect(
      page.locator('[data-buffer-id][aria-current="page"]'),
    ).toHaveAttribute("data-unread", "0");
    await nativeFeelAudit(page);
  }
  if (longUrl) {
    const geometry = await external.evaluate((link) => {
      const list = link.closest<HTMLElement>("[data-message-list]");
      if (list === null) throw new Error("message list is missing");
      return {
        clientWidth: list.clientWidth,
        linkRight: link.getBoundingClientRect().right,
        listRight: list.getBoundingClientRect().right,
        scrollWidth: list.scrollWidth,
      };
    });
    expect(geometry.linkRight).toBeLessThanOrEqual(geometry.listRight);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  }

  const popupPromise = page.waitForEvent("popup");
  await external.click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toBe(url);
  await popup.close();

  const channel = page.getByRole("link", { name: target });
  await expect(channel).toHaveCSS("cursor", "pointer");
  await channel.click();
  await expect(page.getByRole("heading", { name: target })).toBeVisible();
}
