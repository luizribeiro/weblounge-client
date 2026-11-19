import type { Locator, Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

test.describe("nick mentions in message text against local Ergo", () => {
  test.use({ viewport: { width: 1_200, height: 800 } });

  test("colours a member who has not spoken, and keeps it after they leave", async ({
    page,
    irc,
  }) => {
    const quiet = await irc.peer("quiet");
    const talker = await irc.peer("talker");
    await installNativeFeelInstrumentation(page);
    await openChannel(page, irc);

    const ownText = `${quiet.nickname}: are you still alive?`;
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await composer.fill(ownText);
    await composer.press("Enter");
    const peerText = `ping ${quiet.nickname}, lunch?`;
    await talker.privmsgConfirmed(irc.channel, peerText);

    await expectColouredMention(page, ownText, quiet);
    await expectColouredMention(page, peerText, quiet);

    await quiet.part(irc.channel);
    await expect(
      page
        .locator("[data-system-line]")
        .filter({ hasText: quiet.nickname })
        .filter({ hasText: /\bleft\b/u }),
    ).toBeVisible();
    await expectColouredMention(page, ownText, quiet);
    await expectColouredMention(page, peerText, quiet);
    await expectSettled(page, { conversation: irc.channel });
    await nativeFeelAudit(page);
  });

  test("colours mentions in history loaded before the member list", async ({
    page,
    irc,
  }) => {
    const quiet = await irc.peer("hquiet");
    const gone = await irc.peer("hgone");
    const talker = await irc.peer("htalker");
    const presentText = `${quiet.nickname}: are you still alive?`;
    const departedText = `${gone.nickname}: see you tomorrow`;
    await talker.privmsgConfirmed(irc.channel, presentText);
    await talker.privmsgConfirmed(irc.channel, departedText);
    await gone.part(irc.channel);

    await openChannel(page, irc);

    await expectColouredMention(page, presentText, quiet);
    await expectColouredMention(page, departedText, gone);
    await expectSettled(page, { conversation: irc.channel });
  });
});

async function openChannel(page: Page, irc: IrcTestAccount): Promise<void> {
  await page.goto(irc.url());
  await expect(
    page.getByRole("textbox", { name: `Message ${irc.channel}` }),
  ).toBeVisible();
  await expectSettled(page, { conversation: irc.channel });
}

async function expectColouredMention(
  page: Page,
  text: string,
  mentioned: IrcClient,
): Promise<void> {
  const mention = mentionIn(page, text, mentioned.nickname);
  await expect(mention).toBeVisible();
  await expect(mention).toHaveAttribute("style", /--wl-nick-\d+/u);
}

function mentionIn(page: Page, text: string, nickname: string): Locator {
  return page
    .locator(`[data-message-row][data-message-text="${text}"]`)
    .getByRole("button", { name: `Open direct message with ${nickname}` });
}
