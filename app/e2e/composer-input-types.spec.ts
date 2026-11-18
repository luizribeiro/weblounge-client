import type { Locator } from "@playwright/test";
import { expect, test } from "./irc-fixture";

interface Edit {
  readonly inputType: string;
  readonly replace: readonly [start: number, end: number];
  readonly text: string;
}

const applyEdit = (composer: Locator, edit: Edit) =>
  composer.evaluate((element, { inputType, replace, text }) => {
    const field = element as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(replace[0], replace[1]);
    const accepted = field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType,
        data: text,
      }),
    );
    if (!accepted) return;
    field.setRangeText(text, replace[0], replace[1], "end");
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, data: text }),
    );
  }, edit);

test.describe("composer suggestions follow the text whatever the input type", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("stay closed after a /msg send when the text is replaced, composed, pasted, undone or set programmatically", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("amy");
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    const popup = page.locator("[data-composer-suggestions]");
    const nick = page.getByRole("option", {
      name: new RegExp(peer.nickname, "u"),
    });

    await composer.fill("/msg am");
    await expect(nick).toBeVisible();
    await nick.click();
    await composer.pressSequentially("hello");
    await composer.press("Enter");
    await peer.waitForPrivmsg(peer.nickname, "hello", irc.account);
    await expect(composer).toHaveValue("");

    const expectNoPopup = async (value: string) => {
      await expect(composer).toHaveValue(value);
      await expect(popup).toHaveCount(0);
    };
    const reset = async () => {
      await composer.fill("");
      await expectNoPopup("");
    };

    await composer.pressSequentially("im");
    await expectNoPopup("im");
    await applyEdit(composer, {
      inputType: "insertReplacementText",
      replace: [0, 2],
      text: "I'm",
    });
    await expectNoPopup("I'm");
    await composer.pressSequentially(" here");
    await expectNoPopup("I'm here");

    await reset();
    await composer.pressSequentially("im");
    await applyEdit(composer, {
      inputType: "insertReplacementText",
      replace: [0, 2],
      text: "Im",
    });
    await expectNoPopup("Im");

    await reset();
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart"));
    });
    await applyEdit(composer, {
      inputType: "insertCompositionText",
      replace: [0, 0],
      text: "im",
    });
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionend"));
    });
    await expectNoPopup("im");

    await reset();
    await applyEdit(composer, {
      inputType: "insertFromPaste",
      replace: [0, 0],
      text: "im",
    });
    await expectNoPopup("im");

    await applyEdit(composer, {
      inputType: "historyUndo",
      replace: [0, 2],
      text: "",
    });
    await expectNoPopup("");
    await applyEdit(composer, {
      inputType: "historyRedo",
      replace: [0, 0],
      text: "im",
    });
    await expectNoPopup("im");

    await reset();
    await applyEdit(composer, {
      inputType: "",
      replace: [0, 0],
      text: "Im",
    });
    await expectNoPopup("Im");
  });
});
