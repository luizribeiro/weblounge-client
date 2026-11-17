import { expect, test } from "./irc-fixture";
import { expectSettled } from "./settled";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("registers a channel by messaging ChanServ and shows its reply", async ({
  page,
  irc,
}) => {
  const channel = irc.channel;
  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await page.getByRole("button", { name: channel, exact: true }).click();
  const composer = page.getByRole("textbox", { name: `Message ${channel}` });
  await composer.fill(`/msg ChanServ REGISTER ${channel}`);
  await composer.press("Enter");

  await page.getByRole("button", { name: /^ChanServ(?:,|$)/ }).click();
  await expect(page.getByRole("heading", { name: "ChanServ" })).toBeVisible();
  const reply = page
    .locator('[data-message-row][data-irc-notice="true"]')
    .filter({ hasText: `Channel ${channel} successfully registered` });
  await expect(reply).toBeVisible();
  await expect(
    page.locator("[data-message-row]").filter({ hasText: /REGISTER/ }),
  ).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectSettled(page, { conversation: "ChanServ" });
});

test("shows ChanServ's reply to a line typed in its conversation", async ({
  page,
  irc,
}) => {
  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await page.getByRole("button", { name: irc.channel, exact: true }).click();
  const channelComposer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  await channelComposer.fill("/query ChanServ");
  await channelComposer.press("Enter");
  await expect(page.getByRole("heading", { name: "ChanServ" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message ChanServ" });
  await composer.fill("HELP");
  await composer.press("Enter");

  await expect(
    page
      .locator('[data-message-row][data-irc-notice="true"]')
      .filter({ hasText: "ChanServ lets you register and manage channels." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectSettled(page, { conversation: "ChanServ" });
});
