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

  test("keeps keyboard focus and touch drags from panning the app", async ({
    page,
  }) => {
    await installVisualViewportHook(page, true);
    await openChannel(page);
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const root = page.locator("#root");

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

  test("moves the composer and transcript monotonically with the keyboard", async ({
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
    const opening = await sampleKeyboardTransition(
      page,
      "open",
      layoutHeight - 358,
    );
    expectKeyboardMotion(opening, "up");
    await expect(root).toHaveAttribute("data-keyboard", "open");
    await expect(composer).toHaveCSS("padding-bottom", "14px");

    const closing = await sampleKeyboardTransition(page, "close", layoutHeight);
    expectKeyboardMotion(closing, "down");
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
    await expect(overlay).toContainText("trace: ms sy vo vh ih rt rh ct");
  });
});

async function openChannel(page: Page, query = "") {
  await page.goto(`/?irc-password=weblounge-test${query}`);
  await page.getByRole("button", { name: "#weblounge-test" }).click();
}

interface KeyboardFrame {
  readonly adjacency: number;
  readonly composerTop: number;
  readonly liveEdgeGap: number;
  readonly offsetTop: number;
  readonly rootTop: number;
  readonly scrollY: number;
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
      const surface = document.querySelector<HTMLElement>(
        "[data-keyboard-motion]",
      );
      const composer = document.querySelector<HTMLElement>("[data-composer]");
      const messages = document.querySelector<HTMLElement>(
        "[data-message-list]",
      );
      const field = composer?.querySelector("textarea");
      const viewport = window.visualViewport;
      const setViewport = window.__setVisualViewport;
      if (
        root === null ||
        surface === null ||
        composer === null ||
        messages === null ||
        field === null ||
        viewport === null ||
        setViewport === undefined
      )
        throw new Error("keyboard test surfaces are missing");
      const frames: KeyboardFrame[] = [];
      let sawAnimation = false;
      let suppliedClosedGeometry = false;
      const sample = () => {
        const composerRect = composer.getBoundingClientRect();
        frames.push({
          adjacency: Math.abs(
            messages.getBoundingClientRect().bottom - composerRect.top,
          ),
          composerTop: composerRect.top,
          liveEdgeGap: Math.max(
            0,
            messages.scrollHeight - messages.clientHeight - messages.scrollTop,
          ),
          offsetTop: viewport.offsetTop,
          rootTop: root.getBoundingClientRect().top,
          scrollY: window.scrollY,
        });
      };
      sample();
      if (nextDirection === "open") setViewport(nextHeight);
      else field.blur();
      await new Promise<void>((resolve) => {
        const next = () => {
          sample();
          const animations = surface.getAnimations({ subtree: true });
          if (animations.length > 0) sawAnimation = true;
          if (
            nextDirection === "close" &&
            sawAnimation &&
            !suppliedClosedGeometry &&
            animations.length > 0 &&
            animations.every((animation) => animation.playState === "finished")
          ) {
            suppliedClosedGeometry = true;
            setViewport(nextHeight);
          }
          if (
            sawAnimation &&
            animations.length === 0 &&
            (nextDirection === "open" || suppliedClosedGeometry)
          ) {
            resolve();
            return;
          }
          requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      });
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

function expectKeyboardMotion(
  frames: readonly KeyboardFrame[],
  direction: "down" | "up",
): void {
  expect(frames.length).toBeGreaterThan(2);
  const start = frames[0]?.composerTop ?? 0;
  const end = frames.at(-1)?.composerTop ?? 0;
  expect(Math.abs(end - start)).toBeGreaterThan(100);
  expect(
    frames.every((frame, index) => {
      const previous = frames[index - 1]?.composerTop;
      if (previous === undefined) return true;
      return direction === "up"
        ? frame.composerTop <= previous + 0.5
        : frame.composerTop + 0.5 >= previous;
    }),
    JSON.stringify(frames.map(({ composerTop }) => composerTop)),
  ).toBe(true);
  expect(
    frames.every(
      (frame) =>
        frame.composerTop >= Math.min(start, end) - 0.5 &&
        frame.composerTop <= Math.max(start, end) + 0.5 &&
        frame.adjacency <= 1 &&
        frame.liveEdgeGap <= 2 &&
        Math.abs(frame.rootTop) <= 0.5 &&
        Math.abs(frame.offsetTop) <= 0.5 &&
        Math.abs(frame.scrollY) <= 0.5,
    ),
    JSON.stringify(frames),
  ).toBe(true);
}
