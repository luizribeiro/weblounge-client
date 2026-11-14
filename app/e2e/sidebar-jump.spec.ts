import { expect, type Page, test } from "@playwright/test";

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
    }) => {
      await emulatePlatform(page, platform);
      await openWithExtraChannel(page);
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
});

async function emulatePlatform(page: Page, platform: string): Promise<void> {
  await page.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      get: () => value,
    });
  }, platform);
}

async function openWithExtraChannel(page: Page): Promise<void> {
  await page.goto("/?irc-password=weblounge-test");
  const home = page.getByRole("button", { name: /^#weblounge-test/u });
  await home.click();
  const composer = page.getByRole("textbox", {
    name: "Message #weblounge-test",
  });
  const channel = `#jump-${Date.now().toString(36)}`;
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
  await home.click();
}

async function conversationRowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-sidebar-row="true"] [data-buffer-id]')
    .evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.bufferId ?? ""),
    );
}

function row(page: Page, bufferId: string | undefined) {
  return page.locator(`[data-sidebar-row] [data-buffer-id="${bufferId}"]`);
}
