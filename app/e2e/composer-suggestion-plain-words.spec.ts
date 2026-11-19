import type { Locator } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const msgUsage = "/msg <target> <text>";

async function autocorrect(composer: Locator, from: string, to: string) {
  await composer.evaluate(
    (field: HTMLTextAreaElement, [word, replacement]) => {
      const start = field.value.lastIndexOf(word);
      field.value = `${field.value.slice(0, start)}${replacement}${field.value.slice(start + word.length)}`;
      const caret = start + replacement.length;
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: replacement,
          inputType: "insertReplacementText",
        }),
      );
    },
    [from, to] as const,
  );
}

test.describe("plain words do not open composer suggestions", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a first word ending in a command alias is not a command", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    const peer = await irc.peer("checksumbyte");
    await page.goto(irc.url());
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
    });
    await expect(composer).toBeVisible();
    await expectSettled(page, { conversation: irc.channel });
    const nick = page.getByRole("option", {
      name: new RegExp(peer.nickname, "u"),
    });
    const mention = `@${peer.nickname.slice(0, 3)}`;

    for (const typed of ["im ", "Im ", "ij "]) {
      await composer.pressSequentially(`${typed}${mention}`);
      await expect(nick).toBeVisible();
      await expect(page.getByText(/^\/(msg|join) </u)).toHaveCount(0);
      await composer.fill("");
    }

    await composer.pressSequentially("im");
    await autocorrect(composer, "im", "I'm ");
    await expect(composer).toHaveValue("I'm ");
    await composer.pressSequentially(mention);
    await expect(nick).toBeVisible();
    await expect(page.getByText(msgUsage)).toHaveCount(0);

    await composer.fill("");
    await composer.pressSequentially(`/m ${peer.nickname.slice(0, 3)}`);
    await expect(nick).toBeVisible();
    await expect(page.getByText(msgUsage)).toBeVisible();
    await nativeFeelAudit(page);
  });
});
