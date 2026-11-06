import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
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
  await captureHistoryWire(page);
  const suffix = Date.now().toString(36).slice(-5);
  const keeper = await IrcClient.connectWithoutJoin(
    "weblounge",
    "weblounge",
    "weblounge-test",
  );
  let bots: IrcClient[] = [];
  try {
    bots = await Promise.all(
      Array.from({ length: directCount }, async (_, index) => {
        const nick = `slow${index.toString().padStart(2, "0")}-${suffix}`;
        return IrcClient.connectIsolated(nick, targetChannel);
      }),
    );
    const directNicks = bots.map((bot) => bot.nickname);
    const firstBot = bots[0];
    if (firstBot === undefined) throw new Error("channel bot is missing");
    await firstBot.privmsgConfirmed(targetChannel, `ops history ${suffix}`);
    await Promise.all(
      bots.map(async (bot, index) => {
        await bot.privmsgConfirmed("weblounge", `direct history ${index}`);
      }),
    );
    await page.goto("/config.json");
    await seedSnapshot(page, baseURL, [
      "#weblounge-test",
      ...otherChannels,
      targetChannel,
      ...directNicks,
    ]);
    const target = directNicks[0];
    if (target === undefined) throw new Error("direct target is missing");
    await recordTitleTimeline(page, target);
    const url = new URL("/", baseURL);
    url.searchParams.set("irc-password", "weblounge-test");
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
      const timeline = Reflect.get(globalThis, "slowBufferProjectionTimeline");
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
            "slowBufferProjectionTimeline",
          ) as ProjectionTrace[];
          return timeline.findLast(
            (entry) => entry.event.type === "network_state_changed",
          )?.event.network?.state;
        }),
      )
      .toBe("online");
    await expect(title).not.toHaveAttribute("data-connection-progress");
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
      wire: Reflect.get(globalThis, "slowBufferWireTimeline") as WireTrace[],
      projections: Reflect.get(
        globalThis,
        "slowBufferProjectionTimeline",
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
    expect(
      measured.wire.filter(
        (entry) =>
          entry.direction === "sent" &&
          entry.at >= measured.timeOrigin + measured.openedAt &&
          entry.at < request.at &&
          /(?:CHATHISTORY|MARKREAD|WHO) /u.test(entry.line),
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
  } finally {
    keeper.close();
    for (const bot of bots) bot.close();
  }
});

interface WireTrace {
  readonly at: number;
  readonly direction: "received" | "sent";
  readonly line: string;
}

interface ProjectionTrace {
  readonly at: number;
  readonly event: {
    readonly type?: string;
    readonly buffer?: {
      readonly sync_state?: string;
      readonly title?: string;
    };
    readonly network?: {
      readonly state?: unknown;
    };
  };
}

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

async function captureHistoryWire(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "SharedWorker");
    const timeline: unknown[] = [];
    const projections: unknown[] = [];
    const subscribedWorkers = new WeakSet<Worker>();
    Reflect.set(globalThis, "slowBufferWireTimeline", timeline);
    Reflect.set(globalThis, "slowBufferProjectionTimeline", projections);
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (!subscribedWorkers.has(this)) {
        subscribedWorkers.add(this);
        Reflect.apply(postMessage, this, [
          { type: "history_wire_test_trace_subscribe" },
        ]);
      }
      Reflect.apply(postMessage, this, [message, options]);
    };
    const addListener = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message" || listener === null) {
        addListener.call(this, type, listener, options);
        return;
      }
      const wrapped: EventListener = (rawEvent) => {
        const event = rawEvent as MessageEvent<unknown>;
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          event.data.type === "history_wire_test_trace"
        ) {
          timeline.push(event.data);
          return;
        }
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          (event.data.type === "buffer_updated" ||
            event.data.type === "network_state_changed")
        )
          projections.push({ at: performance.now(), event: event.data });
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      addListener.call(this, type, wrapped, options);
    };
  });
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
