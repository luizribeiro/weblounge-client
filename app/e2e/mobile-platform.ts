import type { Page } from "@playwright/test";

export async function emulateStandalone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== "(display-mode: standalone)") {
        return nativeMatchMedia(query);
      }
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        addListener() {},
        dispatchEvent: () => true,
        removeEventListener() {},
        removeListener() {},
      };
    };
  });
}

export interface SafeAreaInsets {
  readonly top?: number;
  readonly bottom?: number;
}

/** Stands in for a notched phone's env(safe-area-inset-*), which desktop browsers report as 0. */
export async function emulateSafeArea(
  page: Page,
  insets: SafeAreaInsets,
): Promise<void> {
  await page.addInitScript(({ top, bottom }) => {
    const sheet = new CSSStyleSheet();
    const declarations = Object.entries({ top, bottom })
      .filter(([, inset]) => inset !== undefined)
      .map(([edge, inset]) => `--wl-safe-${edge}: ${inset}px !important;`);
    sheet.replaceSync(`:root { ${declarations.join(" ")} }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, insets);
}

export function isPhoneViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1_280) < 700;
}
