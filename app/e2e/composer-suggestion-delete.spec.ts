import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const deletions = {
  backspace: async (composer: Locator) => {
    const typed = await composer.inputValue();
    for (const _ of typed) await composer.press("Backspace");
  },
  "select all and delete": async (composer: Locator) => {
    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");
  },
  "select all and cut": async (composer: Locator) => {
    await composer.press("ControlOrMeta+a");
    await composer.press("ControlOrMeta+x");
  },
} as const;

test.describe("composer suggestion popup closes when its text is deleted", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const where of ["channel", "direct"] as const)
    for (const [deletion, remove] of Object.entries(deletions))
      test(`${where}: ${deletion}`, async ({ page, irc }) => {
        await installNativeFeelInstrumentation(page);
        const peer = await irc.peer("checksumbyte");
        await page.goto(irc.url());
        let composer = await openConversation(page, irc.channel);
        if (where === "direct") {
          await peer.privmsgConfirmed(irc.account, "hi");
          composer = await openConversation(page, peer.nickname);
        }
        const popup = page.locator("[data-composer-suggestions]");
        const nick = page.getByRole("option", {
          name: new RegExp(peer.nickname, "u"),
        });
        const expectClosedOverEmptyComposer = async () => {
          await expect(composer).toHaveValue("");
          await expect(popup).toHaveCount(0);
        };

        await composer.press("Tab");
        await expect(composer).toHaveValue(`${peer.nickname}: `);
        await remove(composer);
        await expectClosedOverEmptyComposer();
        await composer.pressSequentially(peer.nickname.slice(0, 3));
        await expect(popup).toHaveCount(0);
        await remove(composer);
        await expectClosedOverEmptyComposer();

        await composer.pressSequentially(`@${peer.nickname.slice(0, 3)}`);
        await expect(nick).toBeVisible();
        await remove(composer);
        await expectClosedOverEmptyComposer();
        await nativeFeelAudit(page);
      });
});

async function openConversation(page: Page, title: string): Promise<Locator> {
  await page
    .getByRole("button", { name: new RegExp(`^${title}(?:,|$)`, "u") })
    .click();
  await expectSettled(page, { conversation: title });
  const composer = page.getByRole("textbox", { name: `Message ${title}` });
  await expect(composer).toBeVisible();
  return composer;
}
