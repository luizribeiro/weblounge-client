import { expect, test } from "@playwright/test";
import {
  expectDeviceForgotTheMember,
  expectSignedOut,
  signedOutScreen,
  signInAgain,
  signInMember,
} from "./account-fixture";
import { oauthIssuer } from "./fake-oauth-route";
import { nativeFeelAudit } from "./native-feel-audit";
import { settingsScreenshot } from "./settings-fixture";
import { expectSettled } from "./settled";

test.describe("desktop Account settings", () => {
  // WebKit sends a service worker's fetches past page.route, so a reload would load the
  // server's own config instead of the hosted fixture.
  test.use({ serviceWorkers: "block" });

  test("links to the members site and signs this device out", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const member = await signInMember(page);
    const composer = page.getByRole("textbox", { name: /#lounge/u });
    await composer.fill("half a thought about the meetup");

    await page
      .getByRole("complementary", { name: "Channel list" })
      .getByRole("button", { name: "Settings" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Account" }).click();
    const account = dialog.getByRole("region", { name: "Account" });
    const members = account.getByRole("link", {
      name: "members.weblounge.org",
    });
    await expect(members).toHaveAttribute("href", oauthIssuer);
    await expect(members).toHaveAttribute("target", "_blank");
    await expect(members).toHaveAccessibleDescription(
      "Manage your account and invite people.",
    );
    await expectSettled(page);
    await nativeFeelAudit(page);
    await settingsScreenshot(dialog, "account-desktop-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectSettled(page);
    await settingsScreenshot(dialog, "account-desktop-dark");

    await account.getByRole("button", { name: "Sign out" }).click();
    const confirmation = account.getByRole("alertdialog", {
      name: "Sign out",
    });
    await expect(confirmation).toContainText(
      "Sign out of weblounge on this device?",
    );
    await expect(
      confirmation.getByRole("button", { name: "Sign out" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await account.getByRole("button", { name: "Sign out" }).click();
    await expectSettled(page);
    await settingsScreenshot(dialog, "account-desktop-confirm-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectSettled(page);
    await settingsScreenshot(dialog, "account-desktop-confirm-light");
    const requestsBefore = member.sessionTokenRequests();
    await confirmation.getByRole("button", { name: "Sign out" }).click();

    await expectSignedOut(page, member, requestsBefore);
    await settingsScreenshot(
      signedOutScreen(page),
      "account-desktop-signed-out-light",
    );
    await expectDeviceForgotTheMember(page);
    await page.reload();
    await expectSignedOut(page, member, requestsBefore);
    await signInAgain(page);
    await expect(
      page.getByRole("heading", { name: "#lounge", exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveValue("");
  });
});
