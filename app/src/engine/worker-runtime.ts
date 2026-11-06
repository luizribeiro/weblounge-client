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

let sharedRuntime: EngineWorkerRuntime | undefined;
const historyWireTestPorts = new Set<WorkerHostPort>();

installHistoryWireTestTrace();

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
        __HISTORY_WIRE_TEST_ENABLED__ &&
        isHistoryWireTestSubscription(event.data)
      ) {
        historyWireTestPorts.add(port);
        return;
      }
      if (isHostDetach(event.data)) {
        this.#ports.delete(port);
        historyWireTestPorts.delete(port);
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
    event.type === "chat_list_snapshot_loaded" ||
    event.type === "chat_list_live" ||
    event.type === "buffer_added" ||
    event.type === "buffer_removed" ||
    event.type === "buffer_updated" ||
    event.type === "draft_key_changed" ||
    event.type === "members_changed" ||
    event.type === "messages_appended" ||
    event.type === "typing_changed" ||
    event.type === "message_updated" ||
    event.type === "messages_prepended" ||
    event.type === "history_state_changed" ||
    event.type === "membership_changed" ||
    event.type === "message_confirmed" ||
    event.type === "message_failed" ||
    event.type === "notice" ||
    event.type === "unread_changed"
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

function isHistoryWireTestSubscription(value: unknown): boolean {
  return isRecord(value) && value.type === "history_wire_test_trace_subscribe";
}

function installHistoryWireTestTrace(): void {
  if (!__HISTORY_WIRE_TEST_ENABLED__) return;
  const NativeWebSocket = globalThis.WebSocket;
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
      void traceHistoryWireValue("sent", at, data);
      super.send(data);
    }
  };
}

async function traceHistoryWireValue(
  direction: "received" | "sent",
  at: number,
  value: unknown,
): Promise<void> {
  const text = await wireText(value);
  if (text === undefined) return;
  for (const line of text.split("\r\n")) {
    if (!/(?:^| )(?:CHATHISTORY|MARKREAD|WHO|BATCH) /u.test(line)) continue;
    for (const port of historyWireTestPorts)
      port.postMessage({
        type: "history_wire_test_trace",
        at,
        direction,
        line,
      });
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
