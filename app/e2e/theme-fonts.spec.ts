import type { Page } from "@playwright/test";
import { expectInterFont } from "./inter-font";
import { expect, test } from "./irc-fixture";
import { choose } from "./settings-fixture";
import { expectSettled } from "./settled";

const themeFontPattern =
  /\/(?:geist|ibm-plex-mono|work-sans|fraunces|courier-prime)[^/]*\.woff2$/u;
const fontFile =
  /\/(geist-mono|geist|ibm-plex-mono|work-sans|fraunces|courier-prime)-/u;

const lazyThemes = [
  {
    name: "Modern",
    families: ["Geist", "Geist Mono"],
    files: ["geist", "geist-mono"],
  },
  {
    name: "Terminal",
    families: ["IBM Plex Mono"],
    files: ["ibm-plex-mono"],
  },
  {
    name: "Retro",
    families: ["Work Sans", "Fraunces", "Courier Prime"],
    files: ["work-sans", "fraunces", "courier-prime"],
  },
] as const;

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

  for (const theme of lazyThemes) {
    test(`${theme.name} downloads only its own fonts once it is chosen`, async ({
      irc,
      page,
    }) => {
      const requested = recordThemeFontRequests(page);
      await page.goto(irc.url());
      const peer = await irc.peer("fonts", [irc.channel]);
      await peer.privmsgConfirmed(irc.channel, "fonts arrive with the theme");
      await page.getByRole("button", { name: irc.channel }).click();
      await expectSettled(page, { conversation: irc.channel });
      expect(requested).toEqual([]);

      await page
        .getByRole("complementary", { name: "Channel list" })
        .getByRole("button", { name: "Settings" })
        .click();
      await choose(page, theme.name);

      await expect
        .poll(() =>
          page.evaluate(async (families) => {
            await document.fonts.ready;
            return families.every((family) =>
              document.fonts.check(`16px "${family}"`),
            );
          }, theme.families),
        )
        .toBe(true);
      expect(new Set(requested.map(fontFamilyFile))).toEqual(
        new Set(theme.files),
      );
    });
  }
});

function fontFamilyFile(path: string): string | undefined {
  return fontFile.exec(path)?.[1];
}

function recordThemeFontRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (themeFontPattern.test(new URL(request.url()).pathname))
      requested.push(new URL(request.url()).pathname);
  });
  return requested;
}
