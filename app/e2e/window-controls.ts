import type { Page } from "@playwright/test";
import { emulateMacApp } from "./sidebar-rows";

export interface WindowCall {
  readonly command: string;
  readonly value: unknown;
}

interface FakeWindowState {
  __fakeFullScreen: boolean;
  __windowCalls: WindowCall[];
}

export const windowControls = { inlineStart: 84, blockSize: 48 } as const;

/**
 * Stands in for the macOS wrapper with a seamless title bar: the identity
 * global reserves the traffic lights' band, and a `__TAURI_INTERNALS__.invoke`
 * answers the window commands the page sends. It doubles as the contract the
 * wrapper must implement.
 */
export async function emulateSeamlessMacApp(
  page: Page,
  { fullScreen = false }: { readonly fullScreen?: boolean } = {},
): Promise<void> {
  await emulateMacApp(page, { windowControls });
  await page.addInitScript((launchFullScreen) => {
    const state = window as unknown as FakeWindowState;
    state.__fakeFullScreen = launchFullScreen;
    state.__windowCalls = [];
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
      value: Object.freeze({
        invoke: (command: string, args?: { value?: unknown }) => {
          state.__windowCalls.push({ command, value: args?.value });
          return Promise.resolve(
            command === "plugin:window|is_fullscreen"
              ? state.__fakeFullScreen
              : null,
          );
        },
      }),
    });
  }, fullScreen);
}

export async function setFakeFullScreen(
  page: Page,
  fullScreen: boolean,
): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as FakeWindowState).__fakeFullScreen = next;
    window.dispatchEvent(new Event("resize"));
  }, fullScreen);
}

export function windowCalls(page: Page): Promise<readonly WindowCall[]> {
  return page.evaluate(
    () => (window as unknown as FakeWindowState).__windowCalls,
  );
}
