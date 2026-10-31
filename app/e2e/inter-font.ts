import { expect, type Locator, type Page } from "@playwright/test";

type ScreenshotOptions = Parameters<Page["screenshot"]>[0];

export async function expectInterFont(target: Locator): Promise<void> {
  const page = target.page();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() => page.evaluate(() => document.fonts.check("14px Inter")))
    .toBe(true);

  const families = await target.evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => getComputedStyle(element).fontFamily),
  );
  expect(families.length).toBeGreaterThan(0);
  for (const family of families)
    expect(primaryFamily(family), family).toBe("Inter");
}

export async function screenshotWithInter(
  fontTarget: Locator,
  options: ScreenshotOptions,
): Promise<Buffer> {
  await expectInterFont(fontTarget);
  return fontTarget.page().screenshot(options);
}

function primaryFamily(family: string): string {
  return (family.split(",")[0] ?? "").trim().replaceAll(/["']/gu, "");
}
