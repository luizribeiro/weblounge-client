import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { choose } from "./settings-fixture";
import { expectSettled } from "./settled";

const themes = [
  { name: "Black", id: "black", background: "rgb(0, 0, 0)" },
  { name: "Modern", id: "modern", background: "rgb(255, 255, 255)" },
  { name: "Terminal", id: "terminal", background: "rgb(16, 17, 18)" },
  { name: "Retro", id: "retro", background: "rgb(246, 239, 225)" },
] as const;

test.describe("themes against local Ergo", () => {
  for (const theme of themes) {
    test(`${theme.name} applies live and paints its first frame after a reload`, async ({
      irc,
      page,
    }) => {
      await installNativeFeelInstrumentation(page);
      await recordFirstFrame(page);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(irc.url());
      await page.getByRole("button", { name: irc.channel }).click();
      await expectSettled(page, { conversation: irc.channel });

      await sidebarSettings(page).click();
      await choose(page, theme.name);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme.id,
      );
      await expect(page.locator("html")).toHaveCSS(
        "background-color",
        theme.background,
      );
      await nativeFeelAudit(page);

      await page.reload();

      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "__firstFrame")))
        .toEqual({ background: theme.background, theme: theme.id });
      await sidebarSettings(page).click();
      await expect(
        page.getByRole("radio", { name: theme.name, exact: true }),
      ).toBeChecked();
      await nativeFeelAudit(page);
    });
  }

  test("Retro sets titles in Fraunces and squares its overlays with a hard shadow", async ({
    irc,
    page,
  }) => {
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    await expectSettled(page, { conversation: irc.channel });
    await sidebarSettings(page).click();
    await choose(page, "Retro");

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("heading", { name: "Settings" })).toHaveCSS(
      "font-family",
      /^Fraunces,/u,
    );
    await expect(dialog).toHaveCSS("border-radius", "4px");
    await expect(dialog).toHaveCSS(
      "box-shadow",
      "rgb(46, 33, 25) 6px 6px 0px 0px",
    );
  });
});

async function recordFirstFrame(page: Page): Promise<void> {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      const root = document.documentElement;
      Object.assign(window, {
        __firstFrame: {
          background: getComputedStyle(root).backgroundColor,
          theme: root.dataset.theme,
        },
      });
    });
  });
}

function sidebarSettings(page: Page) {
  return page
    .getByRole("complementary", { name: "Channel list" })
    .getByRole("button", { name: "Settings" });
}
