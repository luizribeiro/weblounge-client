import { expect, type Page } from "@playwright/test";
import { messageId, serverTime } from "./irc-client";
import type { IrcTestAccount } from "./irc-fixture";
import { armMessageTime } from "./time-rewrite";

export interface MixedConversation {
  readonly channel: string;
  readonly continuation: string;
  readonly groupStart: string;
  readonly highlightContinuation: string;
  readonly highlightStart: string;
  readonly newSender: string;
  readonly own: string;
  readonly reacted: string;
  readonly startUrl: string;
  readonly systemFence: string;
  readonly unreadMessage: string;
  readonly wrappedLink: string;
  readonly sendUnread: (page: Page) => Promise<void>;
}

export async function seedMixedConversation(
  irc: IrcTestAccount,
): Promise<MixedConversation> {
  const account = irc.account;
  const suffix = account;
  const channel = irc.channelNamed("sa-mixed");
  const startUrl = irc.url({ autojoin: [channel] });
  const first = await irc.peer("sa-first", [channel]);
  const clockLine = await first.privmsgConfirmed(
    first.nickname,
    `spacing clock ${suffix}`,
  );
  const clock = new Date(serverTime(clockLine));
  const baseTime = new Date(
    clock.getFullYear(),
    clock.getMonth(),
    clock.getDate() - 1,
    12,
  ).getTime();
  let nextTime = baseTime;
  const armNextRow = async (text: string) => {
    await armMessageTime(text, nextTime);
    nextTime += 1_000;
  };
  const beforeJoin = `message before join ${suffix}`;
  await armNextRow(beforeJoin);
  await first.privmsgConfirmed(channel, beforeJoin);
  const second = await irc.peer("sa-second", [channel]);
  const afterJoin = `message after join ${suffix}`;
  await armNextRow(afterJoin);
  await second.privmsgConfirmed(channel, afterJoin);
  const marker = await irc.self([channel]);
  const own = `own confirmed row ${suffix}`;
  await armNextRow(own);
  const ownLine = await marker.privmsgConfirmed(channel, own);
  await marker.markRead(channel, serverTime(ownLine));

  const groupStart = `group start ${suffix}`;
  const continuation = `same group continuation ${suffix}`;
  const newSender = `new sender ${suffix}`;
  const reacted = `reaction row ${suffix}`;
  const wrappedLink = `wrapped link https://example.com/${"spacing/".repeat(12)}${suffix}`;
  const highlightStart = `highlight group ${account} ${suffix}`;
  const highlightContinuation = `highlight continuation ${account} ${suffix}`;
  const systemFence = `after notice ${suffix}`;
  const unreadMessage = `new divider message ${suffix}`;
  const timed = [
    [first, groupStart],
    [first, continuation],
    [second, newSender],
    [second, reacted],
    [first, wrappedLink],
    [first, highlightStart],
    [first, highlightContinuation],
  ] as const;
  const echoes: string[] = [];
  for (const [client, text] of timed) {
    await armNextRow(text);
    echoes.push(await client.privmsgConfirmed(channel, text));
  }
  await second.reactionConfirmed(channel, messageId(echoes[3] ?? ""), "👍");
  await armNextRow(systemFence);
  await first.privmsgConfirmed(channel, systemFence);
  marker.close();
  await marker.waitForDisconnect();
  return {
    channel,
    continuation,
    groupStart,
    highlightContinuation,
    highlightStart,
    newSender,
    own,
    reacted,
    startUrl,
    systemFence,
    unreadMessage,
    wrappedLink,
    sendUnread: async (page) => {
      await first.privmsgConfirmed(channel, unreadMessage);
      await expect
        .poll(() => bufferUnreadCount(page, channel))
        .toBeGreaterThan(0);
    },
  };
}

function bufferUnreadCount(page: Page, title: string): Promise<number> {
  return page
    .locator("[data-buffer-id]")
    .filter({ hasText: title })
    .evaluate((row) => {
      const desktopCount = row.getAttribute("data-unread");
      if (desktopCount !== null) return Number(desktopCount);
      return Number(row.querySelector('[role="status"]')?.textContent ?? 0);
    });
}
