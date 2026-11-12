import { expect, type Page, test } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { captureHistoryWire, type WireTrace } from "./history-wire-fixture";
import { IrcClient } from "./irc-client";
import { useDedicatedWorker } from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const layout of [
  { name: "desktop", project: "chromium" },
  { name: "iPhone WebKit", project: "webkit-phone-layout" },
] as const) {
  test(`fills a short direct transcript through history start on ${layout.name}`, async ({
    baseURL,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== layout.project, "layout project only");
    const fixture = await seedShortDirectHistory();
    try {
      await useDedicatedWorker(page);
      await captureHistoryWire(page);
      await page.goto("/config.json");
      await seedDirectSnapshot(page, baseURL, fixture.peer.nickname);
      await page.goto(startUrl(baseURL, fixture));
      const direct = page.getByRole("button", {
        name: new RegExp(`^${fixture.peer.nickname}`),
      });
      await expect(direct).toBeVisible();
      await direct.click();
      const list = page.locator("[data-message-list]");

      await expect(
        list.getByText(fixture.recent[2] ?? "", { exact: true }),
      ).toBeVisible();
      const beginning = page.locator('[data-divider-kind="history"]').filter({
        hasText: `Beginning of your messages with ${fixture.peer.nickname}`,
      });
      await expect
        .poll(
          async () =>
            (await beforeRequestCount(page, fixture.peer.nickname)) === 1 ||
            (await beginning.isVisible()),
        )
        .toBe(true);
      for (const text of [...fixture.older, ...fixture.recent])
        await expect(list.getByText(text, { exact: true })).toBeVisible();
      await expect(beginning).toBeVisible();
      expect(
        await beforeRequestCount(page, fixture.peer.nickname),
      ).toBeLessThanOrEqual(1);

      const geometry = await list.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }));
      expect(geometry.scrollTop).toBe(0);
      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
    } finally {
      await page.context().close();
      fixture.keeper.close();
      fixture.peer.close();
    }
  });
}

interface ShortDirectFixture {
  readonly account: string;
  readonly channel: string;
  readonly keeper: IrcClient;
  readonly older: readonly string[];
  readonly peer: IrcClient;
  readonly recent: readonly string[];
}

async function seedShortDirectHistory(): Promise<ShortDirectFixture> {
  const suffix = Date.now().toString(36);
  const account = `short-user-${suffix}`;
  const channel = `#short-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const peer = await IrcClient.connectIsolated(`concierge-${suffix}`, channel);
  const older = Array.from(
    { length: 3 },
    (_, index) => `older concierge ${suffix} ${index}`,
  );
  const recent: string[] = [];
  try {
    await keeper.enablePersistence();
    let boundary = "";
    for (const text of older)
      boundary = await peer.privmsgConfirmed(account, text);
    const timestamp = /(?:^@|;)time=([^; ]+)/u.exec(boundary)?.[1];
    if (timestamp === undefined)
      throw new Error("direct-history boundary time is missing");
    let boundaryTime = timestamp;
    await keeper.markRead(peer.nickname, boundaryTime);
    for (let candidate = 0; recent.length < 3; candidate += 1) {
      const text = `recent concierge ${suffix} ${candidate}`;
      const line = await peer.privmsgConfirmed(account, text);
      const time = /(?:^@|;)time=([^; ]+)/u.exec(line)?.[1];
      if (time === undefined)
        throw new Error("recent direct-history time is missing");
      if (Date.parse(time) <= Date.parse(boundaryTime)) {
        boundaryTime = time;
        await keeper.markRead(peer.nickname, boundaryTime);
        recent.length = 0;
      } else recent.push(text);
    }
  } catch (error) {
    keeper.close();
    peer.close();
    throw error;
  }
  return { account, channel, keeper, older, peer, recent };
}

function startUrl(
  baseURL: string | undefined,
  fixture: ShortDirectFixture,
): string {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const url = new URL("/", baseURL);
  url.searchParams.set("irc-password", `test-${fixture.account}`);
  url.searchParams.set("irc-account", fixture.account);
  url.searchParams.set("irc-nickname", `${fixture.account}-app`);
  url.searchParams.append("irc-autojoin", fixture.channel);
  return url.href;
}

function beforeRequestCount(page: Page, target: string): Promise<number> {
  return page.evaluate(
    ({ directTarget }) =>
      (Reflect.get(globalThis, "historyWireTimeline") as WireTrace[]).filter(
        (entry) =>
          entry.direction === "sent" &&
          entry.line.includes(` CHATHISTORY BEFORE ${directTarget} `),
      ).length,
    { directTarget: target },
  );
}

async function seedDirectSnapshot(
  page: Page,
  baseURL: string | undefined,
  title: string,
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
        schema: 6,
        fingerprint,
        rows: [
          {
            conversation: { kind: "direct", key: title },
            title,
            last_activity_ms: 1_800_000_000_000,
            stubs: [],
            preview: `cached ${title}`,
          },
        ],
      },
    );
  } finally {
    await closeEngineDatabase(database);
  }
}
