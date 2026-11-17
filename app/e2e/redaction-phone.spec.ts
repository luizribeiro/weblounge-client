import type { Page } from "@playwright/test";
import { messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { longPressMessage } from "./message-sheet";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import {
  composer,
  expectRedactedByPeer,
  redactedRow,
  reviewShot,
  waitForReadDwell,
} from "./redaction";
import { choose } from "./settings-fixture";
import { expectSettled } from "./settled";
import { isChromium, tap } from "./touch";

test("deletes your own message from the long-press sheet after confirming", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const peer = await irc.peer("sheet");
  await openChat(page, irc);
  const text = "sent from my phone by mistake";
  await composer(page).fill(text);
  await tap(page, page.getByRole("button", { name: "Send", exact: true }));
  const sent = await peer.waitForPrivmsg(irc.channel, text, irc.account);
  const row = productionMessageRow(page, text);
  await expect(row).toHaveAttribute("data-delivery", "confirmed");
  await waitForReadDwell(irc, irc.channel, serverTime(sent));

  const sheet = await longPressMessage(page, row, irc.account);
  const remove = sheet.getByRole("button", { name: "Delete message" });
  await expect(remove).toHaveAttribute("data-tone", "danger");
  await tap(page, remove);
  const dialog = page.getByRole("alertdialog", {
    name: "Delete this message?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await tap(page, dialog.getByRole("button", { name: "Delete" }));

  await peer.waitForRedact(irc.channel, messageId(sent));
  await expect(productionMessageRow(page, text)).toHaveCount(0);
  await expect(redactedRow(page)).toContainText("Message deleted");
  await expectSettled(page, { conversation: irc.channel });
  await nativeFeelAudit(page);
});

test("offers no Delete on someone else's message", async ({ page, irc }) => {
  const peer = await irc.peer("theirs");
  await openChat(page, irc);
  const text = "this one is not yours";
  await peer.privmsgConfirmed(irc.channel, text);

  const sheet = await longPressMessage(
    page,
    productionMessageRow(page, text),
    peer.nickname,
  );

  await expect(sheet.getByRole("button", { name: "Copy text" })).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Delete message" }),
  ).toHaveCount(0);
});

test("shows a peer's channel deletion as bars on the phone", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const peer = await irc.peer("bars");
  await openChat(page, irc);
  await expectRedactedByPeer(page, irc, peer, irc.channel, "phone secret");
});

test("shows a peer's direct-message deletion as bars on the phone", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const peer = await irc.peer("dm-bars");
  await openChat(page, irc);
  await peer.privmsgConfirmed(irc.account, "opening line");
  await page.goto(irc.url({ path: `/Local%20Ergo/@${peer.nickname}` }));
  await expectSettled(page, { conversation: peer.nickname });
  await expectRedactedByPeer(page, irc, peer, irc.account, "direct secret");
});

const themes = [
  { name: "Lounge", id: "lounge" },
  { name: "Lounge Night", id: "lounge-night" },
  { name: "Black", id: "black" },
] as const;

test("captures the phone sheet, confirmation and bars in Lounge, Lounge Night and Black", async ({
  page,
  irc,
}) => {
  test.skip(isChromium(page.context()), "screenshots come from the iPhone");
  test.skip(
    process.env.WEBLOUNGE_REDACTION_SHOTS === undefined,
    "review screenshots only",
  );
  const peer = await irc.peer("shots");
  await peer.privmsgConfirmed(irc.channel, "did the relay fix land?");
  const gone = await peer.privmsgConfirmed(
    irc.channel,
    "my api key is hunter2",
  );
  await peer.redactConfirmed(irc.channel, messageId(gone));
  await peer.privmsgConfirmed(irc.channel, "oops, ignore that");
  for (const theme of themes) {
    await useTheme(page, irc, theme.name, theme.id);
    const text = `deleting this in ${theme.name}`;
    await composer(page).fill(text);
    await tap(page, page.getByRole("button", { name: "Send", exact: true }));
    const row = productionMessageRow(page, text);
    await expect(row).toHaveAttribute("data-delivery", "confirmed");

    const sheet = await longPressMessage(page, row, irc.account);
    await reviewShot(page, `phone-sheet-${theme.id}`);
    await tap(page, sheet.getByRole("button", { name: "Delete message" }));
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await reviewShot(page, `phone-confirm-${theme.id}`);
    await tap(page, dialog.getByRole("button", { name: "Delete" }));
    await expect(productionMessageRow(page, text)).toHaveCount(0);
    await expect(redactedRow(page)).toHaveCount(1);
    await expectSettled(page, { conversation: irc.channel });
    await reviewShot(page, `phone-bars-${theme.id}`);
  }
});

async function openChat(page: Page, irc: IrcTestAccount): Promise<void> {
  await page.goto(irc.url({ path: `/Local%20Ergo/${irc.channel.slice(1)}` }));
  await expectSettled(page, { conversation: irc.channel });
}

async function useTheme(
  page: Page,
  irc: IrcTestAccount,
  name: string,
  id: string,
): Promise<void> {
  await page.goto(irc.url());
  await page
    .getByRole("region", { name: "Chats" })
    .getByRole("button", { name: "Settings" })
    .tap();
  await page.getByRole("button", { name: /^Appearance/u }).tap();
  await choose(page, name);
  await expect(page.locator("html")).toHaveAttribute("data-theme", id);
  await openChat(page, irc);
  await expect(page.locator("html")).toHaveAttribute("data-theme", id);
}
