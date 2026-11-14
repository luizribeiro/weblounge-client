import {
  decodeArray,
  decodeNumber,
  isOneOf,
  isRecord,
} from "./decode-primitives";
import { decodeCommandSpecs } from "./decodeCommandSpec";
import { decodeTimelineItem } from "./decodeTimelineItem";
import { ENGINE_MESSAGE_KEYS } from "./generated/EngineMessageKeys";
import type {
  BufferProjection,
  CommandRejected,
  CommandResult,
  CompletionCandidate,
  EngineClientMessage,
  EngineRequestEnvelope,
  EngineToUi,
  Hello,
  IncompatibleBuild,
  MessageProjection,
  NetworkProjection,
  ResyncReason,
  UiToEngine,
  Unsubscribe,
  VisibilityState,
  WorkerHostError,
} from "./protocol";
import { TimelineStore, type TimelineView } from "./timeline-store";

export interface EngineClient {
  start(hello: Hello): Promise<void>;
  send(request: EngineRequestEnvelope): Promise<CommandResult>;
  checkLiveness(): void;
  requestSnapshot(reason: ResyncReason): void;
  setVisibility(state: VisibilityState): void;
  timeline(bufferId: number): TimelineView | undefined;
  setFocusedTimelineBuffer(bufferId: number | undefined): void;
  subscribe(listener: (message: EngineClientMessage) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface EnginePort {
  postMessage(message: UiToEngine | { readonly type: "host_detach" }): void;
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

type EngineConnectionFactory = () => EngineConnection;

interface FailureEventTarget {
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
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

  get values(): Readonly<Record<string, string | undefined>> {
    return this.rejection.values ?? {};
  }
}

export class WorkerEngineClient implements EngineClient {
  #connection: EngineConnection;
  readonly #recoverConnection: EngineConnectionFactory | undefined;
  readonly #scheduleFrame: FrameScheduler;
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();
  readonly #requests = new Map<string, RequestWaiter>();
  readonly #renderQueue: EngineToUi[] = [];
  readonly #timelines = new TimelineStore();
  readonly #initialMessages: EngineClientMessage[];
  #startWaiter: StartWaiter | undefined;
  #framePending = false;
  #visibility: VisibilityState = "visible";
  #closed = false;
  #hello: Hello | undefined;
  #recovering = false;
  #heartbeatId: string | undefined;
  #heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    connection: EngineConnection,
    scheduleFrame: FrameScheduler = (callback) =>
      requestAnimationFrame(callback),
    initialMessages: readonly EngineClientMessage[] = [],
    recoverConnection?: EngineConnectionFactory,
  ) {
    this.#connection = connection;
    this.#recoverConnection = recoverConnection;
    this.#scheduleFrame = scheduleFrame;
    this.#initialMessages = [...initialMessages];
    this.#attach(connection);
  }

  start(hello: Hello): Promise<void> {
    if (this.#closed)
      return Promise.reject(new Error("engine client is closed"));
    if (this.#startWaiter !== undefined) {
      return Promise.reject(new Error("engine handshake already pending"));
    }

    this.#hello = hello;
    const started = new Promise<void>((resolve, reject) => {
      this.#startWaiter = { resolve, reject };
    });
    this.#connection.port.postMessage({ type: "hello", payload: hello });
    return started;
  }

  send(request: EngineRequestEnvelope): Promise<CommandResult> {
    if (this.#closed)
      return Promise.reject(new Error("engine client is closed"));
    if (this.#requests.has(request.id)) {
      return Promise.reject(new Error(`duplicate request id: ${request.id}`));
    }

    const result = new Promise<CommandResult>((resolve, reject) => {
      this.#requests.set(request.id, { resolve, reject });
    });
    this.#connection.port.postMessage({ type: "request", payload: request });
    return result;
  }

  checkLiveness(): void {
    if (this.#visibility === "visible") this.#probeWorker();
  }

  requestSnapshot(_reason: ResyncReason): void {}

  setVisibility(state: VisibilityState): void {
    const resumed = this.#visibility === "hidden" && state === "visible";
    this.#visibility = state;
    if (resumed) {
      this.#drainRenderQueue();
      this.#probeWorker();
    }
  }

  subscribe(listener: (message: EngineClientMessage) => void): Unsubscribe {
    this.#listeners.add(listener);
    for (const message of this.#initialMessages.splice(0)) {
      this.#publish(message);
    }
    return () => this.#listeners.delete(listener);
  }

  timeline(bufferId: number): TimelineView | undefined {
    return this.#timelines.get(bufferId);
  }

  setFocusedTimelineBuffer(bufferId: number | undefined): void {
    this.#timelines.focus(bufferId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearHeartbeat();
    this.#connection.port.postMessage({ type: "host_detach" });
    this.#detach(this.#connection);
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
    if (message.type === "pong") {
      if (message.id === this.#heartbeatId) this.#clearHeartbeat();
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
    if (message.type === "notifiable_message_received") {
      // Alerts matter most while hidden, when the render queue holds events until visible.
      this.#publish(message);
      return;
    }
    this.#enqueueForFrame(message);
  };

  readonly #onWorkerFailure = (): void => {
    this.#recover();
  };

  #attach(connection: EngineConnection): void {
    connection.port.addEventListener("message", this.#onMessage);
    const port = connection.port as EnginePort & FailureEventTarget;
    port.addEventListener("messageerror", this.#onWorkerFailure);
    port.addEventListener("error", this.#onWorkerFailure);
    connection.port.start?.();
  }

  #detach(connection: EngineConnection): void {
    connection.port.removeEventListener("message", this.#onMessage);
    const port = connection.port as EnginePort & FailureEventTarget;
    port.removeEventListener("messageerror", this.#onWorkerFailure);
    port.removeEventListener("error", this.#onWorkerFailure);
  }

  #recover(): void {
    if (this.#closed || this.#recovering) return;
    const factory = this.#recoverConnection;
    const hello = this.#hello;
    if (factory === undefined || hello === undefined) {
      this.#publish({ type: "fatal", message_key: "engine.worker_failed" });
      return;
    }
    this.#recovering = true;
    this.#clearHeartbeat();
    const failed = this.#connection;
    this.#detach(failed);
    failed.close();
    const error = new Error("engine worker restarted");
    for (const waiter of this.#requests.values()) waiter.reject(error);
    this.#requests.clear();
    try {
      this.#connection = factory();
      this.#attach(this.#connection);
      this.#connection.port.postMessage({ type: "hello", payload: hello });
    } catch {
      this.#publish({ type: "fatal", message_key: "engine.worker_failed" });
    } finally {
      this.#recovering = false;
    }
  }

  #probeWorker(): void {
    if (
      this.#closed ||
      this.#hello === undefined ||
      this.#startWaiter !== undefined ||
      this.#heartbeatId !== undefined
    )
      return;
    const id = `worker-heartbeat-${crypto.randomUUID()}`;
    this.#heartbeatId = id;
    this.#connection.port.postMessage({
      type: "request",
      payload: { id, request: { type: "ping" } },
    });
    this.#heartbeatTimeout = setTimeout(() => this.#recover(), 5_000);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimeout !== undefined)
      clearTimeout(this.#heartbeatTimeout);
    this.#heartbeatTimeout = undefined;
    this.#heartbeatId = undefined;
  }

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
    if (message.type === "timeline_changed") {
      this.#timelines.apply(message.buffer_id, message);
    } else if (message.type === "buffer_removed") {
      this.#timelines.remove(message.buffer_id);
    }
    for (const listener of this.#listeners) listener(message);
  }
}

function containsOptimisticMessage(message: EngineToUi): boolean {
  return (
    message.type === "timeline_changed" &&
    message.upserted.some(
      (item) =>
        item.body.family === "message" && item.body.delivery === "optimistic",
    )
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
    case "pong":
      if (typeof value.id === "string") return { type: "pong", id: value.id };
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
    case "hosted_token_required":
      if (typeof value.network_id === "number") {
        return { type: messageType, network_id: value.network_id };
      }
      break;
    case "push_device_loaded":
      if (
        typeof value.command_id === "string" &&
        (value.credentials === null ||
          isPushDeviceCredentials(value.credentials))
      ) {
        return {
          type: messageType,
          command_id: value.command_id,
          credentials: value.credentials,
        };
      }
      break;
    case "notification_prompt_dismissal_loaded":
      if (
        typeof value.command_id === "string" &&
        typeof value.dismissed === "boolean"
      ) {
        return {
          type: messageType,
          command_id: value.command_id,
          dismissed: value.dismissed,
        };
      }
      break;
    case "push_state_changed": {
      const state = decodePushState(value.state);
      if (typeof value.network_id === "number" && state !== undefined) {
        return { type: messageType, network_id: value.network_id, state };
      }
      break;
    }
    case "push_route_required":
      if (
        typeof value.network_id === "number" &&
        typeof value.vapid === "string" &&
        (value.previous_route_id === null ||
          typeof value.previous_route_id === "string")
      ) {
        return {
          type: messageType,
          network_id: value.network_id,
          vapid: value.vapid,
          previous_route_id: value.previous_route_id,
        };
      }
      break;
    case "notice": {
      const values = decodeStringRecord(value.values);
      const action = decodeNoticeAction(value.action);
      if (
        typeof value.key === "string" &&
        values !== undefined &&
        (value.tone === "neutral" || value.tone === "error") &&
        action !== undefined
      ) {
        return {
          type: "notice",
          key: value.key,
          values,
          tone: value.tone,
          action,
        };
      }
      break;
    }
    case "command_help_requested":
      if (value.command === null || typeof value.command === "string") {
        return { type: messageType, command: value.command };
      }
      break;
    case "command_result":
      if (typeof value.id === "string")
        return { type: "command_result", id: value.id };
      break;
    case "command_rejected": {
      const rejectionValues =
        value.values === undefined ? {} : decodeStringRecord(value.values);
      if (
        typeof value.id === "string" &&
        isOneOf(value.message_key, ENGINE_MESSAGE_KEYS) &&
        rejectionValues !== undefined
      ) {
        return {
          type: "command_rejected",
          id: value.id,
          message_key: value.message_key,
          values: rejectionValues,
        };
      }
      break;
    }
    case "completion_result": {
      const candidates = decodeArray(
        value.candidates,
        decodeCompletionCandidate,
      );
      if (
        typeof value.command_id === "string" &&
        typeof value.buffer_id === "number" &&
        typeof value.input === "string" &&
        isOneOf(value.trigger, ["command", "person", "channel"]) &&
        typeof value.replace_start === "number" &&
        typeof value.replace_end === "number" &&
        (value.argument_hint === null ||
          typeof value.argument_hint === "string") &&
        typeof value.replacement_prefix === "string" &&
        typeof value.replacement_suffix === "string" &&
        candidates !== undefined
      ) {
        return {
          type: "completion_result",
          command_id: value.command_id,
          buffer_id: value.buffer_id,
          input: value.input,
          trigger: value.trigger,
          replace_start: value.replace_start,
          replace_end: value.replace_end,
          argument_hint: value.argument_hint,
          replacement_prefix: value.replacement_prefix,
          replacement_suffix: value.replacement_suffix,
          candidates,
        };
      }
      break;
    }
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
    case "recent_directs_ready":
    case "pushed_messages_loaded":
      if (typeof value.network_id === "number") {
        return { type: messageType, network_id: value.network_id };
      }
      break;
    case "buffer_added":
    case "buffer_updated": {
      const buffer = decodeBuffer(value.buffer);
      if (buffer !== undefined) return { type: messageType, buffer };
      break;
    }
    case "notifiable_message_received": {
      const buffer = decodeBuffer(value.buffer);
      const message = decodeMessage(value.message);
      if (buffer !== undefined && message !== undefined)
        return { type: messageType, buffer, message };
      break;
    }
    case "buffer_removed":
      if (typeof value.buffer_id === "number") {
        return { type: messageType, buffer_id: value.buffer_id };
      }
      break;
    case "draft_key_changed":
      if (
        typeof value.previous === "string" &&
        typeof value.current === "string"
      ) {
        return {
          type: messageType,
          previous: value.previous,
          current: value.current,
        };
      }
      break;
    case "typing_changed": {
      const typers = decodeArray(value.typers, decodeTypingProjection);
      if (typeof value.buffer_id === "number" && typers !== undefined) {
        return { type: messageType, buffer_id: value.buffer_id, typers };
      }
      break;
    }
    case "history_state_changed":
      if (
        typeof value.buffer_id === "number" &&
        typeof value.loading === "boolean" &&
        typeof value.at_start === "boolean"
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          loading: value.loading,
          at_start: value.at_start,
        };
      }
      break;
    case "timeline_changed": {
      const upserted = decodeArray(value.upserted, decodeTimelineItem);
      const removed = decodeArray(value.removed, decodeNumber);
      if (
        typeof value.buffer_id === "number" &&
        typeof value.reset === "boolean" &&
        upserted !== undefined &&
        removed !== undefined
      ) {
        return {
          type: messageType,
          buffer_id: value.buffer_id,
          reset: value.reset,
          upserted,
          removed,
        };
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
    case "message_failed":
      if (
        typeof value.network_id === "number" &&
        typeof value.buffer_id === "number" &&
        typeof value.target === "string" &&
        typeof value.local_send_id === "number" &&
        isOneOf(value.message_key, ENGINE_MESSAGE_KEYS)
      ) {
        return {
          type: messageType,
          network_id: value.network_id,
          buffer_id: value.buffer_id,
          target: value.target,
          local_send_id: value.local_send_id,
          message_key: value.message_key,
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
    value === "pong" ||
    value === "command_specs_changed" ||
    value === "incompatible_build" ||
    value === "diagnostic" ||
    value === "hosted_token_required" ||
    value === "push_device_loaded" ||
    value === "notification_prompt_dismissal_loaded" ||
    value === "push_state_changed" ||
    value === "push_route_required" ||
    value === "notice" ||
    value === "command_help_requested" ||
    value === "command_result" ||
    value === "command_rejected" ||
    value === "completion_result" ||
    value === "network_state_changed" ||
    value === "buffers_changed" ||
    value === "recent_directs_ready" ||
    value === "pushed_messages_loaded" ||
    value === "buffer_added" ||
    value === "buffer_removed" ||
    value === "buffer_updated" ||
    value === "notifiable_message_received" ||
    value === "draft_key_changed" ||
    value === "focus_buffer_requested" ||
    value === "typing_changed" ||
    value === "timeline_changed" ||
    value === "history_state_changed" ||
    value === "members_changed" ||
    value === "message_failed"
  );
}

function isPushDeviceCredentials(value: unknown): value is {
  relay: string;
  device_id: string;
  secret: string;
} {
  return (
    isRecord(value) &&
    typeof value.relay === "string" &&
    typeof value.device_id === "string" &&
    typeof value.secret === "string"
  );
}

function decodePushState(
  value: unknown,
): Extract<EngineToUi, { type: "push_state_changed" }>["state"] | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  if (
    (value.status === "registered" ||
      value.status === "registered_but_no_delivery") &&
    typeof value.route_id === "string"
  ) {
    return { status: value.status, route_id: value.route_id };
  }
  if (
    value.status === "unsupported" &&
    isOneOf(value.reason, ["no_web_push", "no_account", "no_vapid"])
  ) {
    return { status: value.status, reason: value.reason };
  }
  if (
    value.status === "failed" &&
    typeof value.route_id === "string" &&
    isOneOf(value.reason, [
      "web_push_forbidden",
      "registration_limit",
      "request_limit",
      "invalid_parameters",
      "internal",
      "connection",
      "other",
    ])
  ) {
    return {
      status: value.status,
      route_id: value.route_id,
      reason: value.reason,
    };
  }
  return undefined;
}

function decodeStringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function decodeNoticeAction(
  value: unknown,
): { readonly label: string; readonly run: string } | null | undefined {
  if (value === null) return null;
  if (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.run === "string"
  ) {
    return { label: value.label, run: value.run };
  }
  return undefined;
}

type MemberProjection = Extract<
  EngineToUi,
  { type: "members_changed" }
>["members"][number];

function decodeCompletionCandidate(
  value: unknown,
): CompletionCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "command" &&
    typeof value.name === "string" &&
    typeof value.usage === "string" &&
    typeof value.description === "string"
  )
    return {
      type: "command",
      name: value.name,
      usage: value.usage,
      description: value.description,
    };
  if (
    value.type === "person" &&
    typeof value.nick === "string" &&
    typeof value.nick_color_index === "number" &&
    typeof value.away === "boolean" &&
    (value.bot === null || typeof value.bot === "boolean")
  )
    return {
      type: "person",
      nick: value.nick,
      nick_color_index: value.nick_color_index,
      away: value.away,
      bot: value.bot,
    };
  if (value.type === "channel" && typeof value.name === "string")
    return { type: "channel", name: value.name };
  return undefined;
}

function decodeMember(value: unknown): MemberProjection | undefined {
  if (
    !isRecord(value) ||
    !isOneOf(value.group, ["operators", "voiced", "online", "away", "bots"]) ||
    typeof value.nick !== "string" ||
    !(value.mode_symbol === null || typeof value.mode_symbol === "string") ||
    typeof value.away !== "boolean" ||
    !(value.bot === null || typeof value.bot === "boolean") ||
    !isAccountProjection(value.account) ||
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

function decodeTypingProjection(
  value: unknown,
):
  | Extract<EngineToUi, { type: "typing_changed" }>["typers"][number]
  | undefined {
  if (
    !isRecord(value) ||
    typeof value.nick !== "string" ||
    typeof value.nick_color_index !== "number" ||
    typeof value.paused !== "boolean"
  )
    return undefined;
  return {
    nick: value.nick,
    nick_color_index: value.nick_color_index,
    paused: value.paused,
  };
}

function isAccountProjection(
  value: unknown,
): value is MemberProjection["account"] {
  return (
    isRecord(value) &&
    (value.state === "unknown" ||
      value.state === "logged_out" ||
      (value.state === "logged_in" && typeof value.name === "string"))
  );
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

function decodeNetwork(value: unknown): NetworkProjection | undefined {
  const state = isRecord(value)
    ? decodeNetworkConnectionState(value.state)
    : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.label !== "string" ||
    typeof value.nickname !== "string" ||
    !(
      value.filehost_origin === undefined ||
      typeof value.filehost_origin === "string"
    ) ||
    state === undefined
  ) {
    return undefined;
  }
  return {
    id: value.id,
    label: value.label,
    nickname: value.nickname,
    state,
    ...(typeof value.filehost_origin === "string"
      ? { filehost_origin: value.filehost_origin }
      : {}),
  };
}

function decodeNetworkConnectionState(
  value: unknown,
): NetworkProjection["state"] | undefined {
  if (isOneOf(value, ["connecting", "registering", "online"])) return value;
  if (!isRecord(value)) return undefined;
  if (
    isRecord(value.reconnecting) &&
    typeof value.reconnecting.attempt === "number" &&
    typeof value.reconnecting.next_retry_at_ms === "number"
  ) {
    return {
      reconnecting: {
        attempt: value.reconnecting.attempt,
        next_retry_at_ms: value.reconnecting.next_retry_at_ms,
      },
    };
  }
  if (
    isRecord(value.offline) &&
    isOneOf(value.offline.reason, ["requested", "device_offline"])
  ) {
    return { offline: { reason: value.offline.reason } };
  }
  if (
    isRecord(value.failed) &&
    isOneOf(value.failed.reason, ["authentication", "transport", "protocol"]) &&
    isOneOf(value.failed.message_key, ENGINE_MESSAGE_KEYS)
  ) {
    return {
      failed: {
        reason: value.failed.reason,
        message_key: value.failed.message_key,
      },
    };
  }
  return undefined;
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
    !isOneOf(value.sync_state, ["pending", "syncing", "synced"]) ||
    !(
      value.channel_status === undefined ||
      isOneOf(value.channel_status, ["joined", "kicked"])
    ) ||
    !(value.available === undefined || typeof value.available === "boolean") ||
    typeof value.title !== "string" ||
    typeof value.draft_key !== "string" ||
    !(
      value.nick_color_index === undefined ||
      typeof value.nick_color_index === "number"
    ) ||
    !(
      value.direct_identity === undefined ||
      isOneOf(value.direct_identity, [
        "unverified",
        "verified",
        "different_account",
        "cannot_verify",
        "deferred_different_account",
        "deferred_cannot_verify",
      ])
    ) ||
    !(value.topic === null || typeof value.topic === "string") ||
    !(
      value.member_count === undefined || typeof value.member_count === "number"
    ) ||
    typeof value.unread !== "number" ||
    typeof value.mentions !== "number" ||
    !(value.read_at_ms === undefined || typeof value.read_at_ms === "number") ||
    (value.last_message !== undefined && lastMessage === undefined) ||
    !(
      value.last_activity_ms === undefined ||
      typeof value.last_activity_ms === "number"
    ) ||
    !(value.preview === undefined || typeof value.preview === "string")
  ) {
    return undefined;
  }
  return {
    id: value.id,
    network_id: value.network_id,
    kind: value.kind,
    sync_state: value.sync_state,
    ...(value.channel_status === undefined
      ? {}
      : { channel_status: value.channel_status }),
    available: value.available ?? true,
    title: value.title,
    ...(value.nick_color_index === undefined
      ? {}
      : { nick_color_index: value.nick_color_index }),
    ...(value.direct_identity === undefined
      ? {}
      : { direct_identity: value.direct_identity }),
    draft_key: value.draft_key,
    topic: value.topic,
    ...(value.member_count === undefined
      ? {}
      : { member_count: value.member_count }),
    unread: value.unread,
    mentions: value.mentions,
    ...(value.read_at_ms === undefined ? {} : { read_at_ms: value.read_at_ms }),
    ...(lastMessage === undefined ? {} : { last_message: lastMessage }),
    ...(value.last_activity_ms === undefined
      ? {}
      : { last_activity_ms: value.last_activity_ms }),
    ...(value.preview === undefined ? {} : { preview: value.preview }),
  };
}

export function decodeMessage(value: unknown): MessageProjection | undefined {
  const kind = isRecord(value) ? decodeMessageKind(value.kind) : undefined;
  const reactions = isRecord(value)
    ? decodeReactions(value.reactions)
    : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.author !== "string" ||
    typeof value.text !== "string" ||
    kind === undefined ||
    !(value.bot === null || typeof value.bot === "boolean") ||
    !isOneOf(value.authorship, ["own", "other", "unknown"]) ||
    typeof value.nick_color_index !== "number" ||
    typeof value.highlighted !== "boolean" ||
    !(
      value.unverified_sender === undefined ||
      typeof value.unverified_sender === "boolean"
    ) ||
    (value.reactions !== undefined && reactions === undefined) ||
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
    kind,
    bot: value.bot,
    authorship: value.authorship,
    nick_color_index: value.nick_color_index,
    highlighted: value.highlighted,
    ...(value.unverified_sender === undefined
      ? {}
      : { unverified_sender: value.unverified_sender }),
    ...(reactions === undefined ? {} : { reactions }),
    delivery: value.delivery,
    local_send_id: value.local_send_id,
    server_ids: value.server_ids,
    server_time_ms: value.server_time_ms,
    received_at_ms: value.received_at_ms,
  };
}

function decodeReactions(
  value: unknown,
): NonNullable<MessageProjection["reactions"]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const reactions: NonNullable<MessageProjection["reactions"]> = [];
  for (const reaction of value) {
    if (
      !isRecord(reaction) ||
      typeof reaction.text !== "string" ||
      typeof reaction.mine !== "boolean" ||
      !Array.isArray(reaction.actors)
    )
      return undefined;
    const actors: { nick: string; mine: boolean }[] = [];
    for (const actor of reaction.actors) {
      if (
        !isRecord(actor) ||
        typeof actor.nick !== "string" ||
        typeof actor.mine !== "boolean"
      )
        return undefined;
      actors.push({ nick: actor.nick, mine: actor.mine });
    }
    reactions.push({ text: reaction.text, actors, mine: reaction.mine });
  }
  return reactions;
}

function decodeMessageKind(
  value: unknown,
): MessageProjection["kind"] | undefined {
  if (isOneOf(value, ["text", "action"])) return value;
  if (!isRecord(value)) return undefined;
  if (isOneOf(value.irc_notice, ["user", "service", "server"]))
    return { irc_notice: value.irc_notice };
  const notice = decodeNoticeKind(value.notice);
  return notice === undefined ? undefined : { notice };
}

function decodeNoticeKind(
  value: unknown,
):
  | Extract<MessageProjection["kind"], { notice: unknown }>["notice"]
  | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "info") return { type: "info" };
  if (
    value.type === "topic" &&
    (value.setter === null || typeof value.setter === "string") &&
    (value.set_at === null || typeof value.set_at === "number")
  ) {
    return { type: "topic", setter: value.setter, set_at: value.set_at };
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine message type: ${String(value)}`);
}
