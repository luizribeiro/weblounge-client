import { mkdir } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";
import { armMessageTime } from "./time-rewrite";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("keeps highlighted transcript rows in the message rhythm and scroll layer", async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo.project.name);
  test.skip(
    !phone && testInfo.project.name !== "chromium",
    "runs in desktop Chromium and the phone-layout projects",
  );
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  await page.emulateMedia({ colorScheme: "dark" });
  const suffix = `${testInfo.project.name.slice(0, 2)}${Date.now().toString(36).slice(-5)}`;
  const account = `hluser${suffix}`;
  const channel = `#hl-row-${suffix}`;
  const startUrl = await isolatedStartUrl(account, channel);
  const first = await IrcClient.connect(
    `hl-first-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const second = await IrcClient.connect(
    `hl-second-${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    channel,
  );
  const messages = highlightMessages(account, suffix);
  try {
    await useDedicatedWorker(page);
    await page.goto(startUrl);
    await expect(page.getByRole("button", { name: channel })).toBeVisible();
    await page.getByRole("button", { name: channel }).click();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();

    const minute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    await sendAt(page, first, channel, messages.normalBefore, minute + 1_000);
    await sendAt(page, second, channel, messages.normalAfter, minute + 2_000);
    await sendAt(
      page,
      first,
      channel,
      messages.highlightedGroup,
      minute + 3_000,
    );
    await sendAt(
      page,
      second,
      channel,
      messages.afterHighlight,
      minute + 4_000,
    );
    await sendAt(
      page,
      first,
      channel,
      messages.normalGroupStart,
      minute + 5_000,
    );
    await sendAt(
      page,
      first,
      channel,
      messages.normalContinuation,
      minute + 6_000,
    );
    await sendAt(page, second, channel, messages.breakGroup, minute + 7_000);
    await sendAt(
      page,
      first,
      channel,
      messages.highlightGroupStart,
      minute + 8_000,
    );
    await sendAt(
      page,
      first,
      channel,
      messages.highlightedContinuation,
      minute + 9_000,
    );

    const highlightedGroup = messageRow(page, messages.highlightedGroup);
    const highlightedContinuation = messageRow(
      page,
      messages.highlightedContinuation,
    );
    await expect(highlightedGroup).toBeVisible();
    await expect(highlightedContinuation).toHaveAttribute(
      "data-message-group-start",
      "false",
    );
    await expectHighlight(highlightedGroup);
    await expectHighlight(highlightedContinuation);
    expect(await highlightInsets(highlightedGroup)).toEqual(
      phone ? { end: -8, start: 8 } : { end: 0, start: 0 },
    );
    expect(await highlightInsets(highlightedContinuation)).toEqual(
      phone ? { end: -3, start: 3 } : { end: 0, start: 0 },
    );

    await captureScenario(
      page,
      testInfo.project.name,
      "group",
      highlightedGroup,
    );
    await captureScenario(
      page,
      testInfo.project.name,
      "same-minute",
      highlightedContinuation,
    );

    await sendAt(
      page,
      second,
      channel,
      messages.liveEdgeHighlight,
      minute + 10_000,
    );
    const liveEdgeHighlight = messageRow(page, messages.liveEdgeHighlight);
    await expect(liveEdgeHighlight).toBeVisible();
    await expectHighlight(liveEdgeHighlight);
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);
    await captureScenario(
      page,
      testInfo.project.name,
      "live-edge",
      liveEdgeHighlight,
      true,
    );

    const normalGroupGap = await textGap(
      messageRow(page, messages.normalBefore),
      messageRow(page, messages.normalAfter),
    );
    await expect
      .poll(() =>
        textGap(messageRow(page, messages.normalAfter), highlightedGroup),
      )
      .toBeCloseTo(normalGroupGap, 0);
    await expect
      .poll(() =>
        textGap(highlightedGroup, messageRow(page, messages.afterHighlight)),
      )
      .toBeCloseTo(normalGroupGap, 0);

    if (phone) {
      const normalContinuationGap = await textGap(
        messageRow(page, messages.normalGroupStart),
        messageRow(page, messages.normalContinuation),
      );
      await expect
        .poll(() =>
          textGap(
            messageRow(page, messages.highlightGroupStart),
            highlightedContinuation,
          ),
        )
        .toBeCloseTo(normalContinuationGap, 0);
    }

    const layers = await rowLayerStyles(
      messageRow(page, messages.normalAfter),
      highlightedGroup,
    );
    expect(layers.highlightedPaint).toEqual(layers.normalPaint);
    expect(layers.highlightedRow).toEqual(layers.normalRow);
    expect(layers.motionLayer.willChange).toBe("auto");
  } finally {
    second.close();
    first.close();
  }
});

function isPhoneProject(name: string): boolean {
  return name === "android-phone-layout" || name === "webkit-phone-layout";
}

function highlightMessages(account: string, suffix: string) {
  return {
    normalBefore: `normal before ${suffix}`,
    normalAfter: `normal after ${suffix}`,
    highlightedGroup: `highlighted group for ${account} ${suffix}`,
    afterHighlight: `after highlight ${suffix}`,
    normalGroupStart: `normal group start ${suffix}`,
    normalContinuation: `normal continuation ${suffix}`,
    breakGroup: `group break ${suffix}`,
    highlightGroupStart: `highlight group start ${suffix}`,
    highlightedContinuation: `continuation for ${account} ${suffix}`,
    liveEdgeHighlight: `live edge for ${account} ${suffix}`,
  } as const;
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

async function sendAt(
  page: Page,
  client: IrcClient,
  channel: string,
  text: string,
  time: number,
): Promise<void> {
  await armMessageTime(text, time);
  await client.privmsgConfirmed(channel, text);
  await expect(messageRow(page, text)).toBeVisible();
}

function messageRow(page: Page, text: string): Locator {
  return page.locator(`[data-message-row][data-message-text="${text}"]`);
}

async function expectHighlight(row: Locator): Promise<void> {
  await expect
    .poll(() =>
      row.evaluate(
        (element) =>
          getComputedStyle(element, "::before").backgroundColor !==
          "rgba(0, 0, 0, 0)",
      ),
    )
    .toBe(true);
}

function highlightInsets(row: Locator) {
  return row.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return {
      end: Number.parseFloat(style.insetBlockEnd),
      start: Number.parseFloat(style.insetBlockStart),
    };
  });
}

async function textGap(before: Locator, after: Locator): Promise<number> {
  const [beforeBox, afterBox] = await Promise.all([
    before.locator("[data-selectable]").boundingBox(),
    after.locator("[data-selectable]").boundingBox(),
  ]);
  if (beforeBox === null || afterBox === null)
    throw new Error("message content is not rendered");
  return afterBox.y - beforeBox.y - beforeBox.height;
}

function distanceFromBottom(page: Page): Promise<number> {
  return page.locator("[data-message-list]").evaluate((element) => {
    const list = element as HTMLElement;
    return list.scrollHeight - list.scrollTop - list.clientHeight;
  });
}

async function rowLayerStyles(normal: Locator, highlighted: Locator) {
  const highlightedRow = await highlighted.elementHandle();
  if (highlightedRow === null)
    throw new Error("highlighted row is not rendered");
  return normal.evaluate((normalRow, highlightedRow) => {
    const rowStyles = (row: Element) => {
      const virtualRow = row.closest<HTMLElement>("li[data-index]");
      if (virtualRow === null) throw new Error("message has no virtual row");
      const style = getComputedStyle(virtualRow);
      return {
        isolation: style.isolation,
        position: style.position,
        transform: style.transform === "none" ? "none" : "positioned",
        willChange: style.willChange,
        zIndex: style.zIndex,
      };
    };
    const paintStyles = (row: Element) => {
      const style = getComputedStyle(row);
      return {
        isolation: style.isolation,
        position: style.position,
        transform: style.transform,
        willChange: style.willChange,
        zIndex: style.zIndex,
      };
    };
    const motionLayer = normalRow.closest<HTMLElement>(
      "[data-message-motion-layer]",
    );
    if (motionLayer === null) throw new Error("message has no motion layer");
    const layerStyle = getComputedStyle(motionLayer);
    return {
      highlightedPaint: paintStyles(highlightedRow),
      highlightedRow: rowStyles(highlightedRow),
      motionLayer: {
        isolation: layerStyle.isolation,
        transform: layerStyle.transform,
        willChange: layerStyle.willChange,
        zIndex: layerStyle.zIndex,
      },
      normalPaint: paintStyles(normalRow),
      normalRow: rowStyles(normalRow),
    };
  }, highlightedRow);
}

async function captureScenario(
  page: Page,
  project: string,
  scenario: string,
  row: Locator,
  liveEdge = false,
): Promise<void> {
  const root = process.env.WEBLOUNGE_HIGHLIGHT_SCREENSHOT_DIR;
  if (root === undefined || project === "android-phone-layout") return;
  await page.locator("[data-toast]").evaluateAll((toasts) => {
    for (const toast of toasts) toast.remove();
  });
  if (liveEdge) {
    await page.locator("[data-message-list]").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  } else {
    await row.evaluate((element) => {
      const list = element.closest<HTMLElement>("[data-message-list]");
      if (list === null) throw new Error("message has no scroll owner");
      const listBox = list.getBoundingClientRect();
      const rowBox = element.getBoundingClientRect();
      list.scrollTop +=
        rowBox.top -
        listBox.top -
        Math.max((list.clientHeight - rowBox.height) / 2, 0);
    });
  }
  const shell = isPhoneProject(project) ? "phone" : "desktop";
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: `${root}/${shell}-${scenario}.png` });
}
