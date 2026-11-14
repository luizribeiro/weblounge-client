import { expect, test } from "./irc-fixture";

test.describe("channel departure against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("removes a parted channel whose name contains a slash", async ({
    page,
    irc,
  }) => {
    const channel = `#projects/${irc.account}`;
    await page.goto(irc.url());
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
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

  test("keeps a kicked channel read-only until Rejoin", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("kick");
    const operator = await irc.peer("operator", [channel]);
    await page.goto(irc.url());
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await expect(composer).toBeVisible();
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    await operator.kick(channel, irc.account, "too loud");

    const kickLine = page
      .locator("[data-system-line]")
      .filter({ hasText: `${operator.nickname} kicked you` });
    await expect(kickLine).toHaveAccessibleName(
      `${operator.nickname} kicked you: “too loud” · Rejoin`,
    );
    const kickedComposer = page.getByRole("textbox", {
      name: `Message ${channel}`,
    });
    await expect(kickedComposer).toBeDisabled();
    await expect(
      page.getByRole("status").filter({
        hasText: `You were kicked from ${channel}. Rejoin to send messages.`,
      }),
    ).toBeVisible();

    await kickLine.getByRole("button", { name: "Rejoin channel" }).click();
    await expect(kickedComposer).toBeEnabled();
    await kickedComposer.fill("back again");
    await kickedComposer.press("Enter");
    await expect(page.getByText("back again", { exact: true })).toBeVisible();
  });
});
