import type { Locator, Page } from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { requireWebKitWithErgo } from "./member-drawer";
import { emulateStandalone } from "./mobile-platform";
import {
  expectNoTransformOrTransition,
  expectTransitionMatches,
  hasIntermediatePosition,
  type TransitionStyle,
} from "./motion-assertions";
import { expectSettled } from "./settled";
import { waitForStableGeometry } from "./stable-geometry";

requireWebKitWithErgo();

test.beforeEach(async ({ page, irc }) => {
  await emulateStandalone(page);
  await page.goto(irc.url());
});

test("mobile back gestures cancel and complete aligned", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
  await drag(page, 1, 10, "pointercancel");
  await expectSettled(page);
  await expectAligned(page);

  await drag(page, 2, 360, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture survives diagonal drift after locking", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
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

test("mobile back gesture survives bubbling child capture loss", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
  await panThroughCaptureLoss(page, 100, 300, 390);

  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back uses release velocity and direction", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
  await pointerSequence(page, [
    [200, 300, 1_000],
    [215, 300, 1_010],
    [260, 300, 1_500],
    [330, 300, 1_550],
  ]);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
  await expectSettled(page);

  await openChat(page, irc);
  await pointerSequence(page, [
    [50, 300, 2_000],
    [65, 300, 2_010],
    [300, 300, 2_500],
    [250, 300, 2_550],
  ]);
  await expect(page.locator("[data-mobile-chat]")).toBeVisible();
  await expectSettled(page);
});

test("mobile back starts anywhere and can grab a returning screen", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
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

test("mobile back gesture velocity completes aligned", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
  await drag(page, 3, 80, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("gesture diagnostics show and remember pan decisions", async ({
  page,
  irc,
}) => {
  await page.goto(irc.url({ path: "/?debug=gestures" }));
  await openChat(page, irc);
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

  await page.goto(irc.url());
  await expect(overlay).toBeAttached();
  await page.goto(irc.url({ path: "/?debug=off" }));
  await expect(overlay).toHaveCount(0);
});

test("mobile Back button animates the chat over the visible list", {
  tag: "@serial",
}, async ({ page, irc }) => {
  await openChat(page, irc);
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

test("mobile back reveals chat rows without repainting them", async ({
  page,
  irc,
}) => {
  const bots: IrcClient[] = [];
  await openChat(page, irc);
  await page.getByRole("button", { name: "Back to chats" }).tap();
  await expectSettled(page);

  for (let index = 0; index < 11; index += 1) {
    const bot = await irc.peer(`swipe-fill-${index}`);
    bots.push(bot);
    await bot.privmsgConfirmed(irc.account, `swipe fill preview ${index}`);
  }
  const uncoveredNick = bots[10]?.nickname ?? "";
  const uncoveredRow = page.getByRole("button", { name: uncoveredNick });
  await expect(uncoveredRow).toContainText("swipe fill preview 10");
  await expect(uncoveredRow).toBeVisible();

  const clip = await uncoveredRow.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const y = Math.ceil(Math.max(0, bounds.top) + 4);
    return {
      height: Math.floor(
        Math.min(40, bounds.bottom - y - 4, innerHeight - y - 4),
      ),
      width: 100,
      x: 0,
      y,
    };
  });
  expect(clip.height).toBeGreaterThan(0);
  const resting = await page.screenshot({ clip });

  await uncoveredRow.click();
  await expectSettled(page, { conversation: uncoveredNick });
  await drag(page, 76, 220);
  await expect(page.locator('[data-motion="dragging"]')).toHaveCount(1);
  const chatLeft = await page
    .locator("[data-mobile-chat]")
    .evaluate((chat) => chat.parentElement?.getBoundingClientRect().left ?? 0);
  expect(chatLeft).toBeGreaterThan(clip.width + 80);
  expect(chatLeft).toBeLessThan(280);
  const midDrag = await page.screenshot({ clip });

  expect(midDrag.equals(resting)).toBe(true);
  await releaseBackSwipe(page, 220);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
});

test("mobile keyboard Back uses the pop transition", async ({ page, irc }) => {
  await openChat(page, irc);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-motion="closing"]')).toHaveCount(1);
  await expect(page.locator("[data-mobile-chat]")).toHaveCount(0);
});

test("mobile back gesture midpoint completes aligned", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
  await drag(page, 4, 200, "pointerup");
  await expectSettled(page);
  await expectAligned(page);
});

test("mobile back swipe starts on selectable transcript content", async ({
  page,
  irc,
}) => {
  const bot = await irc.peer("swipe-audit");
  const text = "selectable swipe target";
  await bot.privmsgConfirmed(irc.channel, text);
  await openChat(page, irc);
  const message = page.getByText(text, { exact: true });
  await expect(message).toBeVisible();
  await expect(page.locator("[data-message-list]")).toHaveCSS(
    "touch-action",
    "pan-y",
  );
  await expect(message).toHaveCSS("user-select", "text");
  await waitForStableGeometry(
    page.locator("[data-message-list]"),
    "[data-message-row]",
  );

  const messagePoint = await visiblePoint(message);
  await panOverTranscript(page, messagePoint.x, messagePoint.y, 401, 600);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);

  await openChat(page, irc);
  await waitForStableGeometry(
    page.locator("[data-message-list]"),
    "[data-message-row]",
  );
  const reopenedMessagePoint = await visiblePoint(message);
  await panOverTranscript(page, 5, reopenedMessagePoint.y, 80, 500);
  await expect(page.locator("[data-mobile-chat]")).toBeVisible();
  await expectSettled(page);
  await expectAligned(page);

  const listY = await page.locator("[data-message-list]").evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return bounds.top + 4;
  });
  await panOverTranscript(page, 5, listY, 240, 600);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);

  await openChat(page, irc);
  await waitForStableGeometry(
    page.locator("[data-message-list]"),
    "[data-message-row]",
  );
  const fastMessagePoint = await visiblePoint(message);
  await panOverTranscript(page, 5, fastMessagePoint.y, 80, 80);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back swipe starting on a nickname wins over its tap", async ({
  page,
  irc,
}) => {
  const bot = await irc.peer("swipenick");
  const nick = bot.nickname;
  const marker = "nick swipe target";
  await bot.privmsgConfirmed(irc.channel, marker);
  await openChat(page, irc);
  const nickAction = page
    .locator("[data-message-row]")
    .filter({ has: page.getByText(marker, { exact: true }) })
    .getByRole("button", { name: `Open direct message with ${nick}` });
  await expect(nickAction).toBeVisible();

  expect(await swipeFromNickname(nickAction)).toBe(true);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expect(page.getByRole("heading", { name: nick })).toHaveCount(0);
  await expectAligned(page);
});

test("mobile transcript leaves vertical touchmove available to native scrolling", async ({
  page,
  irc,
}) => {
  await openChat(page, irc);
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

test("mobile history interrupts a gesture aligned", async ({ page, irc }) => {
  await openChat(page, irc);
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
  await expectSettled(page);
  await expectAligned(page);
});

async function openChat(page: Page, irc: IrcTestAccount): Promise<void> {
  await page.getByRole("button", { name: irc.channel }).click();
  await expectSettled(page, { conversation: irc.channel });
}

async function drag(
  page: Page,
  pointerId: number,
  endX: number,
  end?: string,
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
  if (end !== undefined)
    await shell.dispatchEvent(end, {
      clientX: endX,
      clientY: 300,
      pointerId,
    });
}

async function releaseBackSwipe(page: Page, endX: number): Promise<void> {
  await page.locator("[data-mobile-shell]").dispatchEvent("pointerup", {
    clientX: endX,
    clientY: 300,
    isPrimary: true,
    pointerId: 76,
    pointerType: "touch",
  });
}

async function panOverTranscript(
  page: Page,
  startX: number,
  clientY: number,
  endX: number,
  duration: number,
): Promise<void> {
  await page.evaluate(
    ({ clientY, duration, endX, startX }) => {
      const target = document.elementFromPoint(startX, clientY);
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
      dispatch("pointerdown", startX, 1_000);
      dispatch("pointermove", startX + 15, 1_000 + duration / 3);
      dispatch("pointermove", endX, 1_000 + (2 * duration) / 3);
      dispatch("pointerup", endX, 1_000 + duration);
    },
    { clientY, duration, endX, startX },
  );
}

async function visiblePoint(
  locator: Locator,
): Promise<{ readonly x: number; readonly y: number }> {
  await expect(locator).toBeInViewport();
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const left = Math.max(0, bounds.left);
    const right = Math.min(innerWidth, bounds.right);
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(innerHeight, bounds.bottom);
    if (right <= left || bottom <= top)
      throw new Error("swipe target is outside the viewport");
    return {
      x: Math.min(right - 1, left + 2),
      y: top + (bottom - top) / 2,
    };
  });
}

async function panThroughCaptureLoss(
  page: Page,
  startX: number,
  clientY: number,
  endX: number,
): Promise<void> {
  await page.evaluate(
    ({ clientY, endX, startX }) => {
      const target = document.elementFromPoint(startX, clientY);
      if (target === null) throw new Error("gesture start target is missing");
      const dispatch = (type: string, clientX: number, timeStamp: number) => {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          isPrimary: true,
          pointerId: 51,
          pointerType: "touch",
        });
        Object.defineProperty(event, "timeStamp", { value: timeStamp });
        target.dispatchEvent(event);
      };
      dispatch("pointerdown", startX, 1_000);
      dispatch("pointermove", startX + 15, 1_010);
      dispatch("lostpointercapture", startX + 15, 1_020);
      dispatch("pointermove", endX, 1_100);
      dispatch("pointerup", endX, 1_110);
    },
    { clientY, endX, startX },
  );
}

async function swipeFromNickname(
  nickname: import("@playwright/test").Locator,
): Promise<boolean> {
  return nickname.evaluate((target) => {
    const label = target.getAttribute("aria-label");
    const currentTarget = target.isConnected
      ? target
      : [...document.querySelectorAll("button")].find(
          (button) => button.getAttribute("aria-label") === label,
        );
    if (currentTarget === undefined)
      throw new Error("nickname touch target is missing");
    const shell = document.querySelector("[data-mobile-shell]");
    if (shell === null) throw new Error("mobile shell is missing");
    const bounds = currentTarget.getBoundingClientRect();
    const startX = bounds.left + bounds.width / 2;
    const clientY = bounds.top + bounds.height / 2;
    const points = [
      [startX, 1_000],
      [startX + 15, 1_010],
      [Math.min(startX + 120, 320), 1_040],
      [401, 1_080],
    ] as const;
    const pointer = (
      receiver: Element,
      type: string,
      clientX: number,
      timeStamp: number,
    ) => {
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
      receiver.dispatchEvent(event);
    };
    pointer(currentTarget, "pointerdown", points[0][0], points[0][1]);
    for (const [clientX, timeStamp] of points.slice(1))
      pointer(shell, "pointermove", clientX, timeStamp);
    const last = points.at(-1) ?? points[0];
    pointer(shell, "pointerup", last[0], last[1]);
    if (!currentTarget.isConnected) return true;
    return !currentTarget.dispatchEvent(
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
