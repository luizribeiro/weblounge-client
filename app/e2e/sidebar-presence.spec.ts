import type { Locator } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";
import { tokenColour } from "./sidebar-geometry";

test.describe("sidebar presence against local Ergo", () => {
  test("shows a DM peer's MONITOR presence on the row's leading column", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("ana", []);
    try {
      await installNativeFeelInstrumentation(page);
      await page.goto(irc.url());
      await expectSettled(page, { conversation: irc.channel });
      await peer.privmsgConfirmed(irc.account, `hello ${irc.id}`);

      const direct = page.getByRole("button", {
        name: `${peer.nickname}, 1 unread, including mentions, online`,
        exact: true,
      });
      await expect(direct).toBeVisible();
      const row = page.locator(
        `[data-buffer-id="${await direct.getAttribute("data-buffer-id")}"]`,
      );
      const dot = row.locator("[data-sidebar-prefix] [data-presence]");
      await expect(dot).toHaveAttribute("data-presence", "online");
      await expect(dot).toHaveCSS(
        "background-color",
        await tokenColour(page, "--wl-color-online"),
      );
      const channel = page.getByRole("button", { name: irc.channel });
      expect(await nameLeft(row)).toBeCloseTo(await nameLeft(channel), 1);

      await peer.setAway("lunch");
      await expect(row).toHaveAccessibleName(
        `${peer.nickname}, 1 unread, including mentions, away`,
      );
      await expect(dot).toHaveAttribute("data-presence", "away");
      await expect(dot).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(dot).toHaveCSS(
        "border-top-color",
        await tokenColour(page, "--wl-color-panel-muted"),
      );
      peer.close();
      await peer.waitForDisconnect();
      await expect(row).toHaveAccessibleName(
        `${peer.nickname}, 1 unread, including mentions`,
      );
      await expect(dot).toHaveCount(0);
      await nativeFeelAudit(page);
    } finally {
      peer.close();
    }
  });
});

async function nameLeft(row: Locator): Promise<number> {
  const box = await row.locator("[data-sidebar-name]").boundingBox();
  if (box === null) throw new Error("row name has no box");
  return box.x;
}
