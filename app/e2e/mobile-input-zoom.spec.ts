import { expect, type Page, test } from "@playwright/test";
import { auditMobileTextFieldZoom } from "./native-feel-audit";

test.describe("mobile text field zoom", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 402, height: 874 },
  });
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("keeps chat search at the initial scale", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("searchbox", { name: "Search chats" }),
    ).toBeVisible();
    await auditMobileTextFieldZoom(page);
  });

  test("keeps the composer at the initial scale", async ({ page }) => {
    await openChannel(page);
    await expect(
      page.getByRole("textbox", { name: "Message #weblounge-test" }),
    ).toBeVisible();
    await auditMobileTextFieldZoom(page);
  });

  test("animates away the home-indicator inset with the keyboard", async ({
    page,
  }) => {
    await installVisualViewportHook(page);
    await openChannel(page);
    const root = page.locator("#root");
    const composer = page.locator("[data-composer]");
    const messages = page.locator("[data-message-list]");
    await root.evaluate((element) => {
      element.style.setProperty("--wl-safe-bottom", "34px");
    });
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await expect(composer).toHaveCSS("padding-bottom", "34px");
    await messages.press("End");
    await expect.poll(() => liveEdgeGap(messages)).toBeLessThanOrEqual(2);
    await page
      .getByRole("textbox", { name: "Message #weblounge-test" })
      .focus();

    const layoutHeight = await page.evaluate(() => innerHeight);
    const opening = await sampleKeyboardTransition(page, layoutHeight - 358);
    expectPaddingMotion(opening, "down", 34, 14);
    expect(opening.every((frame) => frame.liveEdgeGap <= 2)).toBe(true);
    expect(
      Math.max(...opening.slice(1).map((frame) => frame.bottomError)),
    ).toBeLessThanOrEqual(1);
    await expect(root).toHaveAttribute("data-keyboard", "open");
    await expect(root).toHaveCSS("--wl-keyboard-inset", "358px");
    await expect(composer).toHaveCSS("padding-bottom", "14px");

    const closing = await sampleKeyboardTransition(page, layoutHeight);
    expectPaddingMotion(closing, "up", 14, 34);
    expect(closing.every((frame) => frame.liveEdgeGap <= 2)).toBe(true);
    expect(
      Math.max(...closing.slice(1).map((frame) => frame.bottomError)),
    ).toBeLessThanOrEqual(1);
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await expect(composer).toHaveCSS("padding-bottom", "34px");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(composer).toHaveCSS("transition-duration", "0s");
  });

  test("keeps drawer fields at the initial scale", async ({ page }) => {
    await openChannel(page);
    await page.getByRole("button", { name: "Show members" }).click();
    await expect(
      page.getByRole("searchbox", { name: "Filter members" }),
    ).toBeVisible();
    await auditMobileTextFieldZoom(page);
  });
});

async function openChannel(page: Page) {
  await page.goto("/?irc-password=weblounge-test");
  await page.getByRole("button", { name: "#weblounge-test" }).click();
}

interface KeyboardFrame {
  readonly bottomError: number;
  readonly liveEdgeGap: number;
  readonly padding: number;
}

async function installVisualViewportHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    const geometry: { height?: number; offsetTop: number } = { offsetTop: 0 };
    Object.defineProperties(viewport, {
      height: { get: () => geometry.height ?? innerHeight },
      offsetTop: { get: () => geometry.offsetTop },
      pageLeft: { get: () => 0 },
      pageTop: { get: () => 0 },
      scale: { get: () => 1 },
      width: { get: () => innerWidth },
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    (
      window as Window & {
        __setVisualViewport: (height: number) => void;
      }
    ).__setVisualViewport = (height) => {
      geometry.height = height;
      viewport.dispatchEvent(new Event("resize"));
    };
  });
}

async function sampleKeyboardTransition(
  page: Page,
  height: number,
): Promise<readonly KeyboardFrame[]> {
  return page.evaluate(async (nextHeight) => {
    const composer = document.querySelector<HTMLElement>("[data-composer]");
    const messages = document.querySelector<HTMLElement>("[data-message-list]");
    const viewport = window.visualViewport;
    const setViewport = (
      window as Window & {
        __setVisualViewport?: (height: number) => void;
      }
    ).__setVisualViewport;
    if (
      composer === null ||
      messages === null ||
      viewport === null ||
      setViewport === undefined
    )
      throw new Error("keyboard test surfaces are missing");
    const frames: KeyboardFrame[] = [];
    let sawAnimation = false;
    const sample = () => {
      const style = getComputedStyle(composer);
      frames.push({
        bottomError: Math.abs(
          composer.getBoundingClientRect().bottom -
            viewport.offsetTop -
            viewport.height,
        ),
        liveEdgeGap: Math.max(
          0,
          messages.scrollHeight - messages.clientHeight - messages.scrollTop,
        ),
        padding: Number.parseFloat(style.paddingBottom),
      });
    };
    sample();
    setViewport(nextHeight);
    await new Promise<void>((resolve) => {
      const next = () => {
        sample();
        const animations = composer.getAnimations();
        if (animations.length > 0) sawAnimation = true;
        if (
          sawAnimation &&
          animations.every((animation) => animation.playState === "finished")
        ) {
          resolve();
          return;
        }
        requestAnimationFrame(next);
      };
      requestAnimationFrame(next);
    });
    return frames;
  }, height);
}

async function liveEdgeGap(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((messages) =>
    Math.max(
      0,
      messages.scrollHeight - messages.clientHeight - messages.scrollTop,
    ),
  );
}

function expectPaddingMotion(
  frames: readonly KeyboardFrame[],
  direction: "down" | "up",
  from: number,
  to: number,
): void {
  expect(frames.length).toBeGreaterThan(2);
  expect(Math.round(frames[0]?.padding ?? -1)).toBe(from);
  expect(Math.round(frames.at(-1)?.padding ?? -1)).toBe(to);
  expect(
    frames.some((frame) => frame.padding !== from && frame.padding !== to),
  ).toBe(true);
  expect(
    frames.every((frame, index) => {
      const previous = frames[index - 1]?.padding;
      if (previous === undefined) return true;
      return direction === "down"
        ? frame.padding <= previous + 0.1
        : frame.padding + 0.1 >= previous;
    }),
  ).toBe(true);
}
