import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

test.describe("startup chat-list snapshot against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("persists a fetched server marker before the next launch", async ({
    baseURL,
    browser,
    context,
    page,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const suffix = Date.now().toString(36);
    const channel = `#snapshot-marker-${suffix}`;
    const preview = `stale marker preview ${suffix}`;
    const bot = await IrcClient.connect(
      `snapshot-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const snapshotPreview = `${bot.nickname}: ${preview}`;
    let current = page;
    let readerContext: BrowserContext | undefined;
    try {
      await openChannel(current, channel);
      await leaveConversation(current, channel);
      await bot.privmsgConfirmed(channel, preview);
      await expectUnread(bufferRow(current, channel), channel);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({
          badge: { kind: "unread", count: 1 },
          preview: snapshotPreview,
        });

      await current.close();
      readerContext = await browser.newContext({ baseURL });
      const reader = await readerContext.newPage();
      await useDedicatedWorker(reader);
      await reader.goto(startUrl(channel));
      await bufferRow(reader, channel).click();
      await expect(
        reader.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await expect(reader.getByText(preview, { exact: true })).toBeVisible();
      await expectRead(bufferRow(reader, channel), channel);

      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, channel);
      await current.goto(startUrl(channel));
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          label: `${channel}, 1 unread`,
        });
      await expectRead(bufferRow(current, channel), channel);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ badge: { kind: "none" }, preview: snapshotPreview });

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, channel);
      await current.goto(startUrl(channel));
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          label: channel,
        });
      if (await isMobile(current))
        await expect
          .poll(() => cachedRow(current))
          .toMatchObject({ text: expect.stringContaining(preview) });
    } finally {
      if (!current.isClosed()) await current.close();
      await readerContext?.close();
      bot.close();
    }
  });

  test("keeps a newer live preview when catch-up finishes behind it", async ({
    context,
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = "#weblounge-test";
    const missed = `older catch-up preview ${suffix}`;
    const live = `newer live preview ${suffix}`;
    const bot = await IrcClient.connect(
      `preview-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    let current = page;
    try {
      await useDedicatedWorker(current);
      await openConfiguredChannel(current, channel);
      const quit = bot.waitForNextQuit("weblounge");
      await current.close();
      await quit;
      await bot.privmsgConfirmed(channel, missed);

      const rejoined = bot.waitForNextJoin(channel, "weblounge");
      current = await context.newPage();
      await useDedicatedWorker(current);
      await current.goto(startUrl(channel));
      await rejoined;
      await bot.privmsgConfirmed(channel, live);
      await bufferRow(current, channel).click();
      await expect(
        current.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await expect(current.getByText(live, { exact: true })).toBeVisible();
      await expect(current.getByText(missed, { exact: true })).toBeVisible();
      if (isMobile(current))
        await expect(bufferRow(current, channel)).toContainText(live);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ preview: expect.stringContaining(live) });

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, channel);
      await current.goto(startUrl(channel));
      await expect.poll(() => cachedRow(current)).not.toBeUndefined();
      if (isMobile(current))
        await expect
          .poll(() => cachedRow(current))
          .toMatchObject({ text: expect.stringContaining(live) });
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({ preview: expect.stringContaining(live) });
    } finally {
      if (!current.isClosed()) await current.close();
      bot.close();
    }
  });
});

async function openChannel(page: Page, channel: string): Promise<void> {
  await useDedicatedWorker(page);
  await page.goto("/?irc-password=weblounge-test");
  const mobile = await isMobile(page);
  if (mobile)
    await page.getByRole("button", { name: "#weblounge-test" }).click();
  const composer = page.getByRole("textbox", {
    name: mobile ? "Message #weblounge-test" : "Message",
  });
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

async function openConfiguredChannel(
  page: Page,
  channel: string,
): Promise<void> {
  await useDedicatedWorker(page);
  await page.goto("/?irc-password=weblounge-test");
  await page.getByRole("button", { name: channel }).first().click();
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1_280) < 700;
}

async function leaveConversation(page: Page, channel: string): Promise<void> {
  if (isMobile(page)) {
    await page.getByRole("button", { name: "Back to chats" }).click();
  } else {
    await page.getByRole("button", { name: "#weblounge-test" }).click();
  }
  await expect(bufferRow(page, channel)).not.toHaveAttribute(
    "aria-current",
    "page",
  );
}

function bufferRow(page: Page, channel: string) {
  return page.locator("[data-buffer-id]").filter({ hasText: channel }).first();
}

async function expectUnread(
  row: ReturnType<typeof bufferRow>,
  channel: string,
): Promise<void> {
  await expect(row).toHaveAttribute("aria-label", `${channel}, 1 unread`);
}

async function expectRead(
  row: ReturnType<typeof bufferRow>,
  channel: string,
): Promise<void> {
  await expect(row).toHaveAttribute("aria-label", channel);
}

function startUrl(channel: string): string {
  return `/?irc-password=weblounge-test&irc-autojoin=${encodeURIComponent(channel)}`;
}

async function snapshotRow(page: Page, channel: string): Promise<unknown> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(async (value, title) => {
      const bytes = await new Promise<unknown>((resolve, reject) => {
        const request = value
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (!(bytes instanceof Uint8Array)) return undefined;
      const snapshot: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof snapshot !== "object" ||
        snapshot === null ||
        !("rows" in snapshot) ||
        !Array.isArray(snapshot.rows)
      )
        return undefined;
      return snapshot.rows.find(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          "title" in row &&
          row.title === title,
      );
    }, channel);
  } finally {
    await closeEngineDatabase(database);
  }
}

async function recordCachedRow(page: Page, channel: string): Promise<void> {
  await page.addInitScript((title) => {
    Reflect.set(globalThis, "staleSnapshotCachedRow", undefined);
    new MutationObserver(() => {
      if (Reflect.get(globalThis, "staleSnapshotCachedRow") !== undefined)
        return;
      const row = [
        ...document.querySelectorAll<HTMLElement>("[data-buffer-id]"),
      ].find((candidate) => candidate.textContent?.includes(title));
      if (row !== undefined)
        Reflect.set(globalThis, "staleSnapshotCachedRow", {
          label: row.getAttribute("aria-label"),
          text: row.textContent ?? "",
        });
    }).observe(document, { childList: true, subtree: true });
  }, channel);
}

function cachedRow(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "staleSnapshotCachedRow"));
}
