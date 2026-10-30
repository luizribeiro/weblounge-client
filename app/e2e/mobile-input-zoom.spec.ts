import { expect, type Page, test } from "@playwright/test";
import { auditMobileTextFieldZoom } from "./native-feel-audit";

test.describe("mobile text field zoom", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 402, height: 874 },
  });
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("keeps chat search at the initial scale", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("searchbox", { name: "Search chats" }),
    ).toBeVisible();
    await auditMobileTextFieldZoom(page);
  });

  test("keeps the composer at the initial scale", async ({ page }) => {
    await openChannel(page);
    await expect(
      page.getByRole("textbox", { name: "Message #weblounge-test" }),
    ).toBeVisible();
    await auditMobileTextFieldZoom(page);
  });

  test("keeps drawer fields at the initial scale", async ({ page }) => {
    await openChannel(page);
    await page.getByRole("button", { name: "Show members" }).click();
    await expect(
      page.getByRole("searchbox", { name: "Filter members" }),
    ).toBeVisible();
    await auditMobileTextFieldZoom(page);
  });
});

async function openChannel(page: Page) {
  await page.goto("/?irc-password=weblounge-test");
  await page.getByRole("button", { name: "#weblounge-test" }).click();
}
