import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const fixtureChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test.describe("unread badge colours against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows total counts by mention severity in both shells and themes", async ({
    baseURL,
    browser,
    page,
  }) => {
    const suffix = Date.now().toString(36).slice(-6);
    const desktopChannel = `#badge-d-${suffix}`;
    const mobileChannel = `#badge-m-${suffix}`;
    const mobileContext = await browser.newContext({
      baseURL,
      colorScheme: "light",
      hasTouch: true,
      isMobile: true,
      viewport: { height: 874, width: 402 },
    });
    const mobile = await mobileContext.newPage();
    const bots: IrcClient[] = [];
    try {
      await page.emulateMedia({ colorScheme: "light" });
      await Promise.all([
        page.goto("/?irc-password=weblounge-test"),
        mobile.goto("/?irc-password=weblounge-test"),
      ]);
      await joinDesktopChannel(page, desktopChannel);
      await joinMobileChannel(mobile, mobileChannel);
      bots.push(
        await IrcClient.connect(
          `badged${suffix}`,
          "weblounge-bot",
          "weblounge-bot-test",
          desktopChannel,
        ),
        await IrcClient.connect(
          `badgem${suffix}`,
          "weblounge-bot",
          "weblounge-bot-test",
          mobileChannel,
        ),
      );

      await page.getByRole("button", { name: fixtureChannel }).click();
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
        "weblounge: mentioned on desktop",
      );
      await bots[1]?.privmsgConfirmed(
        mobileChannel,
        "weblounge: mentioned on mobile",
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
      for (const bot of bots) bot.close();
      await mobileContext.close();
    }
  });
});

async function joinDesktopChannel(page: Page, channel: string): Promise<void> {
  const composer = page.getByRole("textbox", {
    name: `Message ${fixtureChannel}`,
  });
  await expect(composer).toBeVisible();
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

async function joinMobileChannel(page: Page, channel: string): Promise<void> {
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await page.getByRole("button", { name: fixtureChannel }).click();
  const composer = page.getByRole("textbox", {
    name: `Message ${fixtureChannel}`,
  });
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
