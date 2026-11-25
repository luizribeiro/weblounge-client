import type { Page } from "@playwright/test";
import { messageId } from "./irc-client";
import { expect, test } from "./irc-fixture";
import { productionMessageRow } from "./production-ergo";
import { composer, conversationButton, openConversation } from "./redaction";
import { replyBar, replyQuote, replyShot } from "./replies";
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
  const bruno = await irc.peer("bruno");
  const question = "does the relay ever see plaintext?";
  const asked = await bruno.privmsgConfirmed(irc.channel, question);
  const oops = await bruno.privmsgConfirmed(irc.channel, "wrong window, sorry");
  await bruno.privmsgReplyConfirmed(
    irc.channel,
    `${bruno.nickname}: ignore that`,
    messageId(oops),
  );
  await bruno.redactConfirmed(irc.channel, messageId(oops));
  const answer = "no, it only forwards ciphertext to APNs";
  await bruno.privmsgReplyConfirmed(
    irc.channel,
    `${bruno.nickname}: ${answer}`,
    messageId(asked),
  );
  await page.goto(irc.url());
  await expect(conversationButton(page, irc.channel)).toBeVisible();
  await openConversation(page, irc.channel);
  await expect(replyQuote(page, answer)).toHaveAttribute(
    "data-reply-quote",
    "loaded",
  );
  await expect(replyQuote(page, "ignore that")).toHaveAttribute(
    "data-reply-quote",
    "unavailable",
  );
  await productionMessageRow(page, answer).hover();
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
