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

      const quit = bot.waitForNextQuit("weblounge");
      await current.close();
      await quit;
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
      await openSnapshotInspector(current);
      await expect
        .poll(() => snapshotRow(current, channel))
        .toMatchObject({
          badge: { kind: "unread", count: 1 },
          preview: snapshotPreview,
        });
      await useDedicatedWorker(current);
      await current.goto(startUrl(channel));
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
      await expect
        .poll(() => transcriptOrders(current, missed, live))
        .toBe(true);
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

  test("persists a read channel and the final live rows across relaunch", async ({
    context,
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#badge-relaunch-${suffix}`;
    const emptyChannel = `#badge-empty-${suffix}`;
    const bot = await IrcClient.connect(
      `badge-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const markerReader = await IrcClient.connect(
      "weblounge",
      "weblounge",
      "weblounge-test",
      channel,
    );
    const titles = [bot.nickname, channel, emptyChannel];
    let current = page;
    try {
      await useDedicatedWorker(current);
      await current.goto(startUrl(channel, emptyChannel));
      await expect(bufferRow(current, channel)).toBeVisible();
      await expect(bufferRow(current, emptyChannel)).toBeVisible();

      const directFirst = await bot.privmsgConfirmed(
        "weblounge",
        `initial direct ${suffix}`,
      );
      const directFirstId = messageTag(directFirst, "msgid");
      const directReply = await bot.privmsgReplyConfirmed(
        "weblounge",
        `reply-tagged direct ${suffix}`,
        directFirstId,
      );
      const directReplyId = messageTag(directReply, "msgid");
      await expectUnreadCount(
        bufferRow(current, bot.nickname),
        bot.nickname,
        2,
      );
      await expect
        .poll(() => snapshotRow(current, bot.nickname))
        .toMatchObject({
          badge: { kind: "mentions", count: 2, mentions: 2 },
        });

      await current.close();
      const closedDirect = await bot.privmsgReplyConfirmed(
        "weblounge",
        `closed-app reply-tagged direct ${suffix}`,
        directReplyId,
      );
      await markerReader.markRead(
        bot.nickname,
        messageTag(closedDirect, "time"),
      );
      const unreadLines = await Promise.all(
        [1, 2, 3].map((index) =>
          bot.privmsgConfirmed(channel, `closed-app unread ${index} ${suffix}`),
        ),
      );
      const newestUnreadTime = messageTag(unreadLines.at(-1), "time");

      current = await context.newPage();
      await useDedicatedWorker(current);
      await observeMarkReadRequests(current);
      await recordCachedRows(current, titles);
      await current.goto(startUrl(channel, emptyChannel));
      await expect
        .poll(() => cachedRows(current))
        .toEqual([
          { label: `${bot.nickname}, 2 unread, including mentions` },
          { label: channel },
          { label: emptyChannel },
        ]);
      await expectUnreadCount(bufferRow(current, channel), channel, 3);
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);

      await bufferRow(current, channel).click();
      await expect(
        current.getByRole("heading", { name: channel }),
      ).toBeVisible();
      await expect(
        current.getByText(`closed-app unread 3 ${suffix}`, { exact: true }),
      ).toBeVisible();
      await expect.poll(() => markReadRequestCount(current)).toBeGreaterThan(0);
      await expect
        .poll(() => markerReader.readMarker(channel))
        .toBe(newestUnreadTime);
      await leaveConversation(current, channel);
      await expectRead(bufferRow(current, channel), channel);

      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
      const finalRows = await visibleChatRows(current);
      await expect
        .poll(() => snapshotRows(current, titles))
        .toEqual(await visibleRows(current, titles));

      await current.close();
      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedChatRows(current, titles);
      await current.goto(startUrl(channel, emptyChannel));
      await expect.poll(() => cachedChatRows(current)).toEqual(finalRows);
      await expect(current.locator("[data-app-root]")).not.toHaveAttribute(
        "data-chat-list-hydrating",
        "true",
      );
      await expectRead(bufferRow(current, channel), channel);
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);
    } finally {
      if (!current.isClosed()) await current.close();
      markerReader.close();
      bot.close();
    }
  });

  test("flushes a cleared cached DM before a background relaunch", async ({
    baseURL,
    context,
    page,
  }) => {
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const suffix = Date.now().toString(36).slice(-6);
    const channels = Array.from(
      { length: 4 },
      (_, index) => `#cache-${index}-${suffix}`,
    );
    const firstChannel = channels[0];
    if (firstChannel === undefined) throw new Error("first channel is missing");
    const bot = await IrcClient.connect(
      `cache-bot-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      firstChannel,
    );
    const directText = `cached direct ${suffix}`;
    let current = page;
    try {
      await current.goto("/config.json");
      await seedUnreadDirectSnapshot(
        current,
        baseURL,
        bot.nickname,
        directText,
        channels,
      );
      await useDedicatedWorker(current);
      await recordCachedRow(current, bot.nickname);
      const joined = bot.waitForNextJoin(firstChannel, "weblounge");
      await current.goto(startUrl(...channels));
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({
          label: `${bot.nickname}, 1 unread, including mentions`,
        });
      await joined;
      await bot.privmsgConfirmed("weblounge", directText);

      await bufferRow(current, bot.nickname).click();
      await expect(
        current.getByRole("heading", { name: bot.nickname }),
      ).toBeVisible();
      await expect(
        current
          .getByRole("list", { name: "Messages" })
          .getByText(directText, { exact: true }),
      ).toBeVisible();
      await expectRead(bufferRow(current, bot.nickname), bot.nickname);

      await expect(current.locator("[data-app-root]")).not.toHaveAttribute(
        "data-chat-list-hydrating",
        "true",
      );
      await backgroundPage(current);
      await current.close();

      current = await context.newPage();
      await useDedicatedWorker(current);
      await recordCachedRow(current, bot.nickname);
      await current.goto(startUrl(...channels));
      await expect
        .poll(() => cachedRow(current))
        .toMatchObject({ label: bot.nickname });
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

async function openSnapshotInspector(page: Page): Promise<void> {
  await page.route("**/__snapshot-inspector", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/__snapshot-inspector");
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
  return page
    .locator("[data-buffer-id]")
    .and(
      page.getByRole("button", {
        includeHidden: true,
        name: new RegExp(`^${escapeRegex(channel)}(?:,|$)`, "u"),
      }),
    )
    .first();
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

function startUrl(...channels: string[]): string {
  const params = new URLSearchParams({ "irc-password": "weblounge-test" });
  for (const channel of channels) params.append("irc-autojoin", channel);
  return `/?${params.toString()}`;
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

async function snapshotRows(
  page: Page,
  titles: readonly string[],
): Promise<readonly { label: string }[] | undefined> {
  const rows = await Promise.all(
    titles.map((title) => snapshotRow(page, title)),
  );
  if (rows.some((row) => row === undefined)) return undefined;
  return rows.map((row, index) => ({
    label: snapshotLabel(titles[index] ?? "", row),
  }));
}

function snapshotLabel(title: string, value: unknown): string {
  if (typeof value !== "object" || value === null || !("badge" in value))
    throw new Error(`Snapshot row missing badge for ${title}`);
  const badge = value.badge;
  if (typeof badge !== "object" || badge === null || !("kind" in badge))
    throw new Error(`Snapshot row has an invalid badge for ${title}`);
  if (badge.kind === "none") return title;
  if (!("count" in badge) || typeof badge.count !== "number")
    throw new Error(`Snapshot row has an invalid count for ${title}`);
  return badge.kind === "mentions"
    ? `${title}, ${badge.count} unread, including mentions`
    : `${title}, ${badge.count} unread`;
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

async function seedUnreadDirectSnapshot(
  page: Page,
  baseURL: string,
  nick: string,
  preview: string,
  channels: readonly string[],
): Promise<void> {
  const endpoint = new URL("/socket", baseURL);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const fingerprint = `${"Local Ergo".length}:Local Ergo${endpoint.href.length}:${endpoint.href}`;
  const database = await openEngineDatabase(page);
  try {
    await database.evaluate(
      async (value, record) => {
        await new Promise<void>((resolve, reject) => {
          const transaction = value.transaction("cache", "readwrite");
          transaction
            .objectStore("cache")
            .put(
              new TextEncoder().encode(JSON.stringify(record)),
              new TextEncoder().encode("chat-list-snapshot"),
            );
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      },
      {
        schema: 4,
        fingerprint,
        rows: [
          {
            conversation: { kind: "direct", key: nick },
            title: nick,
            last_activity_ms: 1_800_000_000_000,
            badge: { kind: "mentions", count: 1, mentions: 1 },
            preview,
          },
          ...channels.map((channel, index) => ({
            conversation: { kind: "channel", key: channel },
            title: channel,
            last_activity_ms: 1_799_999_999_999 - index,
            badge: { kind: "none" },
            preview: `cached ${channel}`,
          })),
        ],
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function backgroundPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperties(document, {
      hidden: { configurable: true, get: () => true },
      visibilityState: { configurable: true, get: () => "hidden" },
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
}

async function recordCachedRows(
  page: Page,
  titles: readonly string[],
): Promise<void> {
  await page.addInitScript((expectedTitles) => {
    Reflect.set(globalThis, "badgePersistCachedRows", undefined);
    new MutationObserver(() => {
      if (Reflect.get(globalThis, "badgePersistCachedRows") !== undefined)
        return;
      const root = document.querySelector("[data-chat-list-hydrating]");
      if (root === null) return;
      const rows = [...root.querySelectorAll<HTMLElement>("[data-buffer-id]")];
      const captured = expectedTitles.map((title) => {
        const row = rows.find((candidate) =>
          candidate.getAttribute("aria-label")?.startsWith(title),
        );
        return row === undefined
          ? undefined
          : { label: row.getAttribute("aria-label") ?? "" };
      });
      if (captured.every((row) => row !== undefined))
        Reflect.set(globalThis, "badgePersistCachedRows", captured);
    }).observe(document, { childList: true, subtree: true });
  }, titles);
}

function cachedRows(
  page: Page,
): Promise<readonly { label: string }[] | undefined> {
  return page.evaluate(() => Reflect.get(globalThis, "badgePersistCachedRows"));
}

async function visibleRows(
  page: Page,
  titles: readonly string[],
): Promise<readonly { label: string }[]> {
  return Promise.all(
    titles.map(async (title) => ({
      label: (await bufferRow(page, title).getAttribute("aria-label")) ?? "",
    })),
  );
}

async function recordCachedChatRows(
  page: Page,
  requiredTitles: readonly string[],
): Promise<void> {
  await page.addInitScript((titles) => {
    Reflect.set(globalThis, "badgePersistCachedChatRows", undefined);
    new MutationObserver(() => {
      if (Reflect.get(globalThis, "badgePersistCachedChatRows") !== undefined)
        return;
      const root = document.querySelector("[data-chat-list-hydrating]");
      if (root === null) return;
      const rows = [...root.querySelectorAll<HTMLElement>("[data-buffer-id]")];
      if (
        !titles.every((title) =>
          rows.some((row) => row.getAttribute("aria-label")?.startsWith(title)),
        )
      )
        return;
      Reflect.set(
        globalThis,
        "badgePersistCachedChatRows",
        rows.map((row) => ({
          label: row.getAttribute("aria-label") ?? "",
          text: row.textContent ?? "",
        })),
      );
    }).observe(document, { childList: true, subtree: true });
  }, requiredTitles);
}

function cachedChatRows(
  page: Page,
): Promise<readonly { label: string; text: string }[] | undefined> {
  return page.evaluate(() =>
    Reflect.get(globalThis, "badgePersistCachedChatRows"),
  );
}

async function visibleChatRows(
  page: Page,
): Promise<readonly { label: string; text: string }[]> {
  return page.locator("[data-buffer-id]").evaluateAll((rows) =>
    rows.map((row) => ({
      label: row.getAttribute("aria-label") ?? "",
      text: row.textContent ?? "",
    })),
  );
}

async function expectUnreadCount(
  row: ReturnType<typeof bufferRow>,
  title: string,
  count: number,
): Promise<void> {
  await expect(row).toHaveAttribute(
    "aria-label",
    new RegExp(`^${escapeRegex(title)}, ${count} unread`, "u"),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function messageTag(line: string | undefined, tag: string): string {
  const value = new RegExp(`(?:^@|;)${tag}=([^; ]+)`, "u").exec(
    line ?? "",
  )?.[1];
  if (value === undefined) throw new Error(`IRC line missing ${tag}: ${line}`);
  return value;
}

async function observeMarkReadRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, { badgePersistMarkReadRequests: 0 });
    const observe = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "request" ||
        !("payload" in message) ||
        typeof message.payload !== "object" ||
        message.payload === null ||
        !("request" in message.payload) ||
        typeof message.payload.request !== "object" ||
        message.payload.request === null ||
        !("type" in message.payload.request) ||
        message.payload.request.type !== "mark_read"
      )
        return;
      const state = window as Window & {
        badgePersistMarkReadRequests: number;
      };
      state.badgePersistMarkReadRequests += 1;
    };
    const wrap = (prototype: {
      postMessage: (...arguments_: unknown[]) => unknown;
    }) => {
      const postMessage = prototype.postMessage;
      prototype.postMessage = function (...arguments_: unknown[]) {
        observe(arguments_[0]);
        return Reflect.apply(postMessage, this, arguments_);
      };
    };
    wrap(MessagePort.prototype as unknown as Parameters<typeof wrap>[0]);
    wrap(Worker.prototype as unknown as Parameters<typeof wrap>[0]);
  });
}

function markReadRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as Window & { badgePersistMarkReadRequests: number })
        .badgePersistMarkReadRequests,
  );
}

async function transcriptOrders(
  page: Page,
  earlier: string,
  later: string,
): Promise<boolean> {
  return page.locator("[data-message-row]").evaluateAll(
    (rows, [earlierText, laterText]) => {
      const earlierIndex = rows.findIndex(
        (row) => row.getAttribute("data-message-text") === earlierText,
      );
      const laterIndex = rows.findIndex(
        (row) => row.getAttribute("data-message-text") === laterText,
      );
      return earlierIndex >= 0 && earlierIndex < laterIndex;
    },
    [earlier, later],
  );
}
