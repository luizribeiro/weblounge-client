import type { Locator } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

test.describe("sidebar row trailing slot against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows the close button instead of the badge without moving the name", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("slot");
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    await peer.privmsgConfirmed(irc.account, `unread direct ${irc.id}`);

    const direct = page.getByRole("button", {
      name: `${peer.nickname}, 1 unread, including mentions, online`,
    });
    await expect(direct).toBeVisible();
    const directRow = page
      .locator('[data-sidebar-row="true"]')
      .filter({ has: direct });
    const badge = directRow.locator("[data-badge-kind]");
    const close = directRow.getByRole("button", {
      name: `Close conversation with ${peer.nickname}`,
    });
    const nameEdge = () => rightEdge(directRow.locator("[data-sidebar-name]"));

    await expect(badge).toBeVisible();
    await expect(close).toBeHidden();
    const restingEdge = await nameEdge();

    await directRow.hover();
    await expect(close).toBeVisible();
    await expect(badge).toBeHidden();
    expect(await nameEdge()).toBe(restingEdge);
    await expect(direct).toHaveAccessibleName(
      `${peer.nickname}, 1 unread, including mentions, online`,
    );

    await page.mouse.move(0, 0);
    await expect(badge).toBeVisible();
    await expect(close).toBeHidden();

    await direct.focus();
    await expect(close).toBeVisible();
    await expect(badge).toBeHidden();
    expect(await nameEdge()).toBe(restingEdge);

    await nativeFeelAudit(page);
  });

  test("shows only a channel's leave button on hover and confirms before leaving", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("leaveslot", [irc.channel]);
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await page.locator('[data-network-state="online"]').click();
    await peer.privmsgConfirmed(irc.channel, `unread channel ${irc.id}`);

    const channel = page.getByRole("button", {
      name: `${irc.channel}, 1 unread`,
    });
    await expect(channel).toBeVisible();
    const channelRow = page
      .locator('[data-sidebar-row="true"]')
      .filter({ has: channel });
    const badge = channelRow.locator("[data-badge-kind]");
    const leave = channelRow.getByRole("button", {
      name: "Leave channel",
    });
    const restingEdge = await rightEdge(
      channelRow.locator("[data-sidebar-name]"),
    );
    await expect(leave).toBeHidden();

    await channelRow.hover();
    await expect(leave).toBeVisible();
    await expect(badge).toBeHidden();
    expect(await rightEdge(channelRow.locator("[data-sidebar-name]"))).toBe(
      restingEdge,
    );
    await expect(channel).toHaveAccessibleName(`${irc.channel}, 1 unread`);

    await leave.click();
    const confirmation = page.getByRole("alertdialog", {
      name: `Leave ${irc.channel}?`,
    });
    await expect(confirmation).toBeVisible();
    await nativeFeelAudit(page);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toBeHidden();
    await expect(channel).toBeFocused();
    await expect(channel).toBeVisible();
  });
});

async function rightEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box.x + box.width;
}
