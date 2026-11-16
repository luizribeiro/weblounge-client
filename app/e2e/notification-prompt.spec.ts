import { expect, type Page, test } from "@playwright/test";
import {
  dismissNotificationPrompt,
  notificationPromptDismissed,
  trackDedicatedEngine,
} from "./tracked-engine-worker";

async function launch(page: Page): Promise<void> {
  await trackDedicatedEngine(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
}

test("the engine reports a dismissed prompt to the page after reload and relaunch", async ({
  context,
  page,
}) => {
  await launch(page);
  await expect(notificationPromptDismissed(page)).resolves.toBe(false);

  await dismissNotificationPrompt(page);
  await expect(notificationPromptDismissed(page)).resolves.toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "weblounge" })).toBeVisible();
  await expect(notificationPromptDismissed(page)).resolves.toBe(true);

  await page.close();
  const relaunched = await context.newPage();
  await launch(relaunched);
  await expect(notificationPromptDismissed(relaunched)).resolves.toBe(true);
});
