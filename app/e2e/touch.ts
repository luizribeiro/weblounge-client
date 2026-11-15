import type {
  BrowserContext,
  CDPSession,
  Locator,
  Page,
} from "@playwright/test";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A finger resting on the screen until the test moves, lifts or loses it. */
export interface HeldTouch {
  readonly moveBy: (dx: number, dy: number) => Promise<void>;
  readonly lift: () => Promise<void>;
}

export async function tap(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centre(target);
  await page.touchscreen.tap(x, y);
}

/**
 * Chromium receives real touch input through CDP. Playwright's WebKit offers only taps, so a held
 * finger there is the touch pointer sequence the browser itself would dispatch to the target.
 */
export async function touchDown(
  page: Page,
  target: Locator | Point,
): Promise<HeldTouch> {
  const start = "x" in target ? target : await centre(target);
  return isChromium(page.context())
    ? cdpTouch(await page.context().newCDPSession(page), start)
    : pointerTouch(page, start);
}

async function cdpTouch(session: CDPSession, start: Point): Promise<HeldTouch> {
  let at = start;
  const send = (type: "touchStart" | "touchMove" | "touchEnd") =>
    session.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [at],
    });
  await send("touchStart");
  return {
    moveBy: async (dx, dy) => {
      const steps = 6;
      const from = at;
      for (let step = 1; step <= steps; step += 1) {
        at = {
          x: from.x + (dx * step) / steps,
          y: from.y + (dy * step) / steps,
        };
        await send("touchMove");
      }
    },
    lift: () => send("touchEnd").then(() => session.detach()),
  };
}

async function pointerTouch(page: Page, start: Point): Promise<HeldTouch> {
  let at = start;
  const dispatch = (type: string) =>
    page.evaluate(
      ({ origin, point, type }) => {
        // Touch pointers stay captured by the element they first landed on.
        const held = window as Window & {
          __heldTouchTarget?: Element | undefined;
        };
        if (type === "pointerdown")
          held.__heldTouchTarget =
            document.elementFromPoint(origin.x, origin.y) ?? undefined;
        const target = held.__heldTouchTarget;
        if (target === undefined) throw new Error("touch target is missing");
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: type === "pointermove" ? -1 : 0,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            composed: true,
            isPrimary: true,
            pointerId: 71,
            pointerType: "touch",
          }),
        );
      },
      { origin: start, point: at, type },
    );
  await dispatch("pointerdown");
  return {
    moveBy: async (dx, dy) => {
      at = { x: at.x + dx, y: at.y + dy };
      await dispatch("pointermove");
    },
    lift: () => dispatch("pointerup"),
  };
}

async function centre(target: Locator): Promise<Point> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("touch target is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function isChromium(context: BrowserContext): boolean {
  return context.browser()?.browserType().name() === "chromium";
}
