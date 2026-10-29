import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");

test.describe("composer suggestions against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test("suggests without moving or covering the conversation", async ({
      page,
    }) => {
      const ana = await connectAna("suggestions-desktop");
      try {
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto("/?irc-password=weblounge-test");
        const composer = page.getByRole("textbox", {
          name: "Message #weblounge-test",
        });
        await expect(composer).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Toggle member list" }),
        ).toContainText("2");
        const listBefore = await page
          .locator("[data-message-list]")
          .boundingBox();

        await composer.fill("/");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await expect(page.getByText("Join one or more channels")).toBeVisible();
        await assertGeometry(page, composer, 6, listBefore);
        await capture(page, "composer-suggestions-desktop-slash-light.png");
        await page.emulateMedia({ colorScheme: "dark" });
        await capture(page, "composer-suggestions-desktop-slash-dark.png");

        await composer.fill("/jo");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("/join ");
        await expect(page.getByText("/join <channels> [keys]")).toBeVisible();
        await composer.fill("@an");
        await expect(page.getByRole("option", { name: /ana/u })).toBeVisible();
        await capture(page, "composer-suggestions-desktop-mention-dark.png");
        await page.emulateMedia({ colorScheme: "light" });
        await capture(page, "composer-suggestions-desktop-mention-light.png");
        await composer.press("Enter");
        await expect(composer).toHaveValue("ana: ");

        await composer.fill("hello @an");
        await expect(page.getByRole("option", { name: /ana/u })).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("hello ana");
        await composer.fill("#we");
        await expect(
          page.getByRole("option", { name: /#weblounge-test/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("#weblounge-test");
      } finally {
        ana.close();
      }
    });
  });

  test.describe("mobile", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });
    test("suggests with touch-sized bounded rows", async ({ page }) => {
      const ana = await connectAna("suggestions-mobile");
      try {
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto("/?irc-password=weblounge-test");
        await page.getByRole("button", { name: "#weblounge-test" }).click();
        const composer = page.getByRole("textbox", {
          name: "Message #weblounge-test",
        });
        await expect(composer).toBeVisible();
        await expect
          .poll(
            async () =>
              (await page.locator("[data-message-list]").boundingBox())?.x,
          )
          .toBe(0);
        const listBefore = await page
          .locator("[data-message-list]")
          .boundingBox();

        await composer.fill("/");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await expect(page.getByText("Join one or more channels")).toBeVisible();
        await assertGeometry(page, composer, 4.5, listBefore);
        await capture(page, "composer-suggestions-mobile-slash-light.png");
        await page.emulateMedia({ colorScheme: "dark" });
        await capture(page, "composer-suggestions-mobile-slash-dark.png");

        await composer.fill("/jo");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("/join ");
        await expect(page.getByText("/join <channels> [keys]")).toBeVisible();
        await composer.fill("@an");
        await expect(page.getByRole("option", { name: /ana/u })).toBeVisible();
        await capture(page, "composer-suggestions-mobile-mention-dark.png");
        await page.emulateMedia({ colorScheme: "light" });
        await capture(page, "composer-suggestions-mobile-mention-light.png");
        await composer.press("Enter");
        await expect(composer).toHaveValue("ana: ");
        await composer.fill("hello @an");
        await expect(page.getByRole("option", { name: /ana/u })).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("hello ana");
        await composer.fill("#we");
        await expect(
          page.getByRole("option", { name: /#weblounge-test/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("#weblounge-test");
      } finally {
        ana.close();
      }
    });
  });
});

async function connectAna(id: string): Promise<IrcClient> {
  const ana = await IrcClient.connect(
    "ana",
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  await ana.privmsgConfirmed("#weblounge-test", `hello from ana ${id}`);
  return ana;
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, name) });
}

async function assertGeometry(
  page: Page,
  composer: Locator,
  visibleRows: number,
  listBefore: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  const popup = page.locator("[data-composer-suggestions]");
  const [popupBox, composerBox, rowBox, listAfter] = await Promise.all([
    popup.boundingBox(),
    composer.boundingBox(),
    popup.getByRole("option").first().boundingBox(),
    page.locator("[data-message-list]").boundingBox(),
  ]);
  expect(popupBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(popupBox?.y ?? 0).toBeGreaterThanOrEqual(0);
  expect(
    Math.abs((popupBox?.x ?? 0) - (composerBox?.x ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect((popupBox?.x ?? 0) + (popupBox?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  expect((popupBox?.y ?? 0) + (popupBox?.height ?? 0)).toBeLessThanOrEqual(
    (composerBox?.y ?? 0) + 1,
  );
  expect(popupBox?.height ?? 0).toBeLessThanOrEqual(
    (rowBox?.height ?? 0) * visibleRows + 3,
  );
  expect(listAfter).toEqual(listBefore);
}
