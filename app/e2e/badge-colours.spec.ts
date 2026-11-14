import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";

test.describe("unread badge colours against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows total counts by mention severity in both shells and themes", async ({
    baseURL,
    browser,
    page,
    irc,
  }) => {
    const desktopChannel = irc.channelNamed("badge-d");
    const mobileChannel = irc.channelNamed("badge-m");
    const mobileContext = await browser.newContext({
      baseURL,
      colorScheme: "light",
      hasTouch: true,
      isMobile: true,
      viewport: { height: 874, width: 402 },
    });
    await irc.scope(mobileContext);
    const mobile = await mobileContext.newPage();
    try {
      await page.emulateMedia({ colorScheme: "light" });
      await Promise.all([page.goto(irc.url()), mobile.goto(irc.url())]);
      await joinDesktopChannel(page, irc.channel, desktopChannel);
      await joinMobileChannel(mobile, irc.channel, mobileChannel);
      const bots = [
        await irc.peer("badged", [desktopChannel]),
        await irc.peer("badgem", [mobileChannel]),
      ];

      await page.getByRole("button", { name: irc.channel }).click();
      await mobile.getByRole("button", { name: "Back to chats" }).click();
      await expect(mobile.locator("[data-mobile-chats]")).toBeVisible();

      const desktopRow = page.locator(
        `[data-buffer-id][aria-label^="${desktopChannel},"]`,
      );
      const mobileRow = mobile.locator(
        `[data-buffer-id][aria-label^="${mobileChannel},"]`,
      );
      await bots[0]?.privmsgConfirmed(
        desktopChannel,
        "ordinary desktop unread",
      );
      await bots[1]?.privmsgConfirmed(mobileChannel, "ordinary mobile unread");
      await expectBadge(desktopRow, "1 unread", "unread");
      await expectBadge(mobileRow, "1 unread", "unread");
      await expectTokenColours(desktopRow, "accent", "accent-fg");
      await expectTokenColours(mobileRow, "accent", "accent-fg");

      await Promise.all([
        page.emulateMedia({ colorScheme: "dark" }),
        mobile.emulateMedia({ colorScheme: "dark" }),
      ]);
      await expectTokenColours(desktopRow, "accent", "accent-fg");
      await expectTokenColours(mobileRow, "accent", "accent-fg");

      await bots[0]?.privmsgConfirmed(
        desktopChannel,
        `${irc.account}: mentioned on desktop`,
      );
      await bots[1]?.privmsgConfirmed(
        mobileChannel,
        `${irc.account}: mentioned on mobile`,
      );
      const mentionLabel = "2 unread, including mentions";
      await expectBadge(desktopRow, mentionLabel, "mention");
      await expectBadge(mobileRow, mentionLabel, "mention");
      await expectTokenColours(desktopRow, "mention-badge", "mention-badge-fg");
      await expectTokenColours(mobileRow, "mention-badge", "mention-badge-fg");

      await Promise.all([
        page.emulateMedia({ colorScheme: "light" }),
        mobile.emulateMedia({ colorScheme: "light" }),
      ]);
      await expectTokenColours(desktopRow, "mention-badge", "mention-badge-fg");
      await expectTokenColours(mobileRow, "mention-badge", "mention-badge-fg");
    } finally {
      await mobileContext.close();
    }
  });
});

async function joinDesktopChannel(
  page: Page,
  home: string,
  channel: string,
): Promise<void> {
  const composer = page.getByRole("textbox", { name: `Message ${home}` });
  await expect(composer).toBeVisible();
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

async function joinMobileChannel(
  page: Page,
  home: string,
  channel: string,
): Promise<void> {
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await page.getByRole("button", { name: home }).click();
  const composer = page.getByRole("textbox", { name: `Message ${home}` });
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

async function expectBadge(
  row: Locator,
  label: string,
  kind: "mention" | "unread",
): Promise<void> {
  await expect(row).toHaveAccessibleName(new RegExp(`${label}$`, "u"));
  const badge = row.locator(`[data-badge-kind="${kind}"]`);
  await expect(badge).toHaveAccessibleName(label);
  await expect(badge).toHaveText(label.split(" ", 1)[0] ?? "");
}

async function expectTokenColours(
  row: Locator,
  backgroundToken: string,
  foregroundToken: string,
): Promise<void> {
  const colours = await row.locator("[data-badge-kind]").evaluate(
    (badge, tokens) => {
      const probe = document.createElement("span");
      probe.style.background = `var(--wl-color-${tokens.background})`;
      probe.style.color = `var(--wl-color-${tokens.foreground})`;
      document.body.append(probe);
      const actual = getComputedStyle(badge);
      const expected = getComputedStyle(probe);
      const result = {
        actualBackground: actual.backgroundColor,
        actualForeground: actual.color,
        expectedBackground: expected.backgroundColor,
        expectedForeground: expected.color,
      };
      probe.remove();
      return result;
    },
    { background: backgroundToken, foreground: foregroundToken },
  );
  expect(colours.actualBackground).toBe(colours.expectedBackground);
  expect(colours.actualForeground).toBe(colours.expectedForeground);
}
