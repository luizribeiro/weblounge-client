import wasmBinaryUrl from "@weblounge-engine-wasm";
import {
  requiresAuthorization,
  SessionTokenError,
  SessionTokenProvider,
} from "../hosted/session-token";

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
    onEvent: (encoded: string) => void,
  ) => Promise<WasmEngine>;
}

type EngineLoader = (onEvent: (encoded: string) => void) => Promise<WasmEngine>;
type HostedProvider = Pick<SessionTokenProvider, "acquire">;
type HostedProviderFactory = (endpoint: string) => HostedProvider;
type RetryScheduler = (callback: () => void, delay: number) => void;

let sharedRuntime: EngineWorkerRuntime | undefined;

export function attachEnginePort(port: WorkerHostPort): void {
  sharedRuntime ??= new EngineWorkerRuntime(loadEngine);
  sharedRuntime.attach(port);
}

export class EngineWorkerRuntime {
  readonly #ports = new Set<WorkerHostPort>();
  readonly #requestPorts = new Map<string, WorkerHostPort>();
  readonly #engine: Promise<WasmEngine>;
  readonly #hostedProviderFactory: HostedProviderFactory;
  readonly #scheduleRetry: RetryScheduler;
  #hostedProvider: HostedProvider | undefined;
  #hostedRefreshPending = false;
  #hostedRetry = 0;

  constructor(
    load: EngineLoader,
    hostedProviderFactory: HostedProviderFactory = (endpoint) =>
      new SessionTokenProvider(endpoint),
    scheduleRetry: RetryScheduler = (callback, delay) => {
      setTimeout(callback, delay);
    },
  ) {
    this.#engine = load((encoded) => this.#routeEncoded(encoded));
    this.#hostedProviderFactory = hostedProviderFactory;
    this.#scheduleRetry = scheduleRetry;
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
      this.#rememberHostedProvider(message);
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
      this.#refreshHostedToken(hostedNetwork);
      return;
    }
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

  #rememberHostedProvider(message: unknown): void {
    const endpoint = hostedSessionTokenEndpoint(message);
    if (endpoint === undefined) return;
    this.#hostedProvider = this.#hostedProviderFactory(endpoint);
    this.#hostedRetry = 0;
  }

  #refreshHostedToken(networkId: number): void {
    if (this.#hostedRefreshPending) return;
    const provider = this.#hostedProvider;
    if (provider === undefined) {
      this.#broadcastHostedFailure();
      return;
    }
    this.#hostedRefreshPending = true;
    void provider
      .acquire()
      .then((token) => {
        this.#hostedRetry = 0;
        return this.#handleInternalRequest({
          type: "reconnect_hosted",
          network_id: networkId,
          oauth_token: token.accessToken,
        });
      })
      .catch((error: unknown) => {
        if (requiresAuthorization(error)) {
          this.#hostedRetry = 0;
          return this.#handleInternalRequest({
            type: "expire_hosted_authentication",
            network_id: networkId,
          });
        }
        if (error instanceof SessionTokenError && error.kind === "transient") {
          const delay = Math.min(1_000 * 2 ** this.#hostedRetry, 30_000);
          this.#hostedRetry += 1;
          this.#scheduleRetry(() => this.#refreshHostedToken(networkId), delay);
          return;
        }
        this.#broadcastHostedFailure();
      })
      .finally(() => {
        this.#hostedRefreshPending = false;
      });
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

  #broadcastHostedFailure(): void {
    const notice = {
      type: "notice",
      key: "engine.connection_failed",
      values: {},
      tone: "neutral",
      action: null,
    };
    for (const port of this.#ports) port.postMessage(notice);
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

function hostedSessionTokenEndpoint(message: unknown): string | undefined {
  if (
    isRecord(message) &&
    message.type === "request" &&
    isRecord(message.payload) &&
    isRecord(message.payload.request) &&
    message.payload.request.type === "connect_hosted" &&
    typeof message.payload.request.session_token_endpoint === "string"
  ) {
    return message.payload.request.session_token_endpoint;
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

function isSharedStateEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  return (
    event.type === "network_state_changed" ||
    event.type === "buffers_changed" ||
    event.type === "chat_list_snapshot_loaded" ||
    event.type === "chat_list_live" ||
    event.type === "buffer_added" ||
    event.type === "buffer_updated" ||
    event.type === "draft_key_changed" ||
    event.type === "members_changed" ||
    event.type === "messages_appended" ||
    event.type === "message_updated" ||
    event.type === "messages_prepended" ||
    event.type === "history_state_changed" ||
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
