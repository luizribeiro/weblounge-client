import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  productionChannel,
  productionMessageRow,
  useDedicatedWorker,
} from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

test("orders split and multiline history by each message server time", async ({
  page,
}) => {
  const bot = await IrcClient.connect(
    `history-order-${Date.now().toString().slice(-6)}`,
    "weblounge-bot",
    "weblounge-bot-test",
    productionChannel,
  );
  const suffix = Date.now();
  const multiline = `multiline first ${suffix} ${"b".repeat(280)}\n\nmultiline last ${suffix} ${"c".repeat(280)}`;
  try {
    const splitFirst = await bot.privmsgSplitConfirmed(
      productionChannel,
      splitText("first", suffix),
    );
    await bot.multilineConfirmed(productionChannel, multiline);
    const splitLast = await bot.privmsgSplitConfirmed(
      productionChannel,
      splitText("last", suffix),
    );

    await useDedicatedWorker(page);
    await page.setViewportSize({ width: 2_000, height: 1_400 });
    const joinedAt = Date.now();
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
    const rows = [...splitFirst, multiline, ...splitLast].map((text) =>
      productionMessageRow(page, text),
    );
    for (const row of rows) await expect(row).toBeVisible();
    await expect(
      rows[splitFirst.length]?.getByTitle(bot.nickname),
    ).toBeVisible();

    const indexes = await Promise.all(
      rows.map((row) =>
        row.evaluate((element) => Number(element.closest("li")?.dataset.index)),
      ),
    );
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    const times = await Promise.all(
      rows.map(async (row) =>
        new Date(
          (await row.locator("time").getAttribute("datetime")) ?? 0,
        ).getTime(),
      ),
    );
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(times.every((time) => time < joinedAt)).toBe(true);
  } finally {
    bot.close();
  }
});

function splitText(label: string, suffix: number): string {
  return Array.from(
    { length: 90 },
    (_, index) => `${label}-${suffix}-${index}`,
  ).join(" ");
}
