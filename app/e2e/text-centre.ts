import { expect, type Locator } from "@playwright/test";

/** A mark beside text reads as aligned when its box's centre meets the centre of the text's glyph boxes. */
export async function expectCentredOnText(
  mark: Locator,
  text: Locator,
): Promise<void> {
  const markBox = await mark.boundingBox();
  const glyphs = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const { top, height } = range.getBoundingClientRect();
    return { top, height };
  });
  if (markBox === null) throw new Error("mark has no box");
  expect(
    Math.abs(markBox.y + markBox.height / 2 - (glyphs.top + glyphs.height / 2)),
  ).toBeLessThanOrEqual(1);
}
