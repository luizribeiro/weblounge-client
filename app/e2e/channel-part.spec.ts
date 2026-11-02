import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const fixtureChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test.describe("channel departure against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("removes a parted channel whose name contains a slash", async ({
    page,
  }) => {
    const channel = `#projects/${Date.now().toString(36)}`;
    await page.goto("/?irc-password=weblounge-test");
    const composer = page.getByRole("textbox", {
      name: `Message ${fixtureChannel}`,
    });
    await expect(composer).toBeVisible();
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    await page
      .getByRole("textbox", { name: `Message ${channel}` })
      .fill("/part");
    await page
      .getByRole("textbox", { name: `Message ${channel}` })
      .press("Enter");

    await expect(page.getByRole("button", { name: channel })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: channel })).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(channel.slice(1), "u"));
    await expect(
      page.getByRole("note").filter({ hasText: "The server refused" }),
    ).toHaveCount(0);
  });

  test("keeps a kicked channel read-only until Rejoin", async ({ page }) => {
    const suffix = Date.now().toString(36);
    const channel = `#kick-${suffix}`;
    const operator = await IrcClient.connectIsolated(
      `operator-${suffix}`,
      channel,
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      const composer = page.getByRole("textbox", {
        name: `Message ${fixtureChannel}`,
      });
      await expect(composer).toBeVisible();
      await composer.fill(`/join ${channel}`);
      await composer.press("Enter");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      await operator.kick(channel, "weblounge", "too loud");

      await expect(
        page.getByText(`operator-${suffix} kicked you: too loud`),
      ).toBeVisible();
      const kickedComposer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });
      await expect(kickedComposer).toBeDisabled();
      await expect(
        page.getByRole("status").filter({
          hasText: `You were kicked from ${channel}. Rejoin to send messages.`,
        }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Rejoin" }).click();
      await expect(kickedComposer).toBeEnabled();
      await kickedComposer.fill("back again");
      await kickedComposer.press("Enter");
      await expect(page.getByText("back again", { exact: true })).toBeVisible();
    } finally {
      operator.close();
    }
  });
});
