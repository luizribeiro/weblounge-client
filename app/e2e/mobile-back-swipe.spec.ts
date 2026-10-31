import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { emulateStandalone } from "./mobile-platform";
import {
  expectNoTransformOrTransition,
  expectTransitionMatches,
  hasIntermediatePosition,
  type TransitionStyle,
} from "./motion-assertions";

test.beforeEach(async ({ browserName, page }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(browserName !== "webkit", "requires WebKit touch events");
  await emulateStandalone(page);
  await page.goto("/?irc-password=weblounge-test");
});

test("mobile back gestures cancel and complete aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 1, 10, "pointercancel");
  await expect(page.locator("[data-motion]")).toHaveCount(0);
  await expectAligned(page);

  await drag(page, 2, 360, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture survives diagonal drift after locking", async ({
  page,
}) => {
  await openChat(page);
  const prevented = await pointerAndTouchSequence(
    page,
    [
      [100, 300, 1_000],
      [115, 302, 1_010],
      [175, 382, 1_050],
      [260, 382, 1_100],
    ],
    "pointercancel",
  );

  expect(prevented).toEqual([true, true, true]);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back uses release velocity and direction", async ({ page }) => {
  await openChat(page);
  await pointerSequence(page, [
    [200, 300, 1_000],
    [215, 300, 1_010],
    [260, 300, 1_500],
    [330, 300, 1_550],
  ]);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
  await expect(page.locator("[data-motion]")).toHaveCount(0);

  await openChat(page);
  await pointerSequence(page, [
    [50, 300, 2_000],
    [65, 300, 2_010],
    [300, 300, 2_500],
    [250, 300, 2_550],
  ]);
  await expect(page.locator("[data-mobile-chat]")).toBeVisible();
  await expect(page.locator("[data-motion]")).toHaveCount(0);
});

test("mobile back starts anywhere and can grab a returning screen", async ({
  page,
}) => {
  await openChat(page);
  await pointerSequence(page, [
    [180, 300, 1_000],
    [195, 300, 1_010],
    [280, 300, 1_400],
  ]);
  await expect(page.locator('[data-motion="returning"]')).toHaveCount(1);

  await pointerSequence(page, [
    [280, 300, 1_500],
    [295, 300, 1_510],
    [390, 300, 1_550],
  ]);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture velocity completes aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 3, 80, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("gesture diagnostics show and remember pan decisions", async ({
  page,
}) => {
  await page.goto("/?irc-password=weblounge-test&debug=gestures");
  await openChat(page);
  await pointerSequence(page, [
    [160, 300, 1_000],
    [175, 300, 1_010],
    [240, 300, 1_500],
  ]);

  const overlay = page.locator("[data-debug-overlay]");
  await expect(overlay).toContainText("[gestures]");
  await expect(overlay).toContainText("data-keyboard: closed");
  await expect(overlay).toContainText("160,300 swipe-back");
  await expect(overlay).toContainText("horizontal@15,0");
  await expect(overlay).toContainText("up-cancel");

  await page.goto("/?irc-password=weblounge-test");
  await expect(overlay).toBeAttached();
  await page.goto("/?irc-password=weblounge-test&debug=off");
  await expect(overlay).toHaveCount(0);
});

test("mobile Back button animates the chat over the visible list", async ({
  page,
}) => {
  await openChat(page);
  await startPopRecording(page);
  await page.getByRole("button", { name: "Back to chats" }).tap();
  const frames = await finishPopRecording(page);
  const moving = frames.filter(
    (frame) => frame.chatLeft !== null && frame.popping,
  );
  const positions = frames
    .filter((frame) => frame.chatLeft !== null)
    .map((frame) => frame.chatLeft ?? 0);

  expect(hasIntermediatePosition(positions, 0, 402)).toBe(true);
  expect(monotonic(positions)).toBe(true);
  expect(moving.length).toBeGreaterThan(0);
  for (const frame of moving)
    expectTransitionMatches(
      frame.transition,
      "transform",
      frame.popDuration,
      frame.popCurve,
    );
  const list = frames[0]?.chatsRect;
  expect(list).not.toBeNull();
  for (const frame of frames) {
    expect(frame.chatsRect).toEqual(list);
    if (frame.chatsStyle !== null)
      expectNoTransformOrTransition(frame.chatsStyle);
  }
  expect(
    frames
      .filter((frame) => frame.popping || frame.chatLeft === null)
      .every((frame) => frame.chatsVisible),
  ).toBe(true);
  expect(frames.at(-1)?.chatLeft).toBeNull();
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
});

test("mobile keyboard Back uses the pop transition", async ({ page }) => {
  await openChat(page);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-motion="closing"]')).toHaveCount(1);
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
});

test("mobile back gesture midpoint completes aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 4, 200, "pointerup");
  await expect(page.locator("[data-motion]")).toHaveCount(0);
  await expectAligned(page);
});

test("mobile back swipe stays owned over selectable transcript content", async ({
  page,
}) => {
  const bot = await IrcClient.connect(
    "swipe-audit",
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  const text = `selectable swipe target ${Date.now()}`;
  try {
    bot.privmsg("#weblounge-test", text);
    await openChat(page);
    const message = page.getByText(text, { exact: true });
    await expect(message).toBeVisible();
    await expect(page.locator("[data-message-list]")).toHaveCSS(
      "touch-action",
      "pan-y",
    );
    await expect(message).toHaveCSS("user-select", "text");

    const messageY = await message.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    });
    await panOverTranscript(page, messageY, 80, 500);
    await expect(page.locator("[data-mobile-chat]")).toBeVisible();
    await expect(page.locator("[data-motion]")).toHaveCount(0);
    await expectAligned(page);

    const listY = await page.locator("[data-message-list]").evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      return bounds.top + 4;
    });
    await panOverTranscript(page, listY, 240, 600);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expectAligned(page);

    await openChat(page);
    await panOverTranscript(page, messageY, 80, 80);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expectAligned(page);
  } finally {
    bot.close();
  }
});

test("mobile back swipe starting on a nickname wins over its tap", async ({
  page,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const nick = `swipenick${suffix}`;
  const marker = `nick swipe target ${suffix}`;
  const bot = await IrcClient.connect(
    nick,
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  try {
    await bot.privmsgConfirmed("#weblounge-test", marker);
    await openChat(page);
    const nickAction = page
      .locator("[data-message-row]")
      .filter({ has: page.getByText(marker, { exact: true }) })
      .getByRole("button", { name: `Open direct message with ${nick}` });
    await expect(nickAction).toBeVisible();

    expect(await swipeFromNickname(nickAction)).toBe(true);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expect(page.getByRole("heading", { name: nick })).toHaveCount(0);
    await expectAligned(page);
  } finally {
    bot.close();
  }
});

test("mobile transcript leaves vertical touchmove available to native scrolling", async ({
  page,
}) => {
  await openChat(page);
  const prevented = await page
    .locator("[data-message-list]")
    .evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      const target = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      if (target === null)
        throw new Error("transcript touch target is missing");
      const dispatch = (type: string, y: number) => {
        const touch = {
          clientX: bounds.left + bounds.width / 2,
          clientY: y,
          identifier: 81,
          target,
        };
        const event = new Event(type, { bubbles: true, cancelable: true });
        const active = type === "touchend" ? [] : [touch];
        Object.defineProperties(event, {
          changedTouches: { value: [touch] },
          targetTouches: { value: active },
          touches: { value: active },
        });
        return !target.dispatchEvent(event);
      };
      dispatch("touchstart", bounds.top + bounds.height / 2);
      const movePrevented = dispatch("touchmove", bounds.top + 40);
      dispatch("touchend", bounds.top + 40);
      return movePrevented;
    });

  expect(prevented).toBe(false);
  await expect(page.locator("[data-mobile-chat]")).toBeVisible();
});

test("mobile history interrupts a gesture aligned", async ({ page }) => {
  await openChat(page);
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    isPrimary: true,
    pointerId: 5,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: 20,
    clientY: 300,
    pointerId: 5,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: 120,
    clientY: 300,
    pointerId: 5,
  });
  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await shell.dispatchEvent("pointerup", {
    clientX: 120,
    clientY: 300,
    pointerId: 5,
  });
  await expect(page.locator("[data-motion]")).toHaveCount(0);
  await expectAligned(page);
});

async function openChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
  await expect(page.locator("[data-motion]")).toHaveCount(0);
}

async function drag(
  page: Page,
  pointerId: number,
  endX: number,
  end: string,
): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    isPrimary: true,
    pointerId,
  });
  if (endX > 20)
    await shell.dispatchEvent("pointermove", {
      clientX: 20,
      clientY: 300,
      isPrimary: true,
      pointerId,
    });
  await shell.dispatchEvent("pointermove", {
    clientX: endX,
    clientY: 300,
    pointerId,
  });
  await shell.dispatchEvent(end, {
    clientX: endX,
    clientY: 300,
    pointerId,
  });
}

async function panOverTranscript(
  page: Page,
  clientY: number,
  endX: number,
  duration: number,
): Promise<void> {
  await page.evaluate(
    ({ clientY, duration, endX }) => {
      const target = document.elementFromPoint(5, clientY);
      if (target === null) throw new Error("swipe start target is missing");
      const dispatch = (type: string, clientX: number, timeStamp: number) => {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          isPrimary: true,
          pointerId: 41,
          pointerType: "touch",
        });
        Object.defineProperty(event, "timeStamp", { value: timeStamp });
        target.dispatchEvent(event);
      };
      dispatch("pointerdown", 5, 1_000);
      dispatch("pointermove", 20, 1_000 + duration / 3);
      dispatch("pointermove", endX, 1_000 + (2 * duration) / 3);
      dispatch("pointerup", endX, 1_000 + duration);
    },
    { clientY, duration, endX },
  );
}

async function swipeFromNickname(
  nickname: import("@playwright/test").Locator,
): Promise<boolean> {
  return nickname.evaluate((target) => {
    const bounds = target.getBoundingClientRect();
    const startX = bounds.left + bounds.width / 2;
    const clientY = bounds.top + bounds.height / 2;
    const points = [
      [startX, 1_000],
      [startX + 15, 1_010],
      [Math.min(startX + 120, 320), 1_040],
      [401, 1_080],
    ] as const;
    const pointer = (type: string, clientX: number, timeStamp: number) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: 91,
        pointerType: "touch",
      });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      target.dispatchEvent(event);
    };
    pointer("pointerdown", points[0][0], points[0][1]);
    for (const [clientX, timeStamp] of points.slice(1))
      pointer("pointermove", clientX, timeStamp);
    const last = points.at(-1) ?? points[0];
    pointer("pointerup", last[0], last[1]);
    return !target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

type GesturePoint = readonly [x: number, y: number, time: number];

async function pointerSequence(
  page: Page,
  points: readonly GesturePoint[],
): Promise<void> {
  await pointerAndTouchSequence(page, points, "pointerup", false);
}

async function pointerAndTouchSequence(
  page: Page,
  points: readonly GesturePoint[],
  end: "pointerup" | "pointercancel",
  includeTouch = true,
): Promise<readonly boolean[]> {
  // Synthetic events prove our cancellability policy and pointer state machine,
  // but Playwright cannot reproduce iOS's native scroll recognizer arbitration.
  return page.evaluate(
    ({ end, includeTouch, points }) => {
      const first = points[0];
      if (first === undefined) throw new Error("gesture needs a start point");
      const target = document.elementFromPoint(first[0], first[1]);
      if (target === null) throw new Error("gesture start target is missing");
      const pointer = (type: string, point: GesturePoint) => {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: point[0],
          clientY: point[1],
          isPrimary: true,
          pointerId: 71,
          pointerType: "touch",
        });
        Object.defineProperty(event, "timeStamp", { value: point[2] });
        target.dispatchEvent(event);
      };
      const touch = (type: string, point: GesturePoint) => {
        const item = {
          clientX: point[0],
          clientY: point[1],
          identifier: 71,
          target,
        };
        const event = new Event(type, { bubbles: true, cancelable: true });
        const active = type === "touchend" ? [] : [item];
        Object.defineProperties(event, {
          changedTouches: { value: [item] },
          targetTouches: { value: active },
          touches: { value: active },
        });
        return !target.dispatchEvent(event);
      };
      if (includeTouch) touch("touchstart", first);
      pointer("pointerdown", first);
      const prevented: boolean[] = [];
      for (const point of points.slice(1)) {
        pointer("pointermove", point);
        if (includeTouch) prevented.push(touch("touchmove", point));
      }
      const last = points.at(-1) ?? first;
      pointer(end, last);
      if (includeTouch) touch("touchend", last);
      return prevented;
    },
    { end, includeTouch, points },
  );
}

async function expectAligned(page: Page): Promise<void> {
  const active = page.locator(
    '[data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chats], [data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chat]',
  );
  await expect(active).toHaveCount(1);
  await expect
    .poll(() =>
      active.evaluate((element) => {
        const screen = element.parentElement;
        if (screen === null) throw new Error("mobile screen is missing");
        const box = screen.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          transform: getComputedStyle(screen).transform,
          viewport: window.innerWidth,
        };
      }),
    )
    .toEqual({ left: 0, right: 402, transform: "none", viewport: 402 });
}

interface PopFrame {
  readonly chatLeft: number | null;
  readonly chatsRect: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  } | null;
  readonly chatsStyle: {
    readonly transform: string;
    readonly transitionDuration: string;
  } | null;
  readonly chatsVisible: boolean;
  readonly popping: boolean;
  readonly popCurve: string;
  readonly popDuration: string;
  readonly transition: TransitionStyle;
}

async function startPopRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as Window & {
      popRecording?: { done: boolean; frames: PopFrame[] };
    };
    const recording = { done: false, frames: [] as PopFrame[] };
    scope.popRecording = recording;
    const sample = () => {
      const chat =
        document.querySelector<HTMLElement>(
          "[data-mobile-chat]",
        )?.parentElement;
      const chats = document.querySelector<HTMLElement>("[data-mobile-chats]");
      const chatsRect = chats?.getBoundingClientRect();
      const chatStyle = chat === undefined ? null : getComputedStyle(chat);
      const chatsStyle = chats === null ? null : getComputedStyle(chats);
      const rootStyle = getComputedStyle(document.documentElement);
      recording.frames.push({
        chatLeft: chat?.getBoundingClientRect().left ?? null,
        chatsRect:
          chatsRect === undefined
            ? null
            : {
                height: chatsRect.height,
                left: chatsRect.left,
                top: chatsRect.top,
                width: chatsRect.width,
              },
        chatsStyle:
          chatsStyle === null
            ? null
            : {
                transform: chatsStyle.transform,
                transitionDuration: chatsStyle.transitionDuration,
              },
        chatsVisible:
          chats?.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          }) ?? false,
        popping: chat?.dataset.motion === "closing",
        popCurve: rootStyle.getPropertyValue("--wl-motion-pop-curve").trim(),
        popDuration: rootStyle.getPropertyValue("--wl-motion-pop").trim(),
        transition: {
          duration: chatStyle?.transitionDuration ?? "0s",
          property: chatStyle?.transitionProperty ?? "all",
          timingFunction: chatStyle?.transitionTimingFunction ?? "ease",
        },
      });
      if (chat === undefined || chat === null) recording.done = true;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function finishPopRecording(page: Page): Promise<readonly PopFrame[]> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              popRecording?: { done: boolean };
            }
          ).popRecording?.done ?? false,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (
        window as Window & {
          popRecording?: { frames: PopFrame[] };
        }
      ).popRecording?.frames ?? [],
  );
}

function monotonic(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value >= (values[index - 1] ?? value),
  );
}
