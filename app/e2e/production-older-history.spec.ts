import {
  type Browser,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { closeEngineDatabase, openEngineDatabase } from "./engine-database";
import { captureHistoryWire, type WireTrace } from "./history-wire-fixture";
import { IrcClient } from "./irc-client";
import { scrollToTranscriptTop } from "./message-list-scroll";
import {
  hasSelfNickColour,
  productionMessageRow,
  useDedicatedWorker,
} from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

// One engine history page holds 100 rows, so this requires several older pages.
const fillerCount = 300;
const fillerSenders = 10;

interface SeededChannel {
  readonly channel: string;
  readonly older: readonly string[];
  readonly ownMultiline: string;
  readonly newest: string;
}

interface SeedFixture {
  readonly channel: string;
  readonly owner: IrcClient;
  readonly senders: readonly IrcClient[];
  readonly suffix: string;
}

const shells = [
  { name: "desktop", context: { viewport: { width: 1_400, height: 1_000 } } },
  {
    name: "mobile",
    context: { ...devices["Pixel 7"], viewport: { width: 402, height: 874 } },
  },
] as const;

for (const shell of shells) {
  test(`prefetches older history without moving the reader on ${shell.name}`, async ({
    browser,
    baseURL,
  }) => {
    const fixture = await createSeedFixture();
    const page = await openApp(
      browser,
      baseURL,
      shell.context,
      fixture.channel,
    );
    try {
      const row = page
        .locator("[data-buffer-id]")
        .filter({ hasText: fixture.channel });
      await expect(row).toBeVisible();
      if (shell.name === "desktop") {
        await page
          .getByRole("button", { name: "#lounge", exact: true })
          .click();
        await expect(row).not.toHaveAttribute("aria-current", "page");
        await expect(row).toHaveAttribute("data-unread", "0");
      } else await expect(row).toHaveAccessibleName(fixture.channel);

      const seeded = await seedChannel(fixture);
      if (shell.name === "desktop")
        await expect(row).toHaveAttribute("data-unread", /^[1-9]\d*$/u);
      else
        await expect(row).toHaveAccessibleName(
          new RegExp(`^${fixture.channel}, (?:[1-9]\\d*|99\\+) unread`, "u"),
        );
      await expect
        .poll(async () => (await snapshotRow(page, seeded.channel))?.preview)
        .toBe(`weblounge-bot: ${seeded.newest}`);

      await page.goto(appUrl(seeded.channel));
      await expect(row).toBeVisible();
      await row.click();
      await expect(productionMessageRow(page, seeded.newest)).toBeVisible();

      const list = page.locator("[data-message-list]");
      const older = [...seeded.older, seeded.ownMultiline];
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await beginSteadyOlderScroll(page, list, shell.name);
      await expect.poll(() => heldBeforeCount(page)).toBe(1);
      const prefetchPosition = await list.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollTop: element.scrollTop,
      }));
      expect(prefetchPosition.scrollTop).toBeGreaterThan(0);
      expect(prefetchPosition.scrollTop).toBeLessThanOrEqual(
        prefetchPosition.clientHeight * 1.5,
      );

      await continueOlderScroll(page, list, shell.name);
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await settleFrames(list);
      const anchor = await topVisibleMessage(list);
      expect(await heldBeforeCount(page)).toBe(1);

      await releaseHeldBefore(page);
      await expect.poll(() => sentBeforeCount(page, seeded.channel)).toBe(1);
      await expect(page.locator('[data-divider-kind="loading"]')).toHaveCount(
        0,
      );
      await expect
        .poll(async () =>
          Math.abs((await messageTop(list, anchor.text)) - anchor.top),
        )
        .toBeLessThanOrEqual(1);

      let requestCount = 1;
      for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
        if (
          (await page
            .locator('[data-divider-kind="history"]')
            .filter({ hasText: `Beginning of ${seeded.channel}` })
            .count()) > 0
        )
          break;
        requestCount = await loadNextOlderPage(
          page,
          list,
          seeded.channel,
          requestCount,
        );
      }
      await expect(
        page
          .locator('[data-divider-kind="history"]')
          .filter({ hasText: `Beginning of ${seeded.channel}` }),
      ).toBeVisible();
      await scrollToTranscriptTop(list);
      await settleFrames(list);
      expect(await heldBeforeCount(page)).toBe(requestCount);
      expect(await sentBeforeCount(page, seeded.channel)).toBe(requestCount);

      await expect.poll(() => renderedRowText(list, "first")).toBe(older[0]);
      const rows = older.map((text) => productionMessageRow(page, text));
      for (const olderRow of rows) await expect(olderRow).toHaveCount(1);
      const indexes = await Promise.all(rows.map(rowIndex));
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
      const times = await Promise.all(rows.map(rowTime));
      expect(times).toEqual([...times].sort((left, right) => left - right));
      await expect
        .poll(() => rows[seeded.older.length]?.evaluate(hasSelfNickColour))
        .toBe(true);
      await expect(
        page.getByRole("button", { name: /new message/ }),
      ).toHaveCount(0);

      await list.press("End");
      await expect
        .poll(() => renderedRowText(list, "last"))
        .toBe(seeded.newest);
      const newestTime = await rowTime(
        productionMessageRow(page, seeded.newest),
      );
      expect(times.every((time) => time < newestTime)).toBe(true);
      for (const text of older)
        await expect(productionMessageRow(page, text)).toHaveCount(0);
      if (shell.name === "desktop")
        await expect(row).toHaveAttribute("data-unread", "0");
    } finally {
      await page.context().close();
      closeSeedFixture(fixture);
      await leaveChannel(fixture.channel);
    }
  });
}

async function createSeedFixture(): Promise<SeedFixture> {
  const suffix = Date.now().toString(36);
  const channel = `#older-${suffix}`;
  const owner = await IrcClient.connect(
    `older-own-${suffix}`,
    "weblounge",
    "weblounge-test",
    channel,
  );
  const senders = await Promise.all(
    Array.from({ length: fillerSenders }, (_, index) =>
      IrcClient.connect(
        `louro${index}-${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      ),
    ),
  );
  return { channel, owner, senders, suffix };
}

async function seedChannel(fixture: SeedFixture): Promise<SeededChannel> {
  const { channel, owner, senders, suffix } = fixture;
  const [louro] = senders;
  if (louro === undefined) throw new Error("no history sender");
  const split = await louro.privmsgSplitConfirmed(
    channel,
    Array.from({ length: 60 }, (_, index) => `louro-${suffix}-${index}`).join(
      " ",
    ),
  );
  const multiline = `louro multiline ${suffix} ${"long ".repeat(70)}\nsecond line ${suffix}`;
  await louro.multilineConfirmed(channel, multiline);
  const ownMultiline = `own multiline ${suffix}\nown second ${suffix}`;
  await owner.multilineConfirmed(channel, ownMultiline);
  await sendFillers(senders, channel, suffix);
  const newest = `newest ${suffix}`;
  await louro.privmsgConfirmed(channel, newest);
  return {
    channel,
    older: [...split, multiline],
    ownMultiline,
    newest,
  };
}

function closeSeedFixture(fixture: SeedFixture): void {
  fixture.owner.close();
  for (const sender of fixture.senders) sender.close();
}

async function sendFillers(
  senders: readonly IrcClient[],
  channel: string,
  suffix: string,
): Promise<void> {
  const fillers = Array.from(
    { length: fillerCount },
    (_, index) => `filler ${suffix} ${index}`,
  );
  for (let index = 0; index < fillers.length; index += senders.length)
    await Promise.all(
      senders.map((sender, offset) => {
        const text = fillers[index + offset];
        return text === undefined
          ? Promise.resolve("")
          : sender.privmsgConfirmed(channel, text);
      }),
    );
}

async function leaveChannel(channel: string): Promise<void> {
  const owner = await IrcClient.connect(
    `older-leave-${Date.now().toString(36)}`,
    "weblounge",
    "weblounge-test",
    channel,
  );
  await owner.part(channel);
  owner.close();
}

async function openApp(
  browser: Browser,
  baseURL: string | undefined,
  options: Parameters<Browser["newContext"]>[0],
  channel: string,
): Promise<Page> {
  const context = await browser.newContext({ ...options, baseURL });
  const page = await context.newPage();
  await useDedicatedWorker(page);
  await captureHistoryWire(page, { beforeTarget: channel });
  await page.goto(appUrl(channel));
  return page;
}

function appUrl(channel: string): string {
  const parameters = new URLSearchParams({
    "irc-password": "weblounge-test",
    "irc-autojoin": channel,
  });
  return `/?${parameters.toString()}`;
}

async function beginSteadyOlderScroll(
  page: Page,
  list: Locator,
  shell: (typeof shells)[number]["name"],
): Promise<void> {
  if (shell === "desktop") {
    await list.hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -160);
        return heldBeforeCount(page);
      })
      .toBe(1);
    return;
  }
  const touch = await touchPoint(list);
  await list.dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: touch.identifier,
    pointerType: "touch",
    ...touch,
  });
  await list.dispatchEvent("touchstart", {
    changedTouches: [touch],
    targetTouches: [touch],
    touches: [touch],
  });
  await list.dispatchEvent("pointercancel", {
    button: 0,
    isPrimary: true,
    pointerId: touch.identifier,
    pointerType: "touch",
    ...touch,
  });
  await expect
    .poll(async () => {
      await list.evaluate((element) => {
        element.scrollTop = Math.max(
          0,
          element.scrollTop - Math.max(80, element.clientHeight / 4),
        );
        element.dispatchEvent(new Event("scroll"));
      });
      return heldBeforeCount(page);
    })
    .toBe(1);
}

async function continueOlderScroll(
  page: Page,
  list: Locator,
  shell: (typeof shells)[number]["name"],
): Promise<void> {
  if (shell === "desktop") {
    await page.mouse.wheel(0, -160);
    return;
  }
  const touch = await touchPoint(list);
  await list.evaluate((element) => {
    element.scrollTop = Math.max(
      1,
      element.scrollTop - Math.max(80, element.clientHeight / 4),
    );
    element.dispatchEvent(new Event("scroll"));
  });
  await list.dispatchEvent("touchend", {
    changedTouches: [touch],
    targetTouches: [],
    touches: [],
  });
}

async function touchPoint(list: Locator) {
  const bounds = await list.boundingBox();
  if (bounds === null) throw new Error("message list has no touch target");
  const clientX = bounds.x + bounds.width / 2;
  const clientY = bounds.y + bounds.height / 2;
  return {
    clientX,
    clientY,
    force: 1,
    identifier: 83,
    pageX: clientX,
    pageY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    screenX: clientX,
    screenY: clientY,
  };
}

async function loadNextOlderPage(
  page: Page,
  list: Locator,
  channel: string,
  previousRequestCount: number,
): Promise<number> {
  const requestCount = previousRequestCount + 1;
  await scrollToTranscriptTop(list);
  await expect.poll(() => heldBeforeCount(page)).toBe(requestCount);
  await scrollToTranscriptTop(list);
  await settleFrames(list);
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(page.locator('[data-divider-kind="loading"]')).toContainText(
    "Loading older messages",
  );
  expect(await heldBeforeCount(page)).toBe(requestCount);
  await releaseHeldBefore(page);
  await expect.poll(() => sentBeforeCount(page, channel)).toBe(requestCount);
  await expect(page.locator('[data-divider-kind="loading"]')).toHaveCount(0);
  return requestCount;
}

function heldBeforeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (Reflect.get(globalThis, "historyWireTimeline") as WireTrace[]).filter(
        (entry) => entry.event === "before_held",
      ).length,
  );
}

function sentBeforeCount(page: Page, channel: string): Promise<number> {
  return page.evaluate(
    (target) =>
      (Reflect.get(globalThis, "historyWireTimeline") as WireTrace[]).filter(
        (entry) =>
          entry.direction === "sent" &&
          entry.line.includes(`CHATHISTORY BEFORE ${target} `),
      ).length,
    channel,
  );
}

async function releaseHeldBefore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const release = Reflect.get(globalThis, "releaseHeldHistoryBefore");
    if (typeof release !== "function")
      throw new Error("history release gate is missing");
    release();
  });
}

async function topVisibleMessage(
  list: Locator,
): Promise<{ readonly text: string; readonly top: number }> {
  return list.evaluate((element) => {
    const listTop = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("li[data-row-key]")]
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.bottom > listTop &&
          candidate.querySelector("[data-message-row]") !== null
        );
      })
      .sort(
        (left, right) =>
          left.getBoundingClientRect().top - right.getBoundingClientRect().top,
      )[0];
    const text = row
      ?.querySelector<HTMLElement>("[data-message-row]")
      ?.getAttribute("data-message-text");
    if (row === undefined || text === null || text === undefined)
      throw new Error("no visible message row");
    return { text, top: row.getBoundingClientRect().top - listTop };
  });
}

function messageTop(list: Locator, text: string): Promise<number> {
  return list.evaluate((element, expected) => {
    const row = [
      ...element.querySelectorAll<HTMLElement>("[data-message-row]"),
    ].find((candidate) => candidate.dataset.messageText === expected);
    const item = row?.closest("li[data-row-key]");
    if (!(item instanceof HTMLElement))
      throw new Error(`anchored message is not rendered: ${expected}`);
    return (
      item.getBoundingClientRect().top - element.getBoundingClientRect().top
    );
  }, text);
}

function settleFrames(list: Locator): Promise<void> {
  return list.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

function renderedRowText(list: Locator, edge: "first" | "last") {
  return list.evaluate((element, edge) => {
    const rows = [
      ...element.querySelectorAll<HTMLElement>("li[data-index]"),
    ].filter((row) => row.querySelector("[data-message-row]") !== null);
    rows.sort(
      (left, right) => Number(left.dataset.index) - Number(right.dataset.index),
    );
    const row = edge === "first" ? rows[0] : rows.at(-1);
    return row
      ?.querySelector<HTMLElement>("[data-message-row]")
      ?.getAttribute("data-message-text");
  }, edge);
}

async function rowIndex(row: Locator): Promise<number> {
  return row.evaluate((element) =>
    Number(element.closest("li")?.dataset.index),
  );
}

async function rowTime(row: Locator): Promise<number> {
  return new Date(
    (await row.locator("time").getAttribute("datetime")) ?? 0,
  ).getTime();
}

interface SnapshotRow {
  readonly preview?: string;
  readonly title?: string;
}

async function snapshotRow(
  page: Page,
  title: string,
): Promise<SnapshotRow | undefined> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(async (value, expectedTitle) => {
      const bytes = await new Promise<unknown>((resolve, reject) => {
        const request = value
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (!(bytes instanceof Uint8Array)) return undefined;
      const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as {
        rows?: readonly SnapshotRow[];
      };
      return snapshot.rows?.find((row) => row.title === expectedTitle);
    }, title);
  } finally {
    await closeEngineDatabase(database);
  }
}
