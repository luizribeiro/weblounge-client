import { expect, type Locator, type Page } from "@playwright/test";

const minimumAwayDistance = 100;
const fullWheelDelta = 100_000;

interface ScrollAwayOptions {
  readonly distance?: number;
  readonly input?: "touch" | "wheel";
  readonly wheelDelta?: number;
}

export function distanceFromBottom(list: Locator): Promise<number> {
  return list.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

export async function scrollAwayFromLiveEdge(
  page: Page,
  list: Locator,
  options: ScrollAwayOptions = {},
): Promise<number> {
  const distance = options.distance ?? minimumAwayDistance;
  if (options.input === "touch") {
    await touchPanAway(list, distance);
    await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(distance);
  } else {
    await list.hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -(options.wheelDelta ?? fullWheelDelta));
        return distanceFromBottom(list);
      })
      .toBeGreaterThan(distance);
  }
  return list.evaluate((element) => element.scrollTop);
}

async function touchPanAway(list: Locator, distance: number): Promise<void> {
  // Playwright exposes only touch tap, so WebKit pans use its legacy-event fallback.
  const bounds = await list.boundingBox();
  if (bounds === null) throw new Error("message list has no touch target");
  const clientX = bounds.x + bounds.width / 2;
  const touchAt = (clientY: number) => ({
    clientX,
    clientY,
    force: 1,
    identifier: 47,
    pageX: clientX,
    pageY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    screenX: clientX,
    screenY: clientY,
  });
  const start = touchAt(bounds.y + bounds.height * 0.3);
  const moved = touchAt(bounds.y + bounds.height * 0.8);
  await list.dispatchEvent("pointerdown", {
    button: 0,
    clientX: start.clientX,
    clientY: start.clientY,
    isPrimary: true,
    pointerId: start.identifier,
    pointerType: "touch",
  });
  await list.dispatchEvent("touchstart", {
    changedTouches: [start],
    targetTouches: [start],
    touches: [start],
  });
  await list.dispatchEvent("pointercancel", {
    button: 0,
    clientX: start.clientX,
    clientY: start.clientY,
    isPrimary: true,
    pointerId: start.identifier,
    pointerType: "touch",
  });
  await list.dispatchEvent("touchmove", {
    changedTouches: [moved],
    targetTouches: [moved],
    touches: [moved],
  });
  await list.evaluate((element, amount) => {
    element.scrollTop = Math.max(0, element.scrollTop - amount);
  }, distance * 2);
  await list.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await list.dispatchEvent("touchend", {
    changedTouches: [moved],
    targetTouches: [],
    touches: [],
  });
  await list.evaluate((element, amount) => {
    element.scrollTop = Math.max(0, element.scrollTop - amount);
  }, distance);
}
