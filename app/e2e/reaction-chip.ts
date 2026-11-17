import { expect, type Locator } from "@playwright/test";

/** A chip is confirmed once it shows this account's reaction with no change still in flight. */
export async function expectConfirmedOwn(
  chip: Locator,
  count: string,
): Promise<void> {
  await expect(chip).toHaveAttribute("data-reaction-own", "true");
  await expect(chip).not.toHaveAttribute("data-reaction-delivery");
  await expect(chip).toContainText(count);
}
