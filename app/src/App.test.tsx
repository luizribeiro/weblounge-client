import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App, recoverFromBuildMismatch } from "./App";
import { type EngineClient, EngineCommandError } from "./engine/EngineClient";
import type {
  EngineClientMessage,
  EngineRequestEnvelope,
} from "./engine/protocol";
import { OneShotAccessToken } from "./hosted/HostedSession";

it("keeps synthetic timelines out of the production app", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  expect(source).not.toContain("debug-messages");
  expect(source).not.toContain("debugTimelineSize");
});

it("reports the wasm worker round trip", async () => {
  render(() => <App engineClient={new FakeEngineClient()} />);

  expect(
    await screen.findByRole("heading", { name: "weblounge" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByText("Engine ready: wasm worker round trip complete"),
  ).toBeInTheDocument();
});

it("keeps one app status region while a polite toast is shown", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  await screen.findByRole("status");

  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("note")).toBeNull();
  client.emit({
    type: "notice",
    key: "engine.dedicated_worker_fallback",
    values: {},
    tone: "neutral",
    action: null,
  });

  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("note")).toHaveTextContent(
    "This browser uses one connection per tab",
  );
});

it("renders the empty shell after the engine handshake before revealing it", async () => {
  let releaseEngine = () => {};
  let releaseVisuals = () => {};
  const engine = new Promise<void>((resolve) => {
    releaseEngine = resolve;
  });
  const visuals = new Promise<void>((resolve) => {
    releaseVisuals = resolve;
  });
  const onReady = vi.fn();
  render(() => (
    <App
      beforeReveal={() => visuals}
      engineClient={new FakeEngineClient(undefined, engine)}
      onReady={onReady}
    />
  ));

  expect(screen.queryByRole("heading", { name: "weblounge" })).toBeNull();
  releaseEngine();
  expect(
    await screen.findByText("Engine ready: wasm worker round trip complete"),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("heading", { name: "weblounge" }),
  ).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  releaseVisuals();

  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(screen.getByRole("status")).toHaveTextContent(
    "Engine ready: wasm worker round trip complete",
  );
});

it("reports document visibility to the engine", () => {
  const client = new FakeEngineClient();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  render(() => <App engineClient={client} />);

  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));

  expect(client.visibility).toEqual(["visible", "hidden"]);
});

it("checks worker liveness on a persisted page restore", () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });

  window.dispatchEvent(event);

  expect(client.livenessChecks).toBe(1);
});

it("hands a hosted token to the engine once and reauthorizes on rejection", async () => {
  const client = new FakeEngineClient();
  const authorize = vi.fn();
  const onReady = vi.fn();
  render(() => (
    <App
      engineClient={client}
      hostedSession={{
        network: {
          name: "weblounge",
          endpoint: "wss://beta.weblounge.org/socket",
          autojoin: ["#lounge"],
        },
        token: new OneShotAccessToken("hosted-secret", Date.now() + 60_000),
      }}
      onHostedAuthorizationRequired={authorize}
      onReady={onReady}
    />
  ));

  await waitFor(() =>
    expect(client.requests).toContainEqual({
      id: expect.any(String),
      request: {
        type: "connect_hosted",
        label: "weblounge",
        endpoint: "wss://beta.weblounge.org/socket",
        nickname: "*",
        oauth_token: "hosted-secret",
        autojoin: ["#lounge"],
      },
    }),
  );
  expect(screen.queryByText("Signing in…")).not.toBeInTheDocument();
  expect(document.querySelector("[data-hosted-status]")).toBeNull();
  expect(onReady).not.toHaveBeenCalled();
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "weblounge",
      nickname: "luiz",
      state: "online",
    },
  });
  expect(await screen.findByText("1 network")).toBeVisible();
  expect(onReady).toHaveBeenCalledOnce();
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "weblounge",
      nickname: "luiz",
      state: {
        reconnecting: { attempt: 2, next_retry_at_ms: Date.now() + 1_000 },
      },
    },
  });
  expect(screen.queryByText("Signing in…")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "weblounge" })).toBeVisible();

  client.emit({
    type: "notice",
    key: "engine.hosted_auth_failed",
    values: {},
    tone: "neutral",
    action: null,
  });
  await waitFor(() => expect(authorize).toHaveBeenCalledWith("revoked"));
  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "expire_hosted_authentication", network_id: 1 },
  });
});

it("lists projected networks, buffers, and messages", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "Local Ergo",
      nickname: "weblounge",
      state: "online",
    },
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 1,
      network_id: 1,
      kind: "server",
      title: "Local Ergo",
      ...{ draft_key: "test:server" },
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      ...{ draft_key: "test:#room" },
      topic: "Room topic",
      unread: 1,
      mentions: 0,
      read_through: null,
    },
  });
  client.emit({
    type: "messages_appended",
    buffer_id: 2,
    messages: [
      {
        id: 1,
        author: "alice",
        text: "hello",
        kind: "text",
        bot: false,
        mode_symbol: null,
        authorship: "other",
        nick_color_index: 0,
        mentioned: false,
        delivery: "received",
        local_send_id: null,
        server_ids: ["msg-1"],
        server_time_ms: null,
        received_at_ms: 1,
      },
    ],
  });
  client.emit({
    type: "message_updated",
    buffer_id: 2,
    message: {
      id: 1,
      author: "alice",
      text: "hello",
      kind: "text",
      bot: false,
      mode_symbol: null,
      authorship: "other",
      nick_color_index: 0,
      mentioned: false,
      delivery: "received",
      local_send_id: null,
      server_ids: ["msg-1"],
      server_time_ms: 1,
      received_at_ms: 1,
    },
  });

  expect(await screen.findByText("1 network")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Local Ergo" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /#room/ })).toBeInTheDocument();
  expect(screen.getByText("Room topic")).toBeInTheDocument();
  expect(screen.getByText("hello")).toBeInTheDocument();
  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "load_history", buffer_id: 2 },
  });
});

it("opens the projected member panel and routes a member to a DM", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      draft_key: "test:#room",
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Toggle member list" }),
  );
  const request = client.requests.find(
    ({ request }) => request.type === "request_members",
  );
  if (request?.request.type !== "request_members")
    throw new Error("member request missing");
  const viewId = request.request.view_id;
  if (viewId === undefined) throw new Error("member view id missing");
  client.emit({
    type: "members_changed",
    buffer_id: 2,
    view_id: viewId,
    version: 0,
    window_size: 256,
    offset: 0,
    total: 1,
    counts: [1, 0, 0, 0, 0],
    members: [
      {
        group: "operators",
        nick: "mel",
        mode_symbol: "@",
        away: false,
        bot: false,
        account: "mel",
        nick_color_index: 1,
        is_you: false,
      },
    ],
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Open direct message with mel" }),
  );
  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "open_direct", network_id: 1, nick: "mel" },
  });
});

it("focuses command-created buffers only from engine buffer ids", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  for (const [id, title] of [
    [2, "#home"],
    [3, "#new"],
  ] as const) {
    client.emit({
      type: "buffer_added",
      buffer: {
        id,
        network_id: 1,
        kind: "channel",
        title,
        ...{ draft_key: `test:${title}` },
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    });
  }
  const input = await screen.findByRole("textbox", { name: "Message #home" });
  fireEvent.input(input, { target: { value: "/join #new" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("heading", { name: "#home" })).toBeInTheDocument();

  client.emit({
    type: "focus_buffer_requested",
    command_id: "join-1",
    buffer_id: 3,
  });
  expect(
    await screen.findByRole("heading", { name: "#new" }),
  ).toBeInTheDocument();
});

it("retains command focus when the target buffer arrives later", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "focus_buffer_requested",
    command_id: "join-restored",
    buffer_id: 3,
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#home",
      draft_key: "test:#home",
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 3,
      network_id: 1,
      kind: "channel",
      title: "#restored",
      draft_key: "test:#restored",
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });

  expect(
    await screen.findByRole("heading", { name: "#restored" }),
  ).toBeInTheDocument();
});

it("retains engine focus until a delayed shell can consume it", async () => {
  const client = new FakeEngineClient();
  render(() => (
    <App
      engineClient={client}
      hostedSession={{
        network: {
          name: "weblounge",
          endpoint: "wss://beta.weblounge.org/socket",
          autojoin: ["#home"],
        },
        token: new OneShotAccessToken("hosted-secret", Date.now() + 60_000),
      }}
    />
  ));
  for (const [id, kind, title] of [
    [2, "channel", "#home"],
    [3, "direct", "composer"],
  ] as const) {
    client.emit({
      type: "buffer_added",
      buffer: {
        id,
        network_id: 1,
        kind,
        title,
        draft_key: `test:${title}`,
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    });
  }
  client.emit({
    type: "focus_buffer_requested",
    command_id: "query-1",
    buffer_id: 3,
  });
  await Promise.resolve();

  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "weblounge",
      nickname: "luiz",
      state: "online",
    },
  });

  expect(
    await screen.findByRole("heading", { name: "composer" }),
  ).toBeVisible();
});

it("renders command error and engine notice keys as human text", async () => {
  const client = new FakeEngineClient("composer.unknown_command");
  render(() => <App engineClient={client} />);
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#home",
      ...{ draft_key: "test:#home" },
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  const input = await screen.findByRole("textbox", { name: "Message #home" });
  fireEvent.input(input, { target: { value: "/frobnicate" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("Unknown command /frobnicate.")).toBeVisible();
  client.emit({
    type: "notice",
    key: "engine.state_inconsistent",
    values: {},
    tone: "neutral",
    action: null,
  });
  expect(
    screen.getByText("The conversation changed unexpectedly. Try again."),
  ).toBeVisible();

  client.emit({
    type: "notice",
    key: "engine.connection_failed",
    values: {},
    tone: "neutral",
    action: null,
  });
  const visibleConnectionNotice = screen
    .getAllByText(/Couldn't connect to the server/u)
    .find((element) => !element.classList.contains("visually-hidden"));
  expect(visibleConnectionNotice).toBeVisible();
});

it("prepends requested history before live rows", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      ...{ draft_key: "test:#room" },
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  const live = {
    id: 2,
    author: "alice",
    kind: "text" as const,
    bot: false,
    mode_symbol: null,
    text: "live",
    authorship: "other" as const,
    nick_color_index: 0,
    mentioned: false,
    delivery: "received" as const,
    local_send_id: null,
    server_ids: ["live"],
    server_time_ms: 2,
    received_at_ms: 2,
  };
  client.emit({
    type: "messages_appended",
    buffer_id: 2,
    messages: [live],
  });
  client.emit({
    type: "messages_prepended",
    buffer_id: 2,
    messages: [
      {
        ...live,
        id: 1,
        text: "older",
        server_ids: ["older"],
        server_time_ms: 1,
        received_at_ms: 1,
      },
    ],
  });

  await screen.findByText("older");
  expect(
    [...document.querySelectorAll<HTMLElement>("[data-message-text]")].map(
      (row) => row.dataset.messageText,
    ),
  ).toEqual(["older", "live"]);
});

it("shows a confirmation received without this tab's optimistic row", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "message_confirmed",
    buffer_id: 2,
    local_send_id: 7,
    message: {
      id: 9,
      author: "weblounge",
      text: "from another tab",
      kind: "text",
      bot: false,
      mode_symbol: null,
      authorship: "own",
      nick_color_index: 0,
      mentioned: false,
      delivery: "confirmed",
      local_send_id: null,
      server_ids: ["msg-9"],
      server_time_ms: 9,
      received_at_ms: 8,
    },
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      ...{ draft_key: "test:#room" },
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });

  const confirmed = await screen.findByText(/from another tab/);
  expect(confirmed.closest("[data-message-row]")).toHaveAttribute(
    "data-delivery",
    "confirmed",
  );
});

it("does not resurrect a closed buffer from a later projection update", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  const direct = {
    id: 2,
    network_id: 1,
    kind: "direct" as const,
    title: "ana",
    draft_key: "test:ana",
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
  client.emit({ type: "buffer_added", buffer: direct });
  expect(await screen.findByRole("heading", { name: "ana" })).toBeVisible();

  client.emit({ type: "buffers_changed", network_id: 1, buffers: [] });
  expect(screen.queryByRole("heading", { name: "ana" })).toBeNull();
  client.emit({
    type: "buffer_updated",
    buffer: { ...direct, unread: 1 },
  });

  expect(screen.queryByRole("heading", { name: "ana" })).toBeNull();
});

it("shows an optimistic message as failed when sending fails", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      ...{ draft_key: "test:#room" },
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  client.emit({
    type: "messages_appended",
    buffer_id: 2,
    messages: [
      {
        id: 9,
        author: "weblounge",
        text: "will fail",
        kind: "text",
        bot: false,
        mode_symbol: null,
        authorship: "own",
        nick_color_index: 0,
        mentioned: false,
        delivery: "optimistic",
        local_send_id: 7,
        server_ids: [],
        server_time_ms: null,
        received_at_ms: 8,
      },
    ],
  });
  client.emit({
    type: "message_failed",
    network_id: 1,
    buffer_id: 2,
    target: "#room",
    local_send_id: 7,
    message_key: "engine.direct_target_gone",
  });

  const failed = await screen.findByText(/will fail/);
  expect(failed.closest("[data-message-row]")).toHaveAttribute(
    "data-delivery",
    "failed",
  );
  expect(
    screen.getByText(/nickname now belongs to someone else/u),
  ).toBeInTheDocument();
});

it("reopens a hidden failed DM from its typed notice", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  const buffer = {
    id: 2,
    network_id: 1,
    kind: "direct" as const,
    title: "ana",
    draft_key: "test:ana",
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
  client.emit({ type: "buffer_added", buffer });
  client.emit({
    type: "messages_appended",
    buffer_id: 2,
    messages: [
      {
        id: 9,
        author: "weblounge",
        text: "hi",
        kind: "text",
        bot: false,
        mode_symbol: null,
        authorship: "own",
        nick_color_index: 0,
        mentioned: false,
        delivery: "optimistic",
        local_send_id: 7,
        server_ids: [],
        server_time_ms: null,
        received_at_ms: 8,
      },
    ],
  });
  client.emit({ type: "buffers_changed", network_id: 1, buffers: [] });
  client.emit({
    type: "message_failed",
    network_id: 1,
    buffer_id: 2,
    target: "ana",
    local_send_id: 7,
    message_key: "engine.send_failed",
  });
  client.emit({
    type: "notice",
    key: "notice.message_not_delivered",
    values: { network_id: "1", target: "ana" },
    tone: "error",
    action: { label: "action.open", run: "buffer.open-direct" },
  });

  expect(
    await screen.findByText("Message to ana wasn't delivered"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "open_direct", network_id: 1, nick: "ana" },
  });
  client.emit({ type: "buffer_added", buffer });

  expect(await screen.findByRole("heading", { name: "ana" })).toBeVisible();
  expect(screen.getByText("hi").closest("[data-message-row]")).toHaveAttribute(
    "data-delivery",
    "failed",
  );
  expect(screen.queryByText("Message to ana wasn't delivered")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Failed · Retry" }));
  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "retry_message", buffer_id: 2, local_send_id: 7 },
  });
  client.emit({ type: "message_retrying", buffer_id: 2, local_send_id: 7 });
  expect(screen.getByText("Sending…")).toBeVisible();
});

it("marks a visible live-edge buffer read only after a focused 500ms dwell", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];

      constructor(private readonly callback: IntersectionObserverCallback) {}

      observe(target: Element): void {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }

      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve(): void {}
    },
  );
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  await vi.advanceTimersByTimeAsync(0);
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      ...{ draft_key: "test:#room" },
      topic: null,
      unread: 1,
      mentions: 0,
      read_through: null,
    },
  });
  client.emit({
    type: "messages_appended",
    buffer_id: 2,
    messages: [
      {
        id: 9,
        author: "alice",
        text: "unread",
        kind: "text",
        bot: false,
        mode_symbol: null,
        authorship: "other",
        nick_color_index: 0,
        mentioned: false,
        delivery: "received",
        local_send_id: null,
        server_ids: ["msg-9"],
        server_time_ms: 9,
        received_at_ms: 9,
      },
    ],
  });

  await vi.advanceTimersByTimeAsync(250);
  focus.mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  await vi.advanceTimersByTimeAsync(500);
  expect(client.requests).not.toContainEqual(
    expect.objectContaining({
      request: expect.objectContaining({ type: "mark_read" }),
    }),
  );

  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(499);
  expect(client.requests).not.toContainEqual(
    expect.objectContaining({
      request: expect.objectContaining({ type: "mark_read" }),
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "mark_read", buffer_id: 2, through: 9 },
  });

  vi.useRealTimers();
});

it("reloads only once for the same stale build", () => {
  const setStatus = vi.fn();
  const reload = vi.fn();
  const storage = new Map<string, string>();
  const session = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };

  recoverFromBuildMismatch(setStatus, session, reload);
  recoverFromBuildMismatch(setStatus, session, reload);

  expect(reload).toHaveBeenCalledOnce();
  expect(setStatus).toHaveBeenCalledOnce();
  expect(setStatus).toHaveBeenCalledWith(
    "Engine update failed; reload site data to recover",
  );
});

class FakeEngineClient implements EngineClient {
  readonly visibility: Parameters<EngineClient["setVisibility"]>[0][] = [];
  readonly requests: EngineRequestEnvelope[] = [];
  livenessChecks = 0;
  #listener: ((message: EngineClientMessage) => void) | undefined;

  constructor(
    private readonly rejection?: string,
    private readonly startResult: Promise<void> = Promise.resolve(),
  ) {}

  start(): Promise<void> {
    return this.startResult;
  }

  async send(request: Parameters<EngineClient["send"]>[0]) {
    this.requests.push(request);
    if (
      request.request.type === "submit_input" &&
      this.rejection !== undefined
    ) {
      throw new EngineCommandError({
        type: "command_rejected",
        id: request.id,
        message_key: this.rejection,
      });
    }
    if (request.request.type === "diagnostic") {
      this.emit({
        type: "diagnostic",
        command_id: request.id,
        message: request.request.message,
      });
    }
    return { type: "command_result" as const, id: request.id };
  }

  emit(message: EngineClientMessage): void {
    this.#listener?.(message);
  }

  requestSnapshot(): void {}

  checkLiveness(): void {
    this.livenessChecks += 1;
  }

  setVisibility(state: Parameters<EngineClient["setVisibility"]>[0]): void {
    this.visibility.push(state);
  }

  subscribe(listener: (message: EngineClientMessage) => void) {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async close(): Promise<void> {}
}
