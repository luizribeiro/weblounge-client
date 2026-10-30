import { expect, test } from "@playwright/test";
import {
  hasSelfNickColour,
  productionMessageRow,
  useDedicatedWorker,
} from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_PRODUCTION_ERGO !== "1",
  "requires the production-shaped always-on Ergo profile",
);

test("restores one own multiline row with blank lines and the self colour", async ({
  page,
}) => {
  await useDedicatedWorker(page);
  await page.goto("/?irc-password=weblounge-test");
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);

  const suffix = Date.now();
  const first = `multiline first ${suffix}`;
  const last = `multiline last ${suffix}`;
  const expected = `${first}\n\n${last}`;
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(first);
  await composer.press("Shift+Enter");
  await composer.press("Shift+Enter");
  await composer.press("Shift+Enter");
  await composer.type(last);
  await composer.press("Enter");
  await expect(productionMessageRow(page, expected)).toHaveCount(1);

  await page.goto("/?irc-password=weblounge-test");
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  const restored = productionMessageRow(page, expected);
  await expect(restored).toHaveCount(1);
  await expect(restored).toHaveAttribute("data-message-text", expected);
  await expect.poll(() => restored.evaluate(hasSelfNickColour)).toBe(true);
});
