import { expect, type Locator, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
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
  }) => {
    const suffix = Date.now().toString(36);
    const peer = await IrcClient.connect(
      `slot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await installNativeFeelInstrumentation(page);
      await page.goto("/?irc-password=weblounge-test");
      await page.getByRole("button", { name: /^#weblounge-test/u }).click();
      await peer.privmsgConfirmed("weblounge", `unread direct ${suffix}`);

      const direct = page.getByRole("button", {
        name: `${peer.nickname}, 1 unread, including mentions`,
      });
      await expect(direct).toBeVisible();
      const directRow = page
        .locator('[data-sidebar-row="true"]')
        .filter({ has: direct });
      const badge = directRow.locator("[data-badge-kind]");
      const close = directRow.getByRole("button", {
        name: `Close conversation with ${peer.nickname}`,
      });
      const nameEdge = () =>
        rightEdge(directRow.locator("[data-sidebar-name]"));

      await expect(badge).toBeVisible();
      await expect(close).toBeHidden();
      const restingEdge = await nameEdge();

      await directRow.hover();
      await expect(close).toBeVisible();
      await expect(badge).toBeHidden();
      expect(await nameEdge()).toBe(restingEdge);
      await expect(direct).toHaveAccessibleName(
        `${peer.nickname}, 1 unread, including mentions`,
      );

      await page.mouse.move(0, 0);
      await expect(badge).toBeVisible();
      await expect(close).toBeHidden();

      await direct.focus();
      await expect(close).toBeVisible();
      await expect(badge).toBeHidden();
      expect(await nameEdge()).toBe(restingEdge);

      await nativeFeelAudit(page);
    } finally {
      peer.close();
    }
  });
});

async function rightEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box.x + box.width;
}
