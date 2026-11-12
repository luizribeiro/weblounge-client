import { IrcClient } from "./irc-client";
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
  readonly close: () => void;
  readonly sendUnread: () => Promise<void>;
}

export async function seedMixedConversation(
  project: string,
): Promise<MixedConversation> {
  const suffix = `${project.slice(0, 2)}${Date.now().toString(36).slice(-6)}`;
  const account = `sauser${suffix}`;
  const channel = `#sa-mixed-${suffix}`;
  const startUrl = await isolatedStartUrl(account, channel);
  const first = await IrcClient.connect(
    `sa-first-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const clockLine = await first.privmsgConfirmed(
    `sa-first-${suffix}`,
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
  const second = await IrcClient.connect(
    `sa-second-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const afterJoin = `message after join ${suffix}`;
  await armNextRow(afterJoin);
  await second.privmsgConfirmed(channel, afterJoin);
  const marker = await IrcClient.connect(
    account,
    account,
    `test-${account}`,
    channel,
  );
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
    sendUnread: async () => {
      await first.privmsgConfirmed(channel, unreadMessage);
    },
    close: () => {
      second.close();
      first.close();
    },
  };
}

async function isolatedStartUrl(
  account: string,
  channel: string,
): Promise<string> {
  const seed = await IrcClient.connectIsolated(account, channel);
  seed.close();
  await seed.waitForDisconnect();
  const params = new URLSearchParams({
    "irc-account": account,
    "irc-nickname": account,
    "irc-password": `test-${account}`,
    "irc-autojoin": channel,
  });
  return `/?${params.toString()}`;
}

function messageId(line: string): string {
  const id = /(?:^@|;)msgid=([^; ]+)/u.exec(line)?.[1];
  if (id === undefined) throw new Error(`message has no msgid: ${line}`);
  return id;
}

function serverTime(line: string): string {
  const value = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
  if (value === undefined)
    throw new Error(`message has no server time: ${line}`);
  return value;
}
