import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
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
  expect(line).toContain(`+draft/reply=${parentMsgid}`);
  return line;
}

export async function sendLines(
  peer: IrcClient,
  target: string,
  count: number,
  label: string,
): Promise<string> {
  let last = "";
  for (let index = 1; index <= count; index += 1)
    last = await peer.privmsgConfirmed(target, `${label} ${index}`);
  return last;
}

/** Saves a screenshot into screenshots/f27 when WEBLOUNGE_REPLY_SHOTS is set. */
export async function replyShot(page: Page, name: string): Promise<void> {
  if (process.env.WEBLOUNGE_REPLY_SHOTS === undefined) return;
  const directory = path.join(process.cwd(), "..", "screenshots", "f27");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}
