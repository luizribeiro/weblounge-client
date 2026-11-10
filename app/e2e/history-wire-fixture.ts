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
    readonly message?: {
      readonly id?: number;
      readonly text?: string;
    };
  };
}

export async function captureHistoryWire(
  page: Page,
  options: {
    readonly beforeTarget?: string;
    readonly holdRequest?: string;
    readonly latestExcept?: string;
  } = {},
): Promise<void> {
  await page.addInitScript((settings) => {
    Reflect.deleteProperty(globalThis, "SharedWorker");
    const NativeWorker = Worker;
    let historyWorker: Worker | undefined;
    let workerScript: string | URL | undefined;
    let workerOptions: WorkerOptions | undefined;
    globalThis.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        historyWorker = this;
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
    let beforeHoldingIdentity:
      | { readonly instance_id: string; readonly port_id: string }
      | undefined;
    let latestHoldingWorker: Worker | undefined;
    let requestHoldingWorker: Worker | undefined;
    const pageControl = (
      event: string,
      line = event,
      details: Readonly<Record<string, unknown>> = {},
    ) => {
      const entry = {
        type: "history_wire_test_control",
        at: performance.timeOrigin + performance.now(),
        direction: "control",
        event,
        line,
        ...details,
      };
      timeline.push(entry);
      return entry;
    };
    globalThis.addEventListener("error", (event) => {
      pageControl("page_error", event.message);
    });
    globalThis.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      pageControl(
        "page_unhandled_rejection",
        reason instanceof Error ? reason.message : String(reason),
      );
    });
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, workerOptions) {
      if (!subscribedWorkers.has(this)) {
        subscribedWorkers.add(this);
        Reflect.apply(postMessage, this, [
          {
            type: "history_wire_test_trace_subscribe",
            hold_before: settings.beforeTarget !== undefined,
            before_target: settings.beforeTarget,
            hold_request: settings.holdRequest,
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
          event.data.type === "history_wire_test_request_held"
        ) {
          requestHoldingWorker = this;
          Reflect.set(globalThis, "historyHeldRequest", event.data);
          timeline.push({
            at: event.data.at,
            direction: "control",
            event: "request_held",
            instance_id: event.data.instance_id,
            line: event.data.line,
            port_id: event.data.port_id,
          });
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
          beforeHoldingIdentity = {
            instance_id: event.data.instance_id,
            port_id: event.data.port_id,
          };
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
            event.data.type === "message_updated" ||
            event.data.type === "network_state_changed")
        )
          projections.push({ at: performance.now(), event: event.data });
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      addListener.call(this, type, wrapped, listenerOptions);
    };
    Reflect.set(globalThis, "releaseHeldHistoryBefore", () => {
      try {
        if (beforeHoldingWorker === undefined)
          throw new Error("holding history worker missing");
        pageControl(
          "before_release_posting",
          "before_release_posting",
          beforeHoldingIdentity,
        );
        beforeHoldingWorker.postMessage({
          type: "history_wire_test_release_before",
        });
        return pageControl(
          "before_release_posted",
          "before_release_posted",
          beforeHoldingIdentity,
        );
      } catch (error) {
        pageControl(
          "before_release_post_failed",
          error instanceof Error ? error.message : String(error),
          beforeHoldingIdentity,
        );
        throw error;
      }
    });
    Reflect.set(globalThis, "releaseHeldHistoryLatest", () => {
      latestHoldingWorker?.postMessage({
        type: "history_wire_test_release_latest",
      });
    });
    Reflect.set(globalThis, "releaseHeldHistoryRequest", () => {
      requestHoldingWorker?.postMessage({
        type: "history_wire_test_release_request",
      });
    });
    Reflect.set(globalThis, "holdHistoryRequest", (request: string) => {
      if (historyWorker === undefined) throw new Error("engine worker missing");
      historyWorker.postMessage({
        type: "history_wire_test_trace_subscribe",
        hold_request: request,
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

export function heldHistoryRequestCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    Reflect.get(globalThis, "historyHeldRequest") === undefined ? 0 : 1,
  );
}

export async function holdHistoryRequest(
  page: Page,
  request: string,
): Promise<void> {
  await page.evaluate((value) => {
    const hold = Reflect.get(globalThis, "holdHistoryRequest");
    if (typeof hold !== "function")
      throw new Error("history request gate missing");
    hold(value);
  }, request);
}

export async function releaseHeldHistoryRequest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const release = Reflect.get(globalThis, "releaseHeldHistoryRequest");
    if (typeof release !== "function")
      throw new Error("history request gate missing");
    release();
  });
}

export function historyMessageUpdateCount(
  page: Page,
  text: string,
): Promise<number> {
  return page.evaluate((expected) => {
    const entries = Reflect.get(globalThis, "historyProjectionTimeline");
    if (!Array.isArray(entries)) return 0;
    const ids = entries.flatMap((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("event" in entry) ||
        typeof entry.event !== "object" ||
        entry.event === null ||
        !("type" in entry.event) ||
        entry.event.type !== "message_updated" ||
        !("message" in entry.event) ||
        typeof entry.event.message !== "object" ||
        entry.event.message === null ||
        !("text" in entry.event.message) ||
        entry.event.message.text !== expected ||
        !("id" in entry.event.message) ||
        typeof entry.event.message.id !== "number"
      )
        return [];
      return [entry.event.message.id];
    });
    return new Set(ids).size;
  }, text);
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
