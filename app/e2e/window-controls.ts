import { expect, type Locator, type Page } from "@playwright/test";
import { emulateMacApp } from "./sidebar-rows";

export interface WindowCall {
  readonly command: string;
  readonly value: unknown;
}

interface FakeWindowState {
  __fakeFullScreen: boolean;
  __windowCalls: WindowCall[];
  __heldFullScreenAnswers: (() => void)[] | undefined;
}

interface FakeWindowOptions {
  readonly fullScreen?: boolean;
  readonly holdFullScreenAnswers?: boolean;
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
  { fullScreen = false, holdFullScreenAnswers = false }: FakeWindowOptions = {},
): Promise<void> {
  await emulateMacApp(page, { windowControls });
  await page.addInitScript(
    ({ launchFullScreen, hold }) => {
      const state = window as unknown as FakeWindowState;
      state.__fakeFullScreen = launchFullScreen;
      state.__windowCalls = [];
      state.__heldFullScreenAnswers = hold ? [] : undefined;
      const answerFullScreen = () =>
        new Promise<boolean>((resolve) => {
          const answer = () => resolve(state.__fakeFullScreen);
          if (state.__heldFullScreenAnswers === undefined) answer();
          else state.__heldFullScreenAnswers.push(answer);
        });
      Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
        value: Object.freeze({
          invoke: (command: string, args?: { value?: unknown }) => {
            state.__windowCalls.push({ command, value: args?.value });
            return command === "plugin:window|is_fullscreen"
              ? answerFullScreen()
              : Promise.resolve(null);
          },
        }),
      });
    },
    { launchFullScreen: fullScreen, hold: holdFullScreenAnswers },
  );
}

export async function releaseFullScreenAnswers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as FakeWindowState;
    const held = state.__heldFullScreenAnswers ?? [];
    state.__heldFullScreenAnswers = undefined;
    for (const answer of held) answer();
  });
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

export async function expectClearOfWindowControls(
  locator: Locator,
): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((element, band) => {
        const box = element.getBoundingClientRect();
        return box.left < band.inlineStart && box.top < band.blockSize;
      }, windowControls),
    )
    .toBe(false);
}
