import type { Page } from "@playwright/test";

export async function dispatchPersistedPageShow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
  });
}

/** Needs `installNativeFeelInstrumentation`, which makes `document.hidden` controllable. */
export async function setPageHidden(
  page: Page,
  hidden: boolean,
): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("visibility control is missing");
    setter(nextHidden);
  }, hidden);
}

export async function installFocusControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let focused = true;
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => focused,
    });
    Reflect.set(globalThis, "__setPageFocused", (next: boolean) => {
      focused = next;
      window.dispatchEvent(new Event(next ? "focus" : "blur"));
    });
  });
}

/** Needs `installFocusControl`; resolves to the page time at which focus changed. */
export async function setPageFocused(
  page: Page,
  focused: boolean,
): Promise<number> {
  return page.evaluate((next) => {
    const setter = Reflect.get(globalThis, "__setPageFocused");
    if (typeof setter !== "function")
      throw new Error("focus control is missing");
    const at = performance.timeOrigin + performance.now();
    setter(next);
    return at;
  }, focused);
}
