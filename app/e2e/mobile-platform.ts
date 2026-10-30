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
