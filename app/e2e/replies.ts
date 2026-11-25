import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
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
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}
