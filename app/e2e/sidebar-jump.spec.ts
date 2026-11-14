import type { Locator, Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import {
  conversationRowIds,
  emulateMacApp,
  emulatePlatform,
  openWithExtraChannel,
  row,
} from "./sidebar-rows";

const webChords = [
  { platform: "Linux x86_64", chord: "Control+Alt" },
  { platform: "Win32", chord: "Alt" },
  { platform: "MacIntel", chord: "Alt" },
] as const;

test.describe("sidebar conversation jumps against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  for (const { platform, chord } of webChords) {
    test(`jumps to the Nth row with ${chord}+digit on ${platform}`, async ({
      page,
      irc,
    }) => {
      await emulatePlatform(page, platform);
      await openWithExtraChannel(page, irc);
      const ids = await conversationRowIds(page);
      const composer = page.locator("[data-composer] textarea");

      await composer.click();
      await page.keyboard.press(`${chord}+2`);
      await expect(row(page, ids[1])).toHaveAttribute("aria-current", "page");
      await expect(composer).toHaveValue("");

      await page.keyboard.press(`${chord}+1`);
      await expect(row(page, ids[0])).toHaveAttribute("aria-current", "page");
    });
  }

  test("numbers the first nine rows while the jump modifier is held", async ({
    page,
    irc,
  }) => {
    await emulatePlatform(page, "Linux x86_64");
    await installNativeFeelInstrumentation(page);
    await openWithExtraChannel(page, irc, 2);
    await seedDirectRows(page, irc, 8);
    const ids = await conversationRowIds(page);
    expect(ids.length).toBeGreaterThan(9);
    const numbered = ids.slice(0, 9);
    const first = sidebarRow(page, ids[0]);
    const restingEdge = await rightEdge(first.locator("[data-sidebar-name]"));

    await holdJumpModifier(page);
    for (const [index, id] of numbered.entries()) {
      const hint = sidebarRow(page, id).locator("[data-jump-hint]");
      await expect(hint).toBeVisible();
      await expect(hint).toHaveAttribute("data-jump-hint", String(index + 1));
      expect(
        await hint.evaluate(
          (element) => getComputedStyle(element, "::after").content,
        ),
      ).toBe(`"${index + 1}"`);
      await expect(hint).toHaveCSS("opacity", "1");
      await expect(
        sidebarRow(page, id).locator("[data-badge-kind]"),
      ).toBeHidden();
    }
    expect(await rightEdge(first.locator("[data-sidebar-name]"))).toBe(
      restingEdge,
    );
    await nativeFeelAudit(page);

    await page.keyboard.press("2");
    await expect(row(page, ids[1])).toHaveAttribute("aria-current", "page");
    await expect(first.locator("[data-jump-hint]")).toBeVisible();
    await page.keyboard.press("3");
    await expect(row(page, ids[2])).toHaveAttribute("aria-current", "page");
    await expect(first.locator("[data-jump-hint]")).toBeVisible();

    await releaseJumpModifier(page);
    await expect(first.locator("[data-jump-hint]")).toBeHidden();

    await holdJumpModifier(page);
    await expect(first.locator("[data-jump-hint]")).toBeVisible();
    await page.keyboard.press("c");
    await expect(first.locator("[data-jump-hint]")).toBeHidden();
    await releaseJumpModifier(page);

    await holdJumpModifier(page);
    await expect(first.locator("[data-jump-hint]")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(first.locator("[data-jump-hint]")).toBeHidden();
    await releaseJumpModifier(page);
  });

  test("the Mac app jumps and hints with Command", async ({ page, irc }) => {
    await emulateMacApp(page);
    await openWithExtraChannel(page, irc);
    const ids = await conversationRowIds(page);

    await page.keyboard.press("Meta+2");
    await expect(row(page, ids[1])).toHaveAttribute("aria-current", "page");
    await page.keyboard.down("Meta");
    await expect(
      sidebarRow(page, ids[0]).locator("[data-jump-hint]"),
    ).toBeVisible();
    await page.keyboard.up("Meta");
    await expect(
      sidebarRow(page, ids[0]).locator("[data-jump-hint]"),
    ).toBeHidden();
  });

  test("the Mac browser keeps Command+digit for the browser", async ({
    page,
    irc,
  }) => {
    await emulatePlatform(page, "MacIntel");
    await openWithExtraChannel(page, irc);
    await page.evaluate(() => {
      const state = window as Window & { __lastDigitPrevented?: boolean };
      window.addEventListener("keydown", (event) => {
        if (event.code === "Digit2")
          state.__lastDigitPrevented = event.defaultPrevented;
      });
    });

    await page.keyboard.press("Meta+2");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __lastDigitPrevented?: boolean })
              .__lastDigitPrevented,
        ),
      )
      .toBe(false);
  });
});

async function seedDirectRows(
  page: Page,
  irc: IrcTestAccount,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const peer = await irc.peer(`jump-dm${index}`, []);
    await peer.privmsgConfirmed(irc.account, `jump row ${index}`);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
      }),
    ).toBeVisible();
  }
}

function sidebarRow(page: Page, bufferId: string | undefined): Locator {
  return page
    .locator('[data-sidebar-row="true"]')
    .filter({ has: page.locator(`[data-buffer-id="${bufferId}"]`) });
}

async function holdJumpModifier(page: Page): Promise<void> {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
}

async function releaseJumpModifier(page: Page): Promise<void> {
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
}

async function rightEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box.x + box.width;
}
