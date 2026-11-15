import type { Locator, Page, TestInfo } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const shells = [
  {
    name: "desktop",
    use: { viewport: { width: 1_280, height: 800 } },
  },
  {
    name: "phone",
    use: {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    },
  },
] as const;

for (const shell of shells) {
  test.describe(`typed mentions on ${shell.name} against local Ergo`, () => {
    test.use(shell.use);

    test("a terminator after an exact @nick accepts the mention", async ({
      page,
      irc,
    }, testInfo) => {
      const alice = await irc.peer("alice");
      await installNativeFeelInstrumentation(page);
      const composer = await openHomeChannel(page, irc, shell.name);

      await composer.pressSequentially(`@${alice.nickname}`);
      await expect(
        page.getByRole("option", { name: new RegExp(alice.nickname, "u") }),
      ).toBeVisible();
      await composer.press(" ");
      await expect(composer).toHaveValue(`${alice.nickname}: `);
      await expectSettled(page, { conversation: irc.channel });
      await capture(composer, testInfo, `mention-${shell.name}.png`);
      await composer.pressSequentially("hello");
      await expect(composer).toHaveValue(`${alice.nickname}: hello`);

      await composer.fill("");
      await composer.pressSequentially(
        `thanks @${alice.nickname.toUpperCase()},`,
      );
      await expect(composer).toHaveValue(`thanks ${alice.nickname},`);

      await composer.fill("");
      await composer.pressSequentially(`@${alice.nickname}x @ali`);
      await expect(
        page.getByRole("option", { name: new RegExp(alice.nickname, "u") }),
      ).toBeVisible();
      await expect(composer).toHaveValue(`@${alice.nickname}x @ali`);
      await nativeFeelAudit(page);
    });
  });
}

async function openHomeChannel(
  page: Page,
  irc: IrcTestAccount,
  shell: (typeof shells)[number]["name"],
): Promise<Locator> {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(irc.url());
  if (shell === "phone")
    await page.getByRole("button", { name: irc.channel }).click();
  const composer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  await expect(composer).toBeVisible();
  await expectSettled(page, { conversation: irc.channel });
  return composer;
}

async function capture(
  composer: Locator,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await screenshotWithInter(composer, {
      path: testInfo.outputPath(name),
    }),
    contentType: "image/png",
  });
}
