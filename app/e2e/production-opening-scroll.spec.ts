import { expect, type Locator, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { productionChannel, useDedicatedWorker } from "./production-ergo";
import { framesPerSecond } from "./timeline-geometry";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

test("keeps the opening history viewport stable frame by frame", async ({
  page,
}) => {
  const bot = await IrcClient.connect(
    `opening-scroll-${Date.now().toString().slice(-6)}`,
    "weblounge-bot",
    "weblounge-bot-test",
    productionChannel,
  );
  const suffix = Date.now();
  try {
    for (let index = 0; index < 24; index += 1)
      await bot.privmsgConfirmed(
        productionChannel,
        `opening history ${suffix} ${index} ${"wrapped text ".repeat(12)}`,
      );
    await bot.multilineConfirmed(
      productionChannel,
      `opening multiline ${suffix} ${"long text ".repeat(30)}\n\nlast line`,
    );

    await useDedicatedWorker(page);
    await page.goto("/?irc-password=weblounge-test");
    const list = page.locator("[data-message-list]");
    await expect(list).toBeVisible();
    const samples = await openingViewportSamples(list, framesPerSecond);
    expect(samples).toHaveLength(framesPerSecond + 1);
    expect(
      samples.every(
        (sample, index) =>
          sample.distanceFromBottom <= 3 ||
          index === 0 ||
          (sample.key === samples[index - 1]?.key &&
            Math.abs(sample.offset - (samples[index - 1]?.offset ?? 0)) <= 1),
      ),
    ).toBe(true);
  } finally {
    bot.close();
  }
});

interface ViewportSample {
  readonly key: string;
  readonly offset: number;
  readonly distanceFromBottom: number;
}

function openingViewportSamples(
  list: Locator,
  frames: number,
): Promise<ViewportSample[]> {
  return list.evaluate(async (element, frameCount) => {
    const firstVisible = () => {
      const listRect = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>("li[data-row-key]")]
        .map((row) => ({ row, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > listRect.top)
        .sort((left, right) => left.rect.top - right.rect.top)[0];
    };
    if (firstVisible() === undefined)
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (firstVisible() === undefined) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(element, { childList: true, subtree: true });
      });
    const values: ViewportSample[] = [];
    const sample = () => {
      const visible = firstVisible();
      const listRect = element.getBoundingClientRect();
      values.push({
        key: visible?.row.dataset.rowKey ?? "",
        offset: (visible?.rect.top ?? listRect.top) - listRect.top,
        distanceFromBottom:
          element.scrollHeight - element.scrollTop - element.clientHeight,
      });
    };
    // wait-ok: viewport stability is sampled over the fixed one-second audit window
    for (let frame = 0; frame < frameCount; frame += 1) {
      sample();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    sample();
    return values;
  }, frames);
}
