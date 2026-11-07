import { devices, expect, type Locator, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { waitForStableGeometry } from "./stable-geometry";
import {
  expectTranscriptHitTarget,
  expectTranscriptPixelVariance,
} from "./transcript-paint";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const shell of [
  { name: "desktop", context: { viewport: { width: 1_200, height: 800 } } },
  {
    name: "mobile",
    context: {
      ...devices["iPhone 16 Pro"],
      viewport: { width: 402, height: 874 },
    },
  },
] as const) {
  test(`paints several screens of history at every ${shell.name} scroll position`, async ({
    baseURL,
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const channel = `#paint-${suffix}`;
    const bots = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        IrcClient.connect(
          `paint${index}-${suffix}`,
          "weblounge-bot",
          "weblounge-bot-test",
          channel,
        ),
      ),
    );
    const messages = Array.from(
      { length: 60 },
      (_, index) => `painted history ${suffix} ${index}`,
    );
    const context = await browser.newContext({ baseURL, ...shell.context });
    const page = await context.newPage();
    try {
      const firstBot = bots[0];
      if (firstBot === undefined) throw new Error("no history sender");
      for (let index = 0; index < messages.length; index += bots.length)
        await Promise.all(
          bots.map((bot, offset) => {
            const message = messages[index + offset];
            return message === undefined
              ? Promise.resolve("")
              : bot.privmsgConfirmed(channel, message);
          }),
        );
      await firstBot.privmsgConfirmed(
        channel,
        `painted history ready ${suffix}`,
      );
      await page.goto("/?irc-password=weblounge-test");
      if (shell.name === "mobile")
        await page.getByRole("button", { name: "#weblounge-test" }).click();
      const composer = page.getByRole("textbox", {
        name: shell.name === "mobile" ? "Message #weblounge-test" : "Message",
      });
      await composer.fill(`/join ${channel}`);
      await composer.press("Enter");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      const list =
        shell.name === "mobile"
          ? page
              .locator("[data-mobile-chat]")
              .filter({ has: page.getByRole("heading", { name: channel }) })
              .locator("[data-message-list]")
          : page.locator("[data-message-list]");
      await expect(
        page.getByText(`painted history ready ${suffix}`, { exact: true }),
      ).toBeVisible();
      await list.press("End");
      await expectTranscriptHitTarget(list, "last");
      await expectTranscriptPixelVariance(list);

      await scrollTo(list, "middle");
      await expectTranscriptHitTarget(list);
      await expectTranscriptPixelVariance(list);

      await scrollTo(list, "top");
      await expectTranscriptHitTarget(list);
      await expectTranscriptPixelVariance(list);
    } finally {
      for (const bot of bots) bot.close();
      await context.close();
    }
  });
}

async function scrollTo(
  list: Locator,
  position: "middle" | "top",
): Promise<void> {
  const setPosition = () =>
    list.evaluate((element, nextPosition) => {
      const next =
        nextPosition === "top"
          ? 0
          : (element.scrollHeight - element.clientHeight) / 2;
      element.scrollTop = next;
      return next;
    }, position);
  await setPosition();
  await waitForStableGeometry(list, "[data-message-row]");
  const target = await setPosition();
  await expect
    .poll(() =>
      list.evaluate(
        (element, expected) => Math.abs(element.scrollTop - expected),
        target,
      ),
    )
    .toBeLessThanOrEqual(1);
}
