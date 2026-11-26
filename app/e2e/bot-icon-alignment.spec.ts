import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { backToChatList, expectSettled } from "./settled";
import { escapeRegex } from "./sidebar-rows";
import { expectCentredOnText } from "./text-centre";

interface Layout {
  readonly name: "desktop" | "phone";
  readonly context: BrowserContextOptions;
}

const layouts: readonly Layout[] = [
  { name: "desktop", context: { viewport: { width: 1_280, height: 800 } } },
  {
    name: "phone",
    context: {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    },
  },
];

for (const layout of layouts) {
  test(`${layout.name}: a bot's robot sits on the centre of the text beside it`, async ({
    browser,
    baseURL,
    irc,
  }) => {
    const bot = await irc.peer("iris", []);
    const context = await browser.newContext({ baseURL, ...layout.context });
    await irc.scope(context);
    const page = await context.newPage();
    try {
      await bot.mode(bot.nickname, "+B");
      await installNativeFeelInstrumentation(page);
      await page.goto(irc.url());
      await expectJoined(page, layout, irc.channel);
      await bot.privmsgConfirmed(irc.account, `beep ${irc.id}`);
      await page
        .getByRole("button", {
          name: new RegExp(`^${escapeRegex(bot.nickname)}(?:,|$)`, "u"),
        })
        .click();
      await expectSettled(page, { conversation: bot.nickname });

      const status = page.locator("[data-direct-presence]");
      await expect(status).toHaveText(/^Online$/u);
      await expectCentredOnText(
        status.getByRole("img", { name: "bot" }),
        status.locator("[data-line]"),
      );

      const nickColumn = page
        .locator("[data-message-chrome]")
        .filter({ has: page.getByRole("img", { name: "bot" }) });
      await expect(nickColumn).toHaveCount(1);
      await expectCentredOnText(
        nickColumn.getByRole("img", { name: "bot" }),
        nickColumn.getByText(bot.nickname, { exact: true }),
      );
      await nativeFeelAudit(page);
    } finally {
      bot.close();
      await context.close();
    }
  });
}

/** The bot's line only reaches us once we are registered, which a shown channel proves. */
async function expectJoined(
  page: Page,
  layout: Layout,
  channel: string,
): Promise<void> {
  if (layout.name === "phone")
    await page.getByRole("button", { exact: true, name: channel }).click();
  await expectSettled(page, { conversation: channel });
  if (layout.name === "phone") await backToChatList(page, channel);
}
