import { devices, type Locator } from "@playwright/test";
import { expect, test } from "./irc-fixture";
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
    irc,
  }) => {
    const channel = irc.channelNamed("paint");
    const suffix = irc.id;
    const bots = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        irc.peer(`paint${index}`, [channel]),
      ),
    );
    const messages = Array.from(
      { length: 60 },
      (_, index) => `painted history ${suffix} ${index}`,
    );
    const context = await browser.newContext({ baseURL, ...shell.context });
    await irc.scope(context);
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
      await page.goto(irc.url());
      if (shell.name === "mobile")
        await page.getByRole("button", { name: irc.channel }).click();
      const composer = page.getByRole("textbox", {
        name: shell.name === "mobile" ? `Message ${irc.channel}` : "Message",
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
