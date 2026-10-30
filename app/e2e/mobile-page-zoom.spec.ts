import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-app-root]")).toBeVisible();
});

test("prevents WebKit pinch and double-tap page zoom", async ({ page }) => {
  const gestures = await page.evaluate(() => {
    const start = new Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    const change = new Event("gesturechange", {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(start);
    document.dispatchEvent(change);
    return {
      changePrevented: change.defaultPrevented,
      rootTouchAction: getComputedStyle(
        document.querySelector("[data-app-root]") as HTMLElement,
      ).touchAction,
      startPrevented: start.defaultPrevented,
    };
  });
  expect(gestures).toEqual({
    changePrevented: true,
    rootTouchAction: "pan-x pan-y",
    startPrevented: true,
  });

  await page.touchscreen.tap(200, 120);
  await page.touchscreen.tap(200, 120);
  await expect
    .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
    .toBe(1);
});

test("keeps larger root text within the mobile shell", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search chats" });
  await expect(search).toBeVisible();
  const initialSize = await search.evaluate((field) =>
    Number.parseFloat(getComputedStyle(field).fontSize),
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });

  await expect
    .poll(() =>
      search.evaluate((field) =>
        Number.parseFloat(getComputedStyle(field).fontSize),
      ),
    )
    .toBeGreaterThan(initialSize);
  const geometry = await page
    .locator("[data-mobile-shell]")
    .evaluate((shell) => ({
      clientWidth: shell.clientWidth,
      scrollWidth: shell.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
  expect(geometry.clientWidth).toBe(geometry.viewportWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});
