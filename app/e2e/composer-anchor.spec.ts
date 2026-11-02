import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  distanceFromBottom,
  scrollAwayFromLiveEdge,
} from "./message-list-scroll";

interface AnchorFrame {
  readonly bottom: number;
  readonly top: number;
}

interface AnchorRecording {
  done: boolean;
  error?: string;
  readonly frames: AnchorFrame[];
}

declare global {
  interface Window {
    __composerAnchorRecording?: AnchorRecording;
  }
}

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const shell of [
  { name: "desktop", touch: false },
  { name: "mobile", touch: true },
] as const) {
  test(`keeps ${shell.name} transcript rows fixed while the composer resizes`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      hasTouch: shell.touch,
      isMobile: shell.touch,
      viewport: shell.touch
        ? { width: 402, height: 874 }
        : { width: 1_200, height: 800 },
    });
    const page = await context.newPage();
    const suffix = `${shell.name}-${Date.now().toString(36)}`;
    const bot = await IrcClient.connect(
      `anchor-${shell.name}`,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      for (let index = 0; index < 10; index += 1)
        bot.privmsg(
          "#weblounge-test",
          `composer anchor ${suffix} ${index} ${"wrapped transcript text ".repeat(14)}`,
        );
      const lastSeed = `composer anchor last ${suffix}`;
      await bot.privmsgConfirmed("#weblounge-test", lastSeed);

      await page.goto("/?irc-password=weblounge-test");
      if (shell.touch)
        await page.getByRole("button", { name: "#weblounge-test" }).click();
      await expect(page.getByText(lastSeed, { exact: true })).toBeVisible();

      const list = page.locator("[data-message-list]");
      const composer = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });
      await list.press("End");
      await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(2);
      await composer.fill("first line");

      await expectAnchorFixed(page, composer, "last", () =>
        composer.press("Shift+Enter"),
      );
      await expectAnchorFixed(page, composer, "last", () =>
        composer.press("Shift+Enter"),
      );
      await expectAnchorFixed(page, composer, "last", () =>
        composer.press("Backspace"),
      );
      await expectAnchorFixed(page, composer, "last", () =>
        composer.press("Backspace"),
      );

      await scrollAwayFromLiveEdge(page, list, {
        input: shell.touch ? "touch" : "wheel",
      });
      await expect.poll(() => distanceFromBottom(list)).toBeGreaterThan(100);
      await expectAnchorFixed(page, composer, "visible", () =>
        composer.press("Shift+Enter"),
      );
      await composer.type("second line");
      await expectAnchorFixed(page, composer, "visible", () =>
        composer.press("Enter"),
      );
      await expect(composer).toHaveValue("");
    } finally {
      bot.close();
      await context.close();
    }
  });
}

async function expectAnchorFixed(
  page: Page,
  composer: Locator,
  anchor: "last" | "visible",
  action: () => Promise<void>,
): Promise<void> {
  await startAnchorRecording(page, anchor);
  await action();
  const frames = await finishAnchorRecording(page);
  expect(frames.length).toBeGreaterThan(1);
  expect(new Set(frames.map(({ top }) => top))).toEqual(
    new Set([frames[0]?.top]),
  );
  expect(new Set(frames.map(({ bottom }) => bottom))).toEqual(
    new Set([frames[0]?.bottom]),
  );
  await expect(composer).toBeFocused();
}

async function startAnchorRecording(
  page: Page,
  anchor: "last" | "visible",
): Promise<void> {
  await page.evaluate((anchorKind) => {
    const list = document.querySelector<HTMLElement>("[data-message-list]");
    if (list === null) throw new Error("message list is missing");
    const rows = [...list.querySelectorAll<HTMLElement>("[data-message-row]")];
    const listTop = list.getBoundingClientRect().top;
    const message =
      anchorKind === "last"
        ? rows.at(-1)
        : rows.find(
            (candidate) => candidate.getBoundingClientRect().bottom > listTop,
          );
    const row = message?.closest<HTMLElement>("li[data-row-key]");
    const rowKey = row?.dataset.rowKey;
    if (rowKey === undefined) throw new Error("transcript anchor is missing");
    const recording: AnchorRecording = { done: false, frames: [] };
    window.__composerAnchorRecording = recording;
    const sample = () => {
      const current = [
        ...list.querySelectorAll<HTMLElement>("li[data-row-key]"),
      ].find((candidate) => candidate.dataset.rowKey === rowKey);
      if (current === undefined) {
        recording.error = `transcript anchor ${rowKey} left the viewport`;
        recording.done = true;
        return;
      }
      const anchoredMessage =
        current.querySelector<HTMLElement>("[data-message-row]");
      if (anchoredMessage === null) {
        recording.error = `transcript anchor ${rowKey} lost its message`;
        recording.done = true;
        return;
      }
      const rect = anchoredMessage.getBoundingClientRect();
      recording.frames.push({
        bottom: rect.bottom,
        top: rect.top,
      });
      if (!recording.done) requestAnimationFrame(sample);
    };
    sample();
  }, anchor);
}

async function finishAnchorRecording(page: Page): Promise<AnchorFrame[]> {
  return page.evaluate(
    () =>
      new Promise<AnchorFrame[]>((resolve, reject) => {
        const recording = window.__composerAnchorRecording;
        if (recording === undefined)
          throw new Error("composer anchor recorder is missing");
        let remaining = 4;
        const finish = () => {
          remaining -= 1;
          if (remaining > 0) {
            requestAnimationFrame(finish);
            return;
          }
          recording.done = true;
          if (recording.error === undefined) resolve(recording.frames);
          else reject(new Error(recording.error));
        };
        // wait-ok: this samples a fixed frame window for intermediate resize motion.
        requestAnimationFrame(finish);
      }),
  );
}
