import type { Locator, Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount } from "./irc-fixture";

export async function emulatePlatform(
  page: Page,
  platform: string,
): Promise<void> {
  await page.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      get: () => value,
    });
  }, platform);
}

export async function emulateMacApp(
  page: Page,
  identity: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await emulatePlatform(page, "MacIntel");
  await page.addInitScript((extra) => {
    Object.defineProperty(globalThis, "__WEBLOUNGE_SHELL__", {
      value: Object.freeze({ kind: "macos-app", version: "0.1.0", ...extra }),
    });
  }, identity);
}

export async function openWithExtraChannel(
  page: Page,
  irc: IrcTestAccount,
  extraChannels = 1,
): Promise<void> {
  await page.goto(irc.url());
  const home = page.getByRole("button", { name: irc.channel });
  await home.click();
  const composer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  for (let index = 0; index < extraChannels; index += 1) {
    const channel = irc.channelNamed(`jump-${index}`);
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await home.click();
  }
}

export async function conversationRowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-sidebar-row="true"] [data-buffer-id]')
    .evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.bufferId ?? ""),
    );
}

export function row(page: Page, bufferId: string | undefined): Locator {
  return page.locator(`[data-sidebar-row] [data-buffer-id="${bufferId}"]`);
}

const peerPresenceSuffix = ", (?:online|away)";

/** A desktop DM row's name ends with its peer's presence whenever the network reports one. */
export function withoutPeerPresence(label: string): string {
  return label.replace(new RegExp(`${peerPresenceSuffix}$`, "u"), "");
}

export function rowName(
  title: string,
  badge?: string,
  { badgeOptional = false } = {},
): RegExp {
  const badgePart =
    badge === undefined
      ? ""
      : `(?:, ${escapeRegex(badge)})${badgeOptional ? "?" : ""}`;
  return new RegExp(
    `^${escapeRegex(title)}${badgePart}(?:${peerPresenceSuffix})?$`,
    "u",
  );
}

export function directRow(page: Page, peer: IrcClient): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
  });
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
