import type { Locator, Page } from "@playwright/test";
import { copiedText, prepareClipboard } from "./clipboard";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import { composer, openConversation } from "./redaction";
import { tokenColor } from "./token-color";

const first = "nice, the second message has a few words";
const second = "and this one follows it";
const time = String.raw`\[\d{2}:\d{2}\]`;

test.describe("desktop copying from the transcript", () => {
  test.beforeEach(async ({ page }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1200, height: 800 });
  });

  test("copies exactly the text dragged over inside one message", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("copy-part");
    await peer.privmsgConfirmed(irc.channel, first);
    await openTranscript(page, irc.url(), irc.channel);

    const text = messageText(page, first);
    const part = "second message";
    const start = first.indexOf(part);
    await drag(
      page,
      await charPoint(text, start),
      await charPoint(text, start + part.length),
    );

    expect(await copySelection(page)).toBe(part);
    await nativeFeelAudit(page);
  });

  test("copies a double-clicked word on its own", async ({ page, irc }) => {
    const peer = await irc.peer("copy-word");
    await peer.privmsgConfirmed(irc.channel, first);
    await openTranscript(page, irc.url(), irc.channel);

    const word = await charPoint(
      messageText(page, first),
      first.indexOf("second") + 2,
    );
    await page.mouse.dblclick(word.x, word.y);

    expect(await copySelection(page)).toBe("second");
  });

  test("copies a selection across messages as prefixed log lines", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("copy-rows");
    await peer.privmsgConfirmed(irc.channel, first);
    await peer.privmsgConfirmed(irc.channel, second);
    await openTranscript(page, irc.url(), irc.channel);

    await drag(
      page,
      await charPoint(messageText(page, first), 10),
      await charPoint(messageText(page, second), 6),
    );

    const selection = await tokenColor(page, "--wl-color-selection");
    for (const text of [first, second]) {
      const row = productionMessageRow(page, text);
      await expect(row.locator("time [data-line]")).toHaveCSS(
        "background-color",
        selection,
      );
      await expect(
        row
          .locator("[data-message-chrome]")
          .getByText(peer.nickname, { exact: true }),
      ).toHaveCSS("background-color", selection);
    }
    expect(await copySelection(page)).toMatch(
      new RegExp(
        `^${time} <${peer.nickname}> ${first}\\n${time} <${peer.nickname}> ${second}$`,
        "u",
      ),
    );

    const firstText = await charPoint(messageText(page, first), 2);
    await page.mouse.click(firstText.x, firstText.y);
    await expect(page.locator("[data-copy-selected]")).toHaveCount(0);
    await nativeFeelAudit(page);
  });

  test("selects text when a drag starts on a link", async ({ page, irc }) => {
    const peer = await irc.peer("copy-link");
    const url = `http://127.0.0.1:4174/copy-${irc.id}`;
    const linked = `see ${url} for details`;
    await peer.privmsgConfirmed(irc.channel, linked);
    await peer.privmsgConfirmed(irc.channel, second);
    await openTranscript(page, irc.url(), irc.channel);

    const link = productionMessageRow(page, linked).getByRole("link");
    const popup = page.waitForEvent("popup");
    await link.click();
    await (await popup).close();
    await drag(
      page,
      await charPoint(messageText(page, linked), linked.indexOf("127")),
      await charPoint(messageText(page, second), 6),
    );

    expect(await copySelection(page)).toMatch(
      new RegExp(
        `^${time} <${peer.nickname}> ${linked}\\n${time} <${peer.nickname}> ${second}$`,
        "u",
      ),
    );
    await expect(link).toHaveAttribute("href", url);
  });

  test("keeps a pressed link a link and restores it wherever the press ends", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("copy-press");
    const url = `http://127.0.0.1:4174/press-${irc.id}`;
    const linked = `read ${url} first`;
    await peer.privmsgConfirmed(irc.channel, linked);
    await openTranscript(page, irc.url(), irc.channel);
    const link = productionMessageRow(page, linked).getByRole("link", {
      name: url,
    });
    const point = await charPoint(
      messageText(page, linked),
      linked.indexOf("127"),
    );

    await page.mouse.move(point.x, point.y);
    for (const button of ["middle", "right"] as const) {
      await page.mouse.down({ button });
      await expect(link).toHaveAttribute("href", url);
      await page.mouse.up({ button });
    }
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await expect(link).toHaveAttribute("href", url);
    await page.mouse.up();
    await page.keyboard.up("Shift");

    await page.mouse.down();
    await expect(link).toBeVisible();
    await page.mouse.move(-20, point.y, { steps: 4 });
    await page.mouse.up();
    await expect(link).toHaveAttribute("href", url);
  });

  test("copies only the triple-clicked message", async ({ page, irc }) => {
    const peer = await irc.peer("copy-para");
    await peer.privmsgConfirmed(irc.channel, first);
    await peer.privmsgConfirmed(irc.channel, second);
    await openTranscript(page, irc.url(), irc.channel);

    const point = await charPoint(messageText(page, first), 10);
    await page.mouse.click(point.x, point.y, { clickCount: 3 });

    expect(await copySelection(page)).toBe(first);
  });
});

test.describe("desktop Copy text action", () => {
  test.beforeEach(async ({ page, context }) => {
    await prepareClipboard(context);
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1200, height: 800 });
  });

  test("copies a peer's multi-line message from the More menu", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("copy-menu");
    const lines = "deploy notes\nstep one done\nstep two pending";
    await peer.multilineConfirmed(irc.channel, lines);
    await openTranscript(page, irc.url(), irc.channel);

    const row = productionMessageRow(page, lines);
    await row.hover();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Delete message" }),
    ).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Copy text" }).click();

    await expect.poll(() => copiedText(page)).toBe(lines);
    await nativeFeelAudit(page);
  });

  test("copies your own message from the row's right-click menu", async ({
    page,
    irc,
  }) => {
    await openTranscript(page, irc.url(), irc.channel);
    const own = "my own words to copy";
    await composer(page).fill(own);
    await composer(page).press("Enter");
    const row = productionMessageRow(page, own);
    await expect(row).toHaveAttribute("data-delivery", "confirmed");

    await row.locator("time").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy text" }).click();

    await expect.poll(() => copiedText(page)).toBe(own);
  });
});

async function openTranscript(
  page: Page,
  url: string,
  channel: string,
): Promise<void> {
  await page.goto(url);
  await openConversation(page, channel);
}

function messageText(page: Page, text: string): Locator {
  return productionMessageRow(page, text).locator("[data-selectable]");
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** A point just inside the left edge of a character, so a press there lands before it. */
async function charPoint(text: Locator, index: number): Promise<Point> {
  await expect(text).toBeVisible();
  return text.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const length = node.textContent?.length ?? 0;
      if (remaining < length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, remaining + 1);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 4, y: box.top + box.height / 2 };
      }
      remaining -= length;
    }
    throw new Error(`character ${offset} is outside the message`);
  }, index);
}

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** Records the copy event's payload, which is what the app writes for a keyboard copy. */
async function copySelection(page: Page): Promise<string | undefined> {
  await page.evaluate(() => {
    const state = window as Window & { __copiedSelection?: string };
    state.__copiedSelection = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        state.__copiedSelection =
          event.clipboardData?.getData("text/plain") ?? "";
      },
      { once: true },
    );
  });
  await page.keyboard.press("ControlOrMeta+c");
  return page.evaluate(
    () => (window as Window & { __copiedSelection?: string }).__copiedSelection,
  );
}
