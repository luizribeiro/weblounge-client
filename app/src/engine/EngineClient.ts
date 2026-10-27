import type {
  CommandEnvelope,
  CommandResult,
  EngineClientMessage,
  EngineToUi,
  Hello,
  IncompatibleBuild,
  ResyncReason,
  UiToEngine,
  Unsubscribe,
  VisibilityState,
  WorkerHostError,
} from "./protocol";

export interface EngineClient {
  start(hello: Hello): Promise<void>;
  send(command: CommandEnvelope): Promise<CommandResult>;
  requestSnapshot(reason: ResyncReason): void;
  setVisibility(state: VisibilityState): void;
  subscribe(listener: (message: EngineClientMessage) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface EnginePort {
  postMessage(message: UiToEngine): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  start?: () => void;
}

export interface EngineConnection {
  port: EnginePort;
  close(): void;
}

type FrameScheduler = (callback: FrameRequestCallback) => number;

interface StartWaiter {
  resolve: () => void;
  reject: (reason: Error) => void;
}

interface CommandWaiter {
  resolve: (result: CommandResult) => void;
  reject: (reason: Error) => void;
}

export class IncompatibleBuildError extends Error {
  constructor(readonly mismatch: IncompatibleBuild) {
    super(`engine build ${mismatch.engine} does not match UI ${mismatch.ui}`);
    this.name = "IncompatibleBuildError";
  }
}

export class WorkerEngineClient implements EngineClient {
  readonly #connection: EngineConnection;
  readonly #scheduleFrame: FrameScheduler;
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();
  readonly #commands = new Map<string, CommandWaiter>();
  readonly #renderQueue: EngineToUi[] = [];
  readonly #initialMessages: EngineClientMessage[];
  #startWaiter: StartWaiter | undefined;
  #framePending = false;
  #closed = false;

  constructor(
    connection: EngineConnection,
    scheduleFrame: FrameScheduler = (callback) =>
      requestAnimationFrame(callback),
    initialMessages: readonly EngineClientMessage[] = [],
  ) {
    this.#connection = connection;
    this.#scheduleFrame = scheduleFrame;
    this.#initialMessages = [...initialMessages];
    connection.port.addEventListener("message", this.#onMessage);
    connection.port.start?.();
  }

  start(hello: Hello): Promise<void> {
    this.#assertOpen();
    if (this.#startWaiter !== undefined) {
      return Promise.reject(new Error("engine handshake already pending"));
    }

    const started = new Promise<void>((resolve, reject) => {
      this.#startWaiter = { resolve, reject };
    });
    this.#connection.port.postMessage({ type: "hello", payload: hello });
    return started;
  }

  send(command: CommandEnvelope): Promise<CommandResult> {
    this.#assertOpen();
    if (this.#commands.has(command.id)) {
      return Promise.reject(new Error(`duplicate command id: ${command.id}`));
    }

    const result = new Promise<CommandResult>((resolve, reject) => {
      this.#commands.set(command.id, { resolve, reject });
    });
    this.#connection.port.postMessage({ type: "command", payload: command });
    return result;
  }

  requestSnapshot(_reason: ResyncReason): void {}

  setVisibility(_state: VisibilityState): void {}

  subscribe(listener: (message: EngineClientMessage) => void): Unsubscribe {
    this.#listeners.add(listener);
    for (const message of this.#initialMessages.splice(0)) {
      this.#publish(message);
    }
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.port.removeEventListener("message", this.#onMessage);
    this.#connection.close();
    const error = new Error("engine client closed");
    this.#startWaiter?.reject(error);
    this.#startWaiter = undefined;
    for (const waiter of this.#commands.values()) waiter.reject(error);
    this.#commands.clear();
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = decodeWorkerMessage(event.data);
    if (message.type === "fatal") {
      this.#publish(message);
      return;
    }
    if (message.type === "command_result") {
      const waiter = this.#commands.get(message.id);
      this.#commands.delete(message.id);
      waiter?.resolve(message);
      this.#publish(message);
      return;
    }
    if (message.type === "ready") {
      this.#startWaiter?.resolve();
      this.#startWaiter = undefined;
      this.#publish(message);
      return;
    }
    if (message.type === "incompatible_build") {
      this.#rejectIncompatibleBuild(message);
      this.#publish(message);
      return;
    }
    this.#renderQueue.push(message);
    if (this.#framePending) return;
    this.#framePending = true;
    this.#scheduleFrame(() => this.#flushRenderQueue());
  };

  #flushRenderQueue(): void {
    this.#framePending = false;
    const messages = this.#renderQueue.splice(0);
    for (const message of messages) this.#publish(message);
  }

  #rejectIncompatibleBuild(message: IncompatibleBuild): void {
    this.#startWaiter?.reject(new IncompatibleBuildError(message));
    this.#startWaiter = undefined;
  }

  #publish(message: EngineClientMessage): void {
    for (const listener of this.#listeners) listener(message);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("engine client is closed");
  }
}

function decodeWorkerMessage(value: unknown): EngineClientMessage {
  if (isRecord(value) && value.type === "fatal") {
    return decodeWorkerHostError(value);
  }
  return decodeEngineMessage(value);
}

function decodeWorkerHostError(
  value: Record<string, unknown>,
): WorkerHostError {
  if (typeof value.message_key === "string") {
    return { type: "fatal", message_key: value.message_key };
  }
  throw new Error("invalid worker host error");
}

function decodeEngineMessage(value: unknown): EngineToUi {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !isEngineMessageType(value.type)
  ) {
    throw new Error("invalid engine message");
  }

  const messageType = value.type;
  switch (messageType) {
    case "ready":
      if (
        typeof value.engine_instance === "string" &&
        typeof value.revision === "number"
      ) {
        return {
          type: "ready",
          engine_instance: value.engine_instance,
          revision: value.revision,
        };
      }
      break;
    case "incompatible_build":
      if (typeof value.engine === "string" && typeof value.ui === "string") {
        return {
          type: "incompatible_build",
          engine: value.engine,
          ui: value.ui,
        };
      }
      break;
    case "diagnostic":
      if (
        typeof value.command_id === "string" &&
        typeof value.message === "string"
      ) {
        return {
          type: "diagnostic",
          command_id: value.command_id,
          message: value.message,
        };
      }
      break;
    case "notice":
      if (typeof value.message_key === "string") {
        return { type: "notice", message_key: value.message_key };
      }
      break;
    case "command_result":
      if (typeof value.id === "string")
        return { type: "command_result", id: value.id };
      break;
    default:
      return assertNever(messageType);
  }

  throw new Error("invalid engine message");
}

function isEngineMessageType(value: string): value is EngineToUi["type"] {
  return (
    value === "ready" ||
    value === "incompatible_build" ||
    value === "diagnostic" ||
    value === "notice" ||
    value === "command_result"
  );
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine message type: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
