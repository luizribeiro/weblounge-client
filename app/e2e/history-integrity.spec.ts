import type { BrowserContext, Page } from "@playwright/test";
import { seedPushedMessage } from "./engine-database";
import {
  chatRow,
  expectChatRowMatchesServer,
  expectHistoryPageReceived,
  expectTranscriptMatchesServer,
} from "./history-integrity";
import { captureHistoryWire } from "./history-wire-fixture";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { isPhoneViewport } from "./mobile-platform";
import { closeAppUntilDetached } from "./page-lifecycle";
import { useDedicatedWorker } from "./production-ergo";
import { expectSettled } from "./settled";

test.describe("history integrity against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  for (const readUpTo of ["some", "every"] as const)
    test(`a relaunch after another device read ${readUpTo} new line shows them all`, async ({
      context,
      page,
      irc,
    }) => {
      const { keeper, channel, peer } = await alwaysOnRoom(irc, "ahead");
      const app = await launch(page, irc, [channel]);
      await peer.privmsgConfirmed(channel, `seen by both ${irc.id}`);
      await expect(chatRow(app, channel)).toBeVisible();
      await closeAppUntilDetached(app, keeper);

      const lines: string[] = [];
      for (let index = 0; index < 5; index += 1)
        lines.push(
          await peer.privmsgConfirmed(
            channel,
            `while closed ${index} ${irc.id}`,
          ),
        );
      const read = readUpTo === "every" ? lines.at(-1) : lines[2];
      await keeper.markRead(channel, justAfter(serverTime(read ?? "")));

      await expectBuffersMatchServer(
        await relaunch(context, irc, [channel], [channel]),
        irc,
        [channel],
      );
    });

  for (const delivery of ["fetched", "pushed"] as const)
    test(`a relaunch from the cache shows lines ${delivery} while closed`, async ({
      context,
      page,
      irc,
    }) => {
      const { keeper, channel, peer } = await alwaysOnRoom(irc, "closed");
      const app = await launch(page, irc, [channel]);
      await peer.privmsgConfirmed(channel, `before closing ${irc.id}`);
      await peer.privmsgConfirmed(irc.account, `direct before ${irc.id}`);
      await expect(chatRow(app, peer.nickname)).toBeVisible();
      await closeAppUntilDetached(app, keeper);

      const arrived = await sendEach(
        peer,
        [channel, irc.account],
        3,
        `closed ${irc.id}`,
      );
      if (delivery === "pushed")
        await drainPushes(await context.newPage(), irc, peer, arrived);

      await expectBuffersMatchServer(
        await relaunch(context, irc, [channel], [channel, peer.nickname]),
        irc,
        [channel, peer.nickname],
      );
    });
});

interface SentLine {
  readonly target: string;
  readonly text: string;
  readonly line: string;
}

/** Sends `count` confirmed lines to each target in turn. */
async function sendEach(
  sender: IrcClient,
  targets: readonly string[],
  count: number,
  label: string,
): Promise<SentLine[]> {
  const sent: SentLine[] = [];
  for (let index = 0; index < count; index += 1)
    for (const target of targets) {
      const text = `${label} ${index} to ${target}`;
      sent.push({
        target,
        text,
        line: await sender.privmsgConfirmed(target, text),
      });
    }
  return sent;
}

/** Stores lines the way the push worker drains them while the app is closed. */
async function drainPushes(
  page: Page,
  irc: IrcTestAccount,
  sender: IrcClient,
  lines: readonly SentLine[],
): Promise<void> {
  try {
    // Any same-origin page reaches the engine's database without starting the app.
    await page.goto("/config.json");
    for (const { target, text, line } of lines)
      await seedPushedMessage(page, {
        nickname: irc.account,
        sender: sender.nickname,
        target,
        text,
        msgid: messageId(line),
        time: serverTime(line),
      });
  } finally {
    await page.close();
  }
}

interface Room {
  readonly keeper: IrcClient;
  readonly channel: string;
  readonly peer: IrcClient;
}

async function alwaysOnRoom(irc: IrcTestAccount, label: string): Promise<Room> {
  const channel = irc.channelNamed(label);
  const keeper = await irc.self([channel]);
  await keeper.setAlwaysOn(true);
  const peer = await irc.peer(`${label}-p`, [channel]);
  return { keeper, channel, peer };
}

async function launch(
  page: Page,
  irc: IrcTestAccount,
  channels: readonly string[],
): Promise<Page> {
  await useDedicatedWorker(page);
  await page.goto(irc.url({ autojoin: channels, path: homePath(page, irc) }));
  await expect(chatRow(page, irc.channel)).toBeVisible();
  return page;
}

// The desktop opens on the account's home channel so that no scenario buffer is read on launch;
// the phone opens on its chat list.
function homePath(page: Page, irc: IrcTestAccount): string {
  return isPhoneViewport(page) ? "/" : `/Local%20Ergo/${irc.channel.slice(1)}`;
}

/** Relaunches the app and waits for the launch catch-up pages of `caughtUp` to arrive. */
async function relaunch(
  context: BrowserContext,
  irc: IrcTestAccount,
  channels: readonly string[],
  caughtUp: readonly string[],
): Promise<Page> {
  const page = await context.newPage();
  await captureHistoryWire(page);
  await launch(page, irc, channels);
  for (const target of caughtUp) await expectHistoryPageReceived(page, target);
  return page;
}

function justAfter(time: string): string {
  return new Date(Date.parse(time) + 1).toISOString();
}

async function expectBuffersMatchServer(
  page: Page,
  irc: IrcTestAccount,
  titles: readonly string[],
): Promise<void> {
  const truth = await irc.self();
  for (const title of titles)
    await expectChatRowMatchesServer(page, truth, title, irc.account);
  for (const title of titles) {
    await openConversation(page, title);
    await expectTranscriptMatchesServer(page, truth, title);
    await leaveConversation(page, title);
  }
}

async function openConversation(page: Page, title: string): Promise<void> {
  await chatRow(page, title).click();
  await expectSettled(page, { conversation: title });
}

async function leaveConversation(page: Page, title: string): Promise<void> {
  if (!isPhoneViewport(page)) return;
  await expectSettled(page, { conversation: title });
  await page.getByRole("button", { name: "Back to chats" }).click();
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
}
