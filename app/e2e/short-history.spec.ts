import type { Page } from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { captureHistoryWire, type WireTrace } from "./history-wire-fixture";
import { type IrcClient, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
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
    irc,
  }, testInfo) => {
    test.skip(testInfo.project.name !== layout.project, "layout project only");
    const fixture = await seedShortDirectHistory(irc);
    await useDedicatedWorker(page);
    await captureHistoryWire(page);
    await page.goto("/config.json");
    await seedDirectSnapshot(page, baseURL, fixture.peer.nickname);
    await page.goto(irc.url());
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
  });
}

interface ShortDirectFixture {
  readonly older: readonly string[];
  readonly peer: IrcClient;
  readonly recent: readonly string[];
}

async function seedShortDirectHistory(
  irc: IrcTestAccount,
): Promise<ShortDirectFixture> {
  const suffix = irc.id;
  const account = irc.account;
  const keeper = await irc.self([irc.channel]);
  const peer = await irc.peer("concierge");
  const older = Array.from(
    { length: 3 },
    (_, index) => `older concierge ${suffix} ${index}`,
  );
  const recent: string[] = [];
  await keeper.enablePersistence();
  let boundary = "";
  for (const text of older)
    boundary = await peer.privmsgConfirmed(account, text);
  let boundaryTime = serverTime(boundary);
  await keeper.markRead(peer.nickname, boundaryTime);
  for (let candidate = 0; recent.length < 3; candidate += 1) {
    const text = `recent concierge ${suffix} ${candidate}`;
    const line = await peer.privmsgConfirmed(account, text);
    const time = serverTime(line);
    if (Date.parse(time) <= Date.parse(boundaryTime)) {
      boundaryTime = time;
      await keeper.markRead(peer.nickname, boundaryTime);
      recent.length = 0;
    } else recent.push(text);
  }
  return { older, peer, recent };
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
