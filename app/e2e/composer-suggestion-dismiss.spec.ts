import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

test.describe("composer suggestion popup follows the composer text", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("closes the /msg nick popup whenever the composer empties", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    const peer = await irc.peer("amy");
    await page.goto(irc.url());
    const channel = page.getByRole("button", { name: irc.channel });
    await channel.click();
    await expectSettled(page, { conversation: irc.channel });
    await peer.privmsgConfirmed(irc.account, `hi from ${peer.nickname}`);
    const direct = page.getByRole("button", {
      name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
    });
    await expect(direct).toBeVisible();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    const popup = page.locator("[data-composer-suggestions]");
    const nick = page.getByRole("option", {
      name: new RegExp(peer.nickname, "u"),
    });
    const showNickSuggestion = async () => {
      await composer.fill("/msg am");
      await expect(nick).toBeVisible();
      await expect(page.getByText("/msg <target> <text>")).toBeVisible();
    };
    const expectClosedOverEmptyComposer = async () => {
      await expect(composer).toHaveValue("");
      await expect(popup).toHaveCount(0);
    };

    await showNickSuggestion();
    await composer.press("Escape");
    await expect(popup).toHaveCount(0);
    await composer.fill("");

    await showNickSuggestion();
    await composer.press("ControlOrMeta+a");
    await composer.press("Delete");
    await expectClosedOverEmptyComposer();

    await showNickSuggestion();
    await composer.press("ControlOrMeta+a");
    await composer.press("ControlOrMeta+x");
    await expectClosedOverEmptyComposer();

    await showNickSuggestion();
    await direct.click();
    await expectSettled(page, { conversation: peer.nickname });
    await expect(popup).toHaveCount(0);
    await channel.click();
    await expectSettled(page, { conversation: irc.channel });
    await expect(composer).toHaveValue("/msg am");
    await composer.fill("");
    await expectClosedOverEmptyComposer();

    await showNickSuggestion();
    await nick.click();
    await expect(composer).toHaveValue(`/msg ${peer.nickname} `);
    await composer.pressSequentially("b29 hello");
    await composer.press("Enter");
    await peer.waitForPrivmsg(peer.nickname, "b29 hello", irc.account);
    await expectClosedOverEmptyComposer();
    await nativeFeelAudit(page);
  });
});
