import type { Page } from "@playwright/test";
import { serverTime } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  scrollAwayFromLiveEdge,
  scrollToTranscriptTop,
} from "./message-list-scroll";
import { useDedicatedWorker } from "./production-ergo";
import { expectSettled } from "./settled";
import { armMessageTime } from "./time-rewrite";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("counts only new peer suffix rows across history, own send, and catch-up", async ({
  page,
  irc,
}) => {
  const suffix = irc.id;
  const account = irc.account;
  const channel = irc.channel;
  const keeper = await irc.self([channel]);
  await keeper.setAlwaysOn(true);
  keeper.close();
  await keeper.waitForDisconnect();
  const bots = await Promise.all(
    Array.from({ length: 9 }, (_, index) => irc.peer(`jump-${index}`)),
  );
  const seeded = Array.from(
    { length: 106 },
    (_, index) => `jump seed ${suffix} ${index} ${"wrapped ".repeat(8)}`,
  );
  const oldest = seeded[0];
  const firstBot = bots[0];
  if (oldest === undefined || firstBot === undefined)
    throw new Error("oldest jump seed is missing");
  const oldestEcho = await firstBot.privmsgConfirmed(channel, oldest);
  await armMessageTime(oldest, Date.parse(serverTime(oldestEcho)) - 1_000);
  const bulkSeeded = seeded.slice(1);
  const finalEchoes: Promise<string>[] = [];
  for (const [index, text] of bulkSeeded.entries()) {
    const bot = bots[index % bots.length];
    if (bot === undefined) throw new Error("jump bot is missing");
    if (index >= bulkSeeded.length - bots.length)
      finalEchoes.push(bot.privmsgConfirmed(channel, text));
    else bot.privmsg(channel, text);
  }
  await Promise.all(finalEchoes);
  const seedFence = `jump seed fence ${suffix}`;
  await firstBot.privmsgConfirmed(channel, seedFence);
  await useDedicatedWorker(page);
  await page.goto(irc.url());
  await page.getByRole("button", { name: channel }).click();
  await expect(messageRow(page, seedFence)).toBeVisible();
  await expectSettled(page, { conversation: channel });
  const list = page.locator("[data-message-list]");
  await expect
    .poll(async () => {
      await scrollToTranscriptTop(list);
      return messageRow(page, oldest).count();
    })
    .toBe(1);
  await expect(jumpButton(page)).toHaveCount(0);

  await list.press("End");
  await expect(messageRow(page, seedFence)).toBeVisible();
  await scrollAwayFromLiveEdge(page, list, { distance: 100 });
  const own = `jump own ${suffix}`;
  const composer = page.getByRole("textbox", { name: "Message" });
  const ownSeen = bots[0]?.waitForPrivmsg(channel, own, account);
  if (ownSeen === undefined) throw new Error("jump observer is missing");
  await composer.fill(own);
  await composer.press("Enter");
  await ownSeen;
  await expect(jumpButton(page)).toHaveCount(0);

  const catchUp = [
    `jump catch-up one ${suffix}`,
    `jump catch-up two ${suffix}`,
  ];
  await irc.forwarder.dropIncomingContaining(
    catchUp[0] ?? "missing catch-up row",
  );
  await bots[0]?.privmsgConfirmed(
    channel,
    catchUp[0] ?? "missing catch-up row",
  );
  await expect.poll(() => networkState(page)).not.toBe("online");
  await bots[1]?.privmsgConfirmed(
    channel,
    catchUp[1] ?? "missing catch-up row",
  );
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "2 new messages" }),
  ).toBeVisible();
});

function messageRow(page: Page, text: string) {
  return page.locator("[data-message-row]").filter({
    has: page.getByText(text, { exact: true }),
  });
}

function networkState(page: Page) {
  return page
    .locator("[data-network-state]")
    .first()
    .getAttribute("data-network-state");
}

function jumpButton(page: Page) {
  return page.getByRole("button", { name: /new messages?/u });
}
