import type { Page } from "@playwright/test";
import { expectInterFont } from "./inter-font";
import { expect, test } from "./irc-fixture";
import { expectSettled } from "./settled";

const themeFontPattern =
  /\/(?:geist|ibm-plex-mono|work-sans|fraunces|courier-prime)[^/]*\.woff2$/u;

test.describe("theme fonts against local Ergo", () => {
  test("Lounge paints with Inter and requests no other theme's fonts", async ({
    irc,
    page,
  }) => {
    const requested = recordThemeFontRequests(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    await expectSettled(page, { conversation: irc.channel });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "lounge");

    await expectInterFont(page.getByRole("main"));
    expect(requested).toEqual([]);
  });
});

function recordThemeFontRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (themeFontPattern.test(new URL(request.url()).pathname))
      requested.push(new URL(request.url()).pathname);
  });
  return requested;
}
