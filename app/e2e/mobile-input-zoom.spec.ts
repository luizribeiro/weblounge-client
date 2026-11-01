import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
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

  test("keeps the composer still and focused when a suggestion is tapped", async ({
    page,
  }) => {
    await installVisualViewportHook(page, true);
    await openChannel(page);
    const root = page.locator("#root");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    await composer.tap();
    await expect(root).toHaveAttribute("data-keyboard", "open");
    await composer.fill("/jo");
    const suggestion = page.getByRole("option", { name: /\/join/u });
    await expect(suggestion).toBeVisible();

    const frames = await sampleSuggestionTap(page, suggestion);

    await expect(composer).toHaveValue("/join ");
    await expect(composer).toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "open");
    expect(frames.every(({ focused }) => focused)).toBe(true);
    const tops = frames.map(({ composerTop }) => composerTop);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(0.5);
  });

  test("keeps keyboard focus and touch drags from panning the app", async ({
    page,
  }) => {
    await installVisualViewportHook(page, true);
    await openChannel(page);
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const root = page.locator("#root");

    await composer.evaluate((field) => {
      field.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          isPrimary: true,
          pointerId: 7,
          pointerType: "touch",
        }),
      );
      field.dispatchEvent(
        new PointerEvent("pointercancel", {
          bubbles: true,
          isPrimary: true,
          pointerId: 7,
          pointerType: "touch",
        }),
      );
    });
    await expect(root).toHaveAttribute("data-keyboard", "closed");

    const drag = await touchMove(composer, 400, 400, {
      endX: 240,
      startX: 200,
    });
    expect(drag.endAllowed).toBe(true);
    await expect(composer).not.toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "closed");

    const longPress = await touchMove(composer, 400, 400, { duration: 500 });
    expect(longPress.endAllowed).toBe(true);
    await expect(composer).not.toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "closed");

    await composer.tap();
    await expect(composer).toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "open");
    const opening = await sampleAppPosition(page, 8);
    expect(opening).toEqual(
      opening.map(() => ({ appTop: 0, offsetTop: 0, scrollY: 0 })),
    );

    const headerMove = await touchMove(
      page.getByRole("button", { name: "Back to chats" }),
      200,
      120,
    );
    if (headerMove.moveAllowed)
      await setVisualViewport(
        page,
        await page.evaluate(() => innerHeight - 358),
        80,
      );
    const dragged = await sampleAppPosition(page, 8);
    expect(headerMove.moveAllowed).toBe(false);
    expect(dragged).toEqual(
      dragged.map(() => ({ appTop: 0, offsetTop: 0, scrollY: 0 })),
    );

    const messages = page.locator("[data-message-list]");
    await makeTranscriptScrollable(messages);
    const before = await messages.evaluate((element) => element.scrollTop);
    expect((await touchMove(messages, 500, 300)).moveAllowed).toBe(true);
    await messages.evaluate((element) => element.scrollBy(0, 100));
    expect(await messages.evaluate((element) => element.scrollTop)).toBe(
      before + 100,
    );
  });

  test("reconciles a focused cached layout to measured keyboard geometry", async ({
    page,
  }) => {
    await installVisualViewportHook(page);
    await openChannel(page);
    const root = page.locator("#root");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const layoutHeight = await page.evaluate(() => innerHeight);
    const firstHeight = layoutHeight - 320;
    const measuredHeight = layoutHeight - 380;

    await composer.tap();
    await expect(composer).toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await setVisualViewport(page, firstHeight);
    await expect(root).toHaveAttribute("data-keyboard", "open");
    await expect.poll(() => appHeight(root)).toBe(firstHeight);

    await composer.evaluate((field) => field.blur());
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await setVisualViewport(page, layoutHeight);

    await composer.tap();
    await expect(composer).toBeFocused();
    await expect.poll(() => appHeight(root)).toBe(firstHeight);
    await setVisualViewport(page, measuredHeight);
    await expect.poll(() => appHeight(root)).toBe(measuredHeight);
    await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);

    await composer.evaluate((field) => field.blur());
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await setVisualViewport(page, layoutHeight);
    await composer.tap();
    await expect.poll(() => appHeight(root)).toBe(measuredHeight);
  });

  test("follows native composer focus when measured keyboard geometry arrives", async ({
    page,
  }) => {
    await installVisualViewportHook(page);
    await openChannel(page);
    const root = page.locator("#root");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const openHeight = 471;

    await composer.evaluate((field) => field.focus({ preventScroll: true }));
    await expect(composer).toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await setVisualViewport(page, openHeight);

    await expect(root).toHaveAttribute("data-keyboard", "open");
    await expect(root).toHaveAttribute("data-keyboard-owner", "true");
    await expect.poll(() => appHeight(root)).toBe(openHeight);
    await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);
  });

  test("reopens after sending the debug command and dismissing with Done", async ({
    page,
  }) => {
    await installVisualViewportHook(page);
    await openChannel(page, "&debug=keyboard");
    const root = page.locator("#root");
    const overlay = page.locator("[data-debug-overlay]");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const layoutHeight = await page.evaluate(() => innerHeight);
    const openHeight = 471;

    await touchTap(composer, 81);
    await setVisualViewport(page, openHeight);
    await expect(root).toHaveAttribute("data-keyboard", "open");
    await composer.fill("/debug keyboard");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();

    await composer.evaluate((field) => field.blur());
    await expect(composer).not.toBeFocused();
    await expect(root).toHaveAttribute("data-keyboard", "closed");
    await setVisualViewport(page, layoutHeight);

    await touchTap(composer, 82);
    await expect(composer).toBeFocused();
    await setVisualViewport(page, openHeight);

    await expect(root).toHaveAttribute("data-keyboard", "open");
    await expect.poll(() => appHeight(root)).toBe(openHeight);
    await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);
    await expect(overlay).toContainText("touchend:tap");
    await expect(overlay).not.toContainText("touchend:rejected");
  });

  test("keeps the chat fixed while the member filter owns the keyboard", async ({
    page,
  }) => {
    await installVisualViewportHook(page);
    await openChannel(page);
    const suffix = Date.now().toString(36);
    const bots = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        IrcClient.connect(
          `drawer-keyboard-${index}-${suffix}`,
          "weblounge-bot",
          "weblounge-bot-test",
          "#weblounge-test",
        ),
      ),
    );
    try {
      for (let round = 0; round < 8; round += 1)
        await Promise.all(
          bots.map((bot, index) =>
            bot.privmsgConfirmed(
              "#weblounge-test",
              `drawer keyboard row ${round * bots.length + index} ${suffix}`,
            ),
          ),
        );
      const root = page.locator("#root");
      const messages = page.locator("[data-message-list]");
      const drawer = page.getByRole("dialog", { name: "Members" });
      const filter = page.getByRole("searchbox", { name: "Filter members" });
      const layoutHeight = await page.evaluate(() => innerHeight);
      const openHeight = layoutHeight - 358;
      await messages.press("End");
      await expect(
        page.getByText(`drawer keyboard row 31 ${suffix}`, { exact: true }),
      ).toBeVisible();
      await root.evaluate((element) =>
        element.style.setProperty("--wl-safe-bottom", "34px"),
      );
      await page.getByRole("button", { name: "Show members" }).click();
      await expect(filter).toBeVisible();
      const background = await readChatBackground(page);

      await filter.tap();
      await expect(filter).toBeFocused();
      await setVisualViewport(page, openHeight);
      await expect(root).toHaveAttribute("data-keyboard", "open");
      await expect(drawer).toHaveAttribute("data-keyboard-owner", "true");
      await expect
        .poll(() =>
          root.evaluate((element) =>
            element.style.getPropertyValue("--wl-app-height"),
          ),
        )
        .toBe("");
      await expect.poll(() => drawerKeyboardGap(drawer)).toBeLessThanOrEqual(1);
      await expect(drawer.locator("aside")).toHaveCSS("padding-bottom", "0px");
      await expect
        .poll(() => fieldKeyboardOverlap(filter))
        .toBeLessThanOrEqual(0);
      await expect
        .poll(() =>
          fieldKeyboardOverlap(
            drawer.locator('[data-member-row-kind="member"]').first(),
          ),
        )
        .toBeLessThanOrEqual(0);
      expect(await readChatBackground(page)).toEqual(background);

      await filter.fill(`drawer-keyboard-0-${suffix}`);
      await expect(
        drawer.locator('[data-member-row-kind="member"]'),
      ).not.toHaveCount(0);
      expect(await readChatBackground(page)).toEqual(background);

      await filter.evaluate((field) => field.blur());
      await expect(root).toHaveAttribute("data-keyboard", "closed");
      await setVisualViewport(page, layoutHeight);
      await expect(drawer).not.toHaveAttribute("data-keyboard-owner");
      await expect(drawer.locator("aside")).toHaveCSS("padding-bottom", "34px");
      expect(await readChatBackground(page)).toEqual(background);
    } finally {
      for (const bot of bots) bot.close();
    }
  });

  test("applies cold and warm keyboard layout in one step", async ({
    page,
  }) => {
    await installVisualViewportHook(page);
    await openChannel(page);
    const suffix = Date.now().toString(36);
    const bots = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        IrcClient.connect(
          `keyboard-step-${index}-${suffix}`,
          "weblounge-bot",
          "weblounge-bot-test",
          "#weblounge-test",
        ),
      ),
    );
    try {
      for (let round = 0; round < 4; round += 1)
        await Promise.all(
          bots.map((bot, index) =>
            bot.privmsgConfirmed(
              "#weblounge-test",
              `keyboard step row ${round * bots.length + index} ${suffix}`,
            ),
          ),
        );
      const root = page.locator("#root");
      const composer = page.locator("[data-composer]");
      const messages = page.locator("[data-message-list]");
      await messages.press("End");
      await expect(
        page.getByText(`keyboard step row 39 ${suffix}`, { exact: true }),
      ).toBeVisible();
      await root.evaluate((element) => {
        element.style.setProperty("--wl-safe-bottom", "34px");
      });
      await expect(root).toHaveAttribute("data-keyboard", "closed");
      await expect(composer).toHaveCSS("padding-bottom", "34px");
      await expect.poll(() => liveEdgeGap(messages)).toBeLessThanOrEqual(2);
      const layoutHeight = await page.evaluate(() => innerHeight);
      const openHeight = layoutHeight - 358;
      const coldOpening = await sampleKeyboardTransition(
        page,
        "open",
        openHeight,
      );
      expectOneStepKeyboardLayout(coldOpening);
      await expect(root).toHaveAttribute("data-keyboard", "open");
      await expect(composer).toHaveCSS("padding-bottom", "14px");

      const coldClosing = await sampleKeyboardTransition(
        page,
        "close",
        layoutHeight,
      );
      expectOneStepKeyboardLayout(coldClosing);
      await expect(root).toHaveAttribute("data-keyboard", "closed");
      await expect(composer).toHaveCSS("padding-bottom", "34px");

      const warmOpening = await sampleKeyboardTransition(
        page,
        "open",
        openHeight,
      );
      expectOneStepKeyboardLayout(warmOpening);
      await expect(root).toHaveAttribute("data-keyboard", "open");

      const warmClosing = await sampleKeyboardTransition(
        page,
        "close",
        layoutHeight,
      );
      expectOneStepKeyboardLayout(warmClosing);
      await expect(root).toHaveAttribute("data-keyboard", "closed");
      await expect(composer).toHaveCSS("transition-duration", "0s");
    } finally {
      for (const bot of bots) bot.close();
    }
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

    test("keeps the composer on the keyboard and the header on screen while iOS pans", async ({
      page,
    }) => {
      await openChannel(page);
      const root = page.locator("#root");
      const composer = page.locator("[data-composer]");
      await page
        .getByRole("textbox", { name: "Message #weblounge-test" })
        .focus();

      await setVisualViewport(page, 476, 336);
      await expect(root).toHaveAttribute("data-keyboard", "open");
      await expect.poll(() => viewportOffsetTop(page)).toBe(0);
      await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);
      expect(await headerTop(page)).toBeGreaterThanOrEqual(0);
      expect(await documentHeight(page)).toBe(layout.height);
      await expect(composer).toHaveCSS("padding-bottom", "14px");

      await attemptDocumentScroll(page);
      await expect.poll(() => documentScroll(page)).toBe(0);
      await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);

      await setVisualViewport(page, layout.height, 0);
      await expect(root).toHaveAttribute("data-keyboard", "closed");
      await expect
        .poll(() => shellBottomError(page, layout.height))
        .toBeLessThanOrEqual(1);
    });

    test("settles on the keyboard when iOS reports it a frame late", async ({
      page,
    }) => {
      await openChannel(page);
      await page
        .getByRole("textbox", { name: "Message #weblounge-test" })
        .focus();

      await setVisualViewport(page, 476, 0, "stale");
      await expect(page.locator("#root")).toHaveAttribute(
        "data-keyboard",
        "open",
      );
      await expect.poll(() => composerKeyboardGap(page)).toBeLessThanOrEqual(1);
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
    const overlay = page.locator("[data-debug-overlay]");
    await expect(overlay).toContainText("inner: 402×874");
    await expect(overlay).toContainText("data-keyboard: closed");
    const overlayBounds = await overlay.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        contentOverflow: element.scrollWidth - element.clientWidth,
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(overlayBounds.left).toBeGreaterThanOrEqual(3);
    expect(overlayBounds.right).toBeLessThanOrEqual(
      overlayBounds.viewportWidth - 3,
    );
    expect(overlayBounds.contentOverflow).toBeLessThanOrEqual(0);
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

  test("captures a copyable keyboard frame trace after a tap", async ({
    page,
  }) => {
    await openChannel(page, "&debug=keyboard");
    const overlay = page.locator("[data-debug-overlay]");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });

    await composer.tap();

    await expect(overlay).toContainText("[keyboard]");
    await expect(overlay).toContainText("trigger: pointerup");
    await expect(overlay).toContainText("touchstart");
    await expect(overlay).toContainText(/touchend:(?:tap|rejected)/);
    await expect(overlay).toContainText("focusin:composer");
    await expect(overlay).toContainText("frames · tap to copy full trace");
    await expect(overlay).toHaveCSS("user-select", "text");
  });
});

async function openChannel(page: Page, query = "") {
  await page.goto(`/?irc-password=weblounge-test${query}`);
  await page.getByRole("button", { name: "#weblounge-test" }).click();
}

interface KeyboardFrame {
  readonly animations: number;
  readonly composerTop: number;
  readonly composerVisible: boolean;
  readonly desktopGridRows: number;
  readonly headerTop: number;
  readonly liveEdgeGap: number;
  readonly newestGap: number;
  readonly offsetTop: number;
  readonly overlappingRows: number;
  readonly rootTop: number;
  readonly scrollerTop: number;
  readonly scrollTop: number;
  readonly scrollY: number;
  readonly visibleRows: number;
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
    __suggestionTapFrames?: SuggestionTapFrame[];
  }
}

interface SuggestionTapFrame {
  readonly composerTop: number;
  readonly focused: boolean;
}

async function sampleSuggestionTap(
  page: Page,
  suggestion: Locator,
): Promise<readonly SuggestionTapFrame[]> {
  const frameCount = 16;
  await page.evaluate((count) => {
    window.__suggestionTapFrames = [];
    document.addEventListener(
      "touchstart",
      (event) => {
        if (
          !(event.target instanceof Element) ||
          event.target.closest('[role="option"]') === null
        )
          return;
        const field = document.querySelector<HTMLTextAreaElement>(
          "[data-composer] textarea",
        );
        const composer = document.querySelector<HTMLElement>("[data-composer]");
        if (field === null || composer === null)
          throw new Error("composer tap surfaces are missing");
        const sample = () => {
          window.__suggestionTapFrames?.push({
            composerTop: composer.getBoundingClientRect().top,
            focused: document.activeElement === field,
          });
        };
        let remaining = count;
        const next = () => {
          sample();
          remaining -= 1;
          if (remaining > 0) requestAnimationFrame(next);
        };
        sample();
        // wait-ok: this samples a fixed frame window for unintended keyboard motion.
        requestAnimationFrame(next);
      },
      { capture: true, once: true },
    );
  }, frameCount);

  await suggestion.tap();
  await expect
    .poll(() => page.evaluate(() => window.__suggestionTapFrames?.length ?? 0))
    .toBe(frameCount + 1);
  return page.evaluate(() => window.__suggestionTapFrames ?? []);
}

// Emulates WebKit: a visual viewport that iOS pans for the keyboard, that
// window.scrollTo(0, 0) pans back, and whose events can precede its values.
async function installVisualViewportHook(
  page: Page,
  openOnComposerFocus = false,
): Promise<void> {
  await page.addInitScript((simulateFocus) => {
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
    if (simulateFocus)
      document.addEventListener(
        "focusin",
        (event) => {
          const target = event.target;
          if (!(target instanceof HTMLTextAreaElement)) return;
          const focusWasProtected =
            target.style.transform === "translateY(-2000px)";
          geometry.height = innerHeight - 358;
          geometry.offsetTop = focusWasProtected ? 0 : 336;
          viewport.dispatchEvent(new Event("resize"));
          if (!focusWasProtected) viewport.dispatchEvent(new Event("scroll"));
        },
        true,
      );
  }, openOnComposerFocus);
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

async function appHeight(root: Locator): Promise<number> {
  return root.evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue("--wl-app-height")),
  );
}

interface ChatBackground {
  readonly composerTop: number;
  readonly firstVisibleRow: string;
  readonly scrollTop: number;
}

async function readChatBackground(page: Page): Promise<ChatBackground> {
  return page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>("[data-composer]");
    const messages = document.querySelector<HTMLElement>("[data-message-list]");
    if (composer === null || messages === null)
      throw new Error("chat background is missing");
    const listRect = messages.getBoundingClientRect();
    const firstVisible = [
      ...messages.querySelectorAll<HTMLElement>("li[data-row-key]"),
    ].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > listRect.top && rect.top < listRect.bottom;
    });
    return {
      composerTop: composer.getBoundingClientRect().top,
      firstVisibleRow: firstVisible?.dataset.rowKey ?? "",
      scrollTop: messages.scrollTop,
    };
  });
}

async function drawerKeyboardGap(drawer: Locator): Promise<number> {
  return drawer.evaluate((element) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("visual viewport is missing");
    return Math.abs(
      element.getBoundingClientRect().bottom -
        viewport.offsetTop -
        viewport.height,
    );
  });
}

async function fieldKeyboardOverlap(field: Locator): Promise<number> {
  return field.evaluate((element) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("visual viewport is missing");
    return (
      element.getBoundingClientRect().bottom -
      viewport.offsetTop -
      viewport.height
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

async function viewportOffsetTop(page: Page): Promise<number> {
  return page.evaluate(() => window.visualViewport?.offsetTop ?? -1);
}

async function composerBottom(page: Page): Promise<number> {
  return page
    .locator("[data-composer]")
    .evaluate((composer) => composer.getBoundingClientRect().bottom);
}

async function headerTop(page: Page): Promise<number> {
  return page
    .getByRole("button", { name: "Back to chats" })
    .evaluate((back) => back.getBoundingClientRect().top);
}

async function sampleKeyboardTransition(
  page: Page,
  direction: "close" | "open",
  height: number,
): Promise<readonly KeyboardFrame[]> {
  return page.evaluate(
    async ([nextDirection, nextHeight]) => {
      const root = document.querySelector<HTMLElement>("#root");
      const composer = document.querySelector<HTMLElement>("[data-composer]");
      const messages = document.querySelector<HTMLElement>(
        "[data-message-list]",
      );
      const scrollerFrame = messages?.parentElement?.parentElement;
      const header = composer
        ?.closest("[data-mobile-chat]")
        ?.querySelector<HTMLElement>("header");
      const field = composer?.querySelector("textarea");
      const viewport = window.visualViewport;
      const setViewport = window.__setVisualViewport;
      if (
        root === null ||
        composer === null ||
        messages === null ||
        scrollerFrame === null ||
        scrollerFrame === undefined ||
        header === null ||
        header === undefined ||
        field === null ||
        viewport === null ||
        setViewport === undefined
      )
        throw new Error("keyboard test surfaces are missing");
      const frames: KeyboardFrame[] = [];
      const sample = () => {
        const composerRect = composer.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        let scrollerTop = 0;
        for (
          let element: HTMLElement | null = scrollerFrame;
          element !== null && element !== root;
          element = element.offsetParent as HTMLElement | null
        )
          scrollerTop += element.offsetTop;
        const rows = [
          ...messages.querySelectorAll<HTMLElement>("li[data-index]"),
        ];
        const rowRects = rows.map((row) => row.getBoundingClientRect());
        const newest = rowRects.at(-1);
        frames.push({
          animations: composer.getAnimations({ subtree: true }).length,
          composerTop: composerRect.top,
          composerVisible:
            composerRect.bottom > headerRect.bottom &&
            composerRect.top < viewport.offsetTop + viewport.height,
          desktopGridRows: rows.filter((row) => {
            const content = row.firstElementChild;
            return (
              content instanceof HTMLElement &&
              getComputedStyle(content).display === "grid"
            );
          }).length,
          headerTop: headerRect.top,
          liveEdgeGap: Math.max(
            0,
            messages.scrollHeight - messages.clientHeight - messages.scrollTop,
          ),
          newestGap:
            newest === undefined
              ? Number.POSITIVE_INFINITY
              : composerRect.top - newest.bottom,
          offsetTop: viewport.offsetTop,
          overlappingRows: rowRects.filter(
            (row, index) =>
              index > 0 &&
              row.top < (rowRects[index - 1]?.bottom ?? row.top) - 0.5,
          ).length,
          rootTop: root.getBoundingClientRect().top,
          scrollerTop,
          scrollTop: messages.scrollTop,
          scrollY: window.scrollY,
          visibleRows: rowRects.filter(
            (row) =>
              row.bottom > headerRect.bottom && row.top < composerRect.top,
          ).length,
        });
      };
      sample();
      if (nextDirection === "open") {
        field.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerType: "touch",
          }),
        );
        field.focus({ preventScroll: true });
        setViewport(nextHeight);
      } else {
        field.blur();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setViewport(nextHeight)),
        );
      }
      // wait-ok: this deliberately samples a fixed frame window for intermediate keyboard layout.
      for (let frame = 0; frame < 10; frame += 1)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        ).then(sample);
      return frames;
    },
    [direction, height] as const,
  );
}

async function liveEdgeGap(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((messages) =>
    Math.max(
      0,
      messages.scrollHeight - messages.clientHeight - messages.scrollTop,
    ),
  );
}

interface AppPositionFrame {
  readonly appTop: number;
  readonly offsetTop: number;
  readonly scrollY: number;
}

async function sampleAppPosition(
  page: Page,
  frameCount: number,
): Promise<readonly AppPositionFrame[]> {
  return page.evaluate(async (count) => {
    const root = document.querySelector<HTMLElement>("#root");
    if (root === null) throw new Error("app root is missing");
    const frames: AppPositionFrame[] = [];
    // wait-ok: this deliberately samples a fixed frame window for transient pan.
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      frames.push({
        appTop: Math.round(root.getBoundingClientRect().top),
        offsetTop: Math.round(window.visualViewport?.offsetTop ?? -1),
        scrollY: Math.round(window.scrollY),
      });
    }
    return frames;
  }, frameCount);
}

async function touchMove(
  target: ReturnType<Page["locator"]>,
  startY: number,
  endY: number,
  options: {
    readonly duration?: number;
    readonly endX?: number;
    readonly startX?: number;
  } = {},
): Promise<{ readonly endAllowed: boolean; readonly moveAllowed: boolean }> {
  return target.evaluate(
    (element, gesture) => {
      const event = (
        type: string,
        clientX: number,
        clientY: number,
        timeStamp: number,
      ) => {
        const touch = {
          clientX,
          clientY,
          identifier: 71,
        };
        const touchEvent = new Event(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperties(touchEvent, {
          changedTouches: { value: [touch] },
          targetTouches: { value: type === "touchend" ? [] : [touch] },
          timeStamp: { value: timeStamp },
          touches: { value: type === "touchend" ? [] : [touch] },
        });
        return element.dispatchEvent(touchEvent);
      };
      event("touchstart", gesture.startX, gesture.startY, 100);
      const moveAllowed = event(
        "touchmove",
        gesture.endX,
        gesture.endY,
        100 + gesture.duration / 2,
      );
      const endAllowed = event(
        "touchend",
        gesture.endX,
        gesture.endY,
        100 + gesture.duration,
      );
      return { endAllowed, moveAllowed };
    },
    {
      duration: options.duration ?? 100,
      endX: options.endX ?? 200,
      endY,
      startX: options.startX ?? 200,
      startY,
    },
  );
}

async function touchTap(
  target: ReturnType<Page["locator"]>,
  identifier: number,
): Promise<void> {
  await target.evaluate((element, touchIdentifier) => {
    const touch = Object.create(
      Object.defineProperties(
        {},
        {
          clientX: { get: () => 20 },
          clientY: { get: () => 40 },
          identifier: { get: () => touchIdentifier },
        },
      ),
    );
    const dispatch = (type: "touchend" | "touchstart", timeStamp: number) => {
      const event = new Event(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      Object.defineProperties(event, {
        changedTouches: { value: [touch] },
        timeStamp: { value: timeStamp },
        touches: { value: type === "touchend" ? [] : [touch] },
      });
      element.dispatchEvent(event);
    };
    dispatch("touchstart", 100);
    dispatch("touchend", 150);
  }, identifier);
}

async function makeTranscriptScrollable(
  messages: ReturnType<Page["locator"]>,
): Promise<void> {
  await messages.evaluate((element) => {
    const fixture = document.createElement("li");
    fixture.dataset.touchScrollFixture = "true";
    fixture.style.height = "2000px";
    element.append(fixture);
    element.scrollTop = 100;
  });
}

function expectOneStepKeyboardLayout(frames: readonly KeyboardFrame[]): void {
  expect(frames).toHaveLength(11);
  const start = frames[0]?.composerTop ?? 0;
  const end = frames.at(-1)?.composerTop ?? 0;
  expect(Math.abs(end - start)).toBeGreaterThan(100);
  const positions = new Set(
    frames.map(({ composerTop }) => Math.round(composerTop * 2) / 2),
  );
  expect([...positions], JSON.stringify(frames)).toHaveLength(2);
  const headerTop = frames[0]?.headerTop ?? 0;
  const scrollerTop = frames[0]?.scrollerTop ?? 0;
  expect(
    frames.every(
      (frame) =>
        frame.composerTop >= Math.min(start, end) - 0.5 &&
        frame.composerTop <= Math.max(start, end) + 0.5 &&
        frame.visibleRows > 0 &&
        frame.animations === 0 &&
        frame.desktopGridRows === 0 &&
        frame.overlappingRows === 0 &&
        Math.abs(frame.headerTop - headerTop) <= 0.5 &&
        Math.abs(frame.scrollerTop - scrollerTop) <= 0.5 &&
        Math.abs(frame.rootTop) <= 0.5 &&
        Math.abs(frame.offsetTop) <= 0.5 &&
        Math.abs(frame.scrollY) <= 0.5,
    ),
    JSON.stringify(frames),
  ).toBe(true);
  expect(frames.at(-1)?.composerVisible).toBe(true);
  expect(
    frames.every(({ newestGap }) => Math.abs(newestGap) <= 8),
    JSON.stringify(frames),
  ).toBe(true);
  expect(frames[0]?.liveEdgeGap).toBeLessThanOrEqual(2);
  expect(frames.at(-1)?.liveEdgeGap).toBeLessThanOrEqual(2);
}
