import { devices, expect, test, webkit } from "@playwright/test";

test("mobile back gestures always end aligned", async ({ baseURL }) => {
  test.slow();
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices["iPhone 16 Pro"] });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/?irc-password=weblounge-test`);
    const openChat = async () => {
      await page.getByRole("button", { name: "#weblounge-test" }).click();
      await expect(
        page.getByRole("heading", { name: "#weblounge-test" }),
      ).toBeVisible();
      await expect(page.locator("[data-position]")).toHaveCount(0);
    };
    const shell = page.locator("[data-mobile-shell]");
    const drag = async (pointerId: number, endX: number, end: string) => {
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
    };

    await openChat();
    await drag(1, 90, "pointercancel");
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
    await expectAligned(page);

    await drag(2, 360, "pointerup");
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expectAligned(page);

    await openChat();
    await drag(3, 80, "pointerup");
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expectAligned(page);

    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await drag(4, 200, "pointerup");
    await expect(page.locator("[data-position]")).toHaveCount(0);
    await expectAligned(page);

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
  } finally {
    await context.close();
    await browser.close();
  }
});

async function expectAligned(
  page: import("@playwright/test").Page,
): Promise<void> {
  const active = page.locator(
    "[data-mobile-chats]:visible, [data-mobile-chat]:visible",
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
