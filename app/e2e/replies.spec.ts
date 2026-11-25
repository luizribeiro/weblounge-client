import { messageId, serverTime } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import {
  composer,
  conversationButton,
  openConversation,
  waitForReadDwell,
} from "./redaction";
import {
  expectThreadedReply,
  messageRowOf,
  replyBar,
  replyQuote,
  sendBacklog,
} from "./replies";

test.describe("message replies on desktop against local Ergo", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("replies from the row toolbar, cancels with Escape, and threads the send", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expect(conversationButton(page, irc.channel)).toBeVisible();
    const peer = await irc.peer("reply-toolbar");
    await openConversation(page, irc.channel);
    const question = "does the relay see plaintext?";
    const asked = await peer.privmsgConfirmed(irc.channel, question);
    // The question arms the 500ms read dwell, which must finish before the idle audit; Ergo moves
    // the marker on your own send, so only the question's time proves the dwell ran.
    await waitForReadDwell(irc, irc.channel, serverTime(asked));
    const parent = productionMessageRow(page, question);
    const reply = page.getByRole("button", { name: "Reply", exact: true });

    await parent.hover();
    await reply.click();
    await expect(replyBar(page)).toContainText(
      `Replying to ${peer.nickname} ${question}`,
    );
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveAttribute(
      "placeholder",
      `Reply to ${peer.nickname}`,
    );
    await expect(parent.locator("xpath=..")).toHaveAttribute(
      "data-reply-target",
      "true",
    );
    await composer(page).press("Escape");
    await expect(replyBar(page)).toHaveCount(0);

    await parent.hover();
    await reply.click();
    const answer = "only ciphertext, it forwards to APNs";
    await composer(page).fill(answer);
    await composer(page).press("Enter");

    const sent = await expectThreadedReply(
      peer,
      irc.channel,
      `${peer.nickname}: `,
      answer,
      irc.account,
      messageId(asked),
    );
    await expect(replyBar(page)).toHaveCount(0);
    const quote = replyQuote(page, answer);
    await expect(quote).toHaveAttribute("data-reply-quote", "loaded");
    await expect(quote).toContainText(`${peer.nickname}${question}`);
    await expect(productionMessageRow(page, answer)).toHaveAttribute(
      "data-delivery",
      "confirmed",
    );
    await waitForReadDwell(irc, irc.channel, serverTime(sent));
    await page.mouse.move(0, 0);
    await nativeFeelAudit(page);
  });

  test("quotes a peer's reply to you and jumps to the parent", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expect(conversationButton(page, irc.channel)).toBeVisible();
    const peer = await irc.peer("reply-jump");
    await openConversation(page, irc.channel);
    const question = "should the badge count DMs only?";
    await composer(page).fill(question);
    await composer(page).press("Enter");
    const asked = await peer.waitForPrivmsg(irc.channel, question, irc.account);
    await sendBacklog(irc, 60, "unrelated");
    const answer = "yes, channels only when mentioned";
    const replied = await peer.privmsgReplyConfirmed(
      irc.channel,
      `${irc.account}: ${answer}`,
      messageId(asked),
    );
    const parent = messageRowOf(page, question);
    const quote = replyQuote(page, answer);
    await expect(quote).toContainText(`${irc.account}${question}`);
    await expect(parent).not.toBeInViewport();
    await waitForReadDwell(irc, irc.channel, serverTime(replied));

    await quote.click();

    await expect(parent).toBeInViewport();
    const parentItem = parent.locator("xpath=..");
    await expect(parentItem).toHaveAttribute("data-flashed", "true");
    await expect(parentItem).not.toHaveAttribute("data-flashed");
    await nativeFeelAudit(page);
  });

  test("says so when a reply's parent is deleted", async ({ page, irc }) => {
    await page.goto(irc.url());
    await expect(conversationButton(page, irc.channel)).toBeVisible();
    const peer = await irc.peer("reply-deleted");
    await openConversation(page, irc.channel);
    const question = "wrong channel, ignore";
    const asked = await peer.privmsgConfirmed(irc.channel, question);
    const answer = "ignoring it";
    await peer.privmsgReplyConfirmed(
      irc.channel,
      `${peer.nickname}: ${answer}`,
      messageId(asked),
    );
    await expect(replyQuote(page, answer)).toHaveAttribute(
      "data-reply-quote",
      "loaded",
    );

    await peer.redactConfirmed(irc.channel, messageId(asked));

    const quote = replyQuote(page, answer);
    await expect(quote).toHaveAttribute("data-reply-quote", "deleted");
    await expect(quote).toHaveText("Original message deleted");
    await expect(page.getByRole("button", { name: /^Reply to / })).toHaveCount(
      0,
    );
  });

  test("fetches a parent older than the loaded history and quotes it", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("reply-fetched");
    const question = "who owns the APNs key rotation?";
    const asked = await peer.privmsgConfirmed(irc.channel, question);
    await sendBacklog(irc, 110, "backlog");
    const answer = "the relay does, every 90 days";
    await peer.privmsgReplyConfirmed(
      irc.channel,
      `${peer.nickname}: ${answer}`,
      messageId(asked),
    );

    await page.goto(irc.url());
    await expect(conversationButton(page, irc.channel)).toBeVisible();
    await openConversation(page, irc.channel);

    const quote = replyQuote(page, answer);
    await expect(quote).toHaveAttribute("data-reply-quote", "fetched");
    await expect(quote).toContainText(`${peer.nickname}${question}`);
    await expect(quote).toHaveRole("note");
    await expect(messageRowOf(page, question)).toHaveCount(0);
  });
});
