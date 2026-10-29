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
  default: (module: string) => Promise<unknown>;
  WasmEngine: new (
    buildId: string,
    instanceId: string,
    onEvent: (encoded: string) => void,
  ) => WasmEngine;
}

type EngineLoader = (onEvent: (encoded: string) => void) => Promise<WasmEngine>;

const wasmBinaryUrl = "/engine_bg.wasm";
let sharedRuntime: EngineWorkerRuntime | undefined;

export function attachEnginePort(port: WorkerHostPort): void {
  sharedRuntime ??= new EngineWorkerRuntime(loadEngine);
  sharedRuntime.attach(port);
}

export class EngineWorkerRuntime {
  readonly #ports = new Set<WorkerHostPort>();
  readonly #requestPorts = new Map<string, WorkerHostPort>();
  readonly #engine: Promise<WasmEngine>;

  constructor(load: EngineLoader) {
    this.#engine = load((encoded) => this.#routeEncoded(encoded));
  }

  attach(port: WorkerHostPort): void {
    this.#ports.add(port);
    let pending = Promise.resolve();
    port.addEventListener("message", (event) => {
      pending = pending.then(() => this.#handleMessage(port, event.data));
    });
    port.start?.();
  }

  async #handleMessage(port: WorkerHostPort, message: unknown): Promise<void> {
    try {
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
    if (
      isRecord(event) &&
      (event.type === "command_result" ||
        event.type === "command_rejected" ||
        event.type === "focus_buffer_requested")
    ) {
      const requestId =
        event.type === "focus_buffer_requested" ? event.command_id : event.id;
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
}

async function loadEngine(
  onEvent: (encoded: string) => void,
): Promise<WasmEngine> {
  const imported: unknown = await import("@weblounge-engine");
  if (!isWasmModule(imported)) throw new Error("invalid wasm module");
  await imported.default(wasmBinaryUrl);
  return new imported.WasmEngine(__BUILD_ID__, crypto.randomUUID(), onEvent);
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

function isSharedStateEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  return (
    event.type === "network_state_changed" ||
    event.type === "buffers_changed" ||
    event.type === "buffer_added" ||
    event.type === "buffer_updated" ||
    event.type === "members_changed" ||
    event.type === "messages_appended" ||
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
    typeof value.WasmEngine === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
