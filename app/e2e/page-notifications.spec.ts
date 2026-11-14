import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import {
  clickPageNotification,
  installPageNotificationStub,
  type PostedPageNotification,
  postedPageNotifications,
} from "./page-notification-stub";

test.describe("page-posted notifications without Web Push", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.beforeEach(async ({ page }) => {
    await installNativeFeelInstrumentation(page);
    await installPageNotificationStub(page, {
      permission: "granted",
      requestResult: "granted",
    });
  });

  test("notifies once for unseen DMs and mentions, opens them and closes on read", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("pn");
    const peer = await irc.peer("pn", [channel]);
    await page.goto(irc.url());
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const composer = page.getByRole("textbox", { name: /Message/ });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    await peer.privmsgConfirmed(channel, "lunch anyone?");
    await peer.privmsgConfirmed(channel, `${irc.account}: visible mention`);
    await composer.fill(`${irc.account}: a note to myself`);
    await composer.press("Enter");
    await expect(messageText(page, "a note to myself")).toBeVisible();
    await expect(messageText(page, "visible mention")).toBeVisible();
    expect(await notificationsFrom(page, peer.nickname)).toEqual([]);

    await peer.privmsgConfirmed(irc.account, "are you around?");
    await expect
      .poll(() => notificationsFrom(page, peer.nickname))
      .toEqual([
        {
          title: peer.nickname,
          body: "are you around?",
          tag: expect.stringMatching(new RegExp(`/${peer.nickname}$`, "u")),
          closed: false,
        },
      ]);

    await setHidden(page, true);
    await peer.privmsgConfirmed(channel, "hidden chatter");
    await peer.privmsgConfirmed(channel, `${irc.account}: hidden mention`);
    await expect
      .poll(() => notificationsFrom(page, peer.nickname))
      .toHaveLength(2);
    expect((await notificationsFrom(page, peer.nickname))[1]).toEqual({
      title: `${peer.nickname} in ${channel}`,
      body: expect.stringMatching(
        new RegExp(
          `^${irc.account}: hidden mention(?:\n· \\d+ new messages)?$`,
          "u",
        ),
      ),
      tag: expect.stringMatching(new RegExp(`/${channel}$`, "u")),
      closed: false,
    });

    await setHidden(page, false);
    await clickPageNotification(page, peer.nickname);
    await expect(
      page.getByRole("heading", { name: peer.nickname }),
    ).toBeVisible();
    expect((await notificationsFrom(page, peer.nickname))[0]?.closed).toBe(
      true,
    );
    expect((await notificationsFrom(page, peer.nickname))[1]?.closed).toBe(
      false,
    );

    await page.getByRole("button", { name: channel }).click();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect
      .poll(
        async () => (await notificationsFrom(page, peer.nickname))[1]?.closed,
      )
      .toBe(true);
    expect(await notificationsFrom(page, peer.nickname)).toHaveLength(2);

    await page.goto(irc.url({ autojoin: [channel] }));
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    await page.getByRole("button", { name: channel }).click();
    await expect(messageText(page, "hidden mention")).toBeVisible();
    await expect(page.getByRole("button", { name: channel })).toHaveAttribute(
      "data-unread",
      "0",
    );
    expect(await notificationsFrom(page, peer.nickname)).toEqual([]);
    await nativeFeelAudit(page);
  });
});

async function notificationsFrom(
  page: Page,
  nickname: string,
): Promise<PostedPageNotification[]> {
  return (await postedPageNotifications(page)).filter((notification) =>
    notification.title.startsWith(nickname),
  );
}

function messageText(page: Page, text: string) {
  return page.locator("[data-message-row]").filter({ hasText: text });
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("visibility control is missing");
    setter(nextHidden);
  }, hidden);
}
