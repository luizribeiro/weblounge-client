import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";

test.describe("mobile member drawer follows navigation", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test("cold start follows channel A to channel B", async ({
    page,
    irc,
  }, testInfo) => {
    requireMobileMembersProject(testInfo.project.name);
    const homeChannel = irc.channel;
    const otherChannel = irc.channelNamed("drawer-cold");
    const homeNick = (await irc.peer("coldhome")).nickname;
    const otherNick = (await irc.peer("coldother", [otherChannel])).nickname;

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(irc.url({ autojoin: [otherChannel] }));
    await expect(
      page.getByRole("button", { exact: true, name: homeChannel }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: otherChannel }),
    ).toBeVisible();

    await openChat(page, homeChannel);
    await expectDrawer(page, homeChannel, homeNick, otherNick);
    await closeDrawer(page);
    await backToChats(page);

    await openChat(page, otherChannel);
    await expectDrawer(page, otherChannel, otherNick, homeNick);
  });

  test("shows the active channel through every mobile navigation path", async ({
    page,
    irc,
  }, testInfo) => {
    requireMobileMembersProject(testInfo.project.name);
    const homeChannel = irc.channel;
    const otherChannel = irc.channelNamed("drawer");
    const homeNick = (await irc.peer("home")).nickname;
    const otherNick = (await irc.peer("other", [otherChannel])).nickname;

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(irc.url());
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

    await page.goto(irc.url({ path: homePath }));
    await expect(
      page.getByRole("heading", { name: homeChannel }),
    ).toBeVisible();
    await expectDrawer(page, homeChannel, homeNick, otherNick);
  });
});

function requireMobileMembersProject(projectName: string): void {
  test.skip(
    !["chromium-mobile-members", "webkit-mobile-members"].includes(projectName),
    "requires a mobile browser profile",
  );
}

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
    drawer.getByRole("complementary", { name: `Members of ${channel}` }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", {
      name: `Open direct message with ${expectedNick}`,
    }),
  ).toBeVisible();
  await expect(drawer.getByText(absentNick, { exact: true })).toHaveCount(0);
  await expect(drawer.locator("[data-member-following]")).toHaveCount(0);
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
