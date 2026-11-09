import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

const defaultChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("groups phone messages without losing timestamps or the live edge", async ({
  page,
}, testInfo) => {
  test.skip(!isPhoneProject(testInfo.project.name), "runs in touch projects");
  const suffix = `${testInfo.project.name.slice(0, 2)}${Date.now().toString(36).slice(-5)}`;
  const channel = `#phone-${suffix}`;
  const sender = await IrcClient.connect(
    `phone-bot-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const peer = await IrcClient.connect(
    `phone-peer-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const first = `phone first ${suffix}`;
  const second = `phone grouped ${suffix}`;
  const changedSender = `phone sender ${suffix}`;
  const changedMinute = `phone minute ${suffix}`;
  try {
    await sender.mode(sender.nickname, "+B");
    await rewriteGroupingTimes(page, first, second, changedMinute);
    await useDedicatedWorker(page);
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("button", { name: defaultChannel }),
    ).toBeVisible();
    await page.getByRole("button", { name: defaultChannel }).click();
    await expect(page.locator("[data-mobile-chat]")).toBeVisible();
    const composer = page.getByRole("textbox", {
      name: `Message ${defaultChannel}`,
    });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    for (let index = 0; index < 10; index += 1)
      sender.privmsg(
        channel,
        `phone backlog ${index} ${suffix} ${"wrap this message across the narrow transcript ".repeat(5)}`,
      );
    await sender.privmsgConfirmed(channel, first);
    const firstRow = messageRow(page, first);
    await expect(firstRow).toBeVisible();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

    const echoed = await sender.privmsgConfirmed(channel, second);
    const secondRow = messageRow(page, second);
    await expect(secondRow).toBeVisible();
    await expect(secondRow).toHaveAttribute(
      "data-message-group-start",
      "false",
    );
    await expect(secondRow.locator("time")).toBeHidden();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

    await peer.privmsgConfirmed(channel, changedSender);
    await sender.privmsgConfirmed(channel, changedMinute);
    await expect(messageRow(page, changedSender)).toHaveAttribute(
      "data-message-group-start",
      "true",
    );
    await expect(messageRow(page, changedMinute)).toHaveAttribute(
      "data-message-group-start",
      "true",
    );
    await expect(messageRow(page, changedMinute).locator("time")).toBeVisible();

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
    await expect(page.getByText("BOT", { exact: true })).toHaveCount(0);
    await expect(visibleBotRow.locator("[data-message-avatar]")).toHaveCount(0);
  } finally {
    peer.close();
    sender.close();
  }
});

test("keeps the desktop row while replacing its bot label", async ({
  page,
}, testInfo) => {
  test.skip(
    isPhoneProject(testInfo.project.name),
    "runs in the desktop project",
  );
  const suffix = Date.now().toString(36).slice(-6);
  const channel = `#desktop-${suffix}`;
  const text = `desktop bot ${suffix}`;
  const sender = await IrcClient.connect(
    `desktop-bot-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  try {
    await sender.mode(sender.nickname, "+B");
    await useDedicatedWorker(page);
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await sender.privmsgConfirmed(channel, text);
    const row = messageRow(page, text);
    await expect(row).toBeVisible();
    await expect(row.getByRole("img", { name: "bot" })).toBeVisible();
    expect(await iconMatchesNick(row, sender.nickname)).toBe(true);
    await expect(page.getByText("BOT", { exact: true })).toHaveCount(0);
    expect(await keepsDesktopColumns(row)).toBe(true);
  } finally {
    sender.close();
  }
});

function isPhoneProject(name: string): boolean {
  return name === "android-phone-layout" || name === "webkit-phone-layout";
}

function messageRow(page: Page, text: string): Locator {
  return page.locator(`[data-message-row][data-message-text="${text}"]`);
}

function distanceFromBottom(page: Page): Promise<number> {
  return page.locator("[data-message-list]").evaluate((element) => {
    const list = element as HTMLElement;
    return list.scrollHeight - list.scrollTop - list.clientHeight;
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

async function rewriteGroupingTimes(
  page: Page,
  first: string,
  second: string,
  changedMinute: string,
): Promise<void> {
  await page.routeWebSocket(/\/socket/u, (route) => {
    const server = route.connectToServer();
    let groupMinute: number | undefined;
    server.onMessage((message) => {
      const source = typeof message === "string" ? message : message.toString();
      const rewritten = source
        .split("\r\n")
        .map((line) => {
          const time = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
          if (time === undefined) return line;
          if (line.endsWith(` :${first}`))
            groupMinute = Math.floor(Date.parse(time) / 60_000) * 60_000;
          const replacement = line.endsWith(` :${first}`)
            ? groupMinute
            : line.endsWith(` :${second}`)
              ? (groupMinute ?? Date.parse(time)) + 1_000
              : line.endsWith(` :${changedMinute}`)
                ? (groupMinute ?? Date.parse(time)) + 60_000
                : undefined;
          return replacement === undefined
            ? line
            : line.replace(time, new Date(replacement).toISOString());
        })
        .join("\r\n");
      route.send(rewritten);
    });
  });
}

function messageId(line: string): string {
  const value = /(?:^@|;)msgid=([^; ]+)/u.exec(line)?.[1];
  if (value === undefined) throw new Error(`IRC line has no msgid: ${line}`);
  return value;
}
