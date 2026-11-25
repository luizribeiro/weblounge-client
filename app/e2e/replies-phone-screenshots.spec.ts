import type { Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { longPressMessage } from "./message-sheet";
import { productionMessageRow } from "./production-ergo";
import { composer } from "./redaction";
import {
  expectReviewQuotes,
  replyBar,
  replyShot,
  seedReviewThread,
} from "./replies";
import { choosePhoneAppearance } from "./settings-fixture";
import { expectSettled } from "./settled";
import { tap } from "./touch";

test.skip(
  process.env.WEBLOUNGE_REPLY_SHOTS === undefined,
  "review screenshots only",
);

const themes = [
  { name: "Lounge", id: "lounge" },
  { name: "Lounge Night", id: "lounge-night" },
  { name: "n.e.", id: "ne" },
] as const;

for (const theme of themes)
  test(`captures phone reply quotes and the reply bar in ${theme.name}`, async ({
    page,
    irc,
  }) => {
    const thread = await seedReviewThread(irc);
    await page.goto(irc.url());
    await choosePhoneAppearance(page, [theme.name]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    await openChannel(page, irc);
    await expectReviewQuotes(page, thread);
    await replyShot(page, `phone-quotes-${theme.id}`);

    const sheet = await longPressMessage(
      page,
      productionMessageRow(page, thread.answer),
      thread.replierNick,
    );
    await tap(page, sheet.getByRole("button", { name: "Reply" }));
    await expect(replyBar(page)).toBeVisible();
    await composer(page).fill("thanks, that settles it");
    await replyShot(page, `phone-bar-${theme.id}`);
  });

async function openChannel(page: Page, irc: IrcTestAccount): Promise<void> {
  await tap(page, page.getByRole("button", { name: irc.channel }));
  await expectSettled(page, { conversation: irc.channel });
}
