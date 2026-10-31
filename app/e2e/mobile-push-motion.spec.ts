import { expect, type Page, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";
import {
  durationMs,
  expectNoTransformOrTransition,
  expectStepsFollowCurve,
  expectTransitionMatches,
  hasIntermediatePosition,
  normalizedCurve,
  type TransitionStyle,
} from "./motion-assertions";

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
  expect(hasIntermediatePosition(moving.map(left), viewport(page), 0)).toBe(
    true,
  );
  expectPushTransition(moving, "pushInDuration", "pushCurve");
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
  expect(hasIntermediatePosition(moving.map(left), 0, viewport(page))).toBe(
    true,
  );
  expectPushTransition(moving, "pushOutDuration", "pushCurve");
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
  expect(
    hasIntermediatePosition(present(pushed).map(left), viewport(page), 0),
  ).toBe(false);

  const popped = await recordMotion(page, () =>
    page.getByRole("button", { name: "Back to chats" }).tap(),
  );
  expect(present(popped).length).toBeGreaterThan(0);
  expect(popped.every((frame) => frame.motion === null)).toBe(true);
  expect(
    hasIntermediatePosition(present(popped).map(left), 0, viewport(page)),
  ).toBe(false);
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
});

test("swipe released past halfway continues closed from the finger", async ({
  page,
}) => {
  await openShell(page);
  await openChat(page);
  const settle = await swipeAndRelease(page, [
    { at: 0, x: 5 },
    { at: 500, x: 150 },
    { at: 900, x: 250 },
    { at: 1_000, x: 262 },
  ]);

  expectSettlesFromFinger(settle, viewport(page));
  expect(settle.frames.at(-1)?.chatLeft).toBeNull();
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
});

test("a flick completes sooner than a slow release, still animated", async ({
  page,
}) => {
  await openShell(page);
  await openChat(page);
  const slow = await swipeAndRelease(page, [
    { at: 0, x: 5 },
    { at: 900, x: 250 },
    { at: 1_000, x: 262 },
  ]);
  await openChat(page);
  const flick = await swipeAndRelease(page, [
    { at: 0, x: 5 },
    { at: 50, x: 60 },
    { at: 100, x: 160 },
  ]);

  expectSettlesFromFinger(flick, viewport(page));
  expect(settleDuration(flick, viewport(page))).toBeLessThan(
    settleDuration(slow, viewport(page)),
  );
});

test("swipe released short springs back open from the finger", async ({
  page,
}) => {
  await openShell(page);
  await openChat(page);
  const settle = await swipeAndRelease(page, [
    { at: 0, x: 5 },
    { at: 800, x: 150 },
    { at: 1_000, x: 160 },
  ]);

  expectSettlesFromFinger(settle, 0);
  expect(settle.frames.at(-1)?.chatLeft).toBe(0);
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
});

interface PanStep {
  readonly at: number;
  readonly x: number;
}

interface PanDispatch {
  readonly base: number | null;
  readonly release: boolean;
  readonly steps: readonly PanStep[];
}

interface PanResult {
  readonly base: number;
  readonly chatLeft: number | null;
  readonly now: number;
}

interface Settle {
  readonly releaseLeft: number;
  readonly releasedAt: number;
  readonly frames: readonly Frame[];
}

function dispatchPan({ base, release, steps }: PanDispatch): PanResult {
  const shell = document.querySelector("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");
  const start = base ?? performance.now();
  steps.forEach((step, index) => {
    const type = release
      ? "pointerup"
      : index === 0
        ? "pointerdown"
        : "pointermove";
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: step.x,
      clientY: 300,
      pointerId: 31,
      pointerType: "touch",
    });
    Object.defineProperty(event, "timeStamp", { value: start + step.at });
    shell.dispatchEvent(event);
  });
  const chat = document.querySelector("[data-mobile-chat]")?.parentElement;
  return {
    base: start,
    chatLeft: chat?.getBoundingClientRect().left ?? null,
    now: performance.now(),
  };
}

async function swipeAndRelease(
  page: Page,
  steps: readonly PanStep[],
): Promise<Settle> {
  const last = steps.at(-1);
  if (last === undefined) throw new Error("a swipe needs steps");
  const drag = await page.evaluate(dispatchPan, {
    base: null,
    release: false,
    steps,
  });
  let releasedAt = 0;
  const frames = await recordMotion(page, async () => {
    const release = await page.evaluate(dispatchPan, {
      base: drag.base,
      release: true,
      steps: [last],
    });
    releasedAt = release.now;
  });
  const released = frames.findIndex((frame) => frame.motion !== "dragging");
  expect(released).toBeGreaterThanOrEqual(0);
  return {
    frames: frames.slice(released),
    releaseLeft: drag.chatLeft ?? Number.NaN,
    releasedAt,
  };
}

function expectSettlesFromFinger(settle: Settle, restingLeft: number): void {
  const { releaseLeft } = settle;
  const moving = present(settle.frames);
  const path = [releaseLeft, ...moving.map(left)];
  const transitionFrame = moving.find((frame) => frame.motion !== null);
  if (transitionFrame === undefined)
    throw new Error("released swipe did not transition");

  expect(releaseLeft).toBeGreaterThan(20);
  expectListStill(settle.frames);
  expect(monotonic(path, restingLeft > releaseLeft ? "up" : "down")).toBe(true);
  expect(
    hasIntermediatePosition(moving.map(left), releaseLeft, restingLeft),
  ).toBe(true);
  expectReleasedTransition(moving);
  expectStepsFollowCurve(
    moving.map((frame) => ({ position: left(frame), time: frame.time })),
    { position: releaseLeft, time: settle.releasedAt },
    restingLeft,
    transitionFrame.transition,
  );
  const final = moving.at(-1)?.chatLeft ?? Number.NaN;
  expect(Math.abs(final - restingLeft)).toBeLessThan(1.5);
  expectShadowWhileMoving(moving);
}

function settleDuration(settle: Settle, restingLeft: number): number {
  const arrived = settle.frames.find(
    (frame) =>
      frame.chatLeft === null || Math.abs(frame.chatLeft - restingLeft) < 1.5,
  );
  return (arrived?.time ?? Number.POSITIVE_INFINITY) - settle.releasedAt;
}

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
  readonly listStyle: {
    readonly transform: string;
    readonly transitionDuration: string;
  } | null;
  readonly motion: string | null;
  readonly shadow: string | null;
  readonly shadowOpacity: number;
  readonly time: number;
  readonly tokens: {
    readonly pushCurve: string;
    readonly pushInDuration: string;
    readonly pushOutDuration: string;
    readonly settleCurve: string;
  };
  readonly transition: TransitionStyle;
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
      const chatStyle = chat === undefined ? null : getComputedStyle(chat);
      const listStyle = list === null ? null : getComputedStyle(list);
      const rootStyle = getComputedStyle(document.documentElement);
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
        listStyle:
          listStyle === null
            ? null
            : {
                transform: listStyle.transform,
                transitionDuration: listStyle.transitionDuration,
              },
        motion,
        shadow: shadow?.content === "none" ? null : (shadow?.boxShadow ?? null),
        shadowOpacity: Number(shadow?.opacity ?? 0),
        time: performance.now(),
        tokens: {
          pushCurve: rootStyle
            .getPropertyValue("--wl-motion-push-curve")
            .trim(),
          pushInDuration: rootStyle
            .getPropertyValue("--wl-motion-push-in")
            .trim(),
          pushOutDuration: rootStyle
            .getPropertyValue("--wl-motion-push-out")
            .trim(),
          settleCurve: rootStyle
            .getPropertyValue("--wl-motion-settle-curve")
            .trim(),
        },
        transition: {
          duration: chatStyle?.transitionDuration ?? "0s",
          property: chatStyle?.transitionProperty ?? "all",
          timingFunction: chatStyle?.transitionTimingFunction ?? "ease",
        },
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

function expectListStill(frames: readonly Frame[]): void {
  const first = frames[0]?.list;
  expect(first).not.toBeNull();
  for (const frame of frames) {
    expect(frame.list).toEqual(first);
    expect(frame.listOpacity).toBe("1");
    if (frame.listStyle !== null)
      expectNoTransformOrTransition(frame.listStyle);
  }
  for (const frame of frames.filter((frame) => frame.motion !== null))
    expect(frame.listVisible).toBe(true);
}

function expectPushTransition(
  frames: readonly Frame[],
  duration: "pushInDuration" | "pushOutDuration",
  curve: "pushCurve" | "settleCurve",
): void {
  const moving = frames.filter((frame) => frame.motion !== null);
  expect(moving.length).toBeGreaterThan(0);
  for (const frame of moving)
    expectTransitionMatches(
      frame.transition,
      "transform",
      frame.tokens[duration],
      frame.tokens[curve],
    );
}

function expectReleasedTransition(frames: readonly Frame[]): void {
  const moving = frames.filter((frame) => frame.motion !== null);
  expect(moving.length).toBeGreaterThan(0);
  for (const frame of moving) {
    expect(frame.transition.property).toBe("transform");
    expect(normalizedCurve(frame.transition.timingFunction)).toBe(
      normalizedCurve(frame.tokens.settleCurve),
    );
    const scale =
      durationMs(frame.transition.duration) /
      durationMs(frame.tokens.pushOutDuration);
    expect(scale).toBeGreaterThanOrEqual(1.3 - 0.001);
    expect(scale).toBeLessThanOrEqual(1.8 + 0.001);
  }
}

function expectShadowWhileMoving(frames: readonly Frame[]): void {
  const moving = frames.filter((frame) => frame.chatLeft !== 0);
  expect(moving.length).toBeGreaterThan(0);
  for (const frame of moving) {
    expect(frame.motion).not.toBeNull();
    expect(frame.shadow).not.toBeNull();
    expect(frame.shadow).not.toBe("none");
  }
  const byPosition = [...moving].sort(
    (left, right) => left.chatLeft - right.chatLeft,
  );
  expect(
    Math.max(...moving.map((frame) => frame.shadowOpacity)),
  ).toBeGreaterThan(0);
  expect(
    byPosition.every(
      (frame, index) =>
        index === 0 ||
        frame.shadowOpacity <=
          (byPosition[index - 1]?.shadowOpacity ?? 1) + 0.02,
    ),
  ).toBe(true);
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
