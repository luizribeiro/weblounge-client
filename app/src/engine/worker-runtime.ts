import wasmBinaryUrl from "@weblounge-engine-wasm";
import { buildVersion } from "../build-version";

export interface WorkerHostPort {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  start?: () => void;
}

export interface WasmEngine {
  handle(message: string): string;
}

interface WasmModule {
  default: (input: { module_or_path: string }) => Promise<unknown>;
  create_wasm_engine: (
    buildId: string,
    instanceId: string,
    buildVersion: string,
    onEvent: (encoded: string) => void,
  ) => Promise<WasmEngine>;
}

type EngineLoader = (onEvent: (encoded: string) => void) => Promise<WasmEngine>;
type WebSocketData = string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>;

let sharedRuntime: EngineWorkerRuntime | undefined;
const historyWireTestPorts = new Set<WorkerHostPort>();
const historyWireTestBacklog: unknown[] = [];
const storageWriteTestPorts = new Set<WorkerHostPort>();
const historyWireTestPortIds = new WeakMap<WorkerHostPort, string>();
let historyWireTestInstalled = false;
let historyWireTestHeartbeatInstalled = false;
let historyWireTestInstanceId: string | undefined;
let historyWireTestHoldBefore = false;
let historyWireTestBeforeTarget: string | undefined;
let historyWireTestLatestExcept: string | undefined;
let historyWireTestHoldRequest: string | undefined;
let storageWriteTestFailuresRemaining = 0;
let storageWriteTestInstalled = false;
let historyWireNativeSend:
  | ((
      this: WebSocket,
      data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>,
    ) => void)
  | undefined;
let heldHistoryBefore:
  | {
      readonly socket: WebSocket;
      readonly data: WebSocketData;
    }
  | undefined;
let heldHistoryLatest:
  | {
      readonly socket: WebSocket;
      readonly data: WebSocketData;
    }
  | undefined;
let heldHistoryRequest:
  | {
      readonly socket: WebSocket;
      readonly data: WebSocketData;
    }
  | undefined;

if (__HISTORY_WIRE_TEST_ENABLED__) {
  historyWireTestInstalled = true;
  installHistoryWireTestTrace();
}

export function attachEnginePort(port: WorkerHostPort): void {
  sharedRuntime ??= new EngineWorkerRuntime(loadEngine);
  sharedRuntime.attach(port);
}

export class EngineWorkerRuntime {
  readonly #ports = new Set<WorkerHostPort>();
  readonly #requestPorts = new Map<string, WorkerHostPort>();
  readonly #engine: Promise<WasmEngine>;
  #activePort: WorkerHostPort | undefined;

  constructor(load: EngineLoader) {
    this.#engine = load((encoded) => this.#routeEncoded(encoded));
  }

  attach(port: WorkerHostPort): void {
    this.#ports.add(port);
    let pending = Promise.resolve();
    port.addEventListener("message", (event) => {
      if (
        __STORAGE_WRITE_TEST_ENABLED__ &&
        isRecord(event.data) &&
        event.data.type === "storage_write_test_fail_next"
      ) {
        storageWriteTestPorts.add(port);
        storageWriteTestFailuresRemaining += 1;
        installStorageWriteTestFailure();
        return;
      }
      if (
        __HISTORY_WIRE_TEST_ENABLED__ &&
        isHistoryWireTestSubscription(event.data)
      ) {
        const instanceId = historyWireTestWorkerInstanceId();
        const portId = historyWireTestPortId(port);
        historyWireTestPorts.add(port);
        for (const entry of historyWireTestBacklog) port.postMessage(entry);
        historyWireTestBacklog.length = 0;
        port.postMessage({
          type: "history_wire_test_control",
          at: historyWireTestNow(),
          event: "port_registered",
          instance_id: instanceId,
          port_id: portId,
        });
        historyWireTestHoldBefore ||= event.data.hold_before === true;
        if (typeof event.data.before_target === "string")
          historyWireTestBeforeTarget = event.data.before_target;
        if (typeof event.data.latest_except === "string")
          historyWireTestLatestExcept = event.data.latest_except;
        if (typeof event.data.hold_request === "string")
          historyWireTestHoldRequest = event.data.hold_request;
        if (!historyWireTestInstalled) {
          historyWireTestInstalled = true;
          installHistoryWireTestTrace();
        }
        installHistoryWireTestHeartbeat();
        return;
      }
      if (
        __HISTORY_WIRE_TEST_ENABLED__ &&
        isRecord(event.data) &&
        event.data.type === "history_wire_test_release_before"
      ) {
        postHistoryWireTestControl(port, "before_release_received", {
          held: heldHistoryBefore !== undefined,
        });
        releaseHeldHistoryBefore();
        return;
      }
      if (
        __HISTORY_WIRE_TEST_ENABLED__ &&
        isRecord(event.data) &&
        event.data.type === "history_wire_test_release_latest"
      ) {
        releaseHeldHistoryLatest();
        return;
      }
      if (
        __HISTORY_WIRE_TEST_ENABLED__ &&
        isRecord(event.data) &&
        event.data.type === "history_wire_test_release_request"
      ) {
        releaseHeldHistoryRequest();
        return;
      }
      if (isHostDetach(event.data)) {
        if (__HISTORY_WIRE_TEST_ENABLED__)
          postHistoryWireTestControl(port, "port_closed");
        this.#ports.delete(port);
        historyWireTestPorts.delete(port);
        storageWriteTestPorts.delete(port);
        if (this.#activePort === port) this.#activePort = this.#lastPort();
        return;
      }
      pending = pending.then(() => this.#handleMessage(port, event.data));
    });
    port.start?.();
  }

  async #handleMessage(port: WorkerHostPort, message: unknown): Promise<void> {
    try {
      if (!this.#ports.has(port)) return;
      this.#activePort = port;
      const requestId = readRequestId(message);
      if (requestId !== undefined) this.#requestPorts.set(requestId, port);
      const currentEngine = await this.#engine;
      const encoded = currentEngine.handle(JSON.stringify(message));
      const events: unknown = JSON.parse(encoded);
      if (!Array.isArray(events))
        throw new Error("engine returned a non-array response");
      for (const event of events) this.#route(event, port);
    } catch {
      port.postMessage({ type: "fatal", message_key: "engine.worker_failed" });
    }
  }

  #routeEncoded(encoded: string): void {
    this.#route(JSON.parse(encoded));
  }

  #route(event: unknown, callingPort?: WorkerHostPort): void {
    const hostedNetwork = hostedTokenNetwork(event);
    if (hostedNetwork !== undefined) {
      const port = callingPort ?? this.#activePort;
      if (port !== undefined) port.postMessage(event);
      else
        void this.#handleInternalRequest({
          type: "hosted_token_unavailable",
          network_id: hostedNetwork,
        });
      return;
    }
    if (isPushRouteRequired(event)) {
      (callingPort ?? this.#activePort)?.postMessage(event);
      return;
    }
    if (
      isRecord(event) &&
      (event.type === "command_result" ||
        event.type === "command_rejected" ||
        event.type === "focus_buffer_requested" ||
        event.type === "push_device_loaded")
    ) {
      const requestId =
        event.type === "focus_buffer_requested" ||
        event.type === "push_device_loaded"
          ? event.command_id
          : event.id;
      const port =
        typeof requestId === "string"
          ? this.#requestPorts.get(requestId)
          : undefined;
      if (
        event.type !== "focus_buffer_requested" &&
        typeof requestId === "string"
      )
        this.#requestPorts.delete(requestId);
      (port ?? callingPort)?.postMessage(event);
    } else if (isSharedStateEvent(event)) {
      for (const port of this.#ports) port.postMessage(event);
    } else {
      callingPort?.postMessage(event);
    }
  }

  async #handleInternalRequest(
    request: Record<string, unknown>,
  ): Promise<void> {
    const engine = await this.#engine;
    const encoded = engine.handle(
      JSON.stringify({
        type: "request",
        payload: { id: crypto.randomUUID(), request },
      }),
    );
    const events: unknown = JSON.parse(encoded);
    if (!Array.isArray(events))
      throw new Error("engine returned a non-array response");
    for (const event of events) this.#route(event);
  }

  #lastPort(): WorkerHostPort | undefined {
    return [...this.#ports].at(-1);
  }
}

async function loadEngine(
  onEvent: (encoded: string) => void,
): Promise<WasmEngine> {
  const imported: unknown = await import("@weblounge-engine");
  if (!isWasmModule(imported)) throw new Error("invalid wasm module");
  await imported.default({ module_or_path: wasmBinaryUrl });
  return imported.create_wasm_engine(
    __BUILD_ID__,
    crypto.randomUUID(),
    buildVersion.text,
    onEvent,
  );
}

function readRequestId(message: unknown): string | undefined {
  if (
    isRecord(message) &&
    message.type === "request" &&
    isRecord(message.payload) &&
    typeof message.payload.id === "string"
  ) {
    return message.payload.id;
  }
  return undefined;
}

function hostedTokenNetwork(event: unknown): number | undefined {
  if (
    isRecord(event) &&
    event.type === "hosted_token_required" &&
    typeof event.network_id === "number"
  ) {
    return event.network_id;
  }
  return undefined;
}

function isPushRouteRequired(event: unknown): boolean {
  return isRecord(event) && event.type === "push_route_required";
}

function isHostDetach(message: unknown): boolean {
  return isRecord(message) && message.type === "host_detach";
}

function isSharedStateEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  return (
    event.type === "network_state_changed" ||
    event.type === "push_state_changed" ||
    event.type === "buffers_changed" ||
    event.type === "buffer_added" ||
    event.type === "buffer_removed" ||
    event.type === "buffer_updated" ||
    event.type === "notifiable_message_received" ||
    event.type === "draft_key_changed" ||
    event.type === "members_changed" ||
    event.type === "timeline_changed" ||
    event.type === "typing_changed" ||
    event.type === "history_state_changed" ||
    event.type === "message_failed" ||
    event.type === "notice"
  );
}

function isWasmModule(value: unknown): value is WasmModule {
  if (!isRecord(value)) return false;
  return (
    typeof value.default === "function" &&
    typeof value.create_wasm_engine === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHistoryWireTestSubscription(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && value.type === "history_wire_test_trace_subscribe";
}

function installHistoryWireTestTrace(): void {
  if (!__HISTORY_WIRE_TEST_ENABLED__) return;
  const NativeWebSocket = globalThis.WebSocket;
  historyWireNativeSend = NativeWebSocket.prototype.send;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        const at = performance.timeOrigin + performance.now();
        void traceHistoryWireValue("received", at, event.data);
      });
    }

    override send(
      data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>,
    ) {
      const at = performance.timeOrigin + performance.now();
      const text = wireTextSync(data);
      if (
        historyWireTestHoldRequest !== undefined &&
        heldHistoryRequest === undefined &&
        text?.includes(historyWireTestHoldRequest) === true
      ) {
        heldHistoryRequest = {
          socket: this,
          data: snapshotHistoryWireData(data),
        };
        for (const port of historyWireTestPorts)
          port.postMessage({
            type: "history_wire_test_request_held",
            at,
            instance_id: historyWireTestWorkerInstanceId(),
            port_id: historyWireTestPortId(port),
            line: text,
          });
        return;
      }
      if (
        historyWireTestHoldBefore &&
        heldHistoryBefore === undefined &&
        text?.includes(
          `CHATHISTORY BEFORE ${historyWireTestBeforeTarget ?? ""}`,
        ) === true
      ) {
        heldHistoryBefore = {
          socket: this,
          data: snapshotHistoryWireData(data),
        };
        for (const port of historyWireTestPorts)
          port.postMessage({
            type: "history_wire_test_before_held",
            at,
            instance_id: historyWireTestWorkerInstanceId(),
            port_id: historyWireTestPortId(port),
            line: text,
          });
        return;
      }
      const latestTarget = historyLatestTarget(text);
      if (
        historyWireTestLatestExcept !== undefined &&
        heldHistoryLatest === undefined &&
        latestTarget !== undefined &&
        latestTarget !== historyWireTestLatestExcept
      ) {
        heldHistoryLatest = {
          socket: this,
          data: snapshotHistoryWireData(data),
        };
        for (const port of historyWireTestPorts)
          port.postMessage({
            type: "history_wire_test_latest_held",
            at,
            line: text,
          });
        return;
      }
      void traceHistoryWireValue("sent", at, data);
      super.send(data);
    }
  };
}

function installHistoryWireTestHeartbeat(): void {
  if (!__HISTORY_WIRE_TEST_ENABLED__ || historyWireTestHeartbeatInstalled)
    return;
  historyWireTestHeartbeatInstalled = true;
  setInterval(() => {
    for (const port of historyWireTestPorts)
      postHistoryWireTestControl(port, "heartbeat");
  }, 100);
}

function installStorageWriteTestFailure(): void {
  if (storageWriteTestInstalled) return;
  storageWriteTestInstalled = true;
  const nativeCommit = IDBTransaction.prototype.commit;
  IDBTransaction.prototype.commit = function () {
    if (storageWriteTestFailuresRemaining > 0 && this.mode === "readwrite") {
      storageWriteTestFailuresRemaining -= 1;
      this.abort();
      for (const port of storageWriteTestPorts)
        port.postMessage({ type: "storage_write_test_aborted" });
      return;
    }
    nativeCommit.call(this);
  };
}

function historyWireTestWorkerInstanceId(): string {
  historyWireTestInstanceId ??= crypto.randomUUID();
  return historyWireTestInstanceId;
}

function historyWireTestPortId(port: WorkerHostPort): string {
  const existing = historyWireTestPortIds.get(port);
  if (existing !== undefined) return existing;
  const created = crypto.randomUUID();
  historyWireTestPortIds.set(port, created);
  return created;
}

function postHistoryWireTestControl(
  port: WorkerHostPort,
  event: "before_release_received" | "heartbeat" | "port_closed",
  details: Readonly<Record<string, unknown>> = {},
): void {
  port.postMessage({
    type: "history_wire_test_control",
    at: historyWireTestNow(),
    event,
    instance_id: historyWireTestWorkerInstanceId(),
    port_id: historyWireTestPortId(port),
    ...details,
  });
}

function historyWireTestNow(): number {
  return performance.timeOrigin + performance.now();
}

function releaseHeldHistoryBefore(): void {
  const held = heldHistoryBefore;
  if (held === undefined) return;
  heldHistoryBefore = undefined;
  const at = performance.timeOrigin + performance.now();
  void traceHistoryWireValue("sent", at, held.data);
  historyWireNativeSend?.call(held.socket, held.data);
}

function releaseHeldHistoryLatest(): void {
  const held = heldHistoryLatest;
  if (held === undefined) return;
  heldHistoryLatest = undefined;
  const at = performance.timeOrigin + performance.now();
  void traceHistoryWireValue("sent", at, held.data);
  historyWireNativeSend?.call(held.socket, held.data);
}

function releaseHeldHistoryRequest(): void {
  const held = heldHistoryRequest;
  if (held === undefined) return;
  heldHistoryRequest = undefined;
  historyWireTestHoldRequest = undefined;
  const at = performance.timeOrigin + performance.now();
  void traceHistoryWireValue("sent", at, held.data);
  historyWireNativeSend?.call(held.socket, held.data);
}

function historyLatestTarget(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return /(?:^| )CHATHISTORY LATEST (\S+) /u.exec(text)?.[1];
}

function wireTextSync(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  return undefined;
}

export function snapshotHistoryWireData(data: WebSocketData): WebSocketData {
  if (typeof data === "string" || data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return data.slice(0);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

async function traceHistoryWireValue(
  direction: "received" | "sent",
  at: number,
  value: unknown,
): Promise<void> {
  const text = await wireText(value);
  if (text === undefined) return;
  for (const line of text.split("\r\n")) {
    if (line.length === 0) continue;
    const entry = {
      type: "history_wire_test_trace",
      at,
      direction,
      line,
    };
    if (historyWireTestPorts.size === 0) historyWireTestBacklog.push(entry);
    else for (const port of historyWireTestPorts) port.postMessage(entry);
  }
}

async function wireText(value: unknown): Promise<string | undefined> {
  if (typeof value === "string") return value;
  if (value instanceof Blob) return value.text();
  if (value instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  return undefined;
}
