import type { Locator, Page } from "@playwright/test";
import { E2E_CONTENT_SECURITY_POLICY } from "../csp";
import { messageId } from "./irc-client";
import { expect, test } from "./irc-fixture";
import { useDedicatedWorker } from "./production-ergo";
import { armMessageTime } from "./time-rewrite";
import { screenshotPixelVariance } from "./transcript-paint";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("keeps clickable sender and mentioned nicks as bold as our own", async ({
  page,
  irc,
}) => {
  const suffix = irc.id;
  const channel = irc.channelNamed("nick-weight");
  const account = irc.account;
  const startUrl = irc.url({ autojoin: [channel] });
  const peer = await irc.peer("nick-bot", [channel]);
  const peerText = `peer sender ${suffix}`;
  const ownText = `own mentions ${peer.nickname}`;
  const actionText = `waves at ${account}`;
  const noticeText = `notice from ${peer.nickname}`;
  await peer.mode(peer.nickname, "+B");
  await useDedicatedWorker(page);
  await page.goto(startUrl);
  await page.getByRole("button", { name: channel }).click();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();

  await peer.privmsgConfirmed(channel, peerText);
  const composer = page.getByRole("textbox", { name: `Message ${channel}` });
  await composer.fill(ownText);
  await composer.press("Enter");
  await peer.actionConfirmed(channel, actionText);
  await peer.noticeConfirmed(channel, noticeText);

  const ownNick = messageRow(page, ownText).locator(`[title="${account}"]`);
  const peerNick = messageRow(page, peerText).locator(
    `[title="${peer.nickname}"]`,
  );
  const actionNick = messageRow(page, actionText)
    .locator("[data-nick-action]")
    .first();
  const noticeNick = messageRow(page, noticeText).locator(
    `[title="${peer.nickname}"]`,
  );
  const mentionedNick = messageRow(page, ownText).locator("[data-nick-action]");
  await expect(ownNick).toBeVisible();
  await expect(peerNick).toBeVisible();
  await expect(actionNick).toBeVisible();
  await expect(noticeNick).toBeVisible();
  await expect(mentionedNick).toBeVisible();

  for (const nick of [ownNick, peerNick, actionNick, noticeNick, mentionedNick])
    await expect(nick).toHaveCSS("font-weight", "650");
  const peerColor = await peerNick.evaluate(
    (element) => getComputedStyle(element).color,
  );
  for (const nick of [actionNick, noticeNick, mentionedNick])
    await expect(nick).toHaveCSS("color", peerColor);
});

test("groups phone messages without losing timestamps or the live edge", async ({
  page,
  irc,
}, testInfo) => {
  test.skip(!isPhoneProject(testInfo.project.name), "runs in touch projects");
  const suffix = irc.id;
  const channel = irc.channelNamed("phone");
  const startUrl = irc.url({ autojoin: [channel] });
  const sender = await irc.peer("phone-bot", [channel]);
  const peer = await irc.peer("phone-peer", [channel]);
  const first = `phone first ${suffix}`;
  const second = `phone grouped ${suffix} ${"wrap inside the phone text column ".repeat(5)}`;
  const changedSender = `phone sender ${suffix}`;
  const beforeMinute = `phone before minute ${suffix}`;
  const changedMinute = `phone minute ${suffix}`;
  const backlog = Array.from(
    { length: 10 },
    (_, index) =>
      `phone backlog ${index} ${suffix} ${"wrap this message across the narrow transcript ".repeat(5)}`,
  );
  await sender.mode(sender.nickname, "+B");
  await armGroupingTimes(
    backlog,
    first,
    second,
    changedSender,
    beforeMinute,
    changedMinute,
  );
  await useDedicatedWorker(page);
  await page.goto(startUrl);
  await expect(page.getByRole("button", { name: channel })).toBeVisible();
  await page.getByRole("button", { name: channel }).click();
  await expect(page.locator("[data-mobile-chat]")).toBeVisible();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();

  for (const text of backlog) sender.privmsg(channel, text);
  await sender.privmsgConfirmed(channel, first);
  const firstRow = messageRow(page, first);
  await expect(firstRow).toBeVisible();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

  const echoed = await sender.privmsgConfirmed(channel, second);
  const secondRow = messageRow(page, second);
  await expect(secondRow).toBeVisible();
  await expect(secondRow).toHaveAttribute("data-message-group-start", "false");
  await expect(secondRow.locator("time")).toBeHidden();
  await expect.poll(() => wrapsAcrossLines(secondRow)).toBe(true);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

  await peer.privmsgConfirmed(channel, changedSender);
  await sender.privmsgConfirmed(channel, beforeMinute);
  await sender.privmsgConfirmed(channel, changedMinute);
  await expect(messageRow(page, changedSender)).toHaveAttribute(
    "data-message-group-start",
    "true",
  );
  await expect(messageRow(page, beforeMinute)).toHaveAttribute(
    "data-message-group-start",
    "true",
  );
  await expect(messageRow(page, changedMinute)).toHaveAttribute(
    "data-message-group-start",
    "true",
  );
  await expect(messageRow(page, changedMinute).locator("time")).toBeVisible();
  expect(await messageMinute(page, beforeMinute)).not.toBe(
    await messageMinute(page, changedMinute),
  );

  await peer.reactionConfirmed(channel, messageId(echoed), "👍");
  const reaction = secondRow.locator('[data-reaction="👍"]');
  await expect(reaction).toBeVisible();
  const reactionGeometry = await geometryBelowText(secondRow, reaction);
  expect(reactionGeometry.verticalGap).toBeGreaterThanOrEqual(0);
  expect(Math.abs(reactionGeometry.horizontalOffset)).toBeLessThanOrEqual(1);

  const visibleBotRow = messageRow(page, changedMinute);
  const icon = visibleBotRow.getByRole("img", { name: "bot" });
  await expect(icon).toBeVisible();
  expect(await iconMatchesNick(visibleBotRow, sender.nickname)).toBe(true);
  expect(
    await iconNickCentreOffset(visibleBotRow, sender.nickname),
  ).toBeLessThanOrEqual(2);
  await expect(page.getByText("BOT", { exact: true })).toHaveCount(0);
  await expect(visibleBotRow.locator("[data-message-avatar]")).toHaveCount(0);
});

test("keeps the desktop row while replacing its bot label", async ({
  page,
  irc,
}, testInfo) => {
  test.skip(
    isPhoneProject(testInfo.project.name),
    "runs in the desktop project",
  );
  const channel = irc.channelNamed("desktop");
  const text = `desktop bot ${irc.id}`;
  const startUrl = irc.url({ autojoin: [channel] });
  const sender = await irc.peer("desktop-bot", [channel]);
  await sender.mode(sender.nickname, "+B");
  await useDedicatedWorker(page);
  await page.goto(startUrl);
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await page.getByRole("button", { name: channel }).click();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await sender.privmsgConfirmed(channel, text);
  const row = messageRow(page, text);
  await expect(row).toBeVisible();
  await expect(row.getByRole("img", { name: "bot" })).toBeVisible();
  expect(await iconMatchesNick(row, sender.nickname)).toBe(true);
  expect(await iconNickCentreOffset(row, sender.nickname)).toBeLessThanOrEqual(
    2,
  );
  await expect(page.getByText("BOT", { exact: true })).toHaveCount(0);
  expect(await keepsDesktopColumns(row)).toBe(true);
});

test("paints message and member bot icons under the beta CSP", async ({
  page,
  irc,
}, testInfo) => {
  test.skip(
    isPhoneProject(testInfo.project.name),
    "runs in the desktop project",
  );
  const channel = irc.channelNamed("bot-csp");
  const text = `bot CSP ${irc.id}`;
  const startUrl = irc.url({ autojoin: [channel] });
  const sender = await irc.peer("csp-bot", [channel]);
  await sender.mode(sender.nickname, "+B");
  await page.addInitScript(() => {
    Reflect.set(globalThis, "botIconCspViolations", []);
    document.addEventListener("securitypolicyviolation", (event) => {
      const violations = Reflect.get(globalThis, "botIconCspViolations");
      if (Array.isArray(violations))
        violations.push({
          blocked: event.blockedURI,
          directive: event.violatedDirective,
        });
    });
  });
  await useDedicatedWorker(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto(startUrl);
  expect(response?.headers()["content-security-policy"]).toBe(
    E2E_CONTENT_SECURITY_POLICY,
  );
  await page.getByRole("button", { name: channel }).click();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await sender.privmsgConfirmed(channel, text);

  const messageIcon = messageRow(page, text).getByRole("img", {
    name: "bot",
  });
  await expect(messageIcon).toBeVisible();
  await page.getByRole("button", { name: "Toggle member list" }).click();
  const memberIcon = page
    .getByRole("complementary", { name: `Members of ${channel}` })
    .getByRole("button", {
      name: `Open direct message with ${sender.nickname}`,
    })
    .getByRole("img", { name: "bot" });
  await expect(memberIcon).toBeVisible();

  for (const icon of [messageIcon, memberIcon]) {
    expect(await maskImageOrigin(icon)).toBe(new URL(page.url()).origin);
    expect(
      await screenshotPixelVariance(
        page,
        await icon.screenshot({ scale: "css" }),
      ),
    ).toBeGreaterThan(1);
  }
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "botIconCspViolations")),
  ).toEqual([]);
});

function isPhoneProject(name: string): boolean {
  return name === "android-phone-layout" || name === "webkit-phone-layout";
}

function messageRow(page: Page, text: string): Locator {
  return page.locator(`[data-message-row][data-message-text="${text}"]`);
}

function maskImageOrigin(icon: Locator): Promise<string> {
  return icon.evaluate((element) => {
    const value = getComputedStyle(element).maskImage;
    const match = /^url\(["']?(.*?)["']?\)$/u.exec(value);
    if (match?.[1] === undefined)
      throw new Error(`bot icon has no mask image: ${value}`);
    return new URL(match[1], location.href).origin;
  });
}

function distanceFromBottom(page: Page): Promise<number> {
  return page.locator("[data-message-list]").evaluate((element) => {
    const list = element as HTMLElement;
    return list.scrollHeight - list.scrollTop - list.clientHeight;
  });
}

async function messageMinute(page: Page, text: string): Promise<number> {
  const dateTime = await messageRow(page, text)
    .locator("time")
    .getAttribute("datetime");
  if (dateTime === null) throw new Error(`message has no timestamp: ${text}`);
  return Math.floor(Date.parse(dateTime) / 60_000);
}

function wrapsAcrossLines(row: Locator): Promise<boolean> {
  return row.locator("[data-selectable]").evaluate((text) => {
    const style = getComputedStyle(text);
    return (
      text.getBoundingClientRect().height >
      Number.parseFloat(style.lineHeight) * 2
    );
  });
}

function iconMatchesNick(row: Locator, nick: string): Promise<boolean> {
  return row.evaluate((element, expectedNick) => {
    const icon = element.querySelector<SVGElement>('[role="img"]');
    const author = element.querySelector<HTMLElement>(
      `[title="${expectedNick}"]`,
    );
    return (
      icon !== null &&
      author !== null &&
      getComputedStyle(icon).color === getComputedStyle(author).color
    );
  }, nick);
}

function iconNickCentreOffset(row: Locator, nick: string): Promise<number> {
  return row.evaluate((element, expectedNick) => {
    const icon = element.querySelector<SVGElement>('[role="img"]');
    const author = element.querySelector<HTMLElement>(
      `[title="${expectedNick}"]`,
    );
    if (icon === null || author === null) return Number.POSITIVE_INFINITY;
    const iconBox = icon.getBoundingClientRect();
    const authorBox = author.getBoundingClientRect();
    return Math.abs(
      iconBox.top + iconBox.height / 2 - (authorBox.top + authorBox.height / 2),
    );
  }, nick);
}

async function geometryBelowText(
  row: Locator,
  reaction: Locator,
): Promise<{
  readonly horizontalOffset: number;
  readonly verticalGap: number;
}> {
  const text = row.locator("[data-selectable]");
  const [textBox, reactionBox] = await Promise.all([
    text.boundingBox(),
    reaction.boundingBox(),
  ]);
  if (textBox === null || reactionBox === null)
    throw new Error("message text or reaction is not laid out");
  return {
    horizontalOffset: reactionBox.x - textBox.x,
    verticalGap: reactionBox.y - textBox.y - textBox.height,
  };
}

function keepsDesktopColumns(row: Locator): Promise<boolean> {
  return row.evaluate((element) => {
    const time = element.querySelector("time")?.getBoundingClientRect();
    const nick = element
      .querySelector<HTMLElement>("[title]")
      ?.getBoundingClientRect();
    const text = element
      .querySelector<HTMLElement>("[data-selectable]")
      ?.getBoundingClientRect();
    if (time === undefined || nick === undefined || text === undefined)
      return false;
    return (
      getComputedStyle(element).display === "grid" &&
      time.left < nick.left &&
      nick.left < text.left &&
      Math.abs(time.bottom - nick.bottom) < 5 &&
      Math.abs(nick.bottom - text.bottom) < 5
    );
  });
}

async function armGroupingTimes(
  backlog: readonly string[],
  first: string,
  second: string,
  changedSender: string,
  beforeMinute: string,
  changedMinute: string,
): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
  await Promise.all([
    ...backlog.map((text, index) =>
      armMessageTime(text, minute - (backlog.length - index) * 1_000),
    ),
    armMessageTime(first, minute + 1_000),
    armMessageTime(second, minute + 2_000),
    armMessageTime(changedSender, minute + 3_000),
    armMessageTime(beforeMinute, minute + 59_000),
    armMessageTime(changedMinute, minute + 60_000),
  ]);
}
