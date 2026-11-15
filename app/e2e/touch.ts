import type { Locator, Page } from "@playwright/test";

interface Point {
  readonly x: number;
  readonly y: number;
}

export async function tap(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centre(target);
  await page.touchscreen.tap(x, y);
}

async function centre(target: Locator): Promise<Point> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("touch target is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
