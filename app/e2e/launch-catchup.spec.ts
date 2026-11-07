import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { IrcClient } from "./irc-client";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);
test.use({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
});

const channelCount = 7;
const directCount = 9;

test("launch reconciles sixteen cached buffers within stock fakelag budgets", async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const suffix = Date.now().toString(36).slice(-5);
  const account = `catch-${suffix}`;
  const password = `test-${account}`;
  const channels = [
    "#weblounge-test",
    ...Array.from(
      { length: channelCount - 1 },
      (_, index) => `#catch-${index}-${suffix}`,
    ),
  ];
  const keeper = await IrcClient.connectIsolated(
    account,
    channels[1] ?? channels[0],
  );
  const writer = await IrcClient.connectIsolated(
    `catch-w-${suffix}`,
    channels[0],
  );
  const bots = await Promise.all(
    Array.from({ length: directCount }, (_, index) =>
      IrcClient.connectIsolated(`catch-d${index}-${suffix}`, channels[0]),
    ),
  );
  try {
    for (const channel of channels.slice(1)) await writer.join(channel);
    const channelInitial = await Promise.all(
      channels.map((channel, index) =>
        writer.privmsgConfirmed(channel, `cached channel ${index} ${suffix}`),
      ),
    );
    const directInitial = await Promise.all(
      bots.map((bot, index) =>
        bot.privmsgConfirmed(account, `cached direct ${index} ${suffix}`),
      ),
    );
    const changedChannelText = `changed channel ${suffix}`;
    const changedDirectText = `changed direct ${suffix}`;
    await writer.privmsgConfirmed(channels[0], changedChannelText);
    await bots[0]?.privmsgConfirmed(account, changedDirectText);

    await page.goto("/config.json");
    await seedSnapshot(page, baseURL, [
      ...channels.map((channel, index) => ({
        kind: "channel" as const,
        title: channel,
        time: messageTag(channelInitial[index], "time"),
        preview: `${writer.nickname}: cached channel ${index} ${suffix}`,
        badge: { kind: "unread" as const, count: 1 },
      })),
      ...bots.map((bot, index) => ({
        kind: "direct" as const,
        title: bot.nickname,
        time: messageTag(directInitial[index], "time"),
        preview: `cached direct ${index} ${suffix}`,
        badge: { kind: "mentions" as const, count: 1, mentions: 1 },
      })),
    ]);
    await captureLaunchWire(page);
    const url = new URL("/", baseURL);
    url.searchParams.set("irc-password", password);
    url.searchParams.set("irc-account", account);
    url.searchParams.set("irc-nickname", account);
    for (const channel of channels.slice(1))
      url.searchParams.append("irc-autojoin", channel);
    await page.goto(url.href);

    const unchangedDirect = bots.at(-1);
    if (unchangedDirect === undefined)
      throw new Error("direct fixture is missing");
    const targetRow = bufferRow(page, unchangedDirect.nickname);
    await expect(targetRow).toBeVisible();
    await page.waitForFunction(() =>
      (
        Reflect.get(globalThis, "launchCatchupEvents") as Array<{
          state?: unknown;
        }>
      ).some((entry) => entry.state === "online"),
    );
    await page.evaluate(() =>
      Reflect.set(
        globalThis,
        "launchCatchupOpenedAt",
        performance.timeOrigin + performance.now(),
      ),
    );
    await targetRow.click();
    await expect(
      page.getByText(`cached direct ${directCount - 1} ${suffix}`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to chats" }).click();
    await expect(page.locator("[data-app-root]")).not.toHaveAttribute(
      "data-chat-list-hydrating",
      "true",
    );

    await expect(bufferRow(page, channels[1])).toContainText(
      `cached channel 1 ${suffix}`,
    );
    await expect(bufferRow(page, channels[1])).toHaveAccessibleName(
      `${channels[1]}, 1 unread`,
    );
    await expect(bufferRow(page, channels[0])).toContainText(
      changedChannelText,
    );
    await expect(bufferRow(page, channels[0])).toHaveAccessibleName(
      `${channels[0]}, 2 unread`,
    );
    await expect(bufferRow(page, bots[1]?.nickname ?? "missing")).toContainText(
      `cached direct 1 ${suffix}`,
    );
    await expect(
      bufferRow(page, bots[1]?.nickname ?? "missing"),
    ).toHaveAccessibleName(
      `${bots[1]?.nickname}, 1 unread, including mentions`,
    );
    await expect(bufferRow(page, bots[0]?.nickname ?? "missing")).toContainText(
      changedDirectText,
    );
    await expect(
      bufferRow(page, bots[0]?.nickname ?? "missing"),
    ).toHaveAccessibleName(
      `${bots[0]?.nickname}, 2 unread, including mentions`,
    );

    const measured = await page.evaluate(() => ({
      openedAt: Reflect.get(globalThis, "launchCatchupOpenedAt") as number,
      wire: Reflect.get(globalThis, "launchCatchupWire") as WireTrace[],
    }));
    const histories = measured.wire.filter(
      (entry) =>
        entry.direction === "sent" && entry.line.includes(" CHATHISTORY "),
    );
    const markerQueries = measured.wire.filter(
      (entry) =>
        entry.direction === "sent" &&
        / MARKREAD \S+$/u.test(entry.line.trimEnd()),
    );
    const monitorCommands = measured.wire.filter(
      (entry) => entry.direction === "sent" && entry.line.includes(" MONITOR "),
    );
    const whoCommands = measured.wire.filter(
      (entry) => entry.direction === "sent" && entry.line.includes(" WHO "),
    );
    const replies = historyReplyLatencies(measured.wire);
    const openedReply = replies.find((reply) =>
      reply.request.includes(`CHATHISTORY LATEST ${unchangedDirect.nickname} `),
    );
    expect(openedReply).toBeDefined();
    if (openedReply === undefined)
      throw new Error("opened history reply is missing");
    expect(openedReply.receivedAt - measured.openedAt).toBeLessThan(450);
    expect(replies.filter((reply) => reply.latency >= 450)).toEqual([]);
    expect(histories.length).toBeGreaterThan(0);
    expect(histories.length).toBeLessThanOrEqual(16);
    expect(markerQueries.length).toBeLessThanOrEqual(16);
    expect(monitorCommands.length).toBeLessThanOrEqual(1);
    expect(whoCommands.length).toBeLessThanOrEqual(4);
  } finally {
    keeper.close();
    writer.close();
    for (const bot of bots) bot.close();
  }
});

interface SnapshotFixtureRow {
  readonly kind: "channel" | "direct";
  readonly title: string;
  readonly time: string;
  readonly preview: string;
  readonly badge:
    | { readonly kind: "unread"; readonly count: number }
    | {
        readonly kind: "mentions";
        readonly count: number;
        readonly mentions: number;
      };
}

interface WireTrace {
  readonly at: number;
  readonly direction: "received" | "sent";
  readonly line: string;
}

function bufferRow(page: Page, title: string) {
  return page
    .locator("[data-mobile-chats]")
    .getByRole("button", {
      name: new RegExp(`^${escapeRegex(title)}(?:,|$)`, "u"),
    })
    .first();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function messageTag(line: string | undefined, tag: string): string {
  const value = line
    ?.slice(1, line.indexOf(" "))
    .split(";")
    .find((entry) => entry.startsWith(`${tag}=`))
    ?.slice(tag.length + 1);
  if (value === undefined) throw new Error(`message has no ${tag} tag`);
  return value;
}

async function seedSnapshot(
  page: Page,
  baseURL: string,
  rows: readonly SnapshotFixtureRow[],
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
        rows: rows.map((row) => ({
          conversation: { kind: row.kind, key: row.title },
          title: row.title,
          last_activity_ms: Date.parse(row.time),
          badge: row.badge,
          preview: row.preview,
        })),
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function captureLaunchWire(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "SharedWorker");
    const wire: unknown[] = [];
    const events: unknown[] = [];
    Reflect.set(globalThis, "launchCatchupWire", wire);
    Reflect.set(globalThis, "launchCatchupEvents", events);
    const subscribed = new WeakSet<Worker>();
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (!subscribed.has(this)) {
        subscribed.add(this);
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
        const event = rawEvent as MessageEvent<Record<string, unknown>>;
        if (event.data?.type === "history_wire_test_trace") {
          wire.push(event.data);
          return;
        }
        const network = event.data?.network;
        if (
          event.data?.type === "network_state_changed" &&
          typeof network === "object" &&
          network !== null &&
          "state" in network
        )
          events.push({ state: network.state });
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      addListener.call(this, type, wrapped, options);
    };
  });
}

function historyReplyLatencies(wire: readonly WireTrace[]) {
  return wire
    .filter(
      (entry) =>
        entry.direction === "sent" &&
        entry.line.includes(" CHATHISTORY ") &&
        !entry.line.includes(" CHATHISTORY TARGETS "),
    )
    .map((request) => {
      const label = /^@label=([^ ;]+)/u.exec(request.line)?.[1];
      const reply = wire.find(
        (entry) =>
          entry.direction === "received" &&
          label !== undefined &&
          new RegExp(`(?:^@|;)label=${label}(?:;| )`, "u").test(entry.line) &&
          entry.line.includes(" BATCH +"),
      );
      if (reply === undefined)
        throw new Error(`history request has no reply: ${request.line}`);
      return {
        request: request.line,
        receivedAt: reply.at,
        latency: reply.at - request.at,
      };
    });
}
