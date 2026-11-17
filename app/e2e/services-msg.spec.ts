import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { expectSettled } from "./settled";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1" ||
    process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
  "requires the flake's local Ergo fixture and its socket forwarder",
);

const HELP_REPLY = "ChanServ lets you register and manage channels.";

test.beforeEach(async ({ irc }) => {
  // Production Ergo answers MONITOR for a service with RPL_MONOFFLINE; the local one says online.
  await irc.forwarder.rewriteIncomingText(
    ":irc.localhost 730 ",
    ":irc.localhost 731 ",
  );
});

test("registers a channel by messaging ChanServ and shows its reply", async ({
  page,
  irc,
}) => {
  const channel = irc.channel;
  await page.goto(irc.url());
  await openChannel(page, channel);
  const composer = page.getByRole("textbox", { name: `Message ${channel}` });
  await composer.fill(`/msg ChanServ REGISTER ${channel}`);
  await composer.press("Enter");

  await page.getByRole("button", { name: /^ChanServ(?:,|$)/ }).click();
  await expect(page.getByRole("heading", { name: "ChanServ" })).toBeVisible();
  await expectChanServReply(page, `Channel ${channel} successfully registered`);
  await expect(
    page.locator("[data-message-row]").filter({ hasText: /REGISTER/ }),
  ).toHaveCount(1);
});

test("registers through ChanServ named in lower case", async ({
  page,
  irc,
}) => {
  await page.goto(irc.url());
  await openChannel(page, irc.channel);
  const composer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  await composer.fill(`/query chanserv REGISTER ${irc.channel}`);
  await composer.press("Enter");

  await expect(page.getByRole("heading", { name: "ChanServ" })).toBeVisible();
  await expectChanServReply(
    page,
    `Channel ${irc.channel} successfully registered`,
  );
});

test("shows ChanServ's reply to a line typed in its conversation", async ({
  page,
  irc,
}) => {
  await page.goto(irc.url());
  await queryChanServ(page, irc.channel);
  await sendToChanServ(page, "HELP");

  await expectChanServReply(page, HELP_REPLY);
});

test("shows ChanServ's replies as trusted server service lines", async ({
  page,
  irc,
}) => {
  await page.goto(irc.url());
  await queryChanServ(page, irc.channel);
  await sendToChanServ(page, "HELP");
  await expectChanServReply(page, HELP_REPLY);

  const replies = page.locator(
    '[data-message-row][data-irc-notice="true"][data-notice-source="user"]',
  );
  await expect(
    replies.filter({ hasText: "End of ChanServ HELP" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-message-row][data-unverified-sender="true"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Unverified sender" }),
  ).toHaveCount(0);
});

test("registers through a ChanServ conversation reopened from Jump to after a relaunch", async ({
  page,
  irc,
}) => {
  await page.goto(irc.url());
  await queryChanServ(page, irc.channel);
  await sendToChanServ(page, "HELP");
  await expectChanServReply(page, HELP_REPLY);
  await page.goto(irc.url());
  await openChannel(page, irc.channel);
  await page.keyboard.press("Control+K");
  const query = page.getByRole("combobox", { name: "Jump to" });
  await query.fill("ChanServ");
  await expect(page.getByRole("option", { name: /ChanServ/u })).toHaveCount(1);
  await query.press("Enter");
  await expect(page.getByRole("heading", { name: "ChanServ" })).toBeVisible();
  await sendToChanServ(page, `REGISTER ${irc.channel}`);

  await expectChanServReply(
    page,
    `Channel ${irc.channel} successfully registered`,
  );
});

async function openChannel(page: Page, channel: string): Promise<void> {
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await page.getByRole("button", { name: channel, exact: true }).click();
}

async function queryChanServ(page: Page, channel: string): Promise<void> {
  await openChannel(page, channel);
  const channelComposer = page.getByRole("textbox", {
    name: `Message ${channel}`,
  });
  await channelComposer.fill("/query ChanServ");
  await channelComposer.press("Enter");
  await expect(page.getByRole("heading", { name: "ChanServ" })).toBeVisible();
}

async function sendToChanServ(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message ChanServ" });
  await composer.fill(text);
  await composer.press("Enter");
}

async function expectChanServReply(page: Page, text: string): Promise<void> {
  await expect(
    page
      .locator('[data-message-row][data-irc-notice="true"]')
      .filter({ hasText: text }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectSettled(page, { conversation: "ChanServ" });
}
