import type { Locator, Page } from "@playwright/test";
import { messageId, serverTime } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  scrollAwayFromLiveEdge,
  scrollToTranscriptTop,
} from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { useDedicatedWorker } from "./production-ergo";
import { expectSettled } from "./settled";
import { seedMixedConversation } from "./spacing-audit-fixture";
import { armMessageTime } from "./time-rewrite";
import { withTranscriptDiagnostics } from "./transcript-diagnostics";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("keeps every transcript row kind on the signed spacing rhythm", async ({
  page,
  irc,
}, testInfo) => {
  test.skip(!auditProject(testInfo.project.name), "runs on desktop and phones");
  const phone = isPhoneProject(testInfo.project.name);
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  await page.emulateMedia({ colorScheme: "dark" });
  const scenario = await seedMixedConversation(irc);
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
  await composer.fill("/topic");
  await composer.press("Enter");
  await expect(page.locator("[data-notice-row]")).toHaveCount(2);
  await expectSettled(page, { conversation: scenario.channel });

  const list = page.locator("[data-message-list]");
  await expect
    .poll(async () => {
      await driveToTranscriptTop(list);
      return page
        .locator('[data-divider-kind="history"]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("aria-label")),
        );
    })
    .toContain(`Beginning of ${scenario.channel}`);
  await expect(page.locator('[data-divider-kind="history"]')).toContainText(
    "Server history starts",
  );
  await leaveConversation(page, phone);
  await scenario.sendUnread(page);
  await page.getByRole("button", { name: scenario.channel }).click();
  await expect(messageRow(page, scenario.unreadMessage)).toBeVisible();
  await expect(page.locator("[data-new-line]")).toBeVisible();
  await composer.fill("/version");
  await composer.press("Enter");
  await expect(
    page.locator('[data-line-spacing="after-message"] [data-notice-row]'),
  ).toBeVisible();
  const density = await transcriptDensity(
    page,
    scenario.unreadMessage,
    scenario.systemFence,
  );
  expect(density.dividerBefore).toBeCloseTo(phone ? 20 : 14, 0);
  expect(density.dividerAfter).toBeCloseTo(phone ? 8 : 6, 0);
  expect(density.newBefore).toBeCloseTo(density.dividerBefore, 0);
  expect(density.newAfter).toBeCloseTo(density.dividerAfter, 0);
  expect(density.paintedDividerBefore).toBeGreaterThan(
    density.paintedDividerAfter,
  );
  expect(density.systemBefore).toBeCloseTo(phone ? 12 : 3, 0);
  expect(density.systemAfter).toBeCloseTo(phone ? 0 : 3, 0);
  expect(density.consecutiveLineBefore).toBeCloseTo(phone ? 4 : 3, 0);
  expect(density.consecutiveLineAfter).toBeCloseTo(phone ? 0 : 3, 0);
  expect(density.afterDividerLineBefore).toBeCloseTo(0, 0);
  expect(density.afterDividerMessageBefore).toBeCloseTo(0, 0);
  expect(density.historyBefore).toBeCloseTo(density.dividerBefore, 0);
  expect(density.historyAfter).toBeCloseTo(density.dividerAfter, 0);

  await expectContiguousRows(page, 2);
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
  await expect(page.locator("[data-notice-row]").first()).toBeVisible();
  await expect
    .poll(() => page.locator("[data-system-line]").count())
    .toBeGreaterThanOrEqual(1);
});

test("keeps measured virtual rows contiguous through transcript mutations", async ({
  page,
  irc,
}, testInfo) => {
  test.skip(!auditProject(testInfo.project.name), "runs on desktop and phones");
  const phone = isPhoneProject(testInfo.project.name);
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  const suffix = irc.id;
  const channel = irc.channelNamed("sa-virt");
  const startUrl = irc.url({ autojoin: [channel] });
  const writers = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      irc.peer(`sa-writer-${index}`, [channel]),
    ),
  );
  const writer = writers[0];
  if (writer === undefined) throw new Error("spacing writer is missing");
  const messages = Array.from(
    { length: 105 },
    (_, index) =>
      `spacing virtual ${suffix} ${index} ${index % 9 === 0 ? "wrapped transcript text ".repeat(7) : "row"}`,
  );
  const oldest = messages[0];
  if (oldest === undefined) throw new Error("oldest spacing row is missing");
  const oldestEcho = await writer.privmsgConfirmed(channel, oldest);
  await armMessageTime(oldest, Date.parse(serverTime(oldestEcho)) - 1_000);
  const bulkMessages = messages.slice(1);
  const finalEchoes: Promise<string>[] = [];
  for (const [index, text] of bulkMessages.entries()) {
    const sender = writers[index % writers.length];
    if (sender === undefined) throw new Error("spacing writer is missing");
    if (index >= bulkMessages.length - writers.length) {
      finalEchoes.push(sender.privmsgConfirmed(channel, text));
    } else {
      sender.privmsg(channel, text);
    }
  }
  await Promise.all(finalEchoes);
  const seedFence = `spacing seed fence ${suffix}`;
  await writer.privmsgConfirmed(channel, seedFence);
  await useDedicatedWorker(page);
  await page.goto(startUrl);
  await page.getByRole("button", { name: channel }).click();
  await withTranscriptDiagnostics(page, testInfo, () =>
    expect(messageRow(page, seedFence)).toBeVisible(),
  );
  await expectSettled(page, { conversation: channel });
  const list = page.locator("[data-message-list]");
  await expect
    .poll(() => list.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(2_500);
  await expectContiguousRows(page, 2);

  await expect
    .poll(async () => {
      await driveToTranscriptTop(list);
      return messageRow(page, oldest).count();
    })
    .toBe(1);
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expectContiguousRows(page, 2);
  await throttleCpu(page, testInfo.project.name);
  await list.press("End");
  await withTranscriptDiagnostics(page, testInfo, () =>
    expect(messageRow(page, seedFence)).toBeVisible(),
  );
  await expectContiguousRows(page, 2);

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
  await expectContiguousRows(page, 2);

  await page.setViewportSize(
    phone ? { width: 844, height: 390 } : { width: 980, height: 800 },
  );
  await expectContiguousRows(page, 2);
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  await expectContiguousRows(page, 2);

  if (phone) {
    await keyboardGeometry(page, true);
    await expectContiguousRows(page, 2);
    await keyboardGeometry(page, false);
    await expectContiguousRows(page, 2);
  }

  await throttleCpu(page, testInfo.project.name, 1);
  await scrollAwayFromLiveEdge(page, list, {
    distance: 100,
    input: phone ? "touch" : "wheel",
    wheelDelta: 55,
  });
  const beforeJump = await mountedRowPositions(page);
  await throttleCpu(page, testInfo.project.name);
  const unseenText = `spacing unseen ${suffix}`;
  writer.privmsg(channel, unseenText);
  const jump = page.getByRole("button", { name: /new message/u });
  await expect(jump).toBeVisible();
  await expect.poll(() => mountedMessageRowKey(page, unseenText)).toBeTruthy();
  const unseenKey = await mountedMessageRowKey(page, unseenText);
  const afterJump = await mountedRowPositions(page);
  expect(afterJump.map(([key]) => key)).toContain(unseenKey);
  expect(commonRowKeys(beforeJump, afterJump).length).toBeGreaterThan(0);
  expect(commonRowShift(beforeJump, afterJump)).toBeLessThanOrEqual(1);
  await jump.click();
  await throttleCpu(page, testInfo.project.name, 1);
  await expectContiguousRows(page, 2);
});

test("paints hidden multiline catch-up without stale row gaps", async ({
  page,
  irc,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "webkit-phone-layout",
    "covers iPhone WebKit foreground layout",
  );
  await installNativeFeelInstrumentation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = irc.id;
  const channel = irc.channelNamed("sa-hidden");
  const startUrl = irc.url({ autojoin: [channel] });
  const writer = await irc.peer("sa-hidden-writer", [channel]);
  const hiddenMessages = [
    `hidden multiline one ${suffix} ${"variable width words for wrapping ".repeat(8)}\nsecond explicit line ${suffix}\n\nlast line ${suffix}`,
    `hidden long two ${suffix} ${"i".repeat(330)}`,
    `hidden multiline three ${suffix}\n${"another wrapped segment ".repeat(10)}\nfinal segment ${suffix}`,
  ] as const;
  await useDedicatedWorker(page);
  await page.goto(startUrl);
  await page.getByRole("button", { name: channel }).click();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & {
        __setNativeVisibility?: (hidden: boolean) => void;
      }
    ).__setNativeVisibility?.(true),
  );
  for (const text of hiddenMessages)
    await writer.multilineConfirmed(channel, text);
  await expect(
    page
      .locator("[data-message-row]")
      .filter({ hasText: hiddenMessages[0].split("\n")[0] }),
  ).toHaveCount(0);

  await captureFirstForegroundGaps(page, hiddenMessages);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __firstForegroundGaps?: readonly string[];
            }
          ).__firstForegroundGaps,
      ),
    )
    .toEqual([]);
  for (const text of hiddenMessages)
    await expect(
      page
        .locator("[data-message-row]")
        .filter({ hasText: text.split("\n")[0] }),
    ).toBeVisible();
  await expectContiguousRows(page, hiddenMessages.length);
});

async function leaveConversation(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.getByRole("button", { name: "Back to chats" }).click();
    return;
  }
  await page.getByRole("button", { name: /Local Ergo, online/u }).click();
}

async function driveToTranscriptTop(list: Locator): Promise<void> {
  await scrollToTranscriptTop(list);
}

function auditProject(project: string): boolean {
  return project === "chromium" || isPhoneProject(project);
}

function isPhoneProject(project: string): boolean {
  return (
    project === "android-phone-layout" || project === "webkit-phone-layout"
  );
}

function messageRow(page: Page, text: string): Locator {
  return page.locator(`[data-message-row][data-message-text="${text}"]`);
}

async function transcriptDensity(
  page: Page,
  unreadMessage: string,
  beforeDividerMessage: string,
) {
  return page.evaluate(
    ({ beforeDividerText, messageText }) => {
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
      const newDivider = blockPadding("[data-new-line]");
      const system = blockPadding(
        '[data-line-spacing="after-message"] [data-notice-row]',
      );
      const consecutiveLine = document.querySelector<HTMLElement>(
        '[data-line-spacing="after-line"] [data-notice-row]',
      );
      if (consecutiveLine === null)
        throw new Error("consecutive line is missing");
      const consecutiveLineStyle = getComputedStyle(consecutiveLine);
      const afterDividerMessage = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-line-spacing="after-divider"] [data-message-row]',
        ),
      ).find((row) => row.dataset.messageText === messageText);
      if (afterDividerMessage === undefined)
        throw new Error("post-divider message is missing");
      const afterDividerMessageStyle = getComputedStyle(afterDividerMessage);
      const afterDividerLine = document.querySelector<HTMLElement>(
        '[data-line-spacing="after-divider"] [data-system-line]',
      );
      if (afterDividerLine === null)
        throw new Error("post-divider line is missing");
      const beforeDivider = Array.from(
        document.querySelectorAll<HTMLElement>("[data-message-row]"),
      ).find((row) => row.dataset.messageText === beforeDividerText);
      const dayDivider = beforeDivider
        ?.closest("li")
        ?.nextElementSibling?.querySelector<HTMLElement>("[data-day-divider]");
      const afterDivider = dayDivider
        ?.closest("li")
        ?.nextElementSibling?.querySelector<HTMLElement>(
          "[data-system-line], [data-message-row]",
        );
      const dividerLabel = dayDivider?.querySelector<HTMLElement>("span");
      if (
        beforeDivider === undefined ||
        afterDivider === null ||
        afterDivider === undefined ||
        dividerLabel === null ||
        dividerLabel === undefined
      )
        throw new Error("painted divider neighbours are missing");
      const paintedBounds = (element: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };
      const beforeBounds = paintedBounds(beforeDivider);
      const afterBounds = paintedBounds(afterDivider);
      const labelBounds = dividerLabel.getBoundingClientRect();
      return {
        afterDividerLineBefore: Number.parseFloat(
          getComputedStyle(afterDividerLine).paddingBlockStart,
        ),
        afterDividerMessageBefore: Number.parseFloat(
          afterDividerMessageStyle.paddingBlockStart,
        ),
        consecutiveLineAfter: Number.parseFloat(
          consecutiveLineStyle.paddingBlockEnd,
        ),
        consecutiveLineBefore: Number.parseFloat(
          consecutiveLineStyle.paddingBlockStart,
        ),
        dividerAfter: divider.after,
        dividerBefore: divider.before,
        historyAfter: history.after,
        historyBefore: history.before,
        newAfter: newDivider.after,
        newBefore: newDivider.before,
        paintedDividerAfter: afterBounds.top - labelBounds.bottom,
        paintedDividerBefore: labelBounds.top - beforeBounds.bottom,
        systemAfter: system.after,
        systemBefore: system.before,
      };
    },
    { beforeDividerText: beforeDividerMessage, messageText: unreadMessage },
  );
}

async function expectContiguousRows(
  page: Page,
  minimumRows: number,
): Promise<void> {
  const rows = page.locator("li[data-row-key]");
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(minimumRows);
  await expect
    .poll(() =>
      rows.evaluateAll((elements) => {
        const ordered = elements
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

async function throttleCpu(
  page: Page,
  project: string,
  rate = 4,
): Promise<void> {
  if (project !== "chromium" && project !== "android-phone-layout") return;
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
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

async function captureFirstForegroundGaps(
  page: Page,
  messages: readonly string[],
): Promise<void> {
  await page.evaluate((expectedMessages) => {
    const state = window as Window & {
      __firstForegroundGaps?: readonly string[];
      __setNativeVisibility?: (hidden: boolean) => void;
    };
    const list = document.querySelector("[data-message-list]");
    if (list === null) throw new Error("message list is missing");
    const observer = new MutationObserver(() => {
      if (document.visibilityState !== "visible") return;
      const renderedMessages = [
        ...list.querySelectorAll<HTMLElement>("[data-message-row]"),
      ];
      const messagesPresent = expectedMessages.every((text) =>
        renderedMessages.some(
          (message) => message.dataset.messageText === text,
        ),
      );
      if (!messagesPresent) return;
      observer.disconnect();
      const rows = [...list.querySelectorAll<HTMLElement>("li[data-index]")]
        .map((row) => ({
          index: Number(row.dataset.index),
          key: row.dataset.rowKey,
          rect: row.getBoundingClientRect(),
        }))
        .sort((left, right) => left.index - right.index);
      state.__firstForegroundGaps = rows.slice(1).flatMap((current, index) => {
        const previous = rows[index];
        if (previous === undefined) return [];
        const gap = current.rect.top - previous.rect.bottom;
        return Math.abs(gap) <= 1
          ? []
          : [`${previous.key}->${current.key}:${gap}`];
      });
    });
    observer.observe(list, { childList: true, subtree: true });
    state.__setNativeVisibility?.(false);
  }, messages);
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

function mountedMessageRowKey(
  page: Page,
  text: string,
): Promise<string | undefined> {
  return messageRow(page, text).evaluateAll((rows) => {
    const row = rows[0]?.closest<HTMLElement>("li[data-row-key]");
    return row !== null &&
      row !== undefined &&
      row.getBoundingClientRect().height > 0
      ? row.dataset.rowKey
      : undefined;
  });
}

function commonRowKeys(
  before: readonly (readonly [string, number])[],
  after: readonly (readonly [string, number])[],
): readonly string[] {
  const afterKeys = new Set(after.map(([key]) => key));
  return before.flatMap(([key]) => (afterKeys.has(key) ? [key] : []));
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
