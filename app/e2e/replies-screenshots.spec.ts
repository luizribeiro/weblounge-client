import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { productionMessageRow } from "./production-ergo";
import { composer, conversationButton, openConversation } from "./redaction";
import {
  expectReviewQuotes,
  replyBar,
  replyShot,
  seedReviewThread,
} from "./replies";
import { choose } from "./settings-fixture";

test.skip(
  process.env.WEBLOUNGE_REPLY_SHOTS === undefined,
  "review screenshots only",
);

test("captures desktop reply quotes and the reply bar in Lounge, Lounge Night and n.e.", async ({
  page,
  irc,
  isMobile,
}) => {
  test.skip(isMobile, "desktop layout");
  await page.setViewportSize({ width: 1280, height: 720 });
  const thread = await seedReviewThread(irc);
  await page.goto(irc.url());
  await expect(conversationButton(page, irc.channel)).toBeVisible();
  await openConversation(page, irc.channel);
  await expectReviewQuotes(page, thread);
  await productionMessageRow(page, thread.answer).hover();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBar(page)).toBeVisible();
  await composer(page).fill("thanks, that settles it");
  await page.mouse.move(0, 0);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await replyShot(page, `desktop-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: null });
  await useNeTheme(page);
  await expect(replyBar(page)).toBeVisible();
  await composer(page).focus();
  await replyShot(page, "desktop-ne");
});

async function useNeTheme(page: Page): Promise<void> {
  await page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("button", { name: "Settings" })
    .click();
  await choose(page, "n.e.");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ne");
}
