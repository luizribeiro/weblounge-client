import type { Page } from "@playwright/test";
import { messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { longPressMessage } from "./message-sheet";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import { composer, waitForReadDwell } from "./redaction";
import { expectThreadedReply, replyBar, replyQuote } from "./replies";
import { expectSettled } from "./settled";
import { tap } from "./touch";

test("replies from the long-press sheet and quotes the parent above the header", async ({
  page,
  irc,
}) => {
  await installNativeFeelInstrumentation(page);
  const peer = await irc.peer("reply-sheet");
  await openChat(page, irc);
  const question = "is the TestFlight build out yet?";
  const asked = await peer.privmsgConfirmed(irc.channel, question);

  const sheet = await longPressMessage(
    page,
    productionMessageRow(page, question),
    peer.nickname,
  );
  await tap(page, sheet.getByRole("button", { name: "Reply" }));
  await expect(sheet).toHaveCount(0);
  await expect(replyBar(page)).toContainText(
    `Replying to ${peer.nickname} ${question}`,
  );
  await expect(composer(page)).toBeFocused();
  const answer = "uploading it now";
  await composer(page).fill(answer);
  await tap(page, page.getByRole("button", { name: "Send", exact: true }));

  const sent = await expectThreadedReply(
    peer,
    irc.channel,
    `${peer.nickname}: `,
    answer,
    irc.account,
    messageId(asked),
  );
  await expect(replyBar(page)).toHaveCount(0);
  const row = productionMessageRow(page, answer);
  await expect(row).toHaveAttribute("data-delivery", "confirmed");
  await expect(row).toHaveAttribute("data-message-group-start", "true");
  const quote = replyQuote(page, answer);
  await expect(quote).toContainText(`${peer.nickname}${question}`);
  const quoteBox = await quote.boundingBox();
  const timeBox = await row.locator("time").boundingBox();
  if (quoteBox === null || timeBox === null)
    throw new Error("the reply's quote or time is not rendered");
  expect(quoteBox.y + quoteBox.height).toBeLessThanOrEqual(timeBox.y);

  await waitForReadDwell(irc, irc.channel, serverTime(sent));
  await expectSettled(page, { conversation: irc.channel });
  await nativeFeelAudit(page);
});

test("cancels a phone reply with the bar's ×", async ({ page, irc }) => {
  const peer = await irc.peer("reply-cancel");
  await openChat(page, irc);
  const question = "anyone seen the relay logs?";
  await peer.privmsgConfirmed(irc.channel, question);

  const sheet = await longPressMessage(
    page,
    productionMessageRow(page, question),
    peer.nickname,
  );
  await tap(page, sheet.getByRole("button", { name: "Reply" }));
  await expect(replyBar(page)).toBeVisible();
  await tap(page, page.getByRole("button", { name: "Cancel reply" }));

  await expect(replyBar(page)).toHaveCount(0);
  await expect(composer(page)).toHaveAttribute(
    "placeholder",
    `Message ${irc.channel}`,
  );
});

async function openChat(page: Page, irc: IrcTestAccount): Promise<void> {
  await page.goto(irc.url({ path: `/Local%20Ergo/${irc.channel.slice(1)}` }));
  await expectSettled(page, { conversation: irc.channel });
}
