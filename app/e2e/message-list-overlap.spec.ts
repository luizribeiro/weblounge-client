import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  firstLongMessage,
  harnessHistoryLength,
  longNick,
  secondLongMessage,
} from "./timeline-fixtures";
import {
  framesPerSecond,
  messageRow,
  timelineOverlapsOverFrames,
} from "./timeline-geometry";

const lastHistoryId = harnessHistoryLength;
const firstLongId = harnessHistoryLength + 1;
const screenshots = path.join(process.cwd(), "e2e", "screenshots");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/e2e/message-list-overlap.html");
  await page.evaluate(() => document.fonts.load("14px Inter"));
  await expect(
    page.getByText(`earlier message ${lastHistoryId}`),
  ).toBeVisible();
  await page.locator("[data-message-list]").evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 40;
  });
  await expect(page.locator("[data-overlap-harness]")).toHaveAttribute(
    "data-live-edge",
    "false",
  );
});

function append(page: Page, texts: readonly string[], readThrough: number) {
  return page.evaluate(
    ([items, marker]) => window.messageListOverlap?.append(items, marker),
    [texts, readThrough] as const,
  );
}

test("ellipsizes a 16-character nick inside the aligned mode slot", async ({
  page,
}) => {
  expect(Array.from(longNick)).toHaveLength(16);
  const prefixedRow = messageRow(
    page,
    `earlier message ${harnessHistoryLength - 1}`,
  );
  const plainRow = messageRow(page, `earlier message ${harnessHistoryLength}`);
  const nick = prefixedRow.getByTitle(longNick);
  await expect(nick).toHaveCSS("text-overflow", "ellipsis");
  await expect(nick).toHaveCSS("overflow", "hidden");
  expect(
    await nick.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  const [prefixedSlot, plainSlot] = await Promise.all([
    prefixedRow
      .locator("[data-mode-slot]")
      .evaluate((element) => element.getBoundingClientRect().width),
    plainRow
      .locator("[data-mode-slot]")
      .evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(prefixedSlot).toBeGreaterThan(0);
  expect(plainSlot).toBe(prefixedSlot);

  await mkdir(screenshots, { recursive: true });
  await prefixedRow.screenshot({
    path: path.join(screenshots, "message-long-nick.png"),
  });
});

async function expectMeasuredAwayFromEstimate(page: Page, text: string) {
  const width = await page
    .locator("[data-message-list]")
    .evaluate((list) => list.clientWidth);
  const estimate = await page.evaluate(
    ([body, listWidth]) =>
      window.messageListOverlap?.estimate(body, listWidth) ?? 0,
    [text, width] as const,
  );
  const measured = await messageRow(page, text).evaluate(
    (row) => row.getBoundingClientRect().height,
  );
  expect(measured).not.toBe(estimate);
}

async function expectNewDividerAfter(page: Page, readThrough: number) {
  await expect(
    page
      .locator("li[data-index]")
      .filter({ has: page.locator("[data-new-line]") }),
  ).toHaveAttribute("data-row-key", `new-after-${readThrough}`);
}

async function expectStackedTimeline(page: Page) {
  await expect(messageRow(page, firstLongMessage)).toBeVisible();
  expect(
    await timelineOverlapsOverFrames(
      page.locator("[data-message-list]"),
      framesPerSecond,
    ),
  ).toEqual([]);
}

test("stacks a long live message when the read boundary passes the previous one", async ({
  page,
}) => {
  await append(page, [firstLongMessage], lastHistoryId);
  await expectNewDividerAfter(page, lastHistoryId);
  await expectStackedTimeline(page);
  await expectMeasuredAwayFromEstimate(page, firstLongMessage);

  await append(page, [secondLongMessage], firstLongId);

  await expectNewDividerAfter(page, firstLongId);
  await expect(messageRow(page, secondLongMessage)).toBeAttached();
  await expectStackedTimeline(page);
});

test("restacks the new divider when the read boundary passes a measured long row", async ({
  page,
}) => {
  await append(page, [firstLongMessage, secondLongMessage], lastHistoryId);
  await expectNewDividerAfter(page, lastHistoryId);
  await expectStackedTimeline(page);
  await expectMeasuredAwayFromEstimate(page, firstLongMessage);

  await page.evaluate(
    (readThrough) => window.messageListOverlap?.markRead(readThrough),
    firstLongId,
  );

  await expectNewDividerAfter(page, firstLongId);
  await expectStackedTimeline(page);
});
