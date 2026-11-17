import type { BrowserContext, Page } from "@playwright/test";
import { isChromium } from "./touch";

/**
 * Playwright can grant reading Chromium's clipboard; WebKit's stays write-only to tests, so there
 * the test records what the app hands the clipboard instead.
 */
export async function prepareClipboard(context: BrowserContext): Promise<void> {
  if (isChromium(context)) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    return;
  }
  await context.addInitScript(() => {
    const clipboard = navigator.clipboard;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text: string) => {
      (window as Window & { __copiedText?: string }).__copiedText = text;
      return write(text);
    };
  });
}

export async function copiedText(page: Page): Promise<string | undefined> {
  return isChromium(page.context())
    ? page.evaluate(() => navigator.clipboard.readText())
    : page.evaluate(
        () => (window as Window & { __copiedText?: string }).__copiedText,
      );
}
