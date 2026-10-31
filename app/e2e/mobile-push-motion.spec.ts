import { expect, type Page, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";

test.beforeEach(async ({ browserName, page }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(browserName !== "webkit", "requires WebKit touch events");
  await emulateStandalone(page);
});

test("push slides the chat over a still chats list", async ({ page }) => {
  await openShell(page);
  const frames = await recordMotion(page, () =>
    page.getByRole("button", { name: "#weblounge-test" }).click(),
  );
  const moving = present(frames);

  expectListStill(frames);
  expect(monotonic(moving.map(left), "down")).toBe(true);
  expect(intermediate(moving, page)).toBeGreaterThanOrEqual(10);
  expectShadowWhileMoving(moving);
  expect(moving.at(-1)?.chatLeft).toBe(0);
});

test("tap Back slides the chat off a still chats list", async ({ page }) => {
  await openShell(page);
  await openChat(page);
  const frames = await recordMotion(page, () =>
    page.getByRole("button", { name: "Back to chats" }).tap(),
  );
  const moving = present(frames);

  expectListStill(frames);
  expect(monotonic(moving.map(left), "up")).toBe(true);
  expect(intermediate(moving, page)).toBeGreaterThanOrEqual(10);
  expectShadowWhileMoving(moving);
  expect(moving.at(-1)?.chatLeft).toBeGreaterThanOrEqual(viewport(page) - 0.5);
  expect(frames.at(-1)?.chatLeft).toBeNull();
});

test("reduced motion pushes and pops instantly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page);
  const pushed = await recordMotion(page, () =>
    page.getByRole("button", { name: "#weblounge-test" }).click(),
  );
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
  expect(present(pushed).length).toBeGreaterThan(0);
  expect(pushed.every((frame) => frame.motion === null)).toBe(true);
  expect(intermediate(present(pushed), page)).toBe(0);

  const popped = await recordMotion(page, () =>
    page.getByRole("button", { name: "Back to chats" }).tap(),
  );
  expect(present(popped).length).toBeGreaterThan(0);
  expect(popped.every((frame) => frame.motion === null)).toBe(true);
  expect(intermediate(present(popped), page)).toBe(0);
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
});

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Frame {
  readonly chatLeft: number | null;
  readonly list: Rect | null;
  readonly listOpacity: string | null;
  readonly listVisible: boolean;
  readonly motion: string | null;
  readonly shadow: string | null;
  readonly shadowOpacity: number;
}

async function openShell(page: Page): Promise<void> {
  await page.goto("/?irc-password=weblounge-test");
  await expect(
    page.getByRole("button", { name: "#weblounge-test" }),
  ).toBeVisible();
}

async function openChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
  await expect(page.locator("[data-motion]")).toHaveCount(0);
}

async function recordMotion(
  page: Page,
  act: () => Promise<void>,
): Promise<readonly Frame[]> {
  await page.evaluate(() => {
    const recording = { done: false, frames: [] as Frame[] };
    (
      window as Window & { motionRecording?: typeof recording }
    ).motionRecording = recording;
    let seenMotion = false;
    const sample = () => {
      const chat =
        document.querySelector<HTMLElement>(
          "[data-mobile-chat]",
        )?.parentElement;
      const list = document.querySelector<HTMLElement>("[data-mobile-chats]");
      const rect = list?.getBoundingClientRect();
      const motion = chat?.dataset.motion ?? null;
      const shadow =
        chat === undefined ? null : getComputedStyle(chat, "::before");
      recording.frames.push({
        chatLeft: chat?.getBoundingClientRect().left ?? null,
        list:
          rect === undefined
            ? null
            : {
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
              },
        listOpacity:
          list?.parentElement === null || list === null
            ? null
            : getComputedStyle(list.parentElement).opacity,
        listVisible:
          list?.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          }) ?? false,
        motion,
        shadow: shadow?.content === "none" ? null : (shadow?.boxShadow ?? null),
        shadowOpacity: Number(shadow?.opacity ?? 0),
      });
      seenMotion ||= motion !== null;
      const settled =
        document.querySelector("[data-motion]") === null &&
        (seenMotion || recording.frames.length >= 20);
      if (settled) recording.done = true;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await act();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { motionRecording?: { done: boolean } })
            .motionRecording?.done ?? false,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (window as Window & { motionRecording?: { frames: Frame[] } })
        .motionRecording?.frames ?? [],
  );
}

function present(frames: readonly Frame[]): readonly Frame[] {
  return frames.filter((frame) => frame.chatLeft !== null);
}

function left(frame: Frame): number {
  return frame.chatLeft ?? 0;
}

function viewport(page: Page): number {
  return page.viewportSize()?.width ?? 0;
}

function intermediate(frames: readonly Frame[], page: Page): number {
  return new Set(
    frames
      .map(left)
      .filter((value) => value > 0.5 && value < viewport(page) - 0.5)
      .map((value) => value.toFixed(1)),
  ).size;
}

function expectListStill(frames: readonly Frame[]): void {
  const first = frames[0]?.list;
  expect(first).not.toBeNull();
  for (const frame of frames) {
    expect(frame.list).toEqual(first);
    expect(frame.listOpacity).toBe("1");
  }
  for (const frame of frames.filter((frame) => frame.motion !== null))
    expect(frame.listVisible).toBe(true);
}

function expectShadowWhileMoving(frames: readonly Frame[]): void {
  const moving = frames.filter((frame) => frame.chatLeft !== 0);
  expect(moving.length).toBeGreaterThan(0);
  for (const frame of moving) {
    expect(frame.motion).not.toBeNull();
    expect(frame.shadow).not.toBeNull();
    expect(frame.shadow).not.toBe("none");
  }
  expect(moving.some((frame) => frame.shadowOpacity > 0.2)).toBe(true);
}

function monotonic(values: readonly number[], direction: "up" | "down") {
  return values.every((value, index) => {
    const previous = values[index - 1];
    if (previous === undefined) return true;
    return direction === "up"
      ? value + 0.01 >= previous
      : value - 0.01 <= previous;
  });
}
