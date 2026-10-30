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
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await openDrawer(page);
});

test("member drawer pans, springs back, and closes before the chat", async ({
  page,
}) => {
  const drawer = page.getByRole("dialog", { name: "Members" });

  await pointer(page, "pointerdown", 100, 300, 0);
  await pointer(page, "pointermove", 160, 304, 400);
  await expect
    .poll(() =>
      drawer.evaluate((element) =>
        Math.round(new DOMMatrix(getComputedStyle(element).transform).m41),
      ),
    )
    .toBe(60);
  await pointer(page, "pointerup", 160, 304, 500);
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  await expect(drawer).toBeVisible();

  await pointer(page, "pointerdown", 100, 300, 600, 2);
  await pointer(page, "pointermove", 105, 360, 800, 2);
  await pointer(page, "pointerup", 105, 360, 900, 2);
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  await expect(drawer).toBeVisible();

  await pointer(page, "pointerdown", 100, 300, 1_000, 3);
  await pointer(page, "pointermove", 140, 300, 1_040, 3);
  await pointer(page, "pointerup", 140, 300, 1_050, 3);
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();

  await openDrawer(page);
  await pointer(page, "pointerdown", 100, 300, 2_000, 4);
  await pointer(page, "pointermove", 230, 300, 2_400, 4);
  await pointer(page, "pointerup", 230, 300, 2_500, 4);
  await expect(drawer).toHaveCount(0);

  await openDrawer(page);
  await page.goBack();
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
});

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show members" }).click();
  await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
}

async function pointer(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  timeStamp: number,
  pointerId = 1,
): Promise<void> {
  await page.locator("[data-member-drawer]").evaluate(
    (element, init) => {
      const event = new PointerEvent(init.type, {
        bubbles: true,
        cancelable: true,
        clientX: init.clientX,
        clientY: init.clientY,
        pointerId: init.pointerId,
      });
      Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
      element.dispatchEvent(event);
    },
    { clientX, clientY, pointerId, timeStamp, type },
  );
}
