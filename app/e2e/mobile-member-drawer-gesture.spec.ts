import { expect, test } from "@playwright/test";
import {
  drawerPointer,
  openDrawer,
  openStandaloneChannel,
  shellPointer,
} from "./member-drawer";

test.beforeEach(async ({ browserName, page }) => {
  await openStandaloneChannel(page, browserName);
});

test("member drawer pans, springs back, and closes before the chat", async ({
  page,
}) => {
  await openDrawer(page);
  const drawer = page.getByRole("dialog", { name: "Members" });

  await drawerPointer(page, "pointerdown", 100, 300, 0);
  await drawerPointer(page, "pointermove", 115, 304, 100);
  await drawerPointer(page, "pointermove", 160, 304, 400);
  await expect
    .poll(() =>
      drawer.evaluate((element) =>
        Math.round(new DOMMatrix(getComputedStyle(element).transform).m41),
      ),
    )
    .toBe(45);
  await drawerPointer(page, "pointerup", 160, 304, 500);
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  await expect(drawer).toBeVisible();

  await drawerPointer(page, "pointerdown", 100, 300, 600, 2);
  await drawerPointer(page, "pointermove", 105, 360, 800, 2);
  await drawerPointer(page, "pointerup", 105, 360, 900, 2);
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  await expect(drawer).toBeVisible();

  await drawerPointer(page, "pointerdown", 100, 300, 1_000, 3);
  await drawerPointer(page, "pointermove", 115, 300, 1_010, 3);
  await drawerPointer(page, "pointermove", 155, 300, 1_040, 3);
  await drawerPointer(page, "pointerup", 155, 300, 1_050, 3);
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();

  await openDrawer(page);
  await drawerPointer(page, "pointerdown", 100, 300, 2_000, 4);
  await drawerPointer(page, "pointermove", 115, 300, 2_100, 4);
  await drawerPointer(page, "pointermove", 245, 300, 2_400, 4);
  await drawerPointer(page, "pointerup", 245, 300, 2_500, 4);
  await expect(drawer).toHaveCount(0);

  await openDrawer(page);
  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await expect(drawer).toHaveCount(0);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
});

test("opens the channel drawer from a protected mid-screen pan", async ({
  page,
}) => {
  const drawer = page.getByRole("dialog", { name: "Members" });
  const historyLength = await page.evaluate(() => history.length);

  await shellPointer(page, "pointerdown", 390, 300, 0, 10);
  await shellPointer(page, "pointermove", 250, 300, 100, 10);
  await shellPointer(page, "pointerup", 250, 300, 200, 10);
  await expect(drawer).toHaveCount(0);

  await page
    .getByRole("heading", { name: "#weblounge-test" })
    .evaluate((heading) => {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(heading);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await shellPointer(page, "pointerdown", 250, 300, 300, 11);
  await shellPointer(page, "pointermove", 100, 300, 400, 11);
  await shellPointer(page, "pointerup", 100, 300, 500, 11);
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() => getSelection()?.removeAllRanges());

  await shellPointer(page, "pointerdown", 250, 300, 600, 12);
  await shellPointer(page, "pointermove", 235, 300, 700, 12);
  await shellPointer(page, "pointermove", 195, 300, 1_000, 12);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByPlaceholder("Filter members")).not.toBeFocused();
  await shellPointer(page, "pointerup", 210, 300, 1_100, 12);
  await expect(drawer).toHaveCount(0);

  await shellPointer(page, "pointerdown", 250, 300, 1_200, 13);
  await shellPointer(page, "pointermove", 235, 300, 1_220, 13);
  await shellPointer(page, "pointermove", 195, 300, 1_240, 13);
  await shellPointer(page, "pointerup", 195, 300, 1_250, 13);
  await expect(drawer).toBeVisible();
  await expect(page.locator("[data-overlay-drawer]")).not.toHaveAttribute(
    "data-drag-returning",
    "true",
  );
  await expect
    .poll(() =>
      drawer.evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
      ),
    )
    .toBe(0);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await expect(drawer).toHaveCount(0);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
});
