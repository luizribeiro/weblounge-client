import {
  type Browser,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  hasSelfNickColour,
  productionMessageRow,
  useDedicatedWorker,
} from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

// One engine history page holds 100 rows, so 100 newer fillers push the
// seeded long messages into the older page that opening the buffer requests.
const fillerCount = 100;
const fillerSenders = 10;

interface SeededChannel {
  readonly channel: string;
  readonly older: readonly string[];
  readonly ownMultiline: string;
  readonly newest: string;
}

const shells = [
  { name: "desktop", context: { viewport: { width: 1_400, height: 1_000 } } },
  {
    name: "mobile",
    context: { ...devices["Pixel 7"], viewport: { width: 402, height: 874 } },
  },
] as const;

for (const shell of shells) {
  test(`places an older page of long and multiline history above the live edge on ${shell.name}`, async ({
    browser,
    baseURL,
  }) => {
    const seeded = await seedChannel();
    const page = await openApp(browser, baseURL, shell.context);
    try {
      const row = page
        .locator("[data-buffer-id]")
        .filter({ hasText: seeded.channel });
      await expect(row).toBeVisible();
      await expectLatestPageLoaded(row, shell.name, seeded);
      await row.click();

      const list = page.locator("[data-message-list]");
      const older = [...seeded.older, seeded.ownMultiline];
      await list.hover();
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, -100_000);
          return renderedRowText(list, "first");
        })
        .toBe(older[0]);
      const rows = older.map((text) => productionMessageRow(page, text));
      for (const olderRow of rows) await expect(olderRow).toHaveCount(1);
      const indexes = await Promise.all(rows.map(rowIndex));
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
      const times = await Promise.all(rows.map(rowTime));
      expect(times).toEqual([...times].sort((left, right) => left - right));
      await expect
        .poll(() => rows[seeded.older.length]?.evaluate(hasSelfNickColour))
        .toBe(true);

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
      await leaveChannel(seeded.channel);
    }
  });
}

async function seedChannel(): Promise<SeededChannel> {
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
  try {
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
  } finally {
    owner.close();
    for (const sender of senders) sender.close();
  }
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
): Promise<Page> {
  const context = await browser.newContext({ ...options, baseURL });
  const page = await context.newPage();
  await useDedicatedWorker(page);
  await page.goto("/?irc-password=weblounge-test");
  return page;
}

async function expectLatestPageLoaded(
  row: Locator,
  shell: string,
  seeded: SeededChannel,
): Promise<void> {
  if (shell === "mobile") {
    await expect(row).toContainText(seeded.newest);
    return;
  }
  await expect(row).toHaveAttribute("data-unread", /^[1-9]\d*$/u);
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
