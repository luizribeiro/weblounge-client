import type { Locator, Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, test } from "./irc-fixture";
import { useDedicatedWorker } from "./production-ergo";

const trafficIntervalMilliseconds = 250;

test.describe("busy bot channel read state", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("clears and persists unread while bot traffic continues", async ({
    page,
    irc,
  }, testInfo) => {
    const channel = irc.channelNamed("bots");
    const mobile = testInfo.project.name === "webkit-mobile-bots-unread";
    const bots = await Promise.all(
      ["louro", "iris", "louro-pi", "relay"].map((name) =>
        irc.peer(name, [channel]),
      ),
    );
    await useDedicatedWorker(page);
    await page.goto(irc.url());
    if (mobile) await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: mobile ? `Message ${irc.channel}` : "Message",
    });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    const row = bufferRow(page, channel);
    const bufferId = await row.getAttribute("data-buffer-id");
    if (bufferId === null) throw new Error("bot channel has no buffer id");
    const list = mobile
      ? page
          .locator(`[data-mobile-chat="${bufferId}"]`)
          .locator("[data-message-list]")
      : page.locator("[data-message-list]");
    await expectRead(row, channel, mobile);
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(2);

    await bots[0]?.typingConfirmed(channel, "active");
    const traffic = sendBotTraffic(page, channel, bots);
    await traffic.readCheckpoints[0];
    await expectRead(row, channel, mobile, 400);
    await traffic.readCheckpoints[1];
    await expectRead(row, channel, mobile, 400);
    const newestText = await traffic.done;
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(2);
    await expectRead(row, channel, mobile);

    await restoreDebugCredentials(page, irc.url({ autojoin: [channel] }));
    await page.reload();
    const reloadedRow = bufferRow(page, channel);
    await expect(reloadedRow).toBeAttached();
    const heading = page.getByRole("heading", { name: channel });
    if (!(await heading.isVisible())) await reloadedRow.click();
    await expect(heading).toBeVisible();
    await expect(
      page.locator("[data-message-row]").filter({ hasText: newestText }),
    ).toBeVisible();
    await expectRead(reloadedRow, channel, mobile);
  });
});

function bufferRow(page: Page, channel: string): Locator {
  return page.locator("[data-buffer-id]").filter({ hasText: channel }).first();
}

async function expectRead(
  row: Locator,
  channel: string,
  mobile: boolean,
  timeout?: number,
): Promise<void> {
  if (mobile) {
    await expect(row).toHaveAttribute("aria-label", channel, { timeout });
    return;
  }
  await expect(row).toHaveAttribute("data-unread", "0", { timeout });
}

async function restoreDebugCredentials(
  page: Page,
  startUrl: string,
): Promise<void> {
  await page.evaluate((start) => {
    const url = new URL(window.location.href);
    for (const [name, value] of new URL(start, url).searchParams)
      url.searchParams.append(name, value);
    window.history.replaceState(window.history.state, "", url);
  }, startUrl);
}

function distanceFromBottom(list: Locator): Promise<number> {
  return list.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

function sendBotTraffic(
  page: Page,
  channel: string,
  bots: readonly IrcClient[],
): {
  readonly done: Promise<string>;
  readonly readCheckpoints: readonly [Promise<void>, Promise<void>];
} {
  const checkpoints = [deferred(), deferred()] as const;
  const done = (async () => {
    let newestText = "";
    for (let index = 0; index < 12; index += 1) {
      const bot = bots[index % bots.length];
      if (bot === undefined) throw new Error("no bot traffic sender");
      const text = `bot traffic ${index} ${Date.now()}`;
      newestText = text;
      if (index === 1) await bot.noticeConfirmed(channel, text);
      else if (index === 2)
        await bot.multilineConfirmed(channel, `${text}\nstatus: healthy`);
      else {
        if (index === 7) await bot.typingConfirmed(channel, "paused");
        await bot.privmsgConfirmed(channel, text);
      }
      if (index !== 1)
        await expect(
          page.locator("[data-message-row]").filter({ hasText: text }),
        ).toBeVisible();
      if (index === 5) checkpoints[0].resolve();
      if (index === 9) checkpoints[1].resolve();
      if (index < 11) {
        // wait-ok: spaces four independent bots' traffic into an aggregate busy-channel window
        await page.waitForTimeout(trafficIntervalMilliseconds);
      }
    }
    return newestText;
  })();
  return {
    done,
    readCheckpoints: [checkpoints[0].promise, checkpoints[1].promise],
  };
}

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
