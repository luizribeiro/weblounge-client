import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

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
    await keeper.joinAll(channels.filter((channel) => channel !== channels[1]));
    await writer.joinAll(channels.slice(1));
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
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const unchangedDirect = bots.at(-1);
    if (unchangedDirect === undefined)
      throw new Error("direct fixture is missing");

    await page.goto("/config.json");
    await seedSnapshot(page, baseURL, [
      ...channels.map((channel, index) => ({
        kind: "channel" as const,
        title: channel,
        time: messageTag(channelInitial[index], "time"),
        msgid: messageTag(channelInitial[index], "msgid"),
        preview: `${writer.nickname}: cached channel ${index} ${suffix}`,
        badge: { kind: "unread" as const, count: 1 },
      })),
      ...bots.map((bot, index) => ({
        kind: "direct" as const,
        title: bot.nickname,
        time: messageTag(directInitial[index], "time"),
        msgid: messageTag(directInitial[index], "msgid"),
        preview: `cached direct ${index} ${suffix}`,
        badge:
          index === 0
            ? { kind: "mentions" as const, count: 1, mentions: 1 }
            : { kind: "none" as const },
      })),
    ]);
    await captureLaunchWire(page);
    const url = new URL("/", baseURL);
    url.searchParams.set("irc-password", password);
    url.searchParams.set("irc-account", account);
    url.searchParams.set("irc-nickname", account);
    const forwarderUrl = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
    if (forwarderUrl === undefined)
      throw new Error("socket forwarder URL is missing");
    await fetch(`${forwarderUrl}/drop`, { method: "POST" });
    await page.goto(url.href);

    const targetRow = bufferRow(page, unchangedDirect.nickname);
    await expect(targetRow).toBeVisible();
    await targetRow.click();
    const timeToInteractive = await page.evaluate(() => {
      const startedAt = Reflect.get(globalThis, "launchCatchupStartedAt");
      if (typeof startedAt !== "number")
        throw new Error("launch start time is missing");
      return performance.timeOrigin + performance.now() - startedAt;
    });
    expect(timeToInteractive).toBeLessThan(500);
    await fetch(`${forwarderUrl}/restore`, { method: "POST" });
    await expect(
      page.getByText(`cached direct ${directCount - 1} ${suffix}`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to chats" }).click();

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
    ).toHaveAccessibleName(`${bots[1]?.nickname}`);
    await expect(bufferRow(page, bots[0]?.nickname ?? "missing")).toContainText(
      changedDirectText,
    );
    await expect(
      bufferRow(page, bots[0]?.nickname ?? "missing"),
    ).toHaveAccessibleName(
      `${bots[0]?.nickname}, 2 unread, including mentions`,
    );
    const measured = await page.evaluate(() => ({
      events: Reflect.get(globalThis, "launchCatchupEvents") as Array<{
        at: number;
        state?: unknown;
        type?: unknown;
      }>,
      wire: Reflect.get(globalThis, "launchCatchupWire") as WireTrace[],
    }));
    const onlineAt = measured.events.find(
      (entry) => entry.state === "online",
    )?.at;
    if (onlineAt === undefined) throw new Error("online transition is missing");
    const launchWire = measured.wire;
    const histories = launchWire.filter(
      (entry) =>
        entry.direction === "sent" && entry.line.includes(" CHATHISTORY "),
    );
    const markerQueries = launchWire.filter(
      (entry) =>
        entry.direction === "sent" &&
        / MARKREAD \S+$/u.test(entry.line.trimEnd()),
    );
    const replies = historyReplyLatencies(launchWire);
    const commandCounts = countWireCommands(launchWire);
    const clientReplies = clientRequestReplyLatencies(launchWire);
    const openedRequest = histories.find((entry) =>
      entry.line.includes(`CHATHISTORY LATEST ${unchangedDirect.nickname} `),
    );
    const openedReply = replies.find((reply) =>
      reply.request.includes(`CHATHISTORY LATEST ${unchangedDirect.nickname} `),
    );
    expect(openedRequest).toBeDefined();
    expect(openedReply).toBeDefined();
    if (openedRequest === undefined || openedReply === undefined)
      throw new Error("opened history request or reply is missing");
    expect(openedRequest.at - onlineAt).toBeLessThan(500);
    expect(
      commandCounts.get("CHATHISTORY") ?? 0,
      histories.map(({ line }) => line).join("\n"),
    ).toBeLessThanOrEqual(4);
    expect(commandCounts.get("MARKREAD") ?? 0).toBeLessThanOrEqual(2);
    expect(commandCounts.get("MONITOR") ?? 0).toBe(0);
    expect(commandCounts.get("WHO") ?? 0).toBeLessThanOrEqual(7);
    expect(
      [...commandCounts.values()].reduce((total, count) => total + count, 0),
    ).toBeLessThanOrEqual(36);
    expect(histories.length).toBeLessThanOrEqual(4);
    expect(markerQueries.length).toBeLessThanOrEqual(2);
    const delayedClientReplies = clientReplies.filter(
      (reply) =>
        reply.latency >= 500 &&
        !reply.request.includes(
          `CHATHISTORY LATEST ${unchangedDirect.nickname} `,
        ),
    );
    expect(
      delayedClientReplies
        .slice(1)
        .map((reply, index) => ({
          addedDelay:
            reply.latency - (delayedClientReplies[index]?.latency ?? 0),
          request: reply.request,
        }))
        .filter(({ addedDelay }) => addedDelay >= 500),
    ).toEqual([]);
  } finally {
    keeper.close();
    writer.close();
    for (const bot of bots) bot.close();
  }
});

test("relaunch catches up a delta interrupted before its page arrives", async ({
  baseURL,
  context,
  page,
}) => {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const suffix = Date.now().toString(36).slice(-5);
  const account = `delta-${suffix}`;
  const password = `test-${account}`;
  const channel = `#delta-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const writer = await IrcClient.connectIsolated(`delta-w-${suffix}`, channel);
  let current = page;
  try {
    const initialText = `cached delta ${suffix}`;
    const initial = await writer.privmsgConfirmed(channel, initialText);
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    await current.goto("/config.json");
    await seedSnapshot(current, baseURL, [
      {
        kind: "channel",
        title: channel,
        time: messageTag(initial, "time"),
        msgid: messageTag(initial, "msgid"),
        preview: `${writer.nickname}: ${initialText}`,
        badge: { kind: "unread", count: 1 },
      },
    ]);
    const changedText = `changed delta ${suffix}`;
    await writer.privmsgConfirmed(channel, changedText);
    await captureLaunchWire(current, `CHATHISTORY LATEST ${channel} `);
    await current.goto(accountUrl(baseURL, account, password, channel));
    await expect
      .poll(() =>
        current.evaluate(
          () =>
            Reflect.get(globalThis, "launchCatchupHeldRequest") !== undefined,
        ),
      )
      .toBe(true);
    await expect.poll(() => snapshotSchema(current)).toBe(7);

    await current.close();
    current = await context.newPage();
    await captureLaunchWire(current);
    await current.goto(accountUrl(baseURL, account, password, channel));
    await expect(bufferRow(current, channel)).toContainText(changedText);
    await expect(bufferRow(current, channel)).toHaveAccessibleName(
      `${channel}, 2 unread`,
    );
  } finally {
    if (!current.isClosed()) await current.close();
    keeper.close();
    writer.close();
  }
});

test("a bounded catch-up keeps the newest page and marks its unread gap", async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const suffix = Date.now().toString(36).slice(-5);
  const account = `gap-${suffix}`;
  const password = `test-${account}`;
  const channel = `#gap-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const writers = await Promise.all(
    Array.from({ length: 17 }, (_, index) =>
      IrcClient.connectIsolated(`gap-w${index}-${suffix}`, channel),
    ),
  );
  const writer = writers[0];
  if (writer === undefined) throw new Error("gap writer fixture is missing");
  try {
    const initialText = `cached gap ${suffix}`;
    const initial = await writer.privmsgConfirmed(channel, initialText);
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    await page.goto("/config.json");
    await seedSnapshot(page, baseURL, [
      {
        kind: "channel",
        title: channel,
        time: messageTag(initial, "time"),
        msgid: messageTag(initial, "msgid"),
        preview: `${writer.nickname}: ${initialText}`,
        badge: { kind: "unread", count: 1 },
      },
    ]);

    await Promise.all(
      writers.map(async (sender, senderIndex) => {
        for (let index = 0; index < 5; index += 1)
          sender.privmsg(
            channel,
            `bounded gap ${senderIndex}-${index} ${suffix}`,
          );
        await sender.privmsgConfirmed(
          channel,
          `bounded gap ${senderIndex}-5 ${suffix}`,
        );
      }),
    );
    const newestText = `bounded gap newest ${suffix}`;
    await writer.privmsgConfirmed(channel, newestText);

    await captureLaunchWire(page);
    await page.goto(accountUrl(baseURL, account, password, channel));
    await expect
      .poll(() =>
        page.evaluate((target) => {
          const wire = Reflect.get(
            globalThis,
            "launchCatchupWire",
          ) as WireTrace[];
          return wire.find(
            (entry) =>
              entry.direction === "sent" &&
              entry.line.includes(` CHATHISTORY `) &&
              entry.line.includes(` ${target} `),
          )?.line;
        }, channel),
      )
      .toContain(` CHATHISTORY LATEST ${channel} `);
    const row = bufferRow(page, channel);
    await expect(row).toContainText(newestText);
    await expect(row).toHaveAccessibleName(`${channel}, 99+ unread`);
    await expect
      .poll(() => snapshotNumber(page, channel, "gap_until"))
      .not.toBeUndefined();
    const wire = await page.evaluate(
      () => Reflect.get(globalThis, "launchCatchupWire") as WireTrace[],
    );
    expect(
      wire.some(
        (entry) =>
          entry.direction === "sent" &&
          entry.line.includes(` CHATHISTORY LATEST ${channel} `),
      ),
    ).toBe(true);
  } finally {
    keeper.close();
    for (const sender of writers) sender.close();
  }
});

test("an unmarked channel keeps pre-follow history read and offline traffic unread", async ({
  baseURL,
  context,
  page,
}) => {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const suffix = Date.now().toString(36).slice(-5);
  const account = `seed-${suffix}`;
  const password = `test-${account}`;
  const channel = `#seed-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const writer = await IrcClient.connectIsolated(`seed-w-${suffix}`, channel);
  let current = page;
  try {
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();
    const oldText = `history before this device ${suffix}`;
    await writer.privmsgConfirmed(channel, oldText);

    await useDedicatedWorker(current);
    await current.goto(accountUrl(baseURL, account, password, channel));
    await expect(bufferRow(current, channel)).toContainText(oldText);
    await expect(bufferRow(current, channel)).toHaveAccessibleName(channel);
    await expect
      .poll(async () => (await snapshotReadAt(current, channel)) !== undefined)
      .toBe(true);

    await current.close();
    const offlineText = `offline unmarked traffic ${suffix}`;
    await writer.privmsgConfirmed(channel, offlineText);

    current = await context.newPage();
    await useDedicatedWorker(current);
    await current.goto(accountUrl(baseURL, account, password, channel));
    await expect(bufferRow(current, channel)).toContainText(offlineText);
    await expect(bufferRow(current, channel)).toHaveAccessibleName(
      `${channel}, 1 unread`,
    );
  } finally {
    if (!current.isClosed()) await current.close();
    keeper.close();
    writer.close();
  }
});

test("records the sixteen-buffer cold-launch wire budget", async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const suffix = Date.now().toString(36).slice(-5);
  const account = `cold-${suffix}`;
  const password = `test-${account}`;
  const channels = [
    "#weblounge-test",
    ...Array.from(
      { length: channelCount - 1 },
      (_, index) => `#cold-${index}-${suffix}`,
    ),
  ];
  const keeper = await IrcClient.connectIsolated(account, channels[0]);
  const writer = await IrcClient.connectIsolated(
    `cold-w-${suffix}`,
    channels[0],
  );
  const bots = await Promise.all(
    Array.from({ length: directCount }, (_, index) =>
      IrcClient.connectIsolated(`cold-d${index}-${suffix}`, channels[0]),
    ),
  );
  try {
    await keeper.joinAll(channels.slice(1));
    await writer.joinAll(channels.slice(1));
    await Promise.all(
      channels.map((channel, index) =>
        writer.privmsgConfirmed(channel, `cold channel ${index} ${suffix}`),
      ),
    );
    await Promise.all(
      bots.map((bot, index) =>
        bot.privmsgConfirmed(account, `cold direct ${index} ${suffix}`),
      ),
    );
    await keeper.setAlwaysOn(true);
    keeper.close();
    await keeper.waitForDisconnect();

    await captureLaunchWire(page);
    await page.goto(accountUrl(baseURL, account, password, ...channels));
    await expect(bufferRow(page, bots[0]?.nickname ?? "missing")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "launchCatchupWire") as WireTrace[]
            ).filter(
              (entry) =>
                entry.direction === "sent" &&
                entry.line.includes(" CHATHISTORY "),
            ).length,
        ),
      )
      .toBe(17);
    const wire = await page.evaluate(
      () => Reflect.get(globalThis, "launchCatchupWire") as WireTrace[],
    );
    const counts = Object.fromEntries(countWireCommands(wire));
    expect(counts).toEqual({
      AUTHENTICATE: 2,
      CAP: 3,
      CHATHISTORY: 17,
      ISUPPORT: 1,
      JOIN: 7,
      MARKREAD: 9,
      NAMES: 7,
      NICK: 1,
      USER: 1,
    });
    expect(
      Object.values(counts).reduce((total, count) => total + count, 0),
    ).toBe(48);
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
  readonly msgid: string;
  readonly preview: string;
  readonly badge:
    | { readonly kind: "none" }
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
        schema: 6,
        fingerprint,
        rows: rows.map((row) => ({
          conversation: { kind: row.kind, key: row.title },
          title: row.title,
          last_activity_ms: Date.parse(row.time),
          newest: {
            msgid: row.msgid,
            server_time_ms: Date.parse(row.time),
          },
          stubs:
            row.badge.kind === "none"
              ? []
              : [
                  {
                    msgid: row.msgid,
                    time: Date.parse(row.time),
                    mention: row.badge.kind === "mentions",
                  },
                ],
          preview: row.preview,
        })),
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function captureLaunchWire(
  page: Page,
  heldRequest?: string,
): Promise<void> {
  await page.addInitScript((request) => {
    Reflect.deleteProperty(globalThis, "SharedWorker");
    const wire: unknown[] = [];
    const events: unknown[] = [];
    Reflect.set(
      globalThis,
      "launchCatchupStartedAt",
      performance.timeOrigin + performance.now(),
    );
    Reflect.set(globalThis, "launchCatchupWire", wire);
    Reflect.set(globalThis, "launchCatchupEvents", events);
    const subscribed = new WeakSet<Worker>();
    let subscribedWorker: Worker | undefined;
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (!subscribed.has(this)) {
        subscribed.add(this);
        subscribedWorker = this;
        Reflect.apply(postMessage, this, [
          {
            type: "history_wire_test_trace_subscribe",
            hold_request: request,
          },
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
        if (event.data?.type === "history_wire_test_control") return;
        if (event.data?.type === "history_wire_test_request_held") {
          Reflect.set(globalThis, "launchCatchupHeldRequest", event.data);
          return;
        }
        const network = event.data?.network;
        if (
          event.data?.type === "network_state_changed" &&
          typeof network === "object" &&
          network !== null &&
          "state" in network
        )
          events.push({
            at: performance.timeOrigin + performance.now(),
            state: network.state,
          });
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      addListener.call(this, type, wrapped, options);
    };
    Reflect.set(globalThis, "launchCatchupReleaseRequest", () => {
      subscribedWorker?.postMessage({
        type: "history_wire_test_release_request",
      });
    });
  }, heldRequest);
}

function accountUrl(
  baseURL: string,
  account: string,
  password: string,
  ...channels: string[]
): string {
  const url = new URL("/", baseURL);
  url.searchParams.set("irc-password", password);
  url.searchParams.set("irc-account", account);
  url.searchParams.set("irc-nickname", account);
  for (const channel of channels)
    url.searchParams.append("irc-autojoin", channel);
  return url.href;
}

async function snapshotSchema(page: Page): Promise<number | undefined> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(
      (value) =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = value
            .transaction("cache", "readonly")
            .objectStore("cache")
            .get(new TextEncoder().encode("chat-list-snapshot"));
          request.onsuccess = () => {
            const bytes = request.result as Uint8Array | undefined;
            if (bytes === undefined) {
              resolve(undefined);
              return;
            }
            const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
            resolve(
              typeof parsed === "object" &&
                parsed !== null &&
                "schema" in parsed &&
                typeof parsed.schema === "number"
                ? parsed.schema
                : undefined,
            );
          };
          request.onerror = () => reject(request.error);
        }),
    );
  } finally {
    await closeEngineDatabase(database);
  }
}

async function snapshotReadAt(
  page: Page,
  title: string,
): Promise<number | undefined> {
  return snapshotNumber(page, title, "read_at_ms");
}

async function snapshotNumber(
  page: Page,
  title: string,
  field: "gap_until" | "read_at_ms",
): Promise<number | undefined> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(
      (value, lookup) =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = value
            .transaction("cache", "readonly")
            .objectStore("cache")
            .get(new TextEncoder().encode("chat-list-snapshot"));
          request.onsuccess = () => {
            const bytes = request.result as Uint8Array | undefined;
            if (bytes === undefined) {
              resolve(undefined);
              return;
            }
            const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("rows" in parsed) ||
              !Array.isArray(parsed.rows)
            ) {
              resolve(undefined);
              return;
            }
            const row = parsed.rows.find(
              (candidate: unknown) =>
                typeof candidate === "object" &&
                candidate !== null &&
                "title" in candidate &&
                candidate.title === lookup.title,
            );
            const number =
              typeof row === "object" && row !== null
                ? Reflect.get(row, lookup.field)
                : undefined;
            resolve(typeof number === "number" ? number : undefined);
          };
          request.onerror = () => reject(request.error);
        }),
      { field, title },
    );
  } finally {
    await closeEngineDatabase(database);
  }
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

function countWireCommands(wire: readonly WireTrace[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of wire) {
    if (entry.direction !== "sent") continue;
    const command = wireCommand(entry.line);
    counts.set(command, (counts.get(command) ?? 0) + 1);
  }
  return counts;
}

function clientRequestReplyLatencies(wire: readonly WireTrace[]) {
  return wire
    .filter(
      (entry) =>
        entry.direction === "sent" &&
        ["CHATHISTORY", "MARKREAD"].includes(wireCommand(entry.line)),
    )
    .map((request) => {
      const label = /^@label=([^ ;]+)/u.exec(request.line)?.[1];
      if (label === undefined)
        throw new Error(`client request has no label: ${request.line}`);
      const reply = wire.find(
        (entry) =>
          entry.direction === "received" &&
          new RegExp(`(?:^@|;)label=${label}(?:;| )`, "u").test(entry.line),
      );
      if (reply === undefined)
        throw new Error(`client request has no reply: ${request.line}`);
      return {
        request: request.line,
        receivedAt: reply.at,
        latency: reply.at - request.at,
      };
    });
}

function wireCommand(line: string): string {
  const words = line.trim().split(/\s+/u);
  const command = words[0]?.startsWith("@") ? words[1] : words[0];
  if (command === undefined) throw new Error(`empty IRC line: ${line}`);
  return command.toUpperCase();
}
