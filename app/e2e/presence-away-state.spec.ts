import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

test.describe("presence of always-on peers against local Ergo", () => {
  test("shows a detached peer away and a connected bot online after a relaunch, without opening their DMs", async ({
    page,
    irc,
  }) => {
    const detached = await irc.peer("ana");
    const bot = await irc.peer("iris");
    await detached.setAlwaysOn(true);
    await detached.setAutoAway(true);
    await bot.mode(bot.nickname, "+B");
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await detached.privmsgConfirmed(irc.account, `hello ${irc.id}`);
    await bot.privmsgConfirmed(irc.account, `beep ${irc.id}`);
    await expect(presenceOf(page, detached.nickname)).toHaveAttribute(
      "data-presence",
      "online",
    );
    await expect(presenceOf(page, bot.nickname)).toHaveAttribute(
      "data-presence",
      "online",
    );

    detached.close();
    await detached.waitForDisconnect();
    await expect(presenceOf(page, detached.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );

    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await expect(presenceOf(page, detached.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );
    await expect(presenceOf(page, bot.nickname)).toHaveAttribute(
      "data-presence",
      "online",
    );

    await page.getByRole("button", { name: "Toggle member list" }).click();
    const members = page.getByRole("complementary", {
      name: `Members of ${irc.channel}`,
    });
    await expect(memberRow(members, detached.nickname)).toHaveAttribute(
      "data-away",
      "true",
    );
    await expect(memberRow(members, bot.nickname)).toHaveAttribute(
      "data-away",
      "false",
    );
    await expectSettled(page, { conversation: irc.channel });
    await nativeFeelAudit(page);
  });
});

function presenceOf(page: Page, nick: string): Locator {
  return page
    .locator(`[data-buffer-id][aria-label^="${nick},"]`)
    .locator("[data-sidebar-prefix] [data-presence]");
}

function memberRow(members: Locator, nick: string): Locator {
  return members.getByRole("button", {
    name: `Open direct message with ${nick}`,
    exact: true,
  });
}
