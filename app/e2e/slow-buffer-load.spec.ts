import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import {
  captureHistoryWire,
  closeUnrelatedHistoryWireWorker,
  heldLatestHistoryCount,
  type ProjectionTrace,
  releaseHeldLatestHistory,
  type WireTrace,
} from "./history-wire-fixture";
import { IrcClient } from "./irc-client";

const directCount = 16;
const targetChannel = "#slow-ops";
const otherChannels = ["#slow-alpha"];

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("settles the opened conversation without waiting for background history", async ({
  baseURL,
  page,
}) => {
  const suffix = Date.now().toString(36).slice(-5);
  const account = `slow-user-${suffix}`;
  const password = `test-${account}`;
  const keeper = await IrcClient.connectIsolated(account, targetChannel);
  const bots: IrcClient[] = [];
  try {
    for (let index = 0; index < directCount; index += 1) {
      const nick = `slow${index.toString().padStart(2, "0")}-${suffix}`;
      bots.push(await IrcClient.connectIsolated(nick, targetChannel));
    }
    const directNicks = bots.map((bot) => bot.nickname);
    const firstBot = bots[0];
    if (firstBot === undefined) throw new Error("channel bot is missing");
    await firstBot.privmsgConfirmed(targetChannel, `ops history ${suffix}`);
    for (const [index, bot] of bots.entries())
      await bot.privmsgConfirmed(account, `direct history ${index}`);
    await page.goto("/config.json");
    await seedSnapshot(page, baseURL, [
      "#weblounge-test",
      ...otherChannels,
      targetChannel,
      ...directNicks,
    ]);
    const target = directNicks[0];
    if (target === undefined) throw new Error("direct target is missing");
    await captureHistoryWire(page, { latestExcept: target });
    await recordTitleTimeline(page, target);
    const url = new URL("/", baseURL);
    url.searchParams.set("irc-password", password);
    url.searchParams.set("irc-account", account);
    url.searchParams.set("irc-nickname", account);
    for (const channel of [...otherChannels, targetChannel])
      url.searchParams.append("irc-autojoin", channel);
    await page.goto(url.href);

    const row = page.getByRole("button", { name: target });
    await expect(row).toBeVisible();
    await row.click();
    await page.evaluate(() =>
      Reflect.set(globalThis, "slowBufferOpenedAt", performance.now()),
    );
    const title = page.locator("[data-conversation-title]");
    await expect(
      page.getByText("direct history 0", { exact: true }),
    ).toBeVisible();
    await page.waitForFunction((targetTitle) => {
      const timeline = Reflect.get(globalThis, "historyProjectionTimeline");
      if (!Array.isArray(timeline)) return false;
      const syncing = timeline.findIndex(
        (entry) => projectedSyncState(entry, targetTitle) === "syncing",
      );
      return (
        syncing >= 0 &&
        timeline
          .slice(syncing + 1)
          .some((entry) => projectedSyncState(entry, targetTitle) === "synced")
      );

      function projectedSyncState(
        entry: unknown,
        title: string,
      ): string | undefined {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("event" in entry) ||
          typeof entry.event !== "object" ||
          entry.event === null ||
          !("buffer" in entry.event) ||
          typeof entry.event.buffer !== "object" ||
          entry.event.buffer === null ||
          !("title" in entry.event.buffer) ||
          entry.event.buffer.title !== title ||
          !("sync_state" in entry.event.buffer) ||
          typeof entry.event.buffer.sync_state !== "string"
        )
          return undefined;
        return entry.event.buffer.sync_state;
      }
    }, target);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const timeline = Reflect.get(
            globalThis,
            "historyProjectionTimeline",
          ) as ProjectionTrace[];
          return timeline.findLast(
            (entry) => entry.event.type === "network_state_changed",
          )?.event.network?.state;
        }),
      )
      .toBe("online");
    await expect(title).not.toHaveAttribute("data-connection-progress");
    await expect.poll(() => heldLatestHistoryCount(page)).toBeGreaterThan(0);
    await expect(page.locator("[data-app-root]")).toHaveAttribute(
      "data-chat-list-hydrating",
      "true",
    );

    const measured = await page.evaluate(() => ({
      openedAt: Reflect.get(globalThis, "slowBufferOpenedAt") as number,
      timeOrigin: performance.timeOrigin,
      phases: Reflect.get(globalThis, "slowBufferTitleTimeline") as Array<{
        at: number;
        phase: string | null;
      }>,
      wire: Reflect.get(globalThis, "historyWireTimeline") as WireTrace[],
      projections: Reflect.get(
        globalThis,
        "historyProjectionTimeline",
      ) as ProjectionTrace[],
    }));

    const request = measured.wire.find(
      (entry) =>
        entry.direction === "sent" &&
        entry.line.includes(`CHATHISTORY LATEST ${target} `),
    );
    expect(request).toBeDefined();
    if (request === undefined) throw new Error("target history was not sent");
    const label = /@label=([^ ;]+)/u.exec(request.line)?.[1];
    expect(label).toBeDefined();
    const reply = measured.wire.find(
      (entry) =>
        entry.direction === "received" &&
        entry.line.includes(`label=${label}`) &&
        entry.line.includes(`chathistory ${target}`),
    );
    expect(reply).toBeDefined();
    const synced = measured.projections.findLast(
      (entry) =>
        entry.event.buffer?.title === target &&
        entry.event.buffer.sync_state === "synced",
    );
    expect(synced).toBeDefined();
    expect(measured.phases.at(-1)?.phase).toBeNull();
    // A timestamp-less MARKREAD queries this buffer's server baseline and is
    // launched alongside its history. Only queued history, identity work, or
    // a marker write can hold useful work ahead of the opened conversation.
    expect(
      measured.wire.filter(
        (entry) =>
          entry.direction === "sent" &&
          entry.at >= measured.timeOrigin + measured.openedAt &&
          entry.at < request.at &&
          (/(?:CHATHISTORY|WHO) /u.test(entry.line) ||
            / MARKREAD \S+ timestamp=/u.test(entry.line)),
      ),
    ).toHaveLength(0);
    if (reply === undefined || synced === undefined)
      throw new Error("history completion timeline is incomplete");
    expect(synced.at).toBeGreaterThanOrEqual(reply.at - measured.timeOrigin);
    expect(
      measured.phases.some(
        (entry) => entry.at >= synced.at && entry.phase === "loading",
      ),
    ).toBe(false);
    await releaseHeldLatestHistory(page);
  } finally {
    keeper.close();
    for (const bot of bots) bot.close();
  }
});

test("opens ready history without a title shimmer or eager older page", async ({
  baseURL,
  page,
}) => {
  const suffix = Date.now().toString(36).slice(-5);
  const account = `warm-user-${suffix}`;
  const password = `test-${account}`;
  const channel = `#warm-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const bots = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      IrcClient.connectIsolated(`warm${index}-${suffix}`, channel),
    ),
  );
  await captureHistoryWire(page, { beforeTarget: channel });
  try {
    for (let index = 0; index < 120; index += bots.length)
      await Promise.all(
        bots.map((bot, offset) =>
          bot.privmsgConfirmed(
            channel,
            `warm history ${index + offset} ${"page ".repeat(12)}`,
          ),
        ),
      );
    await page.goto("/config.json");
    await seedSnapshot(page, baseURL, ["#weblounge-test", channel]);
    await recordTitleTimeline(page, channel);
    const url = new URL("/Local%20Ergo/weblounge-test", baseURL);
    url.searchParams.set("irc-password", password);
    url.searchParams.set("irc-account", account);
    url.searchParams.set("irc-nickname", account);
    url.searchParams.append("irc-autojoin", channel);
    await page.goto(url.href);

    const row = page.getByRole("button", { name: channel });
    await expect(row).toBeVisible();
    await page.waitForFunction((targetTitle) => {
      const timeline = Reflect.get(globalThis, "historyProjectionTimeline");
      return (
        Array.isArray(timeline) &&
        timeline.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "event" in entry &&
            typeof entry.event === "object" &&
            entry.event !== null &&
            "buffer" in entry.event &&
            typeof entry.event.buffer === "object" &&
            entry.event.buffer !== null &&
            "title" in entry.event.buffer &&
            entry.event.buffer.title === targetTitle &&
            "sync_state" in entry.event.buffer &&
            entry.event.buffer.sync_state === "synced",
        )
      );
    }, channel);
    await page.evaluate(() =>
      Reflect.set(globalThis, "slowBufferOpenedAt", performance.now()),
    );
    await row.click();

    const list = page.locator("[data-message-list]");
    await expect(list).toBeVisible();
    await expect(page.getByText(/warm history 119/u)).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeGreaterThan(100);
    await list.hover();
    await page.evaluate(() =>
      Reflect.set(globalThis, "slowBufferScrolledAt", performance.now()),
    );
    await page.mouse.wheel(0, -10_000);
    await expect
      .poll(() =>
        page.evaluate(
          () => Reflect.get(globalThis, "historyHeldBefore") !== undefined,
        ),
      )
      .toBe(true);
    await closeUnrelatedHistoryWireWorker(page);

    const measured = await page.evaluate(() => ({
      held: Reflect.get(globalThis, "historyHeldBefore") as WireTrace,
      openedAt: Reflect.get(globalThis, "slowBufferOpenedAt") as number,
      phases: Reflect.get(globalThis, "slowBufferTitleTimeline") as Array<{
        at: number;
        phase: string | null;
      }>,
      scrolledAt: Reflect.get(globalThis, "slowBufferScrolledAt") as number,
      timeOrigin: performance.timeOrigin,
      wire: Reflect.get(globalThis, "historyWireTimeline") as WireTrace[],
    }));
    expect(measured.held.at).toBeGreaterThanOrEqual(
      measured.timeOrigin + measured.scrolledAt,
    );
    expect(
      measured.wire.some(
        (entry) =>
          entry.direction === "sent" &&
          entry.at < measured.timeOrigin + measured.scrolledAt &&
          entry.line.includes(`CHATHISTORY BEFORE ${channel} `),
      ),
    ).toBe(false);
    expect(
      measured.phases.some(
        (entry) => entry.at >= measured.openedAt && entry.phase === "loading",
      ),
    ).toBe(false);

    await page.evaluate(() => {
      const release = Reflect.get(globalThis, "releaseHeldHistoryBefore");
      if (typeof release !== "function")
        throw new Error("history gate missing");
      Reflect.set(globalThis, "historyReleaseOutcome", release());
    });
    await expect
      .poll(() =>
        page.evaluate((target) => {
          const timeline = Reflect.get(
            globalThis,
            "historyWireTimeline",
          ) as WireTrace[];
          const sent = timeline.some(
            (entry) =>
              entry.direction === "sent" &&
              entry.line.includes(`CHATHISTORY BEFORE ${target} `),
          );
          const held = timeline.find(
            (entry) =>
              entry.line === "before_held" &&
              typeof entry.instance_id === "string" &&
              typeof entry.port_id === "string",
          );
          const released = timeline.some(
            (entry) =>
              entry.line === "before_release_received" &&
              entry.held === true &&
              entry.instance_id === held?.instance_id &&
              entry.port_id === held?.port_id,
          );
          if (sent && held && released) return "sent";
          const heartbeats = timeline.filter(
            (entry) => entry.event === "heartbeat",
          );
          const lastHeartbeat = heartbeats.at(-1);
          return JSON.stringify({
            heartbeat: {
              count: heartbeats.length,
              last_at: lastHeartbeat?.at,
              page_now: performance.timeOrigin + performance.now(),
            },
            page_errors: timeline
              .filter((entry) => entry.event?.startsWith("page_"))
              .map((entry) => ({ event: entry.event, line: entry.line })),
            release: Reflect.get(globalThis, "historyReleaseOutcome"),
            release_controls: timeline
              .filter((entry) => entry.event?.startsWith("before_release"))
              .map((entry) => ({
                at: entry.at,
                event: entry.event,
                held: entry.held,
                instance_id: entry.instance_id,
                line: entry.line,
                port_id: entry.port_id,
              })),
            timeline: timeline
              .filter((entry) => entry.event !== "heartbeat")
              .slice(-8)
              .map((entry) => ({
                at: entry.at,
                direction: entry.direction,
                event: entry.event,
                held: entry.held,
                instance_id: entry.instance_id,
                line:
                  entry.direction === "control"
                    ? entry.line
                    : /(?:^| )(CHATHISTORY|MARKREAD|WHO|BATCH) /u.exec(
                        entry.line,
                      )?.[1],
                port_id: entry.port_id,
              })),
          });
        }, channel),
      )
      .toBe("sent");
    await expect
      .poll(() =>
        page.evaluate(
          (target) =>
            (
              Reflect.get(globalThis, "historyWireTimeline") as WireTrace[]
            ).some(
              (entry) =>
                entry.direction === "received" &&
                entry.line.includes(`chathistory ${target}`),
            ),
          channel,
        ),
      )
      .toBe(true);
  } finally {
    keeper.close();
    for (const bot of bots) bot.close();
  }
});

async function seedSnapshot(
  page: Page,
  baseURL: string | undefined,
  titles: readonly string[],
): Promise<void> {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
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
        rows: titles.map((title, index) => ({
          conversation: {
            kind: title.startsWith("#") ? "channel" : "direct",
            key: title,
          },
          title,
          last_activity_ms: 1_800_000_000_000 - index,
          badge: { kind: "none" },
          preview: `cached ${title}`,
        })),
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function recordTitleTimeline(page: Page, title: string): Promise<void> {
  await page.addInitScript((target) => {
    const timeline: Array<Record<string, unknown>> = [];
    Reflect.set(globalThis, "slowBufferTitleTimeline", timeline);
    const record = () => {
      const element = [
        ...document.querySelectorAll<HTMLElement>("h1, h2"),
      ].find((candidate) => candidate.textContent === target);
      if (element === undefined) return;
      const entry = {
        at: performance.now(),
        phase: element.getAttribute("data-connection-phase"),
        progress: element.hasAttribute("data-connection-progress"),
      };
      const previous = timeline.at(-1);
      if (
        previous?.phase !== entry.phase ||
        previous.progress !== entry.progress
      )
        timeline.push(entry);
    };
    new MutationObserver(record).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, title);
}
