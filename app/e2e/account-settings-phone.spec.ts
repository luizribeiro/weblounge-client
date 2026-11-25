import { expect, test } from "@playwright/test";
import {
  expectDeviceForgotTheMember,
  expectSignedOut,
  signedOutScreen,
  signInAgain,
  signInMember,
} from "./account-fixture";
import { nativeFeelAudit } from "./native-feel-audit";
import { settingsScreenshot } from "./settings-fixture";
import { expectSettled } from "./settled";

test.describe("phone Account settings", () => {
  // WebKit sends a service worker's fetches past page.route, so a reload would load the
  // server's own config instead of the hosted fixture.
  test.use({ serviceWorkers: "block" });

  test("signs this device out from the Account page", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const member = await signInMember(page);
    const chats = page.getByRole("region", { name: "Chats" });
    await chats.getByRole("button", { name: "Settings" }).tap();
    await expect(
      page.getByRole("button", { name: /^Account members\.weblounge\.org/u }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Account/u }).tap();
    const settings = page.locator("[data-mobile-settings='account']");
    await expect(
      settings.getByRole("heading", { name: "Account" }),
    ).toBeVisible();
    await expect(
      settings.getByRole("link", { name: "members.weblounge.org" }),
    ).toHaveAttribute("target", "_blank");
    await expectSettled(page);
    await nativeFeelAudit(page);
    await settingsScreenshot(settings, "account-phone-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectSettled(page);
    await settingsScreenshot(settings, "account-phone-dark");

    await settings.getByRole("button", { name: "Sign out" }).tap();
    const confirmation = settings.getByRole("alertdialog", {
      name: "Sign out",
    });
    await confirmation.getByRole("button", { name: "Cancel" }).tap();
    await expect(confirmation).toHaveCount(0);
    await settings.getByRole("button", { name: "Sign out" }).tap();
    await expectSettled(page);
    await settingsScreenshot(settings, "account-phone-confirm-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectSettled(page);
    await settingsScreenshot(settings, "account-phone-confirm-light");
    const requestsBefore = member.sessionTokenRequests();
    await confirmation.getByRole("button", { name: "Sign out" }).tap();

    await expectSignedOut(page, member, requestsBefore);
    await settingsScreenshot(
      signedOutScreen(page),
      "account-phone-signed-out-light",
    );
    await expectDeviceForgotTheMember(page);
    await page.reload();
    await expectSignedOut(page, member, requestsBefore);
    await signInAgain(page);
    await expect(chats).toBeVisible();
  });
});
