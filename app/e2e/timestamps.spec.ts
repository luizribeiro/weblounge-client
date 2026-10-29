import { chromium, expect, firefox, test, webkit } from "@playwright/test";

const browsers = [chromium, firefox, webkit] as const;
const locales = [
  { hourMarker: /AM|PM/, locale: "en-US" },
  { hourMarker: /^\d{2}:\d{2}$/, locale: "de-DE" },
] as const;

test("desktop timestamps fit in 12-hour and 24-hour locales", async ({
  baseURL,
}) => {
  test.slow();
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  for (const browserType of browsers) {
    const browser = await browserType.launch();
    try {
      for (const { hourMarker, locale } of locales) {
        const context = await browser.newContext({
          locale,
          viewport: { height: 900, width: 1440 },
        });
        const page = await context.newPage();
        await page.goto(`${baseURL}/e2e/message-list-performance.html`);
        const times = page.locator("[data-message-row] time");
        await expect(times.first()).toBeVisible();
        expect(await times.first().innerText()).toMatch(hourMarker);
        const measurements = await times.evaluateAll((elements) =>
          elements.map((element) => ({
            clientWidth: element.clientWidth,
            fontVariantNumeric: getComputedStyle(element).fontVariantNumeric,
            scrollWidth: element.scrollWidth,
          })),
        );
        expect(measurements.length).toBeGreaterThan(0);
        for (const measurement of measurements) {
          expect(measurement.scrollWidth).toBeLessThanOrEqual(
            measurement.clientWidth,
          );
          expect(measurement.fontVariantNumeric).toContain("tabular-nums");
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
});
