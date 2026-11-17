import type { BrowserContext, Page } from "@playwright/test";
import { captureHistoryWire, sentWireLines } from "./history-wire-fixture";
import { type IrcClient, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { scrollToTranscriptTop } from "./message-list-scroll";
import { useDedicatedWorker } from "./production-ergo";

test.describe("launch catch-up after another device read the conversation", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows every line sent while closed when another device read them all", async ({
    context,
    page,
    irc,
  }) => {
    const { me, bot } = await closedWithCachedRow(page, irc);
    const lines = ["missed 0", "missed 1", "missed 2"];
    let newest = "";
    for (const line of lines)
      newest = await bot.privmsgConfirmed(room(irc), line);
    await me.markRead(room(irc), justAfter(serverTime(newest)));

    const current = await relaunch(context, irc);
    await openRoom(current, irc);

    for (const line of ["before", ...lines])
      await expect(transcriptRow(current, line)).toHaveCount(1);
    await expect(
      current.locator("[data-message-list] [data-gap-row]"),
    ).toHaveCount(0);
  });

  test("pages back from a catch-up wider than its page to the line cached before closing", async ({
    context,
    page,
    irc,
  }) => {
    const { me, bot } = await closedWithCachedRow(page, irc);
    const writers = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        irc.peer(`many-${index}`, [room(irc)]),
      ),
    );
    await sendFromEach(writers, room(irc), 11);
    const newestText = "newest line";
    const newest = await bot.privmsgConfirmed(room(irc), newestText);
    await me.markRead(room(irc), serverTime(newest));

    const current = await relaunch(context, irc);
    await openRoom(current, irc);
    await expect(transcriptRow(current, newestText)).toHaveCount(1);
    const list = current.locator("[data-message-list]");

    await expect
      .poll(async () => {
        await scrollToTranscriptTop(list);
        return transcriptRow(current, "before").count();
      })
      .toBe(1);
    await expect(list.locator("[data-gap-row]")).toHaveCount(0);
  });
});

async function closedWithCachedRow(
  page: Page,
  irc: IrcTestAccount,
): Promise<{ me: IrcClient; bot: IrcClient }> {
  const me = await irc.self([room(irc)]);
  await me.setAlwaysOn(true);
  const bot = await irc.peer("bot", [room(irc)]);
  await useDedicatedWorker(page);
  await page.goto(irc.url());
  await bot.privmsgConfirmed(room(irc), "before");
  await openRoom(page, irc);
  await expect(transcriptRow(page, "before")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to chats" }).click();
  await expect(chatRow(page, room(irc))).toContainText("before");
  await page.close();
  return { me, bot };
}

async function relaunch(
  context: BrowserContext,
  irc: IrcTestAccount,
): Promise<Page> {
  const page = await context.newPage();
  await captureHistoryWire(page);
  await page.goto(irc.url());
  await expect.poll(() => catchUpRequest(page, room(irc))).not.toBeUndefined();
  return page;
}

async function openRoom(page: Page, irc: IrcTestAccount): Promise<void> {
  await chatRow(page, room(irc)).click();
  await expect(page.getByRole("heading", { name: room(irc) })).toBeVisible();
}

async function sendFromEach(
  writers: readonly IrcClient[],
  channel: string,
  count: number,
): Promise<void> {
  await Promise.all(
    writers.map(async (writer, writerIndex) => {
      const lines = Array.from(
        { length: count },
        (_, index) => `line ${writerIndex}-${index}`,
      );
      for (const line of lines) await writer.privmsgConfirmed(channel, line);
    }),
  );
}

/** The URL's own channel loads its newest page at launch, so the catch-up runs on another. */
function room(irc: IrcTestAccount): string {
  return irc.channelNamed("read-elsewhere");
}

function justAfter(time: string): string {
  return new Date(Date.parse(time) + 1).toISOString();
}

/** Opening the room first would load its newest page instead of the launch catch-up. */
async function catchUpRequest(
  page: Page,
  target: string,
): Promise<string | undefined> {
  const sent = await sentWireLines(page);
  return sent.find(
    (entry) =>
      entry.line.includes(` CHATHISTORY LATEST ${target} `) &&
      !entry.line.includes(` ${target} * `),
  )?.line;
}

function chatRow(page: Page, name: string) {
  return page.locator(`[data-buffer-id][aria-label^="${name}"]`).first();
}

function transcriptRow(page: Page, text: string) {
  return page.locator(
    `[data-message-row][data-message-text=${JSON.stringify(text)}]`,
  );
}
