import { expect, type Page, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";

test.beforeEach(async ({ browserName, page }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(browserName !== "webkit", "requires WebKit touch events");
  await emulateStandalone(page);
  await page.goto("/?irc-password=weblounge-test");
});

test("mobile back gestures cancel and complete aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 1, 90, "pointercancel");
  await expect(page.locator("[data-swipe]")).toHaveCount(0);
  await expectAligned(page);

  await drag(page, 2, 360, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture velocity completes aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 3, 80, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture midpoint completes aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 4, 200, "pointerup");
  await expect(page.locator("[data-position]")).toHaveCount(0);
  await expectAligned(page);
});

test("mobile history interrupts a gesture aligned", async ({ page }) => {
  await openChat(page);
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    pointerId: 5,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: 120,
    clientY: 300,
    pointerId: 5,
  });
  await page.evaluate(() => history.back());
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await shell.dispatchEvent("pointerup", {
    clientX: 120,
    clientY: 300,
    pointerId: 5,
  });
  await expect(page.locator("[data-swipe]")).toHaveCount(0);
  await expectAligned(page);
});

async function openChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
  await expect(page.locator("[data-position]")).toHaveCount(0);
}

async function drag(
  page: Page,
  pointerId: number,
  endX: number,
  end: string,
): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    pointerId,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: endX,
    clientY: 300,
    pointerId,
  });
  await shell.dispatchEvent(end, {
    clientX: endX,
    clientY: 300,
    pointerId,
  });
}

async function expectAligned(page: Page): Promise<void> {
  const active = page.locator(
    '[data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chats], [data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chat]',
  );
  await expect(active).toHaveCount(1);
  await expect
    .poll(() =>
      active.evaluate((element) => {
        const screen = element.parentElement;
        if (screen === null) throw new Error("mobile screen is missing");
        const box = screen.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          transform: getComputedStyle(screen).transform,
          viewport: window.innerWidth,
        };
      }),
    )
    .toEqual({ left: 0, right: 402, transform: "none", viewport: 402 });
}
