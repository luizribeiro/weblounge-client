import { expect, test } from "./irc-fixture";

const expectedSha = process.env.WEBLOUNGE_EXPECTED_BUILD_SHA;

test("shows the production build in version and debug diagnostics", async ({
  page,
  irc,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1" || expectedSha === undefined,
    "requires the flake's production app and local Ergo fixture",
  );

  await page.goto(irc.url());
  await page.getByRole("button", { name: irc.channel }).click();
  const composer = page.getByRole("textbox", {
    name: `Message ${irc.channel}`,
  });
  const version = await page.evaluate(() => window.weblounge.version);
  expect(version).toMatch(
    new RegExp(
      `^weblounge ${escapeRegExp(expectedSha ?? "")} · built \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC$`,
      "u",
    ),
  );

  await composer.fill("/version");
  await composer.press("Enter");
  await expect(page.getByText(version, { exact: true })).toBeVisible();

  await composer.fill("/help");
  await composer.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "/version" }),
  ).toBeVisible();

  await composer.fill("/debug viewport");
  await composer.press("Enter");
  const overlay = page.locator("[data-debug-overlay]");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(`[viewport]\n${version}`);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
