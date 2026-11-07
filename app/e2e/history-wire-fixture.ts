import type { Page } from "@playwright/test";

export interface WireTrace {
  readonly at: number;
  readonly direction: "control" | "received" | "sent";
  readonly event?: string;
  readonly held?: boolean;
  readonly instance_id?: string;
  readonly line: string;
  readonly port_id?: string;
}

export interface ProjectionTrace {
  readonly at: number;
  readonly event: {
    readonly type?: string;
    readonly buffer?: {
      readonly sync_state?: string;
      readonly title?: string;
    };
    readonly network?: {
      readonly state?: unknown;
    };
  };
}

export async function captureHistoryWire(
  page: Page,
  options: {
    readonly beforeTarget?: string;
    readonly latestExcept?: string;
  } = {},
): Promise<void> {
  await page.addInitScript((settings) => {
    Reflect.deleteProperty(globalThis, "SharedWorker");
    const NativeWorker = Worker;
    let workerScript: string | URL | undefined;
    let workerOptions: WorkerOptions | undefined;
    globalThis.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        workerScript ??= scriptURL;
        workerOptions ??= options;
      }
    };
    const timeline: unknown[] = [];
    const projections: unknown[] = [];
    const heldLatest: unknown[] = [];
    const subscribedWorkers = new WeakSet<Worker>();
    Reflect.set(globalThis, "historyWireTimeline", timeline);
    Reflect.set(globalThis, "historyProjectionTimeline", projections);
    Reflect.set(globalThis, "historyHeldLatest", heldLatest);
    let beforeHoldingWorker: Worker | undefined;
    let latestHoldingWorker: Worker | undefined;
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, workerOptions) {
      if (!subscribedWorkers.has(this)) {
        subscribedWorkers.add(this);
        Reflect.apply(postMessage, this, [
          {
            type: "history_wire_test_trace_subscribe",
            hold_before: settings.beforeTarget !== undefined,
            before_target: settings.beforeTarget,
            latest_except: settings.latestExcept,
          },
        ]);
      }
      Reflect.apply(postMessage, this, [message, workerOptions]);
    };
    const addListener = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      listenerOptions?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message" || listener === null) {
        addListener.call(this, type, listener, listenerOptions);
        return;
      }
      const wrapped: EventListener = (rawEvent) => {
        const event = rawEvent as MessageEvent<unknown>;
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          event.data.type === "history_wire_test_trace"
        ) {
          timeline.push(event.data);
          return;
        }
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          event.data.type === "history_wire_test_control"
        ) {
          timeline.push({
            ...event.data,
            direction: "control",
            line: event.data.event,
          });
          return;
        }
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          event.data.type === "history_wire_test_before_held"
        ) {
          beforeHoldingWorker = this;
          Reflect.set(globalThis, "historyHeldBefore", event.data);
          timeline.push({
            at: event.data.at,
            direction: "control",
            event: "before_held",
            instance_id: event.data.instance_id,
            line: "before_held",
            port_id: event.data.port_id,
          });
          return;
        }
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          event.data.type === "history_wire_test_latest_held"
        ) {
          latestHoldingWorker = this;
          heldLatest.push(event.data);
          return;
        }
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "type" in event.data &&
          (event.data.type === "buffer_updated" ||
            event.data.type === "network_state_changed")
        )
          projections.push({ at: performance.now(), event: event.data });
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      addListener.call(this, type, wrapped, listenerOptions);
    };
    Reflect.set(globalThis, "releaseHeldHistoryBefore", () => {
      beforeHoldingWorker?.postMessage({
        type: "history_wire_test_release_before",
      });
    });
    Reflect.set(globalThis, "releaseHeldHistoryLatest", () => {
      latestHoldingWorker?.postMessage({
        type: "history_wire_test_release_latest",
      });
    });
    Reflect.set(globalThis, "closeUnrelatedHistoryWireWorker", () => {
      if (workerScript === undefined) throw new Error("engine worker missing");
      const worker = new Worker(workerScript, workerOptions);
      worker.postMessage({ type: "history_wire_test_trace_subscribe" });
      worker.terminate();
    });
  }, options);
}

export async function closeUnrelatedHistoryWireWorker(
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    const close = Reflect.get(globalThis, "closeUnrelatedHistoryWireWorker");
    if (typeof close !== "function")
      throw new Error("history worker interference missing");
    close();
  });
}

export function heldLatestHistoryCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const held = Reflect.get(globalThis, "historyHeldLatest");
    return Array.isArray(held) ? held.length : 0;
  });
}

export async function releaseHeldLatestHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const release = Reflect.get(globalThis, "releaseHeldHistoryLatest");
    if (typeof release !== "function") throw new Error("history gate missing");
    release();
  });
}
