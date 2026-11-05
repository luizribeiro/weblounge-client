import type { Page, WebWorker } from "@playwright/test";

interface ClockTimer {
  readonly args: readonly unknown[];
  readonly at: number;
  readonly callback: TimerHandler;
}

interface ClockedWorkerGlobal {
  __webloungeAdvanceClock?: ((milliseconds: number) => void) | undefined;
}

export async function installEngineClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
}

export async function startEngineClock(page: Page): Promise<void> {
  await engineWorker(page).evaluate(() => {
    const scope = globalThis as typeof globalThis & ClockedWorkerGlobal;
    const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const epoch = Date.now();
    const origin = performance.now();
    let elapsed = 0;
    let nextTimer = 1_000_000;
    const timers = new Map<number, ClockTimer>();
    Object.defineProperty(Date, "now", { value: () => epoch + elapsed });
    Object.defineProperty(performance, "now", {
      value: () => origin + elapsed,
    });
    Object.defineProperty(globalThis, "setTimeout", {
      value: (callback: TimerHandler, delay = 0, ...args: unknown[]) => {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, {
          args,
          at: elapsed + Number(delay),
          callback,
        });
        return id;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      value: (id: number) =>
        timers.delete(Number(id)) || nativeClearTimeout(id),
    });
    scope.__webloungeAdvanceClock = (milliseconds) => {
      elapsed += milliseconds;
      const pending = [...timers].sort(
        (left, right) => left[1].at - right[1].at,
      );
      for (const [id, timer] of pending) {
        if (timer.at > elapsed) break;
        timers.delete(id);
        if (typeof timer.callback === "function") {
          timer.callback(...timer.args);
        }
      }
    };
  });
}

export async function advanceEngineClock(
  page: Page,
  milliseconds: number,
): Promise<void> {
  await engineWorker(page).evaluate((advanceBy) => {
    const advance = (globalThis as ClockedWorkerGlobal).__webloungeAdvanceClock;
    if (advance === undefined)
      throw new Error("engine worker clock unavailable");
    advance(advanceBy);
  }, milliseconds);
}

function engineWorker(page: Page): WebWorker {
  const workers = page.workers();
  if (workers.length !== 1) {
    throw new Error(`expected one engine worker, found ${workers.length}`);
  }
  const worker = workers[0];
  if (worker === undefined) throw new Error("engine worker unavailable");
  return worker;
}
