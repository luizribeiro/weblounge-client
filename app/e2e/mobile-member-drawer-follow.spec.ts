import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const homeChannel = "#weblounge-test";

test.describe("mobile member drawer follows navigation", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test("shows the active channel through every mobile navigation path", async ({
    page,
  }, testInfo) => {
    test.skip(
      !["chromium-mobile-members", "webkit-mobile-members"].includes(
        testInfo.project.name,
      ),
      "requires a mobile browser profile",
    );
    const suffix = Date.now().toString().slice(-6);
    const otherChannel = `#drawer-${suffix}`;
    const homeNick = `home${suffix}`;
    const otherNick = `other${suffix}`;
    const homeMember = await IrcClient.connect(
      homeNick,
      "weblounge-bot",
      "weblounge-bot-test",
      homeChannel,
    );
    const otherMember = await IrcClient.connect(
      otherNick,
      "weblounge-bot",
      "weblounge-bot-test",
      otherChannel,
    );

    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/?irc-password=weblounge-test");
      await openChat(page, homeChannel);
      const homePath = new URL(page.url()).pathname;
      const composer = page.getByRole("textbox", {
        name: `Message ${homeChannel}`,
      });
      await composer.fill(`/join ${otherChannel}`);
      await composer.press("Enter");
      await expect(
        page.getByRole("heading", { name: otherChannel }),
      ).toBeVisible();

      await backToChats(page);
      await openChat(page, homeChannel);
      await expectDrawer(page, homeChannel, homeNick, otherNick);
      await closeDrawer(page);
      await backToChats(page);

      await openChat(page, otherChannel);
      await expectDrawer(page, otherChannel, otherNick, homeNick);
      await closeDrawer(page);
      await backToChats(page);

      await openChat(page, homeChannel);
      await expectDrawer(page, homeChannel, homeNick, otherNick);
      await page
        .getByRole("dialog", { name: "Members" })
        .getByRole("button", {
          name: `Open direct message with ${homeNick}`,
        })
        .click();
      await expect(page.getByRole("heading", { name: homeNick })).toBeVisible();
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(
        page.getByRole("heading", { name: homeChannel }),
      ).toBeVisible();
      await backToChats(page);
      await openChat(page, otherChannel);
      await expectDrawer(page, otherChannel, otherNick, homeNick);
      await closeDrawer(page);
      await swipeBack(page);

      await openChat(page, homeChannel);
      await expectDrawer(page, homeChannel, homeNick, otherNick);
      await closeDrawer(page);

      await page.emulateMedia({ reducedMotion: "no-preference" });
      const retainedComposer = page.getByRole("textbox", {
        name: `Message ${homeChannel}`,
      });
      await retainedComposer.fill(`/join ${otherChannel}`);
      await retainedComposer.press("Enter");
      const incoming = page.locator("[data-mobile-chat]").filter({
        has: page.getByRole("heading", { name: otherChannel }),
      });
      await expect(incoming).toBeVisible();
      await expect(page.locator("[data-mobile-chat]")).toHaveCount(2);
      await incoming
        .getByRole("button", { name: "Show members" })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expectOpenDrawer(page, otherChannel, otherNick, homeNick);
      await closeDrawer(page);

      await page.goto(`${homePath}?irc-password=weblounge-test`);
      await expect(
        page.getByRole("heading", { name: homeChannel }),
      ).toBeVisible();
      await expectDrawer(page, homeChannel, homeNick, otherNick);
    } finally {
      homeMember.close();
      otherMember.close();
    }
  });
});

async function openChat(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { exact: true, name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

async function backToChats(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back to chats" }).click();
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
}

async function expectDrawer(
  page: Page,
  channel: string,
  expectedNick: string,
  absentNick: string,
): Promise<void> {
  await page.getByRole("button", { name: "Show members" }).click();
  await expectOpenDrawer(page, channel, expectedNick, absentNick);
}

async function expectOpenDrawer(
  page: Page,
  channel: string,
  expectedNick: string,
  absentNick: string,
): Promise<void> {
  const drawer = page.getByRole("dialog", { name: "Members" });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("list", { name: `Members of ${channel}` }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", {
      name: `Open direct message with ${expectedNick}`,
    }),
  ).toBeVisible();
  await expect(drawer.getByText(absentNick, { exact: true })).toHaveCount(0);
  await expect(drawer.locator("[data-member-following]")).toHaveText(
    `Following ${channel}`,
  );
}

async function closeDrawer(page: Page): Promise<void> {
  const drawer = page.getByRole("dialog", { name: "Members" });
  await drawer.getByRole("button", { name: "Close member list" }).click();
  await expect(drawer).toHaveCount(0);
}

async function swipeBack(page: Page): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  for (const [type, clientX] of [
    ["pointerdown", 40],
    ["pointermove", 60],
    ["pointermove", 360],
    ["pointerup", 360],
  ] as const) {
    await shell.dispatchEvent(type, {
      clientX,
      clientY: 300,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch",
    });
  }
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
}
