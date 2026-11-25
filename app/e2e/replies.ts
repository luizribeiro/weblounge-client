import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { waitForAnimations } from "./filehost-peer";
import { type IrcClient, messageId } from "./irc-client";
import type { IrcTestAccount } from "./irc-fixture";
import { productionMessageRow } from "./production-ergo";

export function replyBar(page: Page): Locator {
  return page.locator("[data-reply-bar]");
}

/** The row showing `text` as its own message, not as a reply's quote of it. */
export function messageRowOf(page: Page, text: string): Locator {
  return page.locator(`[data-message-row][data-message-text="${text}"]`);
}

export function replyQuote(page: Page, replyText: string): Locator {
  return productionMessageRow(page, replyText).locator("[data-reply-quote]");
}

/** Checks the peer received `text` threaded under `parentMsgid`, prefixed for plain clients. */
export async function expectThreadedReply(
  peer: IrcClient,
  target: string,
  prefix: string,
  text: string,
  sender: string,
  parentMsgid: string,
): Promise<string> {
  const line = await peer.waitForPrivmsg(target, `${prefix}${text}`, sender);
  expect(line).toContain(`+reply=${parentMsgid}`);
  return line;
}

const backlogWriterCount = 10;

/** Many writers share the lines, since Ergo's fakelag slows any one writer's burst. */
export async function sendBacklog(
  irc: IrcTestAccount,
  count: number,
  label: string,
): Promise<void> {
  const writers = await Promise.all(
    Array.from({ length: backlogWriterCount }, (_, index) =>
      irc.peer(`${label}-${index}`),
    ),
  );
  await Promise.all(
    writers.map(async (writer, writerIndex) => {
      for (let index = writerIndex; index < count; index += writers.length)
        await writer.privmsgConfirmed(irc.channel, `${label} ${index + 1}`);
    }),
  );
}

/** Saves a screenshot into screenshots/f27 when WEBLOUNGE_REPLY_SHOTS is set. */
export async function replyShot(page: Page, name: string): Promise<void> {
  if (process.env.WEBLOUNGE_REPLY_SHOTS === undefined) return;
  const directory = path.join(process.cwd(), "..", "screenshots", "f27");
  await mkdir(directory, { recursive: true });
  await waitForAnimations(page);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

export interface ReviewThread {
  readonly replierNick: string;
  readonly answer: string;
  readonly orphan: string;
}

/**
 * A reply whose parent loads and one whose parent is unavailable: Ergo drops a redacted line from
 * its history, so the app never learns that parent was deleted.
 */
export async function seedReviewThread(
  irc: IrcTestAccount,
): Promise<ReviewThread> {
  const ana = await irc.peer("ana");
  const bruno = await irc.peer("bruno");
  const asked = await ana.privmsgConfirmed(
    irc.channel,
    "does the relay ever see plaintext?",
  );
  const oops = await ana.privmsgConfirmed(irc.channel, "wrong window, sorry");
  const orphan = `${ana.nickname}: which window?`;
  await bruno.privmsgReplyConfirmed(irc.channel, orphan, messageId(oops));
  await ana.redactConfirmed(irc.channel, messageId(oops));
  const answer = "no, it only forwards ciphertext to APNs";
  await bruno.privmsgReplyConfirmed(
    irc.channel,
    `${ana.nickname}: ${answer}`,
    messageId(asked),
  );
  return { replierNick: bruno.nickname, answer, orphan };
}

export async function expectReviewQuotes(
  page: Page,
  thread: ReviewThread,
): Promise<void> {
  await expect(replyQuote(page, thread.answer)).toHaveAttribute(
    "data-reply-quote",
    "loaded",
  );
  // A reply to an unavailable parent keeps its "nick: " prefix, so only its full text finds it.
  await expect(
    messageRowOf(page, thread.orphan).locator("[data-reply-quote]"),
  ).toHaveAttribute("data-reply-quote", "unavailable");
}
