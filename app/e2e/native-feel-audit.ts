import { expect, type Page } from "@playwright/test";

interface WasteCounters {
  readonly animationFrames: number;
  readonly intervals: number;
  readonly timeouts: number;
}

interface IntervalRegistration {
  readonly delay: number;
  readonly stack: string;
}

interface IntervalAllowance {
  readonly source: RegExp;
  readonly reason: string;
}

const intervalAllowList: readonly IntervalAllowance[] = [
  {
    source: /\/@vite\/client/,
    reason: "the dev server heartbeat is tooling, not application work",
  },
];
const idleObservationMilliseconds = 5_000;

interface NativeFeelMetrics extends WasteCounters {
  engineEvents: string[];
  enginePatches: number;
  intervalRegistrations: IntervalRegistration[];
  layoutShift: number;
  trackingWaste: boolean;
}

export async function installNativeFeelInstrumentation(
  page: Page,
): Promise<void> {
  await page.addInitScript(() => {
    const metrics: NativeFeelMetrics = {
      animationFrames: 0,
      engineEvents: [],
      enginePatches: 0,
      intervalRegistrations: [],
      intervals: 0,
      layoutShift: 0,
      timeouts: 0,
      trackingWaste: false,
    };
    const state = window as Window & {
      __nativeFeelMetrics?: typeof metrics;
      __setNativeVisibility?: (hidden: boolean) => void;
    };
    state.__nativeFeelMetrics = metrics;

    const addPortListener = MessagePort.prototype.addEventListener;
    const removePortListener = MessagePort.prototype.removeEventListener;
    const portListeners = new WeakMap<object, EventListener>();
    MessagePort.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message" || listener === null) {
        addPortListener.call(this, type, listener, options);
        return;
      }
      const wrapped: EventListener = (event) => {
        const data = (event as MessageEvent<unknown>).data;
        if (
          metrics.trackingWaste &&
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          typeof data.type === "string"
        ) {
          metrics.engineEvents.push(data.type);
        }
        if (
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          data.type === "messages_appended"
        ) {
          metrics.enginePatches += 1;
        }
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      portListeners.set(listener, wrapped);
      addPortListener.call(this, type, wrapped, options);
    };
    MessagePort.prototype.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      const wrapped =
        listener === null ? undefined : portListeners.get(listener);
      removePortListener.call(this, type, wrapped ?? listener, options);
    };

    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      requestFrame((time) => {
        if (metrics.trackingWaste) metrics.animationFrames += 1;
        callback(time);
      });

    const setTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) =>
      setTimeout(() => {
        if (metrics.trackingWaste) metrics.timeouts += 1;
        if (typeof handler === "function") handler(...args);
      }, timeout)) as typeof window.setTimeout;

    const setInterval = window.setInterval.bind(window);
    window.setInterval = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      metrics.intervalRegistrations.push({
        delay: timeout ?? 0,
        stack: new Error().stack ?? "unknown call site",
      });
      return setInterval(() => {
        if (metrics.trackingWaste) metrics.intervals += 1;
        if (typeof handler === "function") handler(...args);
      }, timeout);
    }) as typeof window.setInterval;

    if (typeof PerformanceObserver === "function") {
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          const shift = entry as PerformanceEntry & {
            readonly hadRecentInput: boolean;
            readonly value: number;
          };
          if (!shift.hadRecentInput) metrics.layoutShift += shift.value;
        }
      }).observe({ buffered: true, type: "layout-shift" });
    }

    let hidden = false;
    Object.defineProperties(document, {
      hidden: { configurable: true, get: () => hidden },
      visibilityState: {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      },
    });
    state.__setNativeVisibility = (nextHidden) => {
      hidden = nextHidden;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

export async function nativeFeelAudit(page: Page): Promise<void> {
  const violations = await page.locator("[data-app-root]").evaluate((root) => {
    const editable =
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
    return [root, ...root.querySelectorAll("*")].flatMap((element) => {
      if (element.closest("[data-selectable='true']") !== null) return [];
      if (element.closest(editable) !== null) return [];
      const style = getComputedStyle(element);
      const failures: string[] = [];
      if (style.userSelect !== "none") failures.push("selectable chrome");
      if (style.cursor === "text") failures.push("text cursor on chrome");
      return failures.map((failure) => `${element.tagName}: ${failure}`);
    });
  });
  expect(violations).toEqual([]);

  const selectableViolations = await page
    .locator("[data-selectable='true']")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = getComputedStyle(element);
        return style.userSelect === "text" && style.cursor === "text"
          ? []
          : [`${element.tagName}: selectable style lost`];
      }),
    );
  expect(selectableViolations).toEqual([]);

  const chromeMenuPrevented = await page
    .locator("[data-app-root]")
    .evaluate((element) => {
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(chromeMenuPrevented).toBe(true);

  const draggableChrome = await page
    .locator("[data-app-root]")
    .evaluate(
      (root) =>
        [
          ...root.querySelectorAll<HTMLAnchorElement | HTMLImageElement>(
            "a, img",
          ),
        ]
          .filter(
            (element) => element.closest("[data-selectable='true']") === null,
          )
          .filter(
            (element) =>
              element.draggable ||
              getComputedStyle(element).webkitUserDrag !== "none",
          ).length,
    );
  expect(draggableChrome).toBe(0);

  await auditSafeArea(page);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const layoutShift = await page.evaluate(
    () =>
      (
        window as Window & {
          __nativeFeelMetrics?: { readonly layoutShift: number };
        }
      ).__nativeFeelMetrics?.layoutShift ?? Number.POSITIVE_INFINITY,
  );
  expect(layoutShift).toBeLessThanOrEqual(0.01);

  await page.evaluate(() => {
    const metrics = (
      window as Window & {
        __nativeFeelMetrics?: {
          animationFrames: number;
          engineEvents: string[];
          intervals: number;
          timeouts: number;
          trackingWaste: boolean;
        };
      }
    ).__nativeFeelMetrics;
    if (metrics === undefined)
      throw new Error("native-feel metrics are missing");
    metrics.animationFrames = 0;
    metrics.engineEvents = [];
    metrics.intervals = 0;
    metrics.timeouts = 0;
    metrics.trackingWaste = true;
  });
  await page.waitForTimeout(idleObservationMilliseconds); // wait-ok: measures the fixed idle-waste window.
  const result = await page.evaluate(() => {
    const metrics = (
      window as Window & {
        __nativeFeelMetrics?: WasteCounters & {
          engineEvents: string[];
          intervalRegistrations: IntervalRegistration[];
          trackingWaste: boolean;
        };
      }
    ).__nativeFeelMetrics;
    if (metrics === undefined)
      throw new Error("native-feel metrics are missing");
    metrics.trackingWaste = false;
    return {
      registrations: metrics.intervalRegistrations,
      engineEvents: metrics.engineEvents,
      waste: {
        animationFrames: metrics.animationFrames,
        intervals: metrics.intervals,
        timeouts: metrics.timeouts,
      },
    };
  });
  const unexpectedIntervals = result.registrations.filter(
    (registration) =>
      !intervalAllowList.some((allowance) =>
        allowance.source.test(registration.stack),
      ),
  );
  const allowedReasons = intervalAllowList.map(
    (allowance) => `${allowance.source}: ${allowance.reason}`,
  );
  expect(unexpectedIntervals, `allowed intervals: ${allowedReasons}`).toEqual(
    [],
  );
  expect(
    result.waste,
    `engine events: ${result.engineEvents.join(", ")}`,
  ).toEqual({
    animationFrames: 0,
    intervals: 0,
    timeouts: 0,
  });
}

export async function auditSafeArea(page: Page): Promise<void> {
  const result = await page.locator("[data-app-root]").evaluate((root) => {
    const rootStyle = getComputedStyle(root);
    const inset = {
      top: Number.parseFloat(rootStyle.getPropertyValue("--wl-safe-top")) || 0,
      right:
        Number.parseFloat(rootStyle.getPropertyValue("--wl-safe-right")) || 0,
      bottom:
        Number.parseFloat(rootStyle.getPropertyValue("--wl-safe-bottom")) || 0,
      left:
        Number.parseFloat(rootStyle.getPropertyValue("--wl-safe-left")) || 0,
    };
    if (Object.values(inset).every((value) => value === 0)) {
      return { bottomError: 0, headerError: 0, violations: [] as string[] };
    }

    const tolerance = 1;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.clipPath === "none" &&
        Number.parseFloat(style.opacity) > 0 &&
        box.bottom > 0 &&
        box.top < innerHeight &&
        box.right > 0 &&
        box.left < innerWidth
      );
    };
    const violations: string[] = [];
    const checkRect = (rect: DOMRect, label: string) => {
      if (rect.left < inset.left - tolerance)
        violations.push(`${label} crosses the left safe area`);
      if (rect.right > innerWidth - inset.right + tolerance)
        violations.push(`${label} crosses the right safe area`);
    };

    const interactive = root.querySelectorAll(
      "button, input, textarea, select, a[href], [role='button']",
    );
    for (const element of interactive) {
      if (visible(element))
        checkRect(element.getBoundingClientRect(), element.tagName);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const parent = node.parentElement;
      if (
        node.textContent?.trim() !== "" &&
        parent !== null &&
        parent.closest("[aria-hidden='true'], script, style") === null &&
        visible(parent)
      ) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const label = `${parent.tagName}: ${node.textContent.trim().slice(0, 32)}`;
        for (const rect of range.getClientRects()) checkRect(rect, label);
      }
      node = walker.nextNode();
    }

    const headerContent = [
      ...root.querySelectorAll(
        "header button, header input, header h1, header h2, header h3, header [data-selectable]",
      ),
    ].filter(visible);
    const headerTop = Math.min(
      ...headerContent.map((element) => element.getBoundingClientRect().top),
      inset.top,
    );
    const dialog = [...root.querySelectorAll("[role='dialog']")].find(visible);
    const drawerPanel = dialog?.querySelector("aside");
    const composer = [...root.querySelectorAll("[data-composer]")].find(
      visible,
    );
    const activeBottom =
      drawerPanel === null || drawerPanel === undefined
        ? (composer?.getBoundingClientRect().bottom ??
          innerHeight - inset.bottom)
        : drawerPanel.getBoundingClientRect().bottom -
          Number.parseFloat(getComputedStyle(drawerPanel).paddingBottom);
    return {
      bottomError: Math.abs(activeBottom - (innerHeight - inset.bottom)),
      headerError: Math.max(0, inset.top - headerTop),
      violations,
    };
  });

  expect(result.violations).toEqual([]);
  expect(result.headerError).toBeLessThanOrEqual(1);
  expect(result.bottomError).toBeLessThanOrEqual(1);
}

export async function auditMessageSelection(
  page: Page,
  firstText: string,
  secondText: string,
): Promise<void> {
  const first = page.locator(
    `[data-message-text="${firstText}"] [data-selectable="true"]`,
  );
  const second = page.locator(
    `[data-message-text="${secondText}"] [data-selectable="true"]`,
  );
  await first.scrollIntoViewIfNeeded();
  await second.scrollIntoViewIfNeeded();
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  if (firstBox === null || secondBox === null)
    throw new Error("message rows are not visible");

  await page.mouse.move(firstBox.x + 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    secondBox.x + secondBox.width - 2,
    secondBox.y + secondBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();

  const selectionIsContained = await page.evaluate(() => {
    const selection = getSelection();
    const list = selection?.anchorNode?.parentElement?.closest(
      "[data-message-list]",
    );
    return (
      list !== null &&
      list !== undefined &&
      selection?.focusNode !== null &&
      list.contains(selection?.focusNode ?? null)
    );
  });
  expect(selectionIsContained).toBe(true);

  const selectableMenuPrevented = await first.evaluate((element) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(selectableMenuPrevented).toBe(false);

  await page.evaluate(() => {
    const state = window as Window & { __copiedText?: string };
    document.addEventListener(
      "copy",
      (event) => {
        state.__copiedText = event.clipboardData?.getData("text/plain") ?? "";
      },
      { once: true },
    );
  });
  await page.keyboard.press("Control+c");
  const copied = await page.evaluate(
    () => (window as Window & { __copiedText?: string }).__copiedText,
  );
  expect(copied).toMatch(
    new RegExp(
      `^\\[\\d{2}:\\d{2}\\] <native-audit> ${firstText}\\n` +
        `\\[\\d{2}:\\d{2}\\] <native-audit> ${secondText}$`,
    ),
  );
}
