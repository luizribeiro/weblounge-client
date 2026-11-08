import { expect, type Page, test } from "@playwright/test";
import {
  drawerPointer,
  openDrawer,
  openStandaloneChannel,
} from "./member-drawer";
import {
  durationMs,
  expectEqualAtDevicePixelPrecision,
  expectTransitionMatches,
  type TransitionStyle,
} from "./motion-assertions";

test.beforeEach(async ({ browserName, page }) => {
  await openStandaloneChannel(page, browserName);
});

test("opens with a fast start, anchored right, over a painted chat", async ({
  page,
}) => {
  const recording = await recordMotion(page, { kind: "show" });
  const { before, frames } = recording;
  const moving = frames.filter((frame) => frame.left !== null);
  const final = moving.at(-1);
  if (final?.left == null || final.right == null)
    throw new Error("the drawer never painted");

  expectDrawerTransition(
    moving,
    "drawerOpenDuration",
    recording.transitionEndElapsedMs,
  );
  expect(
    monotonic(
      moving.map((frame) => frame.left ?? 0),
      "down",
    ),
  ).toBe(true);
  expect(
    monotonic(
      moving.map((frame) => frame.scrim),
      "up",
    ),
  ).toBe(true);
  expect(final.right).toBeCloseTo(before.viewportWidth, 0);
  for (const frame of moving)
    expect(frame.right ?? 0).toBeGreaterThanOrEqual(before.viewportWidth - 0.5);
  expectChatStill(before, frames);
});

for (const kind of ["close-button", "scrim", "escape"] as const) {
  test(`closes via ${kind} by sliding fully off-screen`, async ({ page }) => {
    await openDrawer(page);
    await expectSlidesClosed(page, kind);
  });
}

test("closes via Back by sliding fully off-screen", async ({
  browserName,
  page,
}) => {
  await page.addInitScript(() => Reflect.deleteProperty(window, "WebKitPoint"));
  await openStandaloneChannel(page, browserName);
  await expect(page.locator("[data-mobile-shell]")).toHaveAttribute(
    "data-history-policy",
    "stack",
  );
  await openDrawer(page);
  await expectSlidesClosed(page, "back");
});

test("hands a released drag to the transition without jumping", async ({
  page,
}) => {
  await openDrawer(page);
  const openLeft = await page
    .getByRole("dialog", { name: "Members" })
    .evaluate((drawer) => drawer.getBoundingClientRect().left);
  await drawerPointer(page, "pointerdown", 100, 300, 0);
  await drawerPointer(page, "pointermove", 115, 301, 100);
  const claimedLeft = await page
    .getByRole("dialog", { name: "Members" })
    .evaluate((drawer) => drawer.getBoundingClientRect().left);
  expect(claimedLeft).toBeCloseTo(openLeft, 0);
  await drawerPointer(page, "pointermove", 160, 304, 400);
  const settle = await recordMotion(page, {
    kind: "release",
    clientX: 160,
    pointerId: 1,
    timeStamp: 500,
  });
  const dragLeft = settle.before.drawerLeft;
  expect(settle.frames.at(-1)?.left ?? 0).toBeCloseTo(openLeft, 0);
  expect(dragLeft - openLeft).toBeCloseTo(45, 0);
  const returning = settle.frames.filter(
    (frame): frame is MotionFrame & { left: number } => frame.left !== null,
  );
  expect(
    monotonic([dragLeft, ...returning.map((frame) => frame.left)], "down"),
  ).toBe(true);
  expectDrawerTransition(
    returning,
    "drawerOpenDuration",
    settle.transitionEndElapsedMs,
  );
  expectTransitionStartsAtDrag(returning, settle.before);

  await drawerPointer(page, "pointerdown", 100, 300, 1_000, 2);
  await drawerPointer(page, "pointermove", 115, 300, 1_050, 2);
  await drawerPointer(page, "pointermove", 200, 300, 1_100, 2);
  const close = await recordMotion(page, {
    kind: "release",
    clientX: 200,
    pointerId: 2,
    timeStamp: 1_150,
  });
  const present = close.frames.filter((frame) => frame.left !== null);
  expect(close.before.drawerLeft - openLeft).toBeCloseTo(85, 0);
  expect(
    monotonic(
      [close.before.drawerLeft, ...present.map((frame) => frame.left ?? 0)],
      "up",
    ),
  ).toBe(true);
  expectDrawerTransition(
    present,
    "drawerCloseDuration",
    close.transitionEndElapsedMs,
  );
  expectTransitionStartsAtDrag(present, close.before);
  expect(present.at(-1)?.left ?? 0).toBeGreaterThanOrEqual(
    close.before.viewportWidth - 0.5,
  );
});

type Trigger =
  | {
      readonly kind: "show" | "close-button" | "scrim" | "escape" | "back";
    }
  | {
      readonly kind: "release";
      readonly clientX: number;
      readonly pointerId: number;
      readonly timeStamp: number;
    };

interface Box {
  readonly top: number;
  readonly height: number;
  readonly visible: boolean;
}

interface MotionFrame {
  readonly drawerTransitionStartX: number | null;
  readonly drawerTransition: TransitionStyle;
  readonly header: Box;
  readonly left: number | null;
  readonly list: Box;
  readonly right: number | null;
  readonly scrim: number;
  readonly scrimTransition: TransitionStyle;
  readonly time: number;
  readonly tokens: {
    readonly drawerCloseDuration: string;
    readonly drawerCurve: string;
    readonly drawerOpenDuration: string;
  };
  readonly width: number | null;
}

interface MotionBefore {
  readonly devicePixelRatio: number;
  readonly drawerLeft: number;
  readonly drawerTransformX: number;
  readonly header: Box;
  readonly list: Box;
  readonly viewportWidth: number;
}

interface MotionRecording {
  readonly before: MotionBefore;
  readonly frames: readonly MotionFrame[];
  readonly transitionEndElapsedMs: number | null;
}

async function recordMotion(
  page: Page,
  trigger: Trigger,
): Promise<MotionRecording> {
  return page.evaluate(
    (action) =>
      new Promise<MotionRecording>((resolve, reject) => {
        let transitionEndElapsedMs: number | null = null;
        const box = (selector: string): Box => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`${selector} is missing`);
          const rect = element.getBoundingClientRect();
          return {
            height: rect.height,
            top: rect.top,
            visible: element.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            }),
          };
        };
        const sample = (): MotionFrame => {
          const overlay = document.querySelector("[data-overlay-drawer]");
          const drawer = overlay?.querySelector("[role=dialog]");
          const scrim = overlay?.querySelector("[data-overlay-scrim]");
          const rect = drawer?.getBoundingClientRect();
          const drawerStyle =
            drawer === null || drawer === undefined
              ? null
              : getComputedStyle(drawer);
          const scrimStyle =
            scrim === null || scrim === undefined
              ? null
              : getComputedStyle(scrim);
          const rootStyle = getComputedStyle(document.documentElement);
          const transition = drawer
            ?.getAnimations()
            .find(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === "transform",
            );
          // WebKit can expose accelerated geometry from a different phase than
          // its JavaScript clock. The generated keyframe owns the real start.
          const transitionStart =
            transition?.effect instanceof KeyframeEffect
              ? transition.effect.getKeyframes()[0]?.transform
              : undefined;
          const transitionStartX = () => {
            if (typeof transitionStart !== "string" || rect === undefined)
              return null;
            const percent =
              /^translateX\((-?\d*\.?\d+)%\)$/.exec(transitionStart) ??
              /^translate3d\((-?\d*\.?\d+)%, 0px, 0px\)$/.exec(transitionStart);
            if (percent !== null)
              return (Number(percent[1]) * rect.width) / 100;
            return new DOMMatrixReadOnly(transitionStart).m41;
          };
          return {
            drawerTransitionStartX: transitionStartX(),
            drawerTransition: {
              duration: drawerStyle?.transitionDuration ?? "0s",
              property: drawerStyle?.transitionProperty ?? "all",
              timingFunction: drawerStyle?.transitionTimingFunction ?? "ease",
            },
            header: box("[data-mobile-chat] header"),
            left: rect?.left ?? null,
            list: box("[data-message-list]"),
            right: rect?.right ?? null,
            scrim:
              scrim === null || scrim === undefined
                ? 0
                : Number(getComputedStyle(scrim).opacity),
            scrimTransition: {
              duration: scrimStyle?.transitionDuration ?? "0s",
              property: scrimStyle?.transitionProperty ?? "all",
              timingFunction: scrimStyle?.transitionTimingFunction ?? "ease",
            },
            time: performance.now(),
            tokens: {
              drawerCloseDuration: rootStyle
                .getPropertyValue("--wl-motion-drawer-close")
                .trim(),
              drawerCurve: rootStyle
                .getPropertyValue("--wl-motion-drawer-curve")
                .trim(),
              drawerOpenDuration: rootStyle
                .getPropertyValue("--wl-motion-drawer-open")
                .trim(),
            },
            width: rect?.width ?? null,
          };
        };
        const settled = () => {
          const overlay = document.querySelector<HTMLElement>(
            "[data-overlay-drawer]",
          );
          if (action.kind === "show") return overlay?.dataset.phase === "open";
          if (action.kind === "release")
            return (
              overlay === null ||
              (overlay.dataset.phase === "open" &&
                overlay.dataset.dragReturning === undefined)
            );
          return overlay === null;
        };
        const current = sample();
        const drawer = document.querySelector<HTMLElement>("[role=dialog]");
        const before: MotionBefore = {
          devicePixelRatio: window.devicePixelRatio,
          drawerLeft: current.left ?? innerWidth,
          drawerTransformX:
            drawer === null
              ? 0
              : new DOMMatrixReadOnly(getComputedStyle(drawer).transform).m41,
          header: current.header,
          list: current.list,
          viewportWidth: innerWidth,
        };
        const click = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (element === null) throw new Error(`${selector} is missing`);
          element.click();
        };
        const captureTransitionEnd = (event: TransitionEvent) => {
          if (
            event.target instanceof Element &&
            event.target.matches("[role=dialog]") &&
            event.propertyName === "transform"
          )
            transitionEndElapsedMs = event.elapsedTime * 1_000;
        };
        document.addEventListener("transitionend", captureTransitionEnd, true);
        let recordingStarted = false;
        const startRecording = () => {
          if (recordingStarted) return;
          recordingStarted = true;
          const frames: MotionFrame[] = [sample()];
          const triggeredAt = performance.now();
          const step = () => {
            frames.push(sample());
            if (settled()) {
              document.removeEventListener(
                "transitionend",
                captureTransitionEnd,
                true,
              );
              resolve({ before, frames, transitionEndElapsedMs });
            } else if (performance.now() - triggeredAt > 3_000) {
              document.removeEventListener(
                "transitionend",
                captureTransitionEnd,
                true,
              );
              reject(
                new Error(`motion did not settle: ${frames.length} frames`),
              );
            } else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        };
        const startAfterBackTransition = () => {
          const overlay = document.querySelector<HTMLElement>(
            "[data-overlay-drawer]",
          );
          if (overlay === null) {
            reject(new Error("the drawer closed before its transition began"));
            return;
          }
          if (overlay.dataset.phase === "closing") {
            startRecording();
            return;
          }
          const observer = new MutationObserver(() => {
            if (overlay.dataset.phase !== "closing") return;
            observer.disconnect();
            startRecording();
          });
          observer.observe(overlay, {
            attributeFilter: ["data-phase"],
            attributes: true,
          });
        };
        switch (action.kind) {
          case "show":
            click('button[aria-label="Show members"]');
            break;
          case "close-button":
            click('[role="dialog"] button[aria-label="Close member list"]');
            break;
          case "scrim":
            click("[data-overlay-scrim]");
            break;
          case "escape":
            document
              .querySelector('[role="dialog"]')
              ?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
              );
            break;
          case "back":
            window.addEventListener("popstate", startAfterBackTransition, {
              once: true,
            });
            history.back();
            return;
          case "release": {
            const event = new PointerEvent("pointerup", {
              bubbles: true,
              cancelable: true,
              clientX: action.clientX,
              clientY: 300,
              pointerId: action.pointerId,
            });
            Object.defineProperty(event, "timeStamp", {
              value: action.timeStamp,
            });
            document
              .querySelector("[data-member-drawer]")
              ?.dispatchEvent(event);
            break;
          }
        }
        startRecording();
      }),
    trigger,
  );
}

async function expectSlidesClosed(
  page: Page,
  kind: "close-button" | "scrim" | "escape" | "back",
): Promise<void> {
  const recording = await recordMotion(page, { kind });
  const { before, frames } = recording;
  const present = frames.filter((frame) => frame.left !== null);

  expectDrawerTransition(
    present,
    "drawerCloseDuration",
    recording.transitionEndElapsedMs,
  );
  expect(
    monotonic(
      present.map((frame) => frame.left ?? 0),
      "up",
    ),
  ).toBe(true);
  expect(
    monotonic(
      present.map((frame) => frame.scrim),
      "down",
    ),
  ).toBe(true);
  expect(present.at(-1)?.left ?? 0).toBeGreaterThanOrEqual(
    before.viewportWidth - 0.5,
  );
  expectChatStill(before, frames);
}

function expectChatStill(
  before: MotionBefore,
  frames: readonly MotionFrame[],
): void {
  for (const frame of frames) {
    expect(frame.header).toEqual(before.header);
    expect(frame.list).toEqual(before.list);
  }
  expect(before.header.visible).toBe(true);
  expect(before.list.visible).toBe(true);
}

function expectDrawerTransition(
  frames: readonly MotionFrame[],
  duration: "drawerCloseDuration" | "drawerOpenDuration",
  transitionEndElapsedMs: number | null,
): void {
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expectTransitionMatches(
      frame.drawerTransition,
      "transform",
      frame.tokens[duration],
      frame.tokens.drawerCurve,
    );
    expectTransitionMatches(
      frame.scrimTransition,
      "opacity",
      frame.tokens[duration],
      frame.tokens.drawerCurve,
    );
  }
  expect(transitionEndElapsedMs).toBeCloseTo(
    durationMs(frames[0]?.tokens[duration] ?? "0ms"),
    5,
  );
}

function expectTransitionStartsAtDrag(
  frames: readonly MotionFrame[],
  before: MotionBefore,
): void {
  const starts = frames.flatMap((frame) =>
    frame.drawerTransitionStartX === null ? [] : [frame.drawerTransitionStartX],
  );
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts)
    expectEqualAtDevicePixelPrecision(
      start,
      before.drawerTransformX,
      before.devicePixelRatio,
    );
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
