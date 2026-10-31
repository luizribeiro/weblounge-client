import { expect, type Page, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";
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

for (const layout of [
  { name: "a status-bar-short", height: 812 },
  { name: "a full-screen", height: 874 },
] as const) {
  test.describe(`iOS standalone with ${layout.name} layout viewport`, () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      screen: { width: 402, height: 874 },
      viewport: { width: 402, height: layout.height },
    });
    test.skip(
      process.env.WEBLOUNGE_E2E_ERGO !== "1",
      "requires the flake's local Ergo fixture",
    );

    test.beforeEach(async ({ page }) => {
      await emulateStandalone(page);
      await emulateSafeTop(page, 62);
      await installVisualViewportHook(page);
    });

    test("asks WebKit for the full screen and keeps the composer whole", async ({
      page,
    }) => {
      await openChannel(page);
      await expect(page.locator("#root")).toHaveAttribute(
        "data-keyboard",
        "closed",
      );
      expect(await documentHeight(page)).toBe(
        Math.min(await largeViewportHeight(page), layout.height + 62),
      );
      await expect
        .poll(() => shellBottomError(page, layout.height))
        .toBeLessThanOrEqual(1);
      expect(await composerBottom(page)).toBeLessThanOrEqual(layout.height);
      await attemptDocumentScroll(page);
      await expect.poll(() => documentScroll(page)).toBe(0);
    });

    test("keeps the composer on an open keyboard while iOS pans", async ({
      page,
    }) => {
      await openChannel(page);
      const root = page.locator("#root");
      await page
        .getByRole("textbox", { name: "Message #weblounge-test" })
        .focus();

      await setVisualViewport(page, 476, 336);
      await expect(root).toHaveAttribute("data-keyboard", "open");
      await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);

      await setVisualViewport(page, layout.height, 0);
      await expect(root).toHaveAttribute("data-keyboard", "closed");
      await expect
        .poll(() => shellBottomError(page, layout.height))
        .toBeLessThanOrEqual(1);
    });
  });
}

test.describe("viewport diagnostics overlay", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 402, height: 874 },
  });
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows live geometry behind ?debug=viewport until turned off", async ({
    page,
  }) => {
    await openChannel(page, "&debug=viewport");
    const overlay = page.locator("[data-viewport-debug]");
    await expect(overlay).toContainText("inner: 402×874");
    await expect(overlay).toContainText("data-keyboard: closed");
    await page
      .getByRole("textbox", { name: "Message #weblounge-test" })
      .focus();
    await expect(overlay).toContainText("event: focusin");
    await expect(overlay).toContainText(/composer: [\d.]+–[\d.]+/u);

    await page.goto("/?irc-password=weblounge-test");
    await expect(overlay).toBeAttached();
    await page.goto("/?irc-password=weblounge-test&debug=off");
    await expect(
      page.getByRole("button", { name: "#weblounge-test" }),
    ).toBeVisible();
    await expect(overlay).toHaveCount(0);
  });
});

async function openChannel(page: Page, query = "") {
  await page.goto(`/?irc-password=weblounge-test${query}`);
  await page.getByRole("button", { name: "#weblounge-test" }).click();
}

interface KeyboardFrame {
  readonly bottomError: number;
  readonly liveEdgeGap: number;
  readonly padding: number;
}

type ViewportTiming = "live" | "stale";
type ViewportSetter = (
  height: number,
  offsetTop?: number,
  timing?: ViewportTiming,
) => void;

declare global {
  interface Window {
    __setVisualViewport?: ViewportSetter;
  }
}

// Emulates WebKit: a visual viewport that iOS pans for the keyboard, that
// window.scrollTo(0, 0) pans back, and whose events can precede its values.
async function installVisualViewportHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    const geometry: { height?: number; offsetTop: number } = { offsetTop: 0 };
    Object.defineProperties(viewport, {
      height: { get: () => geometry.height ?? innerHeight },
      offsetTop: { get: () => geometry.offsetTop },
      pageLeft: { get: () => 0 },
      pageTop: { get: () => geometry.offsetTop + scrollY },
      scale: { get: () => 1 },
      width: { get: () => innerWidth },
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const nativeScrollTo = window.scrollTo.bind(window);
    window.scrollTo = ((...args: Parameters<typeof window.scrollTo>) => {
      nativeScrollTo(...args);
      const top = typeof args[0] === "number" ? args[1] : args[0]?.top;
      if (top !== 0 || geometry.offsetTop === 0) return;
      geometry.offsetTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    }) as typeof window.scrollTo;
    window.__setVisualViewport = (height, offsetTop = 0, timing = "live") => {
      const resized = height !== geometry.height;
      const panned = offsetTop !== geometry.offsetTop;
      const apply = () => {
        geometry.height = height;
        geometry.offsetTop = offsetTop;
      };
      if (timing === "live") apply();
      if (resized) viewport.dispatchEvent(new Event("resize"));
      if (panned) viewport.dispatchEvent(new Event("scroll"));
      if (timing === "stale") apply();
    };
  });
}

async function emulateSafeTop(page: Page, inset: number): Promise<void> {
  await page.addInitScript((top) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`:root { --wl-safe-top: ${top}px !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, inset);
}

async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop: number,
  timing: ViewportTiming = "live",
): Promise<void> {
  await page.evaluate(
    ([nextHeight, nextOffsetTop, nextTiming]) => {
      const setViewport = window.__setVisualViewport;
      if (setViewport === undefined)
        throw new Error("viewport hook is missing");
      setViewport(nextHeight, nextOffsetTop, nextTiming);
    },
    [height, offsetTop, timing] as const,
  );
}

async function shellBottomError(
  page: Page,
  expectedBottom: number,
): Promise<number> {
  return page
    .locator("[data-mobile-shell]")
    .evaluate(
      (shell, bottom) =>
        Math.abs(shell.getBoundingClientRect().bottom - bottom),
      expectedBottom,
    );
}

async function composerKeyboardGap(page: Page): Promise<number> {
  return page.locator("[data-composer]").evaluate((composer) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("visual viewport is missing");
    return Math.abs(
      composer.getBoundingClientRect().bottom -
        viewport.offsetTop -
        viewport.height,
    );
  });
}

async function attemptDocumentScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector("[data-composer]")?.scrollIntoView();
    document.scrollingElement?.scrollBy(0, 400);
    window.scrollBy(0, 400);
  });
}

async function documentScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => (document.scrollingElement?.scrollTop ?? 0) + window.scrollY,
  );
}

async function documentHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.round(document.documentElement.getBoundingClientRect().height),
  );
}

async function largeViewportHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.setProperty("block-size", "100lvh");
    document.body.append(probe);
    const height = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    return height;
  });
}

async function composerBottom(page: Page): Promise<number> {
  return page
    .locator("[data-composer]")
    .evaluate((composer) => composer.getBoundingClientRect().bottom);
}

async function sampleKeyboardTransition(
  page: Page,
  height: number,
): Promise<readonly KeyboardFrame[]> {
  return page.evaluate(async (nextHeight) => {
    const composer = document.querySelector<HTMLElement>("[data-composer]");
    const messages = document.querySelector<HTMLElement>("[data-message-list]");
    const viewport = window.visualViewport;
    const setViewport = window.__setVisualViewport;
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
