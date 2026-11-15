import { expect, type Locator, type Page } from "@playwright/test";
import { touchDown } from "./touch";

/** Holds a finger on a phone message until its action sheet opens, then lifts it. */
export async function longPressMessage(
  page: Page,
  row: Locator,
  author: string,
): Promise<Locator> {
  const sheet = page.getByRole("dialog", {
    name: `Actions for ${author}’s message`,
  });
  const finger = await touchDown(page, row.locator("[data-selectable]"));
  await expect(row).toHaveAttribute("data-pressing", "true");
  await expect(sheet).toBeVisible();
  await finger.lift();
  await expect(sheet).toBeVisible();
  return sheet;
}
