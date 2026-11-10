import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  scrollAwayFromLiveEdge,
  scrollToTranscriptTop,
} from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { useDedicatedWorker } from "./production-ergo";
import { seedMixedConversation } from "./spacing-audit-fixture";

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
    await composer.fill("/topic");
    await composer.press("Enter");
    await expect(page.locator("[data-notice-row]")).toHaveCount(2);

    const list = page.locator("[data-message-list]");
    if (phone) {
      await scrollToTranscriptTop(list);
    } else {
      await list.hover();
      await page.mouse.wheel(0, -100_000);
    }
    await expect(page.locator("[data-history-edge]")).toContainText(
      "Start of history",
    );
    await leaveConversation(page, phone);
    await scenario.sendUnread();
    await page.getByRole("button", { name: scenario.channel }).click();
    await expect(messageRow(page, scenario.unreadMessage)).toBeVisible();
    await expect(page.locator("[data-new-line]")).toBeVisible();
    const density = await transcriptDensity(page, scenario.unreadMessage);
    expect(density.dividerBefore).toBeCloseTo(density.dividerAfter, 0);
    expect(density.dividerBefore).toBeCloseTo(phone ? 14 : 10, 0);
    expect(density.systemBefore).toBeCloseTo(phone ? 12 : 3, 0);
    expect(density.systemAfter).toBeCloseTo(phone ? 0 : 3, 0);
    expect(density.consecutiveLineBefore).toBeCloseTo(phone ? 4 : 3, 0);
    expect(density.consecutiveLineAfter).toBeCloseTo(phone ? 0 : 3, 0);
    expect(density.afterDividerMessageBefore).toBeCloseTo(phone ? 0 : 3, 0);
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
    await expect(page.locator("[data-notice-row]").first()).toBeVisible();
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

test("paints hidden multiline catch-up without stale row gaps", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "webkit-phone-layout",
    "covers iPhone WebKit foreground layout",
  );
  await installNativeFeelInstrumentation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = suffixFor(testInfo.project.name);
  const account = `sa-hidden-${suffix}`;
  const channel = `#sa-hidden-${suffix}`;
  const startUrl = await isolatedStartUrl(account, channel);
  const writer = await IrcClient.connect(
    `sa-hidden-writer-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const hiddenMessages = [
    `hidden multiline one ${suffix} ${"variable width words for wrapping ".repeat(8)}\nsecond explicit line ${suffix}\n\nlast line ${suffix}`,
    `hidden long two ${suffix} ${"i".repeat(330)}`,
    `hidden multiline three ${suffix}\n${"another wrapped segment ".repeat(10)}\nfinal segment ${suffix}`,
  ] as const;
  try {
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
    await expectContiguousRows(page);
  } finally {
    writer.close();
  }
});

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

async function transcriptDensity(page: Page, unreadMessage: string) {
  return page.evaluate((messageText) => {
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
    const system = blockPadding(
      '[data-phone-spacing="after-message"] [data-membership-row]',
    );
    const consecutiveLine = document.querySelector<HTMLElement>(
      '[data-phone-spacing="after-line"] [data-notice-row]',
    );
    if (consecutiveLine === null)
      throw new Error("consecutive line is missing");
    const consecutiveLineStyle = getComputedStyle(consecutiveLine);
    const afterDividerMessage = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-phone-spacing="after-divider"] [data-message-row]',
      ),
    ).find((row) => row.dataset.messageText === messageText);
    if (afterDividerMessage === undefined)
      throw new Error("post-divider message is missing");
    const afterDividerMessageStyle = getComputedStyle(afterDividerMessage);
    return {
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
      systemAfter: system.after,
      systemBefore: system.before,
    };
  }, unreadMessage);
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
