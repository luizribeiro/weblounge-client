import { expect, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";

test.describe("mobile platform history against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("WebKit browser tabs replace in-app entries", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "webkit-mobile-history",
      "requires the WebKit browser-tab profile",
    );
    await page.goto("/?irc-password=weblounge-test");
    const initialLength = await page.evaluate(() => history.length);
    const row = page.getByRole("button", { name: "#weblounge-test" });
    await row.click();
    await expect(page.locator("[data-mobile-shell]")).toHaveAttribute(
      "data-history-policy",
      "replace",
    );
    await expect(
      page.getByRole("heading", { name: "#weblounge-test" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show members" }).click();
    await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(initialLength);

    await page
      .getByRole("dialog", { name: "Members" })
      .getByRole("button", { name: "Close member list" })
      .click();
    await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(0);
    await swipeBack(page);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  });

  test("standalone WebKit keeps in-app navigation replace-only", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "webkit-mobile-history",
      "requires the WebKit standalone profile",
    );
    await emulateStandalone(page);
    await page.goto("/?irc-password=weblounge-test");
    const initialLength = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await expect(page.locator("[data-mobile-shell]")).toHaveAttribute(
      "data-history-policy",
      "replace",
    );
    await page.getByRole("button", { name: "Show members" }).click();
    expect(await page.evaluate(() => history.length)).toBe(initialLength);

    await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
    await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(0);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(initialLength);

    await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test("Android Back exhausts the app stack before leaving", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "android-mobile-history",
      "requires the Android profile",
    );
    await page.goto("http://127.0.0.1:4174/health");
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await expect(page.locator("[data-mobile-shell]")).toHaveAttribute(
      "data-history-policy",
      "stack",
    );
    await page.getByRole("button", { name: "Show members" }).click();

    await page.goBack();
    await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(0);
    await page.goBack();
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL("http://127.0.0.1:4174/health");
  });
});

async function swipeBack(page: import("@playwright/test").Page): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    pointerId: 1,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: 360,
    clientY: 300,
    pointerId: 1,
  });
  await shell.dispatchEvent("pointerup", {
    clientX: 360,
    clientY: 300,
    pointerId: 1,
  });
}
