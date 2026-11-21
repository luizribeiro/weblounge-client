import type { Locator, Page } from "@playwright/test";
import {
  captureHistoryWire,
  heldHistoryRequestCount,
  releaseHeldHistoryRequest,
} from "./history-wire-fixture";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

test.describe("DM and member presence against local Ergo", () => {
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

  test("shows no DM presence after a relaunch until the channel WHO reports away states", async ({
    page,
    irc,
  }) => {
    const detached = await irc.peer("ana");
    const attached = await irc.peer("sam");
    await detached.setAlwaysOn(true);
    await detached.setAutoAway(true);
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await detached.privmsgConfirmed(irc.account, `hello ${irc.id}`);
    await attached.privmsgConfirmed(irc.account, `hi ${irc.id}`);
    detached.close();
    await detached.waitForDisconnect();
    await expect(presenceOf(page, detached.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );
    await nativeFeelAudit(page);

    await captureHistoryWire(page, { holdRequest: `WHO ${irc.channel}` });
    await page.goto(irc.url());
    await expect.poll(() => heldHistoryRequestCount(page)).toBe(1);
    await page.getByRole("button", { name: "Toggle member list" }).click();
    const members = page.getByRole("complementary", {
      name: `Members of ${irc.channel}`,
    });
    await expect(memberRow(members, detached.nickname)).toBeVisible();
    await expect(memberRow(members, attached.nickname)).toBeVisible();
    await expect(directRow(page, detached.nickname)).toBeVisible();
    await expect(directRow(page, attached.nickname)).toBeVisible();
    await expect(presenceOf(page, detached.nickname)).toHaveCount(0);
    await expect(presenceOf(page, attached.nickname)).toHaveCount(0);

    await releaseHeldHistoryRequest(page);
    await expect(presenceOf(page, detached.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );
    await expect(presenceOf(page, attached.nickname)).toHaveAttribute(
      "data-presence",
      "online",
    );
    await expectSettled(page, { conversation: irc.channel });
  });

  test("asks once after a relaunch, so connected peers who share no channel show online or away, then offline once they quit", async ({
    page,
    irc,
  }) => {
    const present = await irc.peer("iris", []);
    const away = await irc.peer("ana", []);
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await present.privmsgConfirmed(irc.account, `beep ${irc.id}`);
    await away.privmsgConfirmed(irc.account, `hello ${irc.id}`);
    await away.setAway("lunch");
    await expect(presenceOf(page, away.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );

    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await expect(presenceOf(page, present.nickname)).toHaveAttribute(
      "data-presence",
      "online",
    );
    await expect(presenceOf(page, away.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );

    await present.setAway("lunch");
    await expect(presenceOf(page, present.nickname)).toHaveAttribute(
      "data-presence",
      "away",
    );
    present.close();
    await present.waitForDisconnect();
    await expect(presenceOf(page, present.nickname)).toHaveAttribute(
      "data-presence",
      "offline",
    );
    await nativeFeelAudit(page);
  });
});

function directRow(page: Page, nick: string): Locator {
  return page.locator(`[data-buffer-id][aria-label^="${nick},"]`);
}

function presenceOf(page: Page, nick: string): Locator {
  return directRow(page, nick).locator("[data-sidebar-prefix] [data-presence]");
}

function memberRow(members: Locator, nick: string): Locator {
  return members.getByRole("button", {
    name: `Open direct message with ${nick}`,
    exact: true,
  });
}
