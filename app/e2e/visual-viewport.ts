import type { Locator, Page } from "@playwright/test";

type ViewportTiming = "live" | "silent" | "stale";
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
export async function installVisualViewportHook(
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
      if (timing === "silent") {
        apply();
        return;
      }
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

export async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop = 0,
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

export async function fieldKeyboardOverlap(field: Locator): Promise<number> {
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
