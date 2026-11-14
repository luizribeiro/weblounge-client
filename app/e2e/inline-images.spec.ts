import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { E2E_FILEHOST_ORIGIN } from "../csp";
import {
  rowFor,
  settledScreenshot,
  slotIn,
  withDirectPeer,
} from "./filehost-peer";
import { expect, test } from "./irc-fixture";
import {
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { waitForStableGeometry } from "./stable-geometry";

const screenshots = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "inline-images",
);

test.describe("inline file host images against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ ignoreHTTPSErrors: true });

  test("reserves desktop slots that never move rows", async ({ page, irc }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await withDirectPeer(page, irc, "desktop", async (peer, suffix) => {
      const held = `${E2E_FILEHOST_ORIGIN}/held/${suffix}/wide.png`;
      const missing = `${E2E_FILEHOST_ORIGIN}/${suffix}/missing.png`;
      const foreign = `https://localhost:4175/${suffix}/landscape.png`;
      await peer.privmsgConfirmed(irc.account, `panorama ${held}`);
      await peer.privmsgConfirmed(irc.account, `broken ${missing}`);
      await peer.privmsgConfirmed(irc.account, `elsewhere ${foreign}`);
      await peer.privmsgConfirmed(irc.account, `after images ${suffix}`);

      const heldSlot = slotIn(page, held);
      await expect(heldSlot).toHaveAttribute("data-inline-image", "loading");
      await expectSlotSize(heldSlot, 240, 320);
      const failed = slotIn(page, missing);
      await expect(failed).toHaveAttribute("data-inline-image", "failed");
      await expectSlotSize(failed, 240, 320);
      await expect(failed).toContainText("Couldn’t load image · Open link");
      await expect(failed).toHaveCSS("text-decoration-line", "none");
      await expect(rowFor(page, foreign).getByRole("link")).toHaveAttribute(
        "href",
        foreign,
      );
      await expect(
        rowFor(page, foreign).locator("[data-inline-image]"),
      ).toHaveCount(0);

      const list = page.locator("[data-message-list]");
      await waitForStableGeometry(list, "[data-message-row]");
      const before = await rowGeometry(page);
      await resetNativeFeelLayoutShift(page);
      const release = await page.request.get(
        `${E2E_FILEHOST_ORIGIN}/release/${suffix}`,
      );
      expect(release.ok()).toBe(true);
      await expect(heldSlot).toHaveAttribute("data-inline-image", "loaded");
      await expectSlotSize(heldSlot, 240, 360);
      await waitForStableGeometry(list, "[data-message-row]");
      expect(await rowGeometry(page)).toEqual(before);
      await nativeFeelAudit(page);

      await captureThemes(page, "desktop");
    });
  });

  test("uses the compact slot height in compact density", async ({
    page,
    irc,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await withDirectPeer(page, irc, "compact", async (peer, suffix) => {
      await page.evaluate(() => {
        document.documentElement.dataset.messageDensity = "compact";
      });
      const image = `${E2E_FILEHOST_ORIGIN}/${suffix}/landscape.png`;
      await peer.privmsgConfirmed(irc.account, `compact ${image}`);
      const slot = slotIn(page, image);
      await expect(slot).toHaveAttribute("data-inline-image", "loaded");
      await expectSlotSize(slot, 160, (160 * 4) / 3);
      await screenshot(page, "compact-light");
    });
  });

  test("stills animated images under reduced motion", async ({ page, irc }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await withDirectPeer(page, irc, "still", async (peer, suffix) => {
      const animated = `${E2E_FILEHOST_ORIGIN}/${suffix}/animated.gif`;
      await peer.privmsgConfirmed(irc.account, `wave ${animated}`);
      const slot = slotIn(page, animated);
      await expect(slot).toHaveAttribute("data-inline-image", "still");
      await expect(slot.locator("canvas")).toBeVisible();
      await expect(slot.locator("img")).toHaveCount(0);
      await expectSlotSize(slot, 240, 320);
    });
  });

  test.describe("phone layout", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });

    test("fits the phone slot inside the content column", async ({
      page,
      irc,
    }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await withDirectPeer(page, irc, "phone", async (peer, suffix) => {
        const wide = `${E2E_FILEHOST_ORIGIN}/${suffix}/wide.png`;
        const tall = `${E2E_FILEHOST_ORIGIN}/${suffix}/tall.png`;
        await peer.privmsgConfirmed(irc.account, `wide ${wide}`);
        await peer.privmsgConfirmed(irc.account, tall);
        const wideSlot = slotIn(page, wide);
        const tallSlot = slotIn(page, tall);
        await expect(wideSlot).toHaveAttribute("data-inline-image", "loaded");
        await expect(tallSlot).toHaveAttribute("data-inline-image", "loaded");
        await expectSlotSize(tallSlot, 200, 64);
        const geometry = await wideSlot.evaluate((slot) => {
          const content = slot.closest("[data-message-row]");
          const list = slot.closest<HTMLElement>("[data-message-list]");
          if (content === null || list === null)
            throw new Error("slot is outside the message list");
          return {
            height: slot.getBoundingClientRect().height,
            right: slot.getBoundingClientRect().right,
            rowRight: content.getBoundingClientRect().right,
            scrollWidth: list.scrollWidth,
            clientWidth: list.clientWidth,
          };
        });
        expect(geometry.height).toBe(200);
        expect(geometry.right).toBeLessThanOrEqual(geometry.rowRight);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
        await screenshot(page, "phone-light");
      });
    });
  });
});

async function expectSlotSize(
  slot: Locator,
  height: number,
  width: number,
): Promise<void> {
  await expect
    .poll(async () => (await slot.boundingBox())?.height)
    .toBe(height);
  const box = await slot.boundingBox();
  expect(box?.width).toBeCloseTo(width, 0);
}

async function rowGeometry(page: Page) {
  return page.locator("[data-message-row]").evaluateAll((rows) =>
    rows.map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    }),
  );
}

async function captureThemes(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "lounge" : "lounge-night",
    );
    await screenshot(page, `${name}-${theme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await settledScreenshot(page, screenshots, name);
}
