import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { choose, choosePhoneAppearance } from "./settings-fixture";
import { expectSettled } from "./settled";

type Face = "chair" | "blob" | "turning" | "both" | "neither";

function shownFace(mark: Locator): Promise<Face> {
  return mark.evaluate((button): Face => {
    const turning = button
      .getAnimations({ subtree: true })
      .some((animation) => animation instanceof CSSTransition);
    if (turning) return "turning";
    const [chair, blob] = [...button.children].map((face) => {
      const style = getComputedStyle(face);
      const facingViewer = new DOMMatrixReadOnly(style.transform).m11 > 0;
      return facingViewer && style.visibility === "visible";
    });
    if (chair && blob) return "both";
    if (chair) return "chair";
    return blob ? "blob" : "neither";
  });
}

async function expectFace(mark: Locator, face: Face): Promise<void> {
  await expect.poll(() => shownFace(mark)).toBe(face);
  await expect(mark).toHaveAttribute("aria-pressed", String(face === "blob"));
}

async function expectStaticChair(page: Page, logo: Locator): Promise<void> {
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("aria-hidden", "true");
  await expect(logo).toHaveCSS("cursor", "default");
  expect(await logo.evaluate((element) => element.closest("button"))).toBe(
    null,
  );
  await expect(page.getByRole("button", { name: "Flip the logo" })).toHaveCount(
    0,
  );
}

test.describe("chair mark on desktop against local Ergo", () => {
  test("flips to the blob and back in the n.e. theme only", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    await expectSettled(page, { conversation: irc.channel });
    const sidebar = page.getByRole("complementary", { name: "Channel list" });
    const logo = sidebar.locator("[data-connection-logo]");
    await expectStaticChair(page, logo);

    await sidebar.getByRole("button", { name: "Settings" }).click();
    await choose(page, "n.e.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    const mark = sidebar.getByRole("button", { name: "Flip the logo" });
    await expectFace(mark, "chair");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.focus();
    await mark.click();
    await expectFace(mark, "blob");
    await expect(composer).toBeFocused();
    await mark.click();
    await expectFace(mark, "chair");

    await mark.focus();
    await page.keyboard.press("Space");
    await expectFace(mark, "blob");
    await page.keyboard.press("Enter");
    await expectFace(mark, "chair");
    await nativeFeelAudit(page);

    await mark.click();
    await expectFace(mark, "blob");
    await sidebar.getByRole("button", { name: "Settings" }).click();
    await choose(page, "Black");
    await page.keyboard.press("Escape");
    await expectStaticChair(page, logo);
  });

  test("swaps faces without turning when motion is reduced", async ({
    irc,
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    await expectSettled(page, { conversation: irc.channel });
    const sidebar = page.getByRole("complementary", { name: "Channel list" });
    await sidebar.getByRole("button", { name: "Settings" }).click();
    await choose(page, "n.e.");
    await page.keyboard.press("Escape");

    const mark = sidebar.getByRole("button", { name: "Flip the logo" });
    await mark.click();
    await expectFace(mark, "blob");
    for (const face of await mark.locator("> *").all()) {
      await expect(face).toHaveCSS("transition-duration", "0s, 0s");
      await expect(face).toHaveCSS("transition-delay", "0s, 0s");
    }
  });
});

test.describe("chair mark on the phone against local Ergo", () => {
  test.use({
    colorScheme: "light",
    hasTouch: true,
    isMobile: true,
    viewport: { width: 402, height: 874 },
  });

  test("flips to the blob and back in the n.e. theme only", async ({
    irc,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    const chats = page.getByRole("region", { name: "Chats" });
    await expect(
      chats.getByRole("button", { name: irc.channel }),
    ).toBeVisible();
    const logo = chats.locator("[data-mobile-logo-mark]");
    await expectStaticChair(page, logo);

    await choosePhoneAppearance(page, ["n.e."]);
    const mark = chats.getByRole("button", { name: "Flip the logo" });
    await expectFace(mark, "chair");
    await mark.tap();
    await expectFace(mark, "blob");
    await expect(chats).toBeVisible();
    await mark.tap();
    await expectFace(mark, "chair");
    await nativeFeelAudit(page);
  });
});
