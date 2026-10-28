import { expect, test } from "@playwright/test";

test("renders the chair glyph instead of a flat mask", async ({ page }) => {
  await page.goto("/");
  const mark = page.locator("[data-sidebar] span[aria-hidden='true']").first();
  const chip = mark.locator("..");
  await expect(chip).toBeVisible();
  const screenshot = await chip.screenshot();
  const panel = await mark.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const panelPixels = await page.evaluate(
    async ({ png, panelColor }) => {
      const bytes = Uint8Array.from(atob(png), (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("2D canvas is unavailable");
      context.drawImage(bitmap, 0, 0);
      const expected = panelColor.match(/\d+/g)?.map(Number) ?? [];
      const pixels = context.getImageData(5, 5, 28, 28).data;
      let matches = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (
          pixels[offset] === expected[0] &&
          pixels[offset + 1] === expected[1] &&
          pixels[offset + 2] === expected[2]
        ) {
          matches += 1;
        }
      }
      return matches / (pixels.length / 4);
    },
    { panelColor: panel, png: screenshot.toString("base64") },
  );

  expect(panelPixels).toBeGreaterThan(0.1);
  expect(panelPixels).toBeLessThan(0.7);
});
