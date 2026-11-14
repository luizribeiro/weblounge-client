import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { E2E_FILEHOST_ORIGIN } from "../csp";
import { settledScreenshot, slotIn, withDirectPeer } from "./filehost-peer";
import { expect, test } from "./irc-fixture";
import {
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";

const screenshots =
  process.env.WEBLOUNGE_VIEWER_SHOTS ??
  path.join(process.cwd(), "e2e", "screenshots", "image-viewer");
const landscapeWidth = 640;

test.describe("full-size image viewer against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ ignoreHTTPSErrors: true });

  test.describe("desktop", () => {
    test.skip(({ isMobile }) => isMobile, "desktop pointer and keyboard flows");

    test("zooms and pans a clicked image, then closes on Escape", async ({
      page,
      irc,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: "light" });
      await withDirectPeer(page, irc, "zoom", async (peer, suffix) => {
        const url = `${E2E_FILEHOST_ORIGIN}/${suffix}/landscape.png`;
        await peer.privmsgConfirmed(irc.account, `look ${url}`);
        const slot = await loadedSlot(page, url);
        const scripts = await loadedScripts(page);
        expect(await anyContains(page, scripts, "pswp__")).toBe(false);

        await slot.click();
        const viewer = await openViewer(page, peer.nickname);
        const added = (await loadedScripts(page)).filter(
          (script) => !scripts.includes(script),
        );
        expect(await anyContains(page, added, "pswp__")).toBe(true);
        await expect(
          viewer.getByText(peer.nickname, { exact: true }),
        ).toBeVisible();
        await expect(
          viewer.getByRole("link", { name: "Open original" }),
        ).toHaveAttribute("href", url);
        await captureThemes(page, "desktop-fit");

        await page.keyboard.press("+");
        await expectScale(page, 1.5);
        await page.keyboard.press("-");
        await expectScale(page, 1);
        await page.keyboard.press("=");
        await page.keyboard.press("0");
        await expectScale(page, 1);

        const image = viewerImage(page);
        await image.dblclick();
        await expectScale(page, 2);
        const close = viewer.getByRole("button", { name: "Close image" });
        await expect(viewer.locator("header")).toHaveCSS(
          "background-color",
          "rgba(0, 0, 0, 0)",
        );
        await expect(close).toBeVisible();
        await captureThemes(page, "desktop-zoomed");
        const before = await image.boundingBox();
        if (before === null) throw new Error("viewer image is not visible");
        const center = { x: 640, y: 424 };
        await page.mouse.move(center.x, center.y);
        await page.mouse.down();
        await page.mouse.move(center.x + 120, center.y + 80, { steps: 8 });
        await page.mouse.up();
        await expect
          .poll(async () => (await image.boundingBox())?.y ?? before.y)
          .toBeGreaterThan(before.y + 40);
        await expect(viewer).toBeVisible();
        await image.dblclick();
        await expectScale(page, 1);

        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -200);
        await page.keyboard.up("Control");
        await expect.poll(() => viewerScale(page)).toBeGreaterThan(1);
        await page.keyboard.press("0");
        await expectScale(page, 1);

        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
        await expect(slot).toBeFocused();
      });
    });

    test("stays idle while open, including on a hidden page", async ({
      page,
      irc,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: "light" });
      await withDirectPeer(page, irc, "idle", async (peer, suffix) => {
        const url = `${E2E_FILEHOST_ORIGIN}/${suffix}/landscape.png`;
        await peer.privmsgConfirmed(irc.account, url);
        const slot = await loadedSlot(page, url);
        await resetNativeFeelLayoutShift(page);

        await slot.click();
        const viewer = await openViewer(page, peer.nickname);
        await viewerImage(page).dblclick();
        await expectScale(page, 2);
        await nativeFeelAudit(page);
        await auditWhileHidden(page);

        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
      });
    });

    test("opens from the keyboard, traps focus and closes from its button", async ({
      page,
      irc,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: "light" });
      await withDirectPeer(page, irc, "keys", async (peer, suffix) => {
        const url = `${E2E_FILEHOST_ORIGIN}/${suffix}/landscape.png`;
        await peer.privmsgConfirmed(irc.account, url);
        const slot = await loadedSlot(page, url);
        await resetNativeFeelLayoutShift(page);
        await expect(slot).toHaveAccessibleName(
          `Image from ${peer.nickname}, open viewer`,
        );

        await slot.focus();
        await page.keyboard.press("Enter");
        const viewer = await openViewer(page, peer.nickname);
        await expect(viewer).toBeFocused();
        await expect(viewer.getByRole("status")).toHaveText(
          `Image from ${peer.nickname}. Press Escape to close.`,
        );
        const original = viewer.getByRole("link", { name: "Open original" });
        const close = viewer.getByRole("button", { name: "Close image" });
        await page.keyboard.press("Tab");
        await expect(original).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(original).toBeFocused();
        await page.keyboard.press("a");
        await expect(composer(page)).toHaveValue("");

        await close.click();
        await expect(viewer).toHaveCount(0);
        await expect(slot).toBeFocused();

        await page.keyboard.press(" ");
        await openViewer(page, peer.nickname);
        await page.mouse.click(40, 760);
        await expect(viewer).toHaveCount(0);
        await expect(slot).toBeFocused();
        await nativeFeelAudit(page);
      });
    });

    test("opens and closes instantly under reduced motion", async ({
      page,
      irc,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      await withDirectPeer(page, irc, "still", async (peer, suffix) => {
        const url = `${E2E_FILEHOST_ORIGIN}/${suffix}/landscape.png`;
        await peer.privmsgConfirmed(irc.account, url);
        const slot = await loadedSlot(page, url);

        await slot.click();
        const viewer = page.getByRole("dialog", {
          name: `Image from ${peer.nickname}`,
        });
        await expect(viewer).toHaveAttribute("data-image-viewer", "open");
        expect(await runningAnimations(page)).toBe(0);
        await expectScale(page, 1);

        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
        expect(await runningAnimations(page)).toBe(0);
        await expect(slot).toBeFocused();
      });
    });
  });

  test.describe("phone", { tag: "@phone" }, () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });

    test("opens on tap and closes on a downward swipe", async ({
      page,
      irc,
    }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await withDirectPeer(page, irc, "phone", async (peer, suffix) => {
        const url = `${E2E_FILEHOST_ORIGIN}/${suffix}/landscape.png`;
        await peer.privmsgConfirmed(irc.account, `phone ${url}`);
        const slot = await loadedSlot(page, url);
        await resetNativeFeelLayoutShift(page);

        await slot.tap();
        const viewer = await openViewer(page, peer.nickname);
        const image = await viewerImage(page).boundingBox();
        expect(image?.width).toBeCloseTo(390, 0);
        await settledScreenshot(page, screenshots, "phone-light");
        await nativeFeelAudit(page);

        await swipeDown(page, 420);
        await expect(viewer).toHaveCount(0);
        await expect(composer(page)).not.toBeFocused();
        await nativeFeelAudit(page);
      });
    });
  });
});

async function loadedSlot(page: Page, url: string): Promise<Locator> {
  const slot = slotIn(page, url);
  await expect(slot).toHaveAttribute("data-inline-image", "loaded");
  return slot;
}

async function openViewer(page: Page, nick: string): Promise<Locator> {
  const viewer = page.getByRole("dialog", { name: `Image from ${nick}` });
  await expect(viewer).toHaveAttribute("aria-modal", "true");
  await expect(viewer).toHaveAttribute("data-image-viewer", "open");
  await expect.poll(() => runningAnimations(page)).toBe(0);
  return viewer;
}

function viewerImage(page: Page): Locator {
  return page.locator("[data-image-viewer] img.pswp__img");
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: /^Message/u });
}

async function viewerScale(page: Page): Promise<number> {
  const box = await viewerImage(page).boundingBox();
  return (box?.width ?? 0) / landscapeWidth;
}

async function expectScale(page: Page, scale: number): Promise<void> {
  await expect.poll(() => viewerScale(page)).toBeCloseTo(scale, 2);
}

function runningAnimations(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running").length,
  );
}

function loadedScripts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => new URL(name).pathname.endsWith(".js")),
  );
}

async function anyContains(
  page: Page,
  scripts: readonly string[],
  text: string,
): Promise<boolean> {
  for (const script of scripts) {
    const response = await page.request.get(script);
    if ((await response.text()).includes(text)) return true;
  }
  return false;
}

async function auditWhileHidden(page: Page): Promise<void> {
  const setHidden = (hidden: boolean) =>
    page.evaluate((next) => {
      (
        window as Window & {
          __setNativeVisibility?: (hidden: boolean) => void;
        }
      ).__setNativeVisibility?.(next);
    }, hidden);
  await setHidden(true);
  await nativeFeelAudit(page);
  await setHidden(false);
}

async function swipeDown(page: Page, distance: number): Promise<void> {
  await page.locator(".pswp__scroll-wrap").evaluate(async (target, delta) => {
    const box = target.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const pointer = (type: string, offset: number) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y + offset,
        isPrimary: true,
        pointerId: 41,
        pointerType: "touch",
      });
      (type === "pointerdown" ? target : window).dispatchEvent(event);
    };
    pointer("pointerdown", 0);
    for (let step = 1; step <= 10; step += 1) {
      await frame();
      pointer("pointermove", (delta * step) / 10);
    }
    await frame();
    pointer("pointerup", delta);
  }, distance);
}

async function captureThemes(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "lounge" : "lounge-night",
    );
    await settledScreenshot(page, screenshots, `${name}-${theme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}
