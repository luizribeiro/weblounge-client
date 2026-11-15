import type { Locator, Page } from "@playwright/test";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import {
  composer,
  conversationButton,
  expectRedactedByPeer,
  openConversation,
  openWithPeer,
  redactedRow,
  reviewShot,
  waitForReadDwell,
} from "./redaction";

test.describe("message redaction on desktop against local Ergo", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("shows a peer's channel deletion as bars", async ({ page, irc }) => {
    const peer = await openWithPeer(page, irc, "chan");
    await openConversation(page, irc.channel);
    await expectRedactedByPeer(page, irc, peer, irc.channel, "channel secret");
  });

  test("shows a peer's direct-message deletion as bars", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "dm");
    await peer.privmsgConfirmed(irc.account, "opening line");
    await openConversation(page, peer.nickname);
    await expectRedactedByPeer(page, irc, peer, irc.account, "direct secret");
  });

  test("deletes your own message after confirming, for everyone", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "own");
    await openConversation(page, irc.channel);
    const text = "I take this back";
    await composer(page).fill(text);
    await composer(page).press("Enter");
    const sent = await peer.waitForPrivmsg(irc.channel, text, irc.account);
    const row = productionMessageRow(page, text);
    await expect(row).toHaveAttribute("data-delivery", "confirmed");
    await waitForReadDwell(irc, irc.channel, serverTime(sent));

    await row.hover();
    await page.getByRole("button", { name: "More actions" }).click();
    await themedShots(page, "desktop-menu");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await row.locator("time").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete message" }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Delete this message?",
    });
    await expect(dialog).toBeVisible();
    await themedShots(page, "desktop-confirm");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText(text);

    await composer(page).click();
    await composer(page).press("ArrowUp");
    await expect(
      page.locator('li[data-selected="true"] [data-message-row]'),
    ).toContainText(text);
    await page.keyboard.press("Delete");
    await dialog.getByRole("button", { name: "Delete" }).click();

    await peer.waitForRedact(irc.channel, messageId(sent));
    await expect(productionMessageRow(page, text)).toHaveCount(0);
    await expect(redactedRow(page)).toContainText("Message deleted");
    await page.mouse.move(0, 0);
    await themedShots(page, "desktop-bars");
    await nativeFeelAudit(page);

    await page.goto(irc.url());
    await expect(conversationButton(page, irc.channel)).toBeVisible();
    await openConversation(page, irc.channel);
    await expect(
      page.locator("[data-message-list]").getByText(peer.nickname).first(),
    ).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    await expect(redactedRow(page)).toHaveCount(0);
  });

  test("keeps what you read still when a message above it is deleted", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "above");
    await openConversation(page, irc.channel);
    const text = longText("deleted above the fold");
    const above = await peer.privmsgConfirmed(irc.channel, text);
    const last = await sendFiller(peer, irc.channel, 30);
    await expect(productionMessageRow(page, "filler 30")).toBeVisible();
    await waitForReadDwell(irc, irc.channel, serverTime(last));
    await scrollToTop(page);
    await scrollBelow(page, productionMessageRow(page, text));
    const anchor = await firstVisibleRow(page);
    await resetNativeFeelLayoutShift(page);

    await peer.redactConfirmed(irc.channel, messageId(above));

    await expect(redactedRow(page)).toHaveCount(1);
    await expectRowTop(page, anchor);
    await expectNoLayoutShift(page);
  });

  test("shrinks a deleted message in place inside the viewport", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "inside");
    await openConversation(page, irc.channel);
    await sendFiller(peer, irc.channel, 20, "before");
    const text = longText("deleted in view");
    const target = await peer.privmsgConfirmed(irc.channel, text);
    const last = await sendFiller(peer, irc.channel, 20, "after");
    await waitForReadDwell(irc, irc.channel, serverTime(last));
    const row = productionMessageRow(page, text);
    await scrollToTop(page);
    await scrollToCentre(page, row);
    await expect(row).toBeInViewport();
    const before = await row.boundingBox();
    const anchor = await firstVisibleRow(page);
    await resetNativeFeelLayoutShift(page);

    await peer.redactConfirmed(irc.channel, messageId(target));

    const redacted = redactedRow(page);
    await expect(redacted).toHaveCount(1);
    await expectRowTop(page, anchor);
    await expect
      .poll(async () => (await redacted.boundingBox())?.y)
      .toBeCloseTo(before?.y ?? Number.NaN, 0);
    expect((await redacted.boundingBox())?.height ?? 0).toBeLessThan(
      before?.height ?? 0,
    );
    await expectNoLayoutShift(page);
  });
});

function longText(label: string): string {
  return `${label}: ${"a sentence that wraps across several lines of the transcript ".repeat(6)}`.trim();
}

async function sendFiller(
  peer: IrcClient,
  target: string,
  count: number,
  label = "filler",
): Promise<string> {
  let last = "";
  for (let index = 1; index <= count; index += 1)
    last = await peer.privmsgConfirmed(target, `${label} ${index}`);
  return last;
}

/**
 * Scrolls with the wheel, as a reader does: only user input takes the transcript off its live
 * edge, where it stays pinned to its end.
 */
async function wheelBy(page: Page, distance: number): Promise<void> {
  const list = page.locator("[data-message-list]");
  const box = await list.boundingBox();
  if (box === null) throw new Error("the message list is not visible");
  const scrollTop = () => list.evaluate((element) => element.scrollTop);
  const start = await scrollTop();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, distance);
  if (Math.abs(distance) >= 1) await expect.poll(scrollTop).not.toBe(start);
}

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

/** The row's and its message list's boxes, measured together. */
function rowAndList(
  row: Locator,
): Promise<{ readonly row: Box; readonly list: Box }> {
  return row.evaluate((element) => {
    const list = element.closest<HTMLElement>("[data-message-list]");
    if (list === null) throw new Error("the row is outside the message list");
    const box = (rect: DOMRect) => ({
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
    });
    return {
      row: box(element.getBoundingClientRect()),
      list: box(list.getBoundingClientRect()),
    };
  });
}

async function scrollToTop(page: Page): Promise<void> {
  const list = page.locator("[data-message-list]");
  const top = await list.evaluate((element) => element.scrollTop);
  if (top > 0) await wheelBy(page, -top - 200);
  await expect(page.getByText(/^Beginning of /u)).toBeVisible();
}

async function scrollBelow(page: Page, row: Locator): Promise<void> {
  const boxes = await rowAndList(row);
  await wheelBy(page, boxes.row.bottom - boxes.list.top + 4);
  await expect(row).not.toBeInViewport();
}

async function scrollToCentre(page: Page, row: Locator): Promise<void> {
  const boxes = await rowAndList(row);
  await wheelBy(page, boxes.row.top - (boxes.list.top + boxes.list.height / 3));
  await expect(row).toBeInViewport();
}

/**
 * Reading away from the live edge keeps the list's scroll bookkeeping busy, which the idle audit
 * counts, so these cases check the native-feel layout-shift budget once the geometry has settled;
 * the peer-deletion cases run the full idle audit at rest.
 */
async function expectNoLayoutShift(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __nativeFeelMetrics?: { layoutShift: number } })
            .__nativeFeelMetrics?.layoutShift ?? Number.POSITIVE_INFINITY,
      ),
    )
    .toBeLessThanOrEqual(0.01);
}

interface RowPosition {
  readonly key: string;
  readonly top: number;
}

function firstVisibleRow(page: Page): Promise<RowPosition> {
  return page.locator("[data-message-list]").evaluate((element) => {
    const listTop = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("li[data-row-key]")]
      .map((item) => ({ item, top: item.getBoundingClientRect().top }))
      .filter(({ top }) => top >= listTop)
      .sort((left, right) => left.top - right.top)[0];
    if (row === undefined) throw new Error("no row is visible");
    return { key: row.item.dataset.rowKey ?? "", top: row.top };
  });
}

async function expectRowTop(page: Page, row: RowPosition): Promise<void> {
  await expect
    .poll(async () =>
      Math.round(
        (await page
          .locator(`li[data-row-key="${row.key}"]`)
          .evaluate((element) => element.getBoundingClientRect().top)) -
          row.top,
      ),
    )
    .toBe(0);
}

async function themedShots(page: Page, name: string): Promise<void> {
  for (const [scheme, theme] of [
    ["light", "lounge"],
    ["dark", "lounge-night"],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await reviewShot(page, `${name}-${theme}`);
  }
  await page.emulateMedia({ colorScheme: null });
}
