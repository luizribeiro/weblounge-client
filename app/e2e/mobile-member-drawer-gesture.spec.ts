import { expect, type Page, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";

test.beforeEach(async ({ browserName, page }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(browserName !== "webkit", "requires WebKit touch events");
  await emulateStandalone(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?irc-password=weblounge-test");
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(page.locator("[data-position]")).toHaveCount(0);
});

test("member drawer pans, springs back, and closes before the chat", async ({
  page,
}) => {
  await openDrawer(page);
  const drawer = page.getByRole("dialog", { name: "Members" });

  await drawerPointer(page, "pointerdown", 100, 300, 0);
  await drawerPointer(page, "pointermove", 160, 304, 400);
  await expect
    .poll(() =>
      drawer.evaluate((element) =>
        Math.round(new DOMMatrix(getComputedStyle(element).transform).m41),
      ),
    )
    .toBe(60);
  await drawerPointer(page, "pointerup", 160, 304, 500);
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  await expect(drawer).toBeVisible();

  await drawerPointer(page, "pointerdown", 100, 300, 600, 2);
  await drawerPointer(page, "pointermove", 105, 360, 800, 2);
  await drawerPointer(page, "pointerup", 105, 360, 900, 2);
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  await expect(drawer).toBeVisible();

  await drawerPointer(page, "pointerdown", 100, 300, 1_000, 3);
  await drawerPointer(page, "pointermove", 140, 300, 1_040, 3);
  await drawerPointer(page, "pointerup", 140, 300, 1_050, 3);
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();

  await openDrawer(page);
  await drawerPointer(page, "pointerdown", 100, 300, 2_000, 4);
  await drawerPointer(page, "pointermove", 230, 300, 2_400, 4);
  await drawerPointer(page, "pointerup", 230, 300, 2_500, 4);
  await expect(drawer).toHaveCount(0);

  await openDrawer(page);
  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await expect(drawer).toHaveCount(0);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
});

test("opens the channel drawer from a protected mid-screen pan", async ({
  page,
}) => {
  const drawer = page.getByRole("dialog", { name: "Members" });
  const historyLength = await page.evaluate(() => history.length);

  await shellPointer(page, "pointerdown", 390, 300, 0, 10);
  await shellPointer(page, "pointermove", 250, 300, 100, 10);
  await shellPointer(page, "pointerup", 250, 300, 200, 10);
  await expect(drawer).toHaveCount(0);

  await page
    .getByRole("heading", { name: "#weblounge-test" })
    .evaluate((heading) => {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(heading);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await shellPointer(page, "pointerdown", 250, 300, 300, 11);
  await shellPointer(page, "pointermove", 100, 300, 400, 11);
  await shellPointer(page, "pointerup", 100, 300, 500, 11);
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() => getSelection()?.removeAllRanges());

  await shellPointer(page, "pointerdown", 250, 300, 600, 12);
  await shellPointer(page, "pointermove", 210, 300, 1_000, 12);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByPlaceholder("Filter members")).not.toBeFocused();
  await shellPointer(page, "pointerup", 210, 300, 1_100, 12);
  await expect(drawer).toHaveCount(0);

  await shellPointer(page, "pointerdown", 250, 300, 1_200, 13);
  await shellPointer(page, "pointermove", 210, 300, 1_240, 13);
  await shellPointer(page, "pointerup", 210, 300, 1_250, 13);
  await expect(drawer).toBeVisible();
  await expect(page.locator("[data-overlay-drawer]")).not.toHaveAttribute(
    "data-drag-returning",
    "true",
  );
  await expect(drawer).toHaveCSS("transform", "none");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await expect(drawer).toHaveCount(0);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
});

test("member drawer and scrim enter and leave as one motion", async ({
  page,
}) => {
  const opening = await sampleMotion(page, "opening");
  expect(opening.frames.length).toBeGreaterThan(2);
  expect(opening.curve).not.toBe("");
  expect(opening.easings.map(compact)).toEqual(
    opening.easings.map(() => compact(opening.curve)),
  );
  expect(
    monotonic(
      opening.frames.map((frame) => frame.scrim),
      "up",
    ),
  ).toBe(true);
  expect(
    monotonic(
      opening.frames.map((frame) => frame.shadow),
      "up",
    ),
  ).toBe(true);
  expect(
    monotonic(
      opening.frames.map((frame) => Math.abs(frame.offset)),
      "down",
    ),
  ).toBe(true);
  expect(new Set(opening.frames.map((frame) => frame.contentWidth)).size).toBe(
    1,
  );

  await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
    "data-phase",
    "open",
  );
  const closing = await sampleMotion(page, "closing");
  expect(closing.frames.length).toBeGreaterThan(2);
  expect(
    monotonic(
      closing.frames.map((frame) => frame.scrim),
      "down",
    ),
  ).toBe(true);
  expect(
    monotonic(
      closing.frames.map((frame) => frame.shadow),
      "down",
    ),
  ).toBe(true);
  expect(
    monotonic(
      closing.frames.map((frame) => Math.abs(frame.offset)),
      "up",
    ),
  ).toBe(true);
  expect(new Set(closing.frames.map((frame) => frame.contentWidth)).size).toBe(
    1,
  );
  await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(0);
});

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show members" }).click();
  await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
  await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
    "data-phase",
    "open",
  );
}

async function drawerPointer(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  timeStamp: number,
  pointerId = 1,
): Promise<void> {
  await page.locator("[data-member-drawer]").evaluate(
    (element, init) => {
      const event = new PointerEvent(init.type, {
        bubbles: true,
        cancelable: true,
        clientX: init.clientX,
        clientY: init.clientY,
        pointerId: init.pointerId,
      });
      Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
      element.dispatchEvent(event);
    },
    { clientX, clientY, pointerId, timeStamp, type },
  );
}

async function shellPointer(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  timeStamp: number,
  pointerId: number,
): Promise<void> {
  await page.locator("[data-mobile-shell]").evaluate(
    (element, init) => {
      const event = new PointerEvent(init.type, {
        bubbles: true,
        cancelable: true,
        clientX: init.clientX,
        clientY: init.clientY,
        pointerId: init.pointerId,
      });
      Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
      element.dispatchEvent(event);
    },
    { clientX, clientY, pointerId, timeStamp, type },
  );
}

interface MotionFrame {
  readonly contentWidth: number;
  readonly offset: number;
  readonly scrim: number;
  readonly shadow: number;
}

interface MotionSample {
  readonly curve: string;
  readonly easings: readonly string[];
  readonly frames: readonly MotionFrame[];
}

async function sampleMotion(
  page: Page,
  phase: "opening" | "closing",
): Promise<MotionSample> {
  return page.evaluate((motionPhase) => {
    if (motionPhase === "opening") {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Show members"]')
        ?.click();
    } else {
      document
        .querySelector<HTMLElement>(
          '[role="dialog"] button[aria-label="Close member list"]',
        )
        ?.click();
    }
    const overlay = document.querySelector<HTMLElement>(
      `[data-overlay-drawer]`,
    );
    const drawer = overlay?.querySelector<HTMLElement>("[role=dialog]");
    const scrim = overlay?.querySelector<HTMLElement>("[data-overlay-scrim]");
    if (overlay === null || drawer === undefined || scrim === undefined)
      throw new Error("drawer motion surfaces are missing");
    const animations = overlay.getAnimations({ subtree: true });
    const duration = Math.max(
      ...animations.map((animation) =>
        Number(animation.effect?.getComputedTiming().endTime ?? 0),
      ),
    );
    for (const animation of animations) animation.pause();
    const content = document.querySelector<HTMLElement>("[data-mobile-chat]");
    if (content === null) throw new Error("conversation content is missing");
    const frames = Array.from({ length: 6 }, (_, index) => {
      const time = (duration * index) / 5;
      for (const animation of animations) animation.currentTime = time;
      return {
        contentWidth: content.getBoundingClientRect().width,
        offset: new DOMMatrix(getComputedStyle(drawer).transform).m41,
        scrim: Number(getComputedStyle(scrim).opacity),
        shadow: Number(getComputedStyle(drawer, "::before").opacity),
      };
    });
    for (const animation of animations) animation.finish();
    return {
      curve: getComputedStyle(document.documentElement)
        .getPropertyValue("--wl-motion-drawer-curve")
        .trim(),
      easings: [
        getComputedStyle(drawer).animationTimingFunction,
        getComputedStyle(drawer, "::before").animationTimingFunction,
        getComputedStyle(scrim).animationTimingFunction,
      ],
      frames,
    };
  }, phase);
}

function compact(value: string): string {
  return value.replaceAll(" ", "").replaceAll("0.", ".");
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
