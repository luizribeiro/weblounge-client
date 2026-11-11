import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  scrollAwayFromLiveEdge,
  scrollToTranscriptTop,
} from "./message-list-scroll";
import { useDedicatedWorker } from "./production-ergo";
import { armMessageTime } from "./time-rewrite";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("counts only new peer suffix rows across history, own send, and catch-up", async ({
  baseURL,
  page,
}) => {
  const suffix = Date.now().toString(36);
  const account = `jump-own-${suffix}`;
  const channel = `#jump-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  await keeper.setAlwaysOn(true);
  keeper.close();
  await keeper.waitForDisconnect();
  const bots = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      IrcClient.connectIsolated(`jump-${index}-${suffix}`, channel),
    ),
  );
  const seeded = Array.from(
    { length: 106 },
    (_, index) => `jump seed ${suffix} ${index} ${"wrapped ".repeat(8)}`,
  );
  try {
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
    await useDedicatedWorker(page);
    await page.goto(accountUrl(baseURL, account, channel));
    await page.getByRole("button", { name: channel }).click();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    const list = page.locator("[data-message-list]");
    await expect
      .poll(async () => {
        await scrollToTranscriptTop(list);
        return messageRow(page, oldest).count();
      })
      .toBe(1);
    await expect(jumpButton(page)).toHaveCount(0);

    await list.press("End");
    await expect(
      messageRow(page, seeded.at(-1) ?? "missing newest"),
    ).toBeVisible();
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
    await dropIncomingContaining(catchUp[0] ?? "missing catch-up row");
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
  } finally {
    for (const bot of bots) bot.close();
  }
});

function messageRow(page: Page, text: string) {
  return page.locator("[data-message-row]").filter({
    has: page.getByText(text, { exact: true }),
  });
}

function accountUrl(
  baseURL: string | undefined,
  account: string,
  channel: string,
) {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const url = new URL("/", baseURL);
  url.searchParams.set("irc-password", `test-${account}`);
  url.searchParams.set("irc-account", account);
  url.searchParams.set("irc-nickname", account);
  url.searchParams.append("irc-autojoin", channel);
  return url.href;
}

function networkState(page: Page) {
  return page
    .locator("[data-network-state]")
    .first()
    .getAttribute("data-network-state");
}

function serverTime(line: string): string {
  const value = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
  if (value === undefined)
    throw new Error(`message has no server time: ${line}`);
  return value;
}

function jumpButton(page: Page) {
  return page.getByRole("button", { name: /new messages?/u });
}

async function dropIncomingContaining(text: string) {
  const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
  if (base === undefined) throw new Error("socket forwarder is unavailable");
  const endpoint = new URL("/drop-incoming", base);
  endpoint.searchParams.set("contains", text);
  const response = await fetch(endpoint, { method: "POST" });
  if (!response.ok) throw new Error("socket forwarder incoming drop failed");
}
