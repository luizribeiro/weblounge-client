import type { Locator, Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import { composer, openConversation, openWithPeer } from "./redaction";
import { expectSettled } from "./settled";

test.describe("row toolbars on desktop against local Ergo", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("keeps a row's menu open while you hover other rows, which show no toolbar", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "menu");
    await openConversation(page, irc.channel);
    await sendLines(peer, irc.channel, 3);
    const own = await sendOwn(page, "my menu row");
    await sendLines(peer, irc.channel, 2, "after");
    await expectSettled(page);
    await recordToolbarPeak(page);

    await own.hover();
    await own.getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu", { name: "Message actions" });
    await expect(menu).toBeVisible();
    await productionMessageRow(page, "line 2").hover();
    await productionMessageRow(page, "after 1").hover();

    await expect(menu).toBeVisible();
    await expect(toolbars(page)).toHaveCount(1);
    await expect(toolbars(own)).toHaveCount(1);
    expect(await toolbarPeak(page)).toBe(1);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(own).toBeFocused();
    await page.locator("[data-message-list]").focus();
    await productionMessageRow(page, "after 2").hover();
    await expect(toolbars(productionMessageRow(page, "after 2"))).toHaveCount(
      1,
    );
    await page.mouse.move(0, 0);
    await expectSettled(page);
    await nativeFeelAudit(page);
  });

  test("keeps the toolbar's menu on its row as the transcript scrolls, and closes it once the row leaves", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "follow");
    await openConversation(page, irc.channel);
    await sendLines(peer, irc.channel, 20, "before");
    const own = await sendOwn(page, "my scrolling row");
    await sendLines(peer, irc.channel, 6, "after");
    await expectSettled(page);

    await own.hover();
    const more = own.getByRole("button", { name: "More actions" });
    await more.click();
    const menu = page.getByRole("menu", { name: "Message actions" });
    await expect(menu).toBeVisible();
    const gap = () => verticalGap(more, menu);
    const opened = await gap();

    await wheelTranscript(page, -40);
    await expect.poll(gap).toBe(opened);
    await expect(menu).toBeVisible();

    await wheelTranscript(page, -2000);
    await expect(menu).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expectSettled(page);
    await nativeFeelAudit(page);
  });

  test("leaves no reaction bar behind when an outside click closes the picker", async ({
    page,
    irc,
  }) => {
    const peer = await openWithPeer(page, irc, "outside");
    await openConversation(page, irc.channel);
    await sendLines(peer, irc.channel, 4);
    await expectSettled(page);
    await recordToolbarPeak(page);

    for (const text of ["line 2", "line 3"]) {
      const row = productionMessageRow(page, text);
      await row.hover();
      await row.getByRole("button", { name: "Add reaction" }).click();
      const picker = page.getByRole("dialog", { name: "Add reaction" });
      await expect(picker).toBeVisible();
      await composer(page).click();
      await expect(picker).toHaveCount(0);
    }

    await expect(toolbars(page)).toHaveCount(0);
    expect(await toolbarPeak(page)).toBe(1);
  });

  test("shows at most one row toolbar while the pointer sweeps rows that scroll and change", async ({
    page,
    irc,
    browserName,
  }) => {
    await installNativeFeelInstrumentation(page);
    const peer = await openWithPeer(page, irc, "sweep");
    await openConversation(page, irc.channel);
    await sendLines(peer, irc.channel, 24);
    await expectSettled(page);
    await recordToolbarPeak(page);

    // WebKit gives programmatic focus no focus ring, so only Chromium can start from a row
    // that keyboard focus already shows.
    if (browserName === "chromium") {
      await page.keyboard.press("Shift");
      await productionMessageRow(page, "line 20").focus();
      await expect(toolbars(productionMessageRow(page, "line 20"))).toHaveCount(
        1,
      );
    }
    await sweepRows(page);
    await wheelTranscript(page, -120);
    await sweepRows(page);
    const arriving = sendLines(peer, irc.channel, 3, "arriving");
    await sweepRows(page);
    await arriving;
    await sweepRows(page);

    expect(await toolbarPeak(page)).toBe(1);
  });
});

async function sendLines(
  peer: IrcClient,
  target: string,
  count: number,
  label = "line",
): Promise<void> {
  for (let index = 1; index <= count; index += 1)
    await peer.privmsgConfirmed(target, `${label} ${index}`);
}

async function sendOwn(page: Page, text: string): Promise<Locator> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  const row = productionMessageRow(page, text);
  await expect(row).toHaveAttribute("data-delivery", "confirmed");
  return row;
}

function toolbars(scope: Page | Locator): Locator {
  return scope.locator("[data-reaction-toolbar]");
}

/** Records, in the page, the most row toolbars ever on screen at once from now on. */
async function recordToolbarPeak(page: Page): Promise<void> {
  await page.evaluate(() => {
    const count = () =>
      document.querySelectorAll("[data-reaction-toolbar]").length;
    const record = window as unknown as { toolbarPeak: number };
    record.toolbarPeak = count();
    new MutationObserver(() => {
      record.toolbarPeak = Math.max(record.toolbarPeak, count());
    }).observe(document.body, { childList: true, subtree: true });
  });
}

function toolbarPeak(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { toolbarPeak: number }).toolbarPeak,
  );
}

/** Moves the pointer down and back up across the transcript in small steps. */
async function sweepRows(page: Page): Promise<void> {
  const box = await transcriptBox(page);
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 10);
  await page.mouse.move(x, box.y + box.height - 10, { steps: 25 });
  await page.mouse.move(x, box.y + 10, { steps: 25 });
}

async function wheelTranscript(
  page: Page,
  distance: number,
  at: { readonly x: number; readonly y: number } = { x: 0.5, y: 0.5 },
): Promise<void> {
  const list = page.locator("[data-message-list]");
  const box = await transcriptBox(page);
  const scrollTop = () => list.evaluate((element) => element.scrollTop);
  const start = await scrollTop();
  await page.mouse.move(box.x + box.width * at.x, box.y + box.height * at.y);
  await page.mouse.wheel(0, distance);
  await expect.poll(scrollTop).not.toBe(start);
}

async function transcriptBox(page: Page) {
  const box = await page.locator("[data-message-list]").boundingBox();
  if (box === null) throw new Error("the message list is not visible");
  return box;
}

async function verticalGap(anchor: Locator, layer: Locator): Promise<number> {
  const [from, to] = await Promise.all([
    anchor.boundingBox(),
    layer.boundingBox(),
  ]);
  if (from === null || to === null) throw new Error("a box is not visible");
  return Math.round(to.y - from.y);
}
