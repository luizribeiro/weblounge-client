import { expect, type Page, test } from "@playwright/test";
import {
  drawerPointer,
  openDrawer,
  openStandaloneChannel,
} from "./member-drawer";

test.beforeEach(async ({ browserName, page }) => {
  await openStandaloneChannel(page, browserName);
});

test("opens with a fast start, anchored right, over a painted chat", async ({
  page,
}) => {
  const { before, frames } = await recordMotion(page, { kind: "show" });
  const moving = frames.filter((frame) => frame.left !== null);
  const final = moving.at(-1);
  if (final?.left == null || final.right == null || final.width == null)
    throw new Error("the drawer never painted");
  const start = final.left + final.width;
  const travelled = ((moving[0]?.left ?? start) - start) / (final.left - start);

  expect(travelled).toBeLessThanOrEqual(0.35);
  expect(distinct(moving.map((frame) => frame.left))).toBeGreaterThanOrEqual(
    12,
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
  await drawerPointer(page, "pointerdown", 100, 300, 0);
  await drawerPointer(page, "pointermove", 160, 304, 400);
  const settle = await recordMotion(page, {
    kind: "release",
    clientX: 160,
    pointerId: 1,
    timeStamp: 500,
  });
  const dragLeft = settle.before.drawerLeft;
  const openLeft = settle.frames.at(-1)?.left ?? 0;
  expect(dragLeft - openLeft).toBeCloseTo(60, 0);
  expect(settle.frames[0]?.left ?? 0).toBeGreaterThan(openLeft + 30);
  expect(
    monotonic(
      settle.frames.map((frame) => frame.left ?? 0),
      "down",
    ),
  ).toBe(true);

  await drawerPointer(page, "pointerdown", 100, 300, 1_000, 2);
  await drawerPointer(page, "pointermove", 200, 300, 1_100, 2);
  const close = await recordMotion(page, {
    kind: "release",
    clientX: 200,
    pointerId: 2,
    timeStamp: 1_150,
  });
  const present = close.frames.filter((frame) => frame.left !== null);
  expect(close.before.drawerLeft - openLeft).toBeCloseTo(100, 0);
  expect(present[0]?.left ?? 0).toBeGreaterThanOrEqual(close.before.drawerLeft);
  expect(present[0]?.left ?? 0).toBeLessThan(
    close.before.drawerLeft + (close.before.viewportWidth - openLeft) / 2,
  );
  expect(
    monotonic(
      present.map((frame) => frame.left ?? 0),
      "up",
    ),
  ).toBe(true);
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
  readonly header: Box;
  readonly left: number | null;
  readonly list: Box;
  readonly right: number | null;
  readonly scrim: number;
  readonly width: number | null;
}

interface MotionBefore {
  readonly drawerLeft: number;
  readonly header: Box;
  readonly list: Box;
  readonly viewportWidth: number;
}

interface MotionRecording {
  readonly before: MotionBefore;
  readonly frames: readonly MotionFrame[];
}

async function recordMotion(
  page: Page,
  trigger: Trigger,
): Promise<MotionRecording> {
  return page.evaluate(
    (action) =>
      new Promise<MotionRecording>((resolve, reject) => {
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
          return {
            header: box("[data-mobile-chat] header"),
            left: rect?.left ?? null,
            list: box("[data-message-list]"),
            right: rect?.right ?? null,
            scrim:
              scrim === null || scrim === undefined
                ? 0
                : Number(getComputedStyle(scrim).opacity),
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
        const before: MotionBefore = {
          drawerLeft: current.left ?? innerWidth,
          header: current.header,
          list: current.list,
          viewportWidth: innerWidth,
        };
        const click = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (element === null) throw new Error(`${selector} is missing`);
          element.click();
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
            history.back();
            break;
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
        const frames: MotionFrame[] = [];
        const startedAt = performance.now();
        const step = () => {
          frames.push(sample());
          if (settled()) resolve({ before, frames });
          else if (performance.now() - startedAt > 3_000)
            reject(new Error(`motion did not settle: ${frames.length} frames`));
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    trigger,
  );
}

async function expectSlidesClosed(
  page: Page,
  kind: "close-button" | "scrim" | "escape" | "back",
): Promise<void> {
  const { before, frames } = await recordMotion(page, { kind });
  const present = frames.filter((frame) => frame.left !== null);

  expect(distinct(present.map((frame) => frame.left))).toBeGreaterThanOrEqual(
    7,
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

function distinct(values: readonly (number | null)[]): number {
  return new Set(values.map((value) => value?.toFixed(1))).size;
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
