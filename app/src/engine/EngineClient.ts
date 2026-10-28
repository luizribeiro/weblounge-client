import { decodeCommandSpecs } from "./decodeCommandSpec";
import type {
  BufferProjection,
  CommandRejected,
  CommandResult,
  EngineClientMessage,
  EngineRequestEnvelope,
  EngineToUi,
  Hello,
  IncompatibleBuild,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
  ResyncReason,
  UiToEngine,
  Unsubscribe,
  VisibilityState,
  WorkerHostError,
} from "./protocol";

export interface EngineClient {
  start(hello: Hello): Promise<void>;
  send(request: EngineRequestEnvelope): Promise<CommandResult>;
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

interface RequestWaiter {
  resolve: (result: CommandResult) => void;
  reject: (reason: Error) => void;
}

export class IncompatibleBuildError extends Error {
  constructor(readonly mismatch: IncompatibleBuild) {
    super(`engine build ${mismatch.engine} does not match UI ${mismatch.ui}`);
    this.name = "IncompatibleBuildError";
  }
}

export class EngineCommandError extends Error {
  constructor(readonly rejection: CommandRejected) {
    super(rejection.message_key);
    this.name = "EngineCommandError";
  }

  get messageKey(): string {
    return this.rejection.message_key;
  }
}

export class WorkerEngineClient implements EngineClient {
  readonly #connection: EngineConnection;
  readonly #scheduleFrame: FrameScheduler;
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();
  readonly #requests = new Map<string, RequestWaiter>();
  readonly #renderQueue: EngineToUi[] = [];
  readonly #initialMessages: EngineClientMessage[];
  #startWaiter: StartWaiter | undefined;
  #framePending = false;
  #visibility: VisibilityState = "visible";
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

  send(request: EngineRequestEnvelope): Promise<CommandResult> {
    this.#assertOpen();
    if (this.#requests.has(request.id)) {
      return Promise.reject(new Error(`duplicate request id: ${request.id}`));
    }

    const result = new Promise<CommandResult>((resolve, reject) => {
      this.#requests.set(request.id, { resolve, reject });
    });
    this.#connection.port.postMessage({ type: "request", payload: request });
    return result;
  }

  requestSnapshot(_reason: ResyncReason): void {}

  setVisibility(state: VisibilityState): void {
    this.#visibility = state;
    if (state === "visible" && this.#renderQueue.length > 0) {
      this.#scheduleRenderFrame();
    }
  }

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
    for (const waiter of this.#requests.values()) waiter.reject(error);
    this.#requests.clear();
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = decodeWorkerMessage(event.data);
    if (message.type === "fatal") {
      this.#publish(message);
      return;
    }
    if (message.type === "command_result") {
      const waiter = this.#requests.get(message.id);
      this.#requests.delete(message.id);
      waiter?.resolve(message);
      this.#enqueueForFrame(message);
      return;
    }
    if (message.type === "command_rejected") {
      const waiter = this.#requests.get(message.id);
      this.#requests.delete(message.id);
      waiter?.reject(new EngineCommandError(message));
      this.#enqueueForFrame(message);
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
    this.#enqueueForFrame(message);
  };

  #enqueueForFrame(message: EngineToUi): void {
    this.#renderQueue.push(message);
    if (this.#visibility === "hidden") return;
    if (containsOptimisticMessage(message)) {
      this.#drainRenderQueue();
      return;
    }
    this.#scheduleRenderFrame();
  }

  #scheduleRenderFrame(): void {
    if (this.#framePending) return;
    this.#framePending = true;
    this.#scheduleFrame(() => this.#flushRenderQueue());
  }

  #flushRenderQueue(): void {
    this.#framePending = false;
    if (this.#visibility === "hidden") return;
    this.#drainRenderQueue();
  }

  #drainRenderQueue(): void {
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

function containsOptimisticMessage(message: EngineToUi): boolean {
  return (
    message.type === "messages_appended" &&
    message.messages.some((item) => item.delivery === "optimistic")
  );
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
    case "command_specs_changed": {
      const specs = decodeCommandSpecs(value.specs);
      if (specs !== undefined) return { type: messageType, specs };
      break;
    }
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
    case "command_help_requested":
      if (value.command === null || typeof value.command === "string") {
        return { type: messageType, command: value.command };
      }
      break;
    case "command_result":
      if (typeof value.id === "string")
        return { type: "command_result", id: value.id };
      break;
    case "command_rejected":
      if (
        typeof value.id === "string" &&
        typeof value.message_key === "string"
      ) {
        return {
          type: "command_rejected",
          id: value.id,
          message_key: value.message_key,
        };
      }
      break;
    case "completion_result":
      if (
        typeof value.command_id === "string" &&
        typeof value.buffer_id === "number" &&
        typeof value.prefix === "string" &&
        Array.isArray(value.candidates) &&
        value.candidates.every((candidate) => typeof candidate === "string")
      ) {
        return {
          type: "completion_result",
          command_id: value.command_id,
          buffer_id: value.buffer_id,
          prefix: value.prefix,
          candidates: value.candidates,
        };
      }
      break;
    case "focus_buffer_requested":
      if (
        typeof value.command_id === "string" &&
        typeof value.buffer_id === "number"
      ) {
        return {
          type: "focus_buffer_requested",
          command_id: value.command_id,
          buffer_id: value.buffer_id,
        };
      }
      break;
    case "network_state_changed": {
      const network = decodeNetwork(value.network);
      if (network !== undefined) return { type: messageType, network };
      break;
    }
    case "buffers_changed": {
      const buffers = decodeArray(value.buffers, decodeBuffer);
      if (typeof value.network_id === "number" && buffers !== undefined) {
        return {
          type: messageType,
          network_id: value.network_id,
          buffers,
        };
      }
      break;
    }
    case "buffer_added":
    case "buffer_updated": {
      const buffer = decodeBuffer(value.buffer);
      if (buffer !== undefined) return { type: messageType, buffer };
      break;
    }
    case "messages_appended": {
      const messages = decodeArray(value.messages, decodeMessage);
      if (typeof value.buffer_id === "number" && messages !== undefined) {
        return { type: messageType, buffer_id: value.buffer_id, messages };
      }
      break;
    }
    case "messages_prepended": {
      const messages = decodeArray(value.messages, decodeMessage);
      if (typeof value.buffer_id === "number" && messages !== undefined) {
        return { type: messageType, buffer_id: value.buffer_id, messages };
      }
      break;
    }
    case "membership_changed": {
      const membership = decodeMembership(value.membership);
      if (typeof value.buffer_id === "number" && membership !== undefined) {
        return { type: messageType, buffer_id: value.buffer_id, membership };
      }
      break;
    }
    case "members_changed": {
      const members = decodeArray(value.members, decodeMember);
      const counts = decodeMemberCounts(value.counts);
      if (
        typeof value.buffer_id === "number" &&
        typeof value.view_id === "string" &&
        typeof value.version === "number" &&
        typeof value.window_size === "number" &&
        typeof value.offset === "number" &&
        typeof value.total === "number" &&
        (value.filter === undefined || typeof value.filter === "string") &&
        counts !== undefined &&
        members !== undefined
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          view_id: value.view_id,
          version: value.version,
          window_size: value.window_size,
          offset: value.offset,
          total: value.total,
          counts,
          members,
          ...(typeof value.filter === "string" ? { filter: value.filter } : {}),
        };
      }
      break;
    }
    case "message_confirmed": {
      const message = decodeMessage(value.message);
      if (
        typeof value.buffer_id === "number" &&
        typeof value.local_send_id === "number" &&
        message !== undefined
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          local_send_id: value.local_send_id,
          message,
        };
      }
      break;
    }
    case "message_failed":
      if (
        typeof value.buffer_id === "number" &&
        typeof value.local_send_id === "number" &&
        typeof value.message_key === "string"
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          local_send_id: value.local_send_id,
          message_key: value.message_key,
        };
      }
      break;
    case "unread_changed":
      if (
        typeof value.buffer_id === "number" &&
        typeof value.unread === "number" &&
        typeof value.mentions === "number"
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          unread: value.unread,
          mentions: value.mentions,
        };
      }
      break;
    case "read_marker_moved":
      if (
        typeof value.buffer_id === "number" &&
        (value.through === null || typeof value.through === "number")
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          through: value.through,
        };
      }
      break;
    default:
      return assertNever(messageType);
  }

  throw new Error("invalid engine message");
}

function isEngineMessageType(value: string): value is EngineToUi["type"] {
  return (
    value === "ready" ||
    value === "command_specs_changed" ||
    value === "incompatible_build" ||
    value === "diagnostic" ||
    value === "notice" ||
    value === "command_help_requested" ||
    value === "command_result" ||
    value === "command_rejected" ||
    value === "completion_result" ||
    value === "network_state_changed" ||
    value === "buffers_changed" ||
    value === "buffer_added" ||
    value === "buffer_updated" ||
    value === "focus_buffer_requested" ||
    value === "messages_appended" ||
    value === "messages_prepended" ||
    value === "membership_changed" ||
    value === "members_changed" ||
    value === "message_confirmed" ||
    value === "message_failed" ||
    value === "unread_changed" ||
    value === "read_marker_moved"
  );
}

type MemberProjection = Extract<
  EngineToUi,
  { type: "members_changed" }
>["members"][number];

function decodeMember(value: unknown): MemberProjection | undefined {
  if (
    !isRecord(value) ||
    !isOneOf(value.group, ["operators", "voiced", "online", "away", "bots"]) ||
    typeof value.nick !== "string" ||
    !(value.mode_symbol === null || typeof value.mode_symbol === "string") ||
    typeof value.away !== "boolean" ||
    typeof value.bot !== "boolean" ||
    !(value.account === null || typeof value.account === "string") ||
    typeof value.nick_color_index !== "number" ||
    typeof value.is_you !== "boolean"
  )
    return undefined;
  return {
    group: value.group,
    nick: value.nick,
    mode_symbol: value.mode_symbol,
    away: value.away,
    bot: value.bot,
    account: value.account,
    nick_color_index: value.nick_color_index,
    is_you: value.is_you,
  };
}

function decodeMemberCounts(
  value: unknown,
): [number, number, number, number, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    !value.every((item) => typeof item === "number")
  )
    return undefined;
  const [operators, voiced, online, away, bots] = value;
  if (
    operators === undefined ||
    voiced === undefined ||
    online === undefined ||
    away === undefined ||
    bots === undefined
  )
    return undefined;
  return [operators, voiced, online, away, bots];
}

function decodeMembership(value: unknown): MembershipProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !isOneOf(value.kind, ["joined", "parted", "quit"]) ||
    !isStringArray(value.nicks) ||
    !(
      value.server_time_ms === null || typeof value.server_time_ms === "number"
    ) ||
    typeof value.received_at_ms !== "number"
  )
    return undefined;
  return {
    id: value.id,
    kind: value.kind,
    nicks: value.nicks,
    server_time_ms: value.server_time_ms,
    received_at_ms: value.received_at_ms,
  };
}

function decodeNetwork(value: unknown): NetworkProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.label !== "string" ||
    typeof value.nickname !== "string" ||
    !isOneOf(value.state, ["connecting", "online", "reconnecting", "stopped"])
  ) {
    return undefined;
  }
  return {
    id: value.id,
    label: value.label,
    nickname: value.nickname,
    state: value.state,
  };
}

function decodeBuffer(value: unknown): BufferProjection | undefined {
  const lastMessage =
    isRecord(value) && value.last_message !== undefined
      ? decodeMessage(value.last_message)
      : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.network_id !== "number" ||
    !isOneOf(value.kind, ["server", "channel", "direct"]) ||
    typeof value.title !== "string" ||
    typeof value.draft_key !== "string" ||
    !(value.topic === null || typeof value.topic === "string") ||
    typeof value.unread !== "number" ||
    typeof value.mentions !== "number" ||
    !(value.read_through === null || typeof value.read_through === "number") ||
    (value.last_message !== undefined && lastMessage === undefined)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    network_id: value.network_id,
    kind: value.kind,
    title: value.title,
    draft_key: value.draft_key,
    topic: value.topic,
    unread: value.unread,
    mentions: value.mentions,
    read_through: value.read_through,
    ...(lastMessage === undefined ? {} : { last_message: lastMessage }),
  };
}

function decodeMessage(value: unknown): MessageProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.author !== "string" ||
    typeof value.text !== "string" ||
    !isOneOf(value.kind, ["text", "action"]) ||
    typeof value.bot !== "boolean" ||
    !(value.mode_symbol === null || typeof value.mode_symbol === "string") ||
    !isOneOf(value.authorship, ["own", "other", "unknown"]) ||
    typeof value.nick_color_index !== "number" ||
    typeof value.mentioned !== "boolean" ||
    !isOneOf(value.delivery, [
      "received",
      "optimistic",
      "confirmed",
      "failed",
    ]) ||
    !(
      value.local_send_id === null || typeof value.local_send_id === "number"
    ) ||
    !isStringArray(value.server_ids) ||
    !(
      value.server_time_ms === null || typeof value.server_time_ms === "number"
    ) ||
    typeof value.received_at_ms !== "number"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    author: value.author,
    text: value.text,
    kind: value.kind,
    bot: value.bot,
    mode_symbol: value.mode_symbol,
    authorship: value.authorship,
    nick_color_index: value.nick_color_index,
    mentioned: value.mentioned,
    delivery: value.delivery,
    local_send_id: value.local_send_id,
    server_ids: value.server_ids,
    server_time_ms: value.server_time_ms,
    received_at_ms: value.received_at_ms,
  };
}

function decodeArray<T>(
  value: unknown,
  decode: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: T[] = [];
  for (const item of value) {
    const result = decode(item);
    if (result === undefined) return undefined;
    decoded.push(result);
  }
  return decoded;
}

function isOneOf<const T extends string>(
  value: unknown,
  choices: readonly T[],
): value is T {
  return (
    typeof value === "string" && choices.some((choice) => choice === value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine message type: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
