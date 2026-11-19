import type { Locator, Page, TestInfo } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const popup = (page: Page) => page.locator("[data-composer-suggestions]");
const usageLine = (page: Page, command: string) =>
  page.locator(`[data-command-usage="${command}"]`);
const activeParameter = (page: Page) =>
  page.locator("[data-command-usage] [data-active-argument]");

async function expectUsage(
  page: Page,
  command: string,
  line: string,
  active: string,
) {
  await expect(usageLine(page, command)).toHaveText(line);
  await expect(activeParameter(page)).toHaveText(active);
}

async function openChannel(
  page: Page,
  irc: IrcTestAccount,
  channel: string,
): Promise<Locator> {
  await page.goto(irc.url());
  const home = page.getByRole("textbox", { name: `Message ${irc.channel}` });
  await expect(home).toBeVisible();
  if (channel === irc.channel) {
    await expectSettled(page, { conversation: channel });
    return home;
  }
  await home.fill(`/join ${channel}`);
  await home.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await expectSettled(page, { conversation: channel });
  return page.getByRole("textbox", { name: `Message ${channel}` });
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  command: string,
  name: string,
) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const file = `${name}-${colorScheme}.png`;
    await testInfo.attach(file, {
      body: await screenshotWithInter(usageLine(page, command), {
        path: testInfo.outputPath(file),
      }),
      contentType: "image/png",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("command usage hint against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("/join highlights the channel and then the key", async ({
      page,
      irc,
    }) => {
      await installNativeFeelInstrumentation(page);
      const composer = await openChannel(page, irc, irc.channel);

      await composer.pressSequentially("/join ");
      await expectUsage(page, "join", "/join <channels> [keys]", "<channels>");
      await composer.pressSequentially("#usage-hint");
      await expectUsage(page, "join", "/join <channels> [keys]", "<channels>");
      await composer.pressSequentially(" sekrit");
      await expectUsage(page, "join", "/join <channels> [keys]", "[keys]");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await composer.pressSequentially(" more");
      await expectUsage(page, "join", "/join <channels> [keys]", "[keys]");

      await composer.press("Escape");
      await expect(popup(page)).toHaveCount(0);
      await composer.pressSequentially("x");
      await expect(popup(page)).toHaveCount(0);
      await composer.fill("");
      await composer.pressSequentially("/part see you");
      await expectUsage(page, "part", "/part [channel] [reason]", "[reason]");
      await nativeFeelAudit(page);
    });

    test("/kick shows nick candidates under its usage, then the reason", async ({
      page,
      irc,
    }, testInfo) => {
      await installNativeFeelInstrumentation(page);
      const channel = irc.channelNamed("usage-kick");
      const composer = await openChannel(page, irc, channel);
      const peer = await irc.peer("kickee", [channel]);
      await expect(
        page.locator("[data-system-line]").filter({ hasText: peer.nickname }),
      ).toBeVisible();

      await composer.pressSequentially(`/kick ${peer.nickname.slice(0, 5)}`);
      const candidate = page.getByRole("option", {
        name: new RegExp(peer.nickname, "u"),
      });
      await expect(candidate).toBeVisible();
      await expectUsage(page, "kick", "/kick <nick> [reason]", "<nick>");
      await capture(page, testInfo, "kick", "usage-kick-nick-desktop");

      await composer.press("Enter");
      await expect(composer).toHaveValue(`/kick ${peer.nickname} `);
      await expectUsage(page, "kick", "/kick <nick> [reason]", "[reason]");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await composer.pressSequentially("link spam again");
      await expectUsage(page, "kick", "/kick <nick> [reason]", "[reason]");
      await capture(page, testInfo, "kick", "usage-kick-reason-desktop");

      await composer.press("Enter");
      await expect(
        page
          .locator("[data-system-line]")
          .filter({ hasText: `You kicked ${peer.nickname}` }),
      ).toBeVisible();
      await expect(composer).toHaveValue("");
      await expect(popup(page)).toHaveCount(0);
      await nativeFeelAudit(page);
    });

    test("unknown commands and plain words show no usage", async ({
      page,
      irc,
    }) => {
      await installNativeFeelInstrumentation(page);
      const composer = await openChannel(page, irc, irc.channel);

      await composer.pressSequentially("/whois someone");
      await expect(popup(page)).toHaveCount(0);
      await composer.fill("");
      await composer.pressSequentially("join the fun");
      await expect(popup(page)).toHaveCount(0);
      await composer.fill("");
      await composer.pressSequentially("/close ");
      await expect(popup(page)).toHaveCount(0);
      await nativeFeelAudit(page);
    });
  });

  test.describe("phone", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });

    test("the usage rides above the composer without moving the transcript", async ({
      page,
      irc,
    }, testInfo) => {
      await installNativeFeelInstrumentation(page);
      const channel = irc.channelNamed("usage-phone");
      await page.goto(irc.url({ autojoin: [channel] }));
      await page.getByRole("button", { name: channel }).click();
      const composer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });
      await expect(composer).toBeVisible();
      await expectSettled(page, { conversation: channel });
      const peer = await irc.peer("phonekickee", [channel]);
      await expect(
        page.locator("[data-system-line]").filter({ hasText: peer.nickname }),
      ).toBeVisible();
      const messages = page.locator("[data-message-list]");
      const before = await messages.boundingBox();

      await composer.pressSequentially(`/kick ${peer.nickname} `);
      await expectUsage(page, "kick", "/kick <nick> [reason]", "[reason]");
      await composer.pressSequentially("bye");
      await expectUsage(page, "kick", "/kick <nick> [reason]", "[reason]");
      expect(await messages.boundingBox()).toEqual(before);
      const hint = await popup(page).boundingBox();
      const field = await composer.boundingBox();
      expect(hint).not.toBeNull();
      expect(field).not.toBeNull();
      if (hint !== null && field !== null) {
        expect(hint.y + hint.height).toBeLessThanOrEqual(field.y);
        expect(hint.x).toBeGreaterThanOrEqual(0);
        expect(hint.x + hint.width).toBeLessThanOrEqual(402);
      }
      await capture(page, testInfo, "kick", "usage-kick-reason-phone");

      await composer.fill("");
      await expect(popup(page)).toHaveCount(0);
      await nativeFeelAudit(page);
    });
  });
});
