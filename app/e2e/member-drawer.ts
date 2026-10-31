import { expect, type Page, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";

type PointerType = "pointerdown" | "pointermove" | "pointerup";

export async function openStandaloneChannel(
  page: Page,
  browserName: string,
): Promise<void> {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(browserName !== "webkit", "requires WebKit touch events");
  await emulateStandalone(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?irc-password=weblounge-test");
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(page.locator("[data-motion]")).toHaveCount(0);
}

export async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show members" }).click();
  await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
  await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
    "data-phase",
    "open",
  );
}

export async function drawerPointer(
  page: Page,
  type: PointerType,
  clientX: number,
  clientY: number,
  timeStamp: number,
  pointerId = 1,
): Promise<void> {
  await dispatchPointer(page, "[data-member-drawer]", {
    clientX,
    clientY,
    pointerId,
    timeStamp,
    type,
  });
}

export async function shellPointer(
  page: Page,
  type: PointerType,
  clientX: number,
  clientY: number,
  timeStamp: number,
  pointerId: number,
): Promise<void> {
  await dispatchPointer(page, "[data-mobile-shell]", {
    clientX,
    clientY,
    pointerId,
    timeStamp,
    type,
  });
}

interface PointerInit {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly timeStamp: number;
  readonly type: PointerType;
}

async function dispatchPointer(
  page: Page,
  selector: string,
  init: PointerInit,
): Promise<void> {
  await page.locator(selector).evaluate((element, pointer) => {
    const event = new PointerEvent(pointer.type, {
      bubbles: true,
      cancelable: true,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      isPrimary: true,
      pointerId: pointer.pointerId,
      pointerType: "touch",
    });
    Object.defineProperty(event, "timeStamp", { value: pointer.timeStamp });
    element.dispatchEvent(event);
  }, init);
}
