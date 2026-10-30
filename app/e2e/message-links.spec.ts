import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

test.describe("message links against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens desktop URLs and channel links", async ({ page }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1200, height: 800 });
    await exerciseLinks(page, "desktop", false, true);
  });

  test.describe("touch-primary rendering", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });

    test("opens mobile URLs and channel links without overflowing", async ({
      page,
    }) => {
      await exerciseLinks(page, "mobile", true);
    });
  });
});

async function exerciseLinks(
  page: import("@playwright/test").Page,
  label: string,
  longUrl: boolean,
  audit = false,
): Promise<void> {
  const suffix = Date.now().toString().slice(-6);
  const target = `#links-${label}-${suffix}`;
  const url = `http://127.0.0.1:4174/${longUrl ? "unbroken-segment".repeat(12) : `message-${suffix}`}`;
  const source = await IrcClient.connect(
    `source${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  const targetMember = await IrcClient.connect(
    `target${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    target,
  );
  try {
    await source.privmsgConfirmed(
      "#weblounge-test",
      `visit ${url}. then open ${target}`,
    );
    await page.goto("/?irc-password=weblounge-test");
    if (label === "mobile")
      await page.getByRole("button", { name: "#weblounge-test" }).click();

    const external = page
      .locator("[data-message-list]")
      .getByRole("link", { name: url });
    await expect(external).toHaveAttribute("href", url);
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).toHaveAttribute("rel", "noopener noreferrer");
    if (audit) {
      await expect(
        page.locator('[data-buffer-id][aria-current="page"]'),
      ).toHaveAttribute("data-unread", "0");
      await nativeFeelAudit(page);
    }
    if (longUrl) {
      const geometry = await external.evaluate((link) => {
        const list = link.closest<HTMLElement>("[data-message-list]");
        if (list === null) throw new Error("message list is missing");
        return {
          clientWidth: list.clientWidth,
          linkRight: link.getBoundingClientRect().right,
          listRight: list.getBoundingClientRect().right,
          scrollWidth: list.scrollWidth,
        };
      });
      expect(geometry.linkRight).toBeLessThanOrEqual(geometry.listRight);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    }

    const popupPromise = page.waitForEvent("popup");
    await external.click();
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe(url);
    await popup.close();

    await page.getByRole("link", { name: target }).click();
    await expect(page.getByRole("heading", { name: target })).toBeVisible();
  } finally {
    source.close();
    targetMember.close();
  }
}
