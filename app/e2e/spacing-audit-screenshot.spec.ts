import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { scrollToTranscriptTop } from "./message-list-scroll";
import { useDedicatedWorker } from "./production-ergo";
import { seedMixedConversation } from "./spacing-audit-fixture";

const phase = process.env.WEBLOUNGE_SPACING_SCREENSHOT_PHASE;
const outputDirectory = process.env.WEBLOUNGE_SPACING_SCREENSHOT_DIR;

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1" ||
    phase === undefined ||
    outputDirectory === undefined,
  "runs only for an explicit spacing screenshot capture",
);

test("captures the transcript spacing review fixture", async ({
  page,
}, testInfo) => {
  test.skip(!auditProject(testInfo.project.name), "runs on desktop and phones");
  const phone = isPhoneProject(testInfo.project.name);
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  );
  await page.emulateMedia({ colorScheme: "dark" });
  const scenario = await seedMixedConversation(testInfo.project.name);
  try {
    await useDedicatedWorker(page);
    await page.goto(scenario.startUrl);
    await page.getByRole("button", { name: scenario.channel }).click();
    await expect(
      page.getByRole("heading", { name: scenario.channel }),
    ).toBeVisible();
    await expect(
      page.locator(
        `[data-message-row][data-message-text="${scenario.systemFence}"]`,
      ),
    ).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("/version");
    await composer.press("Enter");
    await composer.fill("/topic");
    await composer.press("Enter");
    await expect(page.locator("[data-notice-row]")).toHaveCount(2);
    const list = page.locator("[data-message-list]");
    if (phone) await scrollToTranscriptTop(list);
    else {
      await list.hover();
      await page.mouse.wheel(0, -100_000);
    }
    if (phase !== "before") {
      if (phone)
        await page.getByRole("button", { name: "Back to chats" }).click();
      else
        await page.getByRole("button", { name: /Local Ergo, online/u }).click();
      await scenario.sendUnread();
      await page.getByRole("button", { name: scenario.channel }).click();
      await expect(page.locator("[data-new-line]")).toBeVisible();
    }
    await mkdir(`${outputDirectory}/${phase}`, { recursive: true });
    await page.screenshot({
      path: `${outputDirectory}/${phase}/${phone ? "phone" : "desktop"}-mixed.png`,
    });
  } finally {
    scenario.close();
  }
});

function auditProject(project: string): boolean {
  return project === "chromium" || isPhoneProject(project);
}

function isPhoneProject(project: string): boolean {
  return (
    project === "android-phone-layout" || project === "webkit-phone-layout"
  );
}
