import { expect, type Locator } from "@playwright/test";

export async function expectPinnedToHeaderEnd(button: Locator): Promise<void> {
  const geometry = await button.evaluate((element) => {
    const header = element.closest<HTMLElement>("[data-connection-brand]");
    const title = header?.querySelector("[data-connection-title]");
    if (header == null || title == null)
      throw new Error("header button is outside the sidebar brand row");
    const buttonBox = element.getBoundingClientRect();
    const paddingRight = Number.parseFloat(
      getComputedStyle(header).paddingRight,
    );
    return {
      buttonLeft: buttonBox.left,
      buttonRight: buttonBox.right,
      contentRight: header.getBoundingClientRect().right - paddingRight,
      titleRight: title.getBoundingClientRect().right,
    };
  });
  expect(
    Math.abs(geometry.contentRight - geometry.buttonRight),
  ).toBeLessThanOrEqual(1);
  expect(geometry.titleRight).toBeLessThanOrEqual(geometry.buttonLeft);
}
