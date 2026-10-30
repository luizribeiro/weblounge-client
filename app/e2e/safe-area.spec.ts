import { mkdir } from "node:fs/promises";
import path from "node:path";
import { devices, expect, type Page, test } from "@playwright/test";
import { auditSafeArea } from "./native-feel-audit";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");
const { defaultBrowserType: _iphoneBrowser, ...iphone } =
  devices["iPhone 16 Pro"];
const { defaultBrowserType: _androidBrowser, ...android } = devices["Pixel 7"];

interface SafeAreaProfile {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

test.describe("safe-area profiles against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.describe("iPhone portrait", () => {
    test.use(iphone);

    test("clears the island and home indicator", async ({ page }) => {
      await verifyProfile(
        page,
        { top: 62, right: 0, bottom: 34, left: 0 },
        "iphone-portrait",
      );
      await page.getByRole("button", { name: "Show members" }).click();
      await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
      await auditSafeArea(page);
    });
  });

  test.describe("iPhone landscape", () => {
    test.use({
      ...iphone,
      viewport: { width: 874, height: 402 },
    });

    test("clears both landscape edges", async ({ page }) => {
      await verifyProfile(
        page,
        { top: 0, right: 62, bottom: 21, left: 62 },
        "iphone-landscape",
      );
    });
  });

  test.describe("Android gesture navigation", () => {
    test.use(android);

    test("clears the gesture navigation area", async ({ page }) => {
      await verifyProfile(
        page,
        { top: 0, right: 0, bottom: 24, left: 0 },
        "android-gesture",
      );
    });
  });
});

async function verifyProfile(
  page: Page,
  profile: SafeAreaProfile,
  screenshotName: string,
): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?irc-password=weblounge-test");
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #weblounge-test" }),
  ).toBeVisible();
  await expect(page.locator("[data-position]")).toHaveCount(0);
  await page.locator("#root").evaluate((root, inset) => {
    root.style.setProperty("--wl-safe-top", `${inset.top}px`);
    root.style.setProperty("--wl-safe-right", `${inset.right}px`);
    root.style.setProperty("--wl-safe-bottom", `${inset.bottom}px`);
    root.style.setProperty("--wl-safe-left", `${inset.left}px`);
  }, profile);
  await auditSafeArea(page);

  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(
      screenshotDirectory,
      `safe-area-${screenshotName}-light.png`,
    ),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "lounge-night",
  );
  await page.screenshot({
    path: path.join(
      screenshotDirectory,
      `safe-area-${screenshotName}-dark.png`,
    ),
  });
}
