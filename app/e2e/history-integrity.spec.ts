import type { BrowserContext, Page } from "@playwright/test";
import { seedPushedMessage } from "./engine-database";
import {
  chatRow,
  expectChatRowMatchesServer,
  expectHistoryPageReceived,
  expectTranscriptMatchesServer,
  historyPagesReceived,
} from "./history-integrity";
import {
  captureHistoryWire,
  heldHistoryRequestCount,
} from "./history-wire-fixture";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { isPhoneViewport } from "./mobile-platform";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import {
  closeAppUntilDetached,
  dispatchPersistedPageShow,
  setPageHidden,
} from "./page-lifecycle";
import { expectSettled } from "./settled";
import { closeFromSidebar, openFromSwitcher } from "./sidebar-rows";

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

  test("a relaunch after more lines than one catch-up page shows them all", async ({
    context,
    page,
    irc,
  }) => {
    const { keeper, channel, peer } = await alwaysOnRoom(irc, "long");
    const app = await launch(page, irc, [channel]);
    await peer.privmsgConfirmed(channel, `before the long absence ${irc.id}`);
    await expect(chatRow(app, channel)).toBeVisible();
    await closeAppUntilDetached(app, keeper);

    await sendFromMany(irc, channel, longerThanOnePage);

    await expectBuffersMatchServer(
      await relaunch(context, irc, [channel], [channel]),
      irc,
      [channel],
    );
  });

  test("an open app offline for more than one catch-up page shows every line", async ({
    page,
    irc,
  }) => {
    // B20: the reconnect catch-up leaves a "Messages may be missing" gap between the lines
    // already loaded and its newest page, and nothing ever fills it.
    test.fail();
    const { keeper, channel, peer } = await alwaysOnRoom(irc, "away");
    const app = await launch(page, irc, [channel]);
    await sendEach(peer, [channel], 3, `before going offline ${irc.id}`);
    await openConversation(app, channel);
    await expectTranscriptMatchesServer(app, keeper, channel);
    await leaveConversation(app, channel);

    const pagesBefore = await historyPagesReceived(app, channel);
    await irc.forwarder.drop();
    await expect.poll(() => keeper.attachedClientCount()).toBe(1);
    await sendFromMany(irc, channel, longerThanOnePage);
    await irc.forwarder.restore();
    await reconnectNow(app, keeper);
    await expectHistoryPageReceived(app, channel, pagesBefore);

    await expectBuffersMatchServer(app, irc, [channel]);
  });

  for (const interruption of ["unsent", "unanswered"] as const)
    test(`a launch catch-up cut off while ${interruption} still shows every line`, async ({
      context,
      page,
      irc,
    }) => {
      const { keeper, channel, peer } = await alwaysOnRoom(irc, "cut");
      const app = await launch(page, irc, [channel]);
      await peer.privmsgConfirmed(channel, `before closing ${irc.id}`);
      await expect(chatRow(app, channel)).toBeVisible();
      await closeAppUntilDetached(app, keeper);
      await sendEach(peer, [channel], 3, `while closed ${irc.id}`);

      const relaunched = await relaunchCutOff(
        context,
        irc,
        channel,
        keeper,
        interruption,
      );
      await sendEach(peer, [channel], 3, `while cut off ${irc.id}`);
      await irc.forwarder.restore();
      await reconnectNow(relaunched, keeper);

      await expectHistoryPageReceived(relaunched, channel);
      await expectBuffersMatchServer(relaunched, irc, [channel]);
    });

  test("busy channels and DMs while the app is hidden show every line", async ({
    page,
    irc,
  }) => {
    const channels = ["busy-a", "busy-b", "busy-c"].map(irc.channelNamed);
    const keeper = await irc.self(channels);
    await keeper.setAlwaysOn(true);
    const writers = await Promise.all(
      ["bw0", "bw1", "bw2", "bw3"].map((label) => irc.peer(label, channels)),
    );
    const app = await launch(page, irc, channels);
    await setPageHidden(app, true);
    await Promise.all(
      writers.map((writer, index) =>
        sendEach(
          writer,
          [...channels, irc.account],
          2,
          `hidden ${index} ${irc.id}`,
        ),
      ),
    );
    await setPageHidden(app, false);

    await expectBuffersMatchServer(app, irc, [
      ...channels,
      ...writers.map((writer) => writer.nickname),
    ]);
  });

  test("a DM opened from the switcher after a live line shows its history", async ({
    page,
    irc,
  }) => {
    test.skip(isPhoneViewport(page), "the switcher is a desktop keyboard path");
    const { keeper, peer } = await alwaysOnRoom(irc, "switch");
    const app = await launch(page, irc, []);
    await sendEach(peer, [irc.account], 3, `earlier direct ${irc.id}`);
    await openConversation(app, peer.nickname);
    await expectTranscriptMatchesServer(app, keeper, peer.nickname);
    await closeFromSidebar(app, chatRow(app, peer.nickname), peer.nickname);
    await app.goto(irc.url({ path: homePath(app, irc) }));
    await expect(chatRow(app, irc.channel)).toBeVisible();

    await peer.privmsgConfirmed(irc.account, `live direct ${irc.id}`);
    await expect(chatRow(app, peer.nickname)).toBeVisible();
    await expectChatRowMatchesServer(app, keeper, peer.nickname, irc.account);
    await openFromSwitcher(app, peer.nickname);
    await expectSettled(app, { conversation: peer.nickname });
    await expectTranscriptMatchesServer(app, keeper, peer.nickname);
  });

  test("own lines queued while offline show once, in order, after reconnecting", async ({
    context,
    page,
    irc,
  }) => {
    const { keeper, channel, peer } = await alwaysOnRoom(irc, "queued");
    const app = await launch(page, irc, [channel]);
    await peer.privmsgConfirmed(channel, `before offline ${irc.id}`);
    await openConversation(app, channel);
    // Chromium's offline emulation drops frames on a socket it leaves open, which a real network
    // never does, so the socket is cut as well.
    await context.setOffline(true);
    await irc.forwarder.drop();
    await expect.poll(() => keeper.attachedClientCount()).toBe(1);
    await expectAppOffline(app);
    for (let index = 0; index < 3; index += 1)
      await sendFromComposer(app, channel, `queued ${index} ${irc.id}`);
    await peer.privmsgConfirmed(channel, `while offline ${irc.id}`);
    await irc.forwarder.restore();
    await context.setOffline(false);
    await reconnectNow(app, keeper);
    await expect(
      app.locator('[data-message-row][data-delivery="optimistic"]'),
    ).toHaveCount(0);

    await expectTranscriptMatchesServer(app, keeper, channel);
    await leaveConversation(app, channel);
    await expectChatRowMatchesServer(app, keeper, channel, irc.account);
  });

  test("deletions and reactions leave the transcript matching the server", async ({
    context,
    page,
    irc,
  }) => {
    const { keeper, channel, peer } = await alwaysOnRoom(irc, "edits");
    const app = await launch(page, irc, [channel]);
    const seen = await sendEach(
      peer,
      [channel, irc.account],
      3,
      `seen ${irc.id}`,
    );
    await expect(chatRow(app, peer.nickname)).toBeVisible();
    await changeLines(peer, seen);
    await expect(app.locator("[data-redacted]")).toHaveCount(0);
    await closeAppUntilDetached(app, keeper);

    const unseen = await sendEach(
      peer,
      [channel, irc.account],
      3,
      `unseen ${irc.id}`,
    );
    await changeLines(peer, unseen);

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

type WireOptions = Parameters<typeof captureHistoryWire>[1];

async function launch(
  page: Page,
  irc: IrcTestAccount,
  channels: readonly string[],
  wire: WireOptions = {},
): Promise<Page> {
  await captureHistoryWire(page, wire);
  await installNativeFeelInstrumentation(page);
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
  const page = await openRelaunched(context, irc, channels);
  for (const target of caughtUp) await expectHistoryPageReceived(page, target);
  return page;
}

async function openRelaunched(
  context: BrowserContext,
  irc: IrcTestAccount,
  channels: readonly string[],
  wire: WireOptions = {},
): Promise<Page> {
  return launch(await context.newPage(), irc, channels, wire);
}

/**
 * Relaunches the app and cuts its connection during the channel's launch catch-up: before the
 * request goes out ("unsent") or as its reply starts to arrive ("unanswered").
 */
async function relaunchCutOff(
  context: BrowserContext,
  irc: IrcTestAccount,
  channel: string,
  sameAccount: IrcClient,
  interruption: "unanswered" | "unsent",
): Promise<Page> {
  const attached = await sameAccount.attachedClientCount();
  if (interruption === "unanswered")
    await irc.forwarder.dropIncomingContaining(` chathistory ${channel}`);
  const page = await openRelaunched(
    context,
    irc,
    [channel],
    interruption === "unsent"
      ? { holdRequest: `CHATHISTORY LATEST ${channel} ` }
      : {},
  );
  if (interruption === "unsent") {
    await expect.poll(() => heldHistoryRequestCount(page)).toBe(1);
    await expect
      .poll(() => sameAccount.attachedClientCount())
      .toBe(attached + 1);
  }
  await irc.forwarder.drop();
  await expect.poll(() => sameAccount.attachedClientCount()).toBe(attached);
  return page;
}

/**
 * Waits for the app to know the device is offline: only then does it queue a line instead of
 * sending it on the dead socket, where its fate is unknown and it fails by design.
 */
async function expectAppOffline(page: Page): Promise<void> {
  await expect(page.locator("[data-network-state]").first()).toBeAttached();
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(0);
}

/** Returning to the foreground probes the connection instead of waiting out the backoff. */
async function reconnectNow(page: Page, sameAccount: IrcClient): Promise<void> {
  const attached = await sameAccount.attachedClientCount();
  await setPageHidden(page, true);
  await setPageHidden(page, false);
  await dispatchPersistedPageShow(page);
  await expect.poll(() => sameAccount.attachedClientCount()).toBe(attached + 1);
}

const longerThanOnePage = 128;
const writerCount = 16;

/** Many writers share the lines, since Ergo's fakelag slows any one writer's burst. */
async function sendFromMany(
  irc: IrcTestAccount,
  channel: string,
  total: number,
): Promise<void> {
  const writers = await Promise.all(
    Array.from({ length: writerCount }, (_, index) =>
      irc.peer(`w${index}`, [channel]),
    ),
  );
  await Promise.all(
    writers.map((writer, writerIndex) =>
      sendEach(
        writer,
        [channel],
        Math.ceil(total / writerCount),
        `writer ${writerIndex} ${irc.id}`,
      ),
    ),
  );
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

/** Reacts to the first line sent to each target and deletes the second. */
async function changeLines(
  sender: IrcClient,
  lines: readonly SentLine[],
): Promise<void> {
  for (const target of new Set(lines.map((line) => line.target))) {
    const [reacted, deleted] = lines.filter((line) => line.target === target);
    if (reacted === undefined || deleted === undefined)
      throw new Error(`two lines to ${target} are needed`);
    await sender.reactionConfirmed(target, messageId(reacted.line), "👍");
    await sender.redactConfirmed(target, messageId(deleted.line));
  }
}

async function sendFromComposer(
  page: Page,
  title: string,
  text: string,
): Promise<void> {
  const composer = page.getByRole("textbox", { name: `Message ${title}` });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(
    page.locator("[data-message-row]").filter({ hasText: text }),
  ).toHaveCount(1);
}
