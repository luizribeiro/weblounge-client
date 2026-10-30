import { expect, test } from "@playwright/test";

test.describe("buffer routing against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("updates the address and restores the selected channel", async ({
    page,
  }) => {
    const channel = `#route-${Date.now().toString(36)}`;
    await page.goto("/?irc-password=weblounge-test");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    await expect(composer).toBeVisible();
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");

    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );

    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set("irc-password", "weblounge-test");
      history.replaceState(history.state, "", url);
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/Local%20Ergo/${channel.slice(1)}$`, "u"),
    );
  });
});
