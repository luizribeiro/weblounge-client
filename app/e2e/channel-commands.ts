import type { Locator, Page } from "@playwright/test";
import { expect, type IrcTestAccount } from "./irc-fixture";
import { expectSettled } from "./settled";

export async function joinFirst(
  page: Page,
  irc: IrcTestAccount,
  channel: string,
): Promise<Locator> {
  await page.goto(irc.url());
  const home = page.getByRole("textbox", { name: `Message ${irc.channel}` });
  await expect(home).toBeVisible();
  await home.fill(`/join ${channel}`);
  await home.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await expectSettled(page, { conversation: channel });
  return page.getByRole("textbox", { name: `Message ${channel}` });
}

export async function showMembers(
  page: Page,
  channel: string,
): Promise<Locator> {
  const toggle = page.getByRole("button", { name: "Toggle member list" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
  const members = page.getByRole("complementary", {
    name: `Members of ${channel}`,
  });
  await expect(members).toBeVisible();
  return members;
}

export async function submit(composer: Locator, input: string): Promise<void> {
  await composer.fill(input);
  await composer.press("Enter");
}

export const composerNotice = (page: Page, text: string): Locator =>
  page.getByRole("status").filter({ hasText: text });

export const member = (members: Locator, nick: string): Locator =>
  members.getByRole("button", { name: `Open direct message with ${nick}` });

export const memberPrefix = (members: Locator, nick: string): Locator =>
  member(members, nick).locator("[data-member-prefix]");

export const systemLine = (page: Page, text: string): Locator =>
  page.locator("[data-system-line]").filter({ hasText: text });
