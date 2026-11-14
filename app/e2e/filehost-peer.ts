import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount } from "./irc-fixture";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { expectSettled } from "./settled";

export async function withDirectPeer(
  page: Page,
  irc: IrcTestAccount,
  label: string,
  body: (peer: IrcClient, suffix: string) => Promise<void>,
): Promise<void> {
  const suffix = `${label}${irc.id}`;
  await installNativeFeelInstrumentation(page);
  await page.goto(irc.url());
  await expect(page.getByRole("button", { name: irc.channel })).toBeVisible();
  const peer = await irc.peer(`img-${label}`, [
    irc.channelNamed(`img-${label}`),
  ]);
  await peer.privmsgConfirmed(irc.account, `images ${suffix}`);
  const direct = page.getByRole("button", {
    name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
  });
  await direct.click();
  await expectSettled(page, { conversation: peer.nickname });
  await body(peer, suffix);
}

export function rowFor(page: Page, url: string): Locator {
  return page.locator("[data-message-row]").filter({ hasText: url });
}

export function slotIn(page: Page, url: string): Locator {
  return rowFor(page, url).locator("[data-inline-image]");
}

export async function settledScreenshot(
  page: Page,
  directory: string,
  name: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .getAnimations()
          .every((animation) => animation.playState === "finished"),
      ),
    )
    .toBe(true);
  await screenshotWithInter(page.locator("[data-app-root]"), {
    path: path.join(directory, `${name}.png`),
  });
}
