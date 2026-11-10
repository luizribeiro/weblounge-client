import { mkdir } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
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

test("keeps every transcript row kind on the signed spacing rhythm", async ({
  page,
}, testInfo) => {
  test.skip(!auditProject(testInfo.project.name), "runs on desktop and phones");
  const phone = isPhoneProject(testInfo.project.name);
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  await page.emulateMedia({ colorScheme: "dark" });
  const scenario = await seedMixedConversation(testInfo.project.name);
  try {
    await useDedicatedWorker(page);
    await page.goto(scenario.startUrl);
    await page.getByRole("button", { name: scenario.channel }).click();
    await expect(
      page.getByRole("heading", { name: scenario.channel }),
    ).toBeVisible();
    await expect(messageRow(page, scenario.systemFence)).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("/version");
    await composer.press("Enter");
    await expect(page.locator("[data-notice-row]")).toBeVisible();

    const list = page.locator("[data-message-list]");
    if (phone) {
      await scrollToTranscriptTop(list);
    } else {
      await list.hover();
      await page.mouse.wheel(0, -100_000);
    }
    if (process.env.WEBLOUNGE_SPACING_SCREENSHOT_PHASE === "before") {
      await capture(page, testInfo.project.name, "mixed");
      return;
    }
    await expect(page.locator("[data-history-edge]")).toContainText(
      "Start of history",
    );
    await leaveConversation(page, phone);
    await scenario.sendUnread();
    await page.getByRole("button", { name: scenario.channel }).click();
    await expect(messageRow(page, scenario.unreadMessage)).toBeVisible();
    await expect(page.locator("[data-new-line]")).toBeVisible();
    await capture(page, testInfo.project.name, "mixed");

    const density = await transcriptDensity(page);
    expect(density.dividerBefore).toBeCloseTo(density.dividerAfter, 0);
    expect(density.dividerBefore).toBeCloseTo(phone ? 8 : 8, 0);
    expect(density.systemBefore).toBeCloseTo(density.systemAfter, 0);
    expect(density.systemBefore).toBeCloseTo(3, 0);
    expect(density.historyBefore).toBeCloseTo(density.dividerBefore, 0);
    expect(density.historyAfter).toBeCloseTo(density.dividerAfter, 0);

    await expectContiguousRows(page);
    if (phone) {
      await expectTextGap(
        messageRow(page, scenario.groupStart),
        messageRow(page, scenario.continuation),
        6,
      );
      await expectTextGap(
        messageRow(page, scenario.continuation),
        messageRow(page, scenario.newSender),
        16,
        true,
      );
      await expectTextGap(
        messageRow(page, scenario.highlightStart),
        messageRow(page, scenario.highlightContinuation),
        6,
      );
      const band = await bandInsets(
        messageRow(page, scenario.highlightContinuation),
      );
      expect(band).toEqual({ after: 3, before: 3 });
    }

    const link = messageRow(page, scenario.wrappedLink);
    await expect(link.getByRole("link")).toBeVisible();
    await expect(link.locator("[data-selectable]")).toHaveCSS(
      "overflow-wrap",
      "anywhere",
    );
    await expect(
      messageRow(page, scenario.reacted).locator('[data-reaction="👍"]'),
    ).toBeVisible();
    await expect(messageRow(page, scenario.own)).toBeVisible();
    await expect(page.locator("[data-notice-row]")).toBeVisible();
    await expect
      .poll(() => page.locator("[data-membership-row]").count())
      .toBeGreaterThanOrEqual(2);
  } finally {
    scenario.close();
  }
});

test("keeps measured virtual rows contiguous through transcript mutations", async ({
  page,
}, testInfo) => {
  test.skip(!auditProject(testInfo.project.name), "runs on desktop and phones");
  const phone = isPhoneProject(testInfo.project.name);
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  const suffix = suffixFor(testInfo.project.name);
  const account = `sa-virt-${suffix}`;
  const channel = `#sa-virt-${suffix}`;
  const startUrl = await isolatedStartUrl(account, channel);
  const writers = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      IrcClient.connect(
        `sa-writer-${index}-${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      ),
    ),
  );
  const writer = writers[0];
  if (writer === undefined) throw new Error("spacing writer is missing");
  const messages = Array.from(
    { length: 105 },
    (_, index) =>
      `spacing virtual ${suffix} ${index} ${index % 9 === 0 ? "wrapped transcript text ".repeat(7) : "row"}`,
  );
  try {
    const finalEchoes: Promise<string>[] = [];
    for (const [index, text] of messages.entries()) {
      const sender = writers[index % writers.length];
      if (sender === undefined) throw new Error("spacing writer is missing");
      if (index >= messages.length - writers.length) {
        finalEchoes.push(sender.privmsgConfirmed(channel, text));
      } else {
        sender.privmsg(channel, text);
      }
    }
    await Promise.all(finalEchoes);
    const seedFence = `spacing seed fence ${suffix}`;
    await writer.privmsgConfirmed(channel, seedFence);
    await throttleCpu(page, testInfo.project.name);
    await useDedicatedWorker(page);
    await page.goto(startUrl);
    await page.getByRole("button", { name: channel }).click();
    await expect(messageRow(page, seedFence)).toBeVisible();
    const list = page.locator("[data-message-list]");
    await expect
      .poll(() => list.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(2_500);
    const initialHistoryHeight = await list.evaluate(
      (element) => element.scrollHeight,
    );
    await expectContiguousRows(page);

    if (phone) {
      await scrollToTranscriptTop(list);
    } else {
      await list.hover();
      await page.mouse.wheel(0, -100_000);
    }
    await expect
      .poll(() => list.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(initialHistoryHeight);
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expectContiguousRows(page);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(messageRow(page, seedFence)).toBeVisible();
    await expectContiguousRows(page);

    const reactionTarget = await writer.privmsgConfirmed(
      channel,
      `spacing reaction target ${suffix}`,
    );
    const reactionText = `spacing reaction target ${suffix}`;
    await expect(messageRow(page, reactionText)).toBeVisible();
    await writer.reactionConfirmed(channel, messageId(reactionTarget), "👍");
    await expect(
      messageRow(page, reactionText).locator('[data-reaction="👍"]'),
    ).toBeVisible();
    await expectContiguousRows(page);

    await page.setViewportSize(
      phone ? { width: 844, height: 390 } : { width: 980, height: 800 },
    );
    await expectContiguousRows(page);
    await page.setViewportSize(
      phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    );
    await expectContiguousRows(page);

    if (phone) {
      await keyboardGeometry(page, true);
      await expectContiguousRows(page);
      await keyboardGeometry(page, false);
      await expectContiguousRows(page);
    }

    await scrollAwayFromLiveEdge(page, list, {
      distance: 300,
      input: phone ? "touch" : "wheel",
    });
    const beforeJump = await mountedRowPositions(page);
    writer.privmsg(channel, `spacing unseen ${suffix}`);
    const jump = page.getByRole("button", { name: /new message/u });
    await expect(jump).toBeVisible();
    expect(
      await commonRowShift(beforeJump, await mountedRowPositions(page)),
    ).toBeLessThanOrEqual(1);
    await jump.click();
    await expectContiguousRows(page);
  } finally {
    for (const client of writers) client.close();
  }
});

interface MixedConversation {
  readonly channel: string;
  readonly continuation: string;
  readonly groupStart: string;
  readonly highlightContinuation: string;
  readonly highlightStart: string;
  readonly newSender: string;
  readonly own: string;
  readonly reacted: string;
  readonly startUrl: string;
  readonly systemFence: string;
  readonly unreadMessage: string;
  readonly wrappedLink: string;
  readonly close: () => void;
  readonly sendUnread: () => Promise<void>;
}

async function seedMixedConversation(
  project: string,
): Promise<MixedConversation> {
  const suffix = suffixFor(project);
  const account = `sauser${suffix}`;
  const channel = `#sa-mixed-${suffix}`;
  const startUrl = await isolatedStartUrl(account, channel);
  const first = await IrcClient.connect(
    `sa-first-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const beforeJoin = `message before join ${suffix}`;
  await first.privmsgConfirmed(channel, beforeJoin);
  const second = await IrcClient.connect(
    `sa-second-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  await second.privmsgConfirmed(channel, `message after join ${suffix}`);
  const marker = await IrcClient.connect(
    account,
    account,
    `test-${account}`,
    channel,
  );
  const own = `own confirmed row ${suffix}`;
  const ownLine = await marker.privmsgConfirmed(channel, own);
  await marker.markRead(channel, serverTime(ownLine));

  const minute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
  const groupStart = `group start ${suffix}`;
  const continuation = `same group continuation ${suffix}`;
  const newSender = `new sender ${suffix}`;
  const reacted = `reaction row ${suffix}`;
  const wrappedLink = `wrapped link https://example.com/${"spacing/".repeat(12)}${suffix}`;
  const highlightStart = `highlight group ${account} ${suffix}`;
  const highlightContinuation = `highlight continuation ${account} ${suffix}`;
  const systemFence = `after notice ${suffix}`;
  const unreadMessage = `new divider message ${suffix}`;
  const timed = [
    [first, groupStart],
    [first, continuation],
    [second, newSender],
    [second, reacted],
    [first, wrappedLink],
    [first, highlightStart],
    [first, highlightContinuation],
  ] as const;
  const echoes: string[] = [];
  for (const [index, [client, text]] of timed.entries()) {
    await armMessageTime(text, minute + index * 1_000);
    echoes.push(await client.privmsgConfirmed(channel, text));
  }
  await second.reactionConfirmed(channel, messageId(echoes[3] ?? ""), "👍");
  await first.privmsgConfirmed(channel, systemFence);
  marker.close();
  return {
    channel,
    continuation,
    groupStart,
    highlightContinuation,
    highlightStart,
    newSender,
    own,
    reacted,
    startUrl,
    systemFence,
    unreadMessage,
    wrappedLink,
    sendUnread: async () => {
      await first.privmsgConfirmed(channel, unreadMessage);
    },
    close: () => {
      second.close();
      first.close();
    },
  };
}

async function leaveConversation(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.getByRole("button", { name: "Back to chats" }).click();
    return;
  }
  await page.getByRole("button", { name: /Local Ergo, online/u }).click();
}

function auditProject(project: string): boolean {
  return project === "chromium" || isPhoneProject(project);
}

function isPhoneProject(project: string): boolean {
  return (
    project === "android-phone-layout" || project === "webkit-phone-layout"
  );
}

function suffixFor(project: string): string {
  return `${project.slice(0, 2)}${Date.now().toString(36).slice(-6)}`;
}

async function isolatedStartUrl(
  account: string,
  channel: string,
): Promise<string> {
  const seed = await IrcClient.connectIsolated(account, channel);
  seed.close();
  await seed.waitForDisconnect();
  const params = new URLSearchParams({
    "irc-account": account,
    "irc-nickname": account,
    "irc-password": `test-${account}`,
    "irc-autojoin": channel,
  });
  return `/?${params.toString()}`;
}

function messageRow(page: Page, text: string): Locator {
  return page.locator(`[data-message-row][data-message-text="${text}"]`);
}

function messageId(line: string): string {
  const id = /(?:^@|;)msgid=([^; ]+)/u.exec(line)?.[1];
  if (id === undefined) throw new Error(`message has no msgid: ${line}`);
  return id;
}

function serverTime(line: string): string {
  const value = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
  if (value === undefined)
    throw new Error(`message has no server time: ${line}`);
  return value;
}

async function transcriptDensity(page: Page) {
  return page.evaluate(() => {
    const blockPadding = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      const style = getComputedStyle(element);
      return {
        after: Number.parseFloat(style.paddingBlockEnd),
        before: Number.parseFloat(style.paddingBlockStart),
      };
    };
    const divider = blockPadding("[data-day-divider]");
    const history = blockPadding("[data-history-edge]");
    const system = blockPadding("[data-membership-row]");
    return {
      dividerAfter: divider.after,
      dividerBefore: divider.before,
      historyAfter: history.after,
      historyBefore: history.before,
      systemAfter: system.after,
      systemBefore: system.before,
    };
  });
}

async function expectContiguousRows(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator("li[data-index]").evaluateAll((rows) => {
        const ordered = rows
          .map((row) => ({
            index: Number((row as HTMLElement).dataset.index),
            key: (row as HTMLElement).dataset.rowKey,
            rect: row.getBoundingClientRect(),
          }))
          .sort((left, right) => left.index - right.index);
        return ordered.slice(1).flatMap((current, index) => {
          const previous = ordered[index];
          if (previous === undefined) return [];
          const gap = current.rect.top - previous.rect.bottom;
          return Math.abs(gap) <= 1
            ? []
            : [`${previous.key}->${current.key}:${gap}`];
        });
      }),
    )
    .toEqual([]);
}

async function expectTextGap(
  before: Locator,
  after: Locator,
  expected: number,
  header = false,
): Promise<void> {
  await expect
    .poll(async () => {
      const [beforeBox, afterBox] = await Promise.all([
        before.locator("[data-selectable]").boundingBox(),
        after
          .locator(header ? "[data-message-chrome]" : "[data-selectable]")
          .last()
          .boundingBox(),
      ]);
      if (beforeBox === null || afterBox === null) return Number.NaN;
      return afterBox.y - beforeBox.y - beforeBox.height;
    })
    .toBeCloseTo(expected, 0);
}

function bandInsets(row: Locator): Promise<{ after: number; before: number }> {
  return row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect();
    const text = element.querySelector<HTMLElement>("[data-selectable]");
    if (text === null) throw new Error("highlighted row has no text");
    const textRect = text.getBoundingClientRect();
    const style = getComputedStyle(element, "::before");
    const bandTop = rowRect.top + Number.parseFloat(style.insetBlockStart);
    const bandBottom = rowRect.bottom - Number.parseFloat(style.insetBlockEnd);
    return {
      after: Math.round((bandBottom - textRect.bottom) * 10) / 10,
      before: Math.round((textRect.top - bandTop) * 10) / 10,
    };
  });
}

async function capture(
  page: Page,
  project: string,
  name: string,
): Promise<void> {
  const root = process.env.WEBLOUNGE_SPACING_SCREENSHOT_DIR;
  const phase = process.env.WEBLOUNGE_SPACING_SCREENSHOT_PHASE;
  if (
    root === undefined ||
    phase === undefined ||
    project === "android-phone-layout"
  )
    return;
  await mkdir(`${root}/${phase}`, { recursive: true });
  await page.screenshot({
    path: `${root}/${phase}/${isPhoneProject(project) ? "phone" : "desktop"}-${name}.png`,
  });
}

async function throttleCpu(page: Page, project: string): Promise<void> {
  if (project !== "chromium" && project !== "android-phone-layout") return;
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
}

async function keyboardGeometry(page: Page, open: boolean): Promise<void> {
  await page.evaluate((keyboardOpen) => {
    const root = document.getElementById("root");
    if (root === null) throw new Error("app root is missing");
    root.dataset.keyboard = keyboardOpen ? "open" : "closed";
    root.style.setProperty("--wl-app-height", keyboardOpen ? "520px" : "844px");
    window.dispatchEvent(
      new CustomEvent("weblounge:app-geometry-change", {
        detail: { owner: root },
      }),
    );
  }, open);
}

function mountedRowPositions(
  page: Page,
): Promise<readonly (readonly [string, number])[]> {
  return page
    .locator("li[data-row-key]")
    .evaluateAll((rows) =>
      rows.map(
        (row) =>
          [
            (row as HTMLElement).dataset.rowKey ?? "",
            row.getBoundingClientRect().top,
          ] as const,
      ),
    );
}

function commonRowShift(
  before: readonly (readonly [string, number])[],
  afterEntries: readonly (readonly [string, number])[],
): number {
  const after = new Map(afterEntries);
  return [...before].reduce((largest, [key, top]) => {
    const next = after.get(key);
    return next === undefined
      ? largest
      : Math.max(largest, Math.abs(next - top));
  }, 0);
}
