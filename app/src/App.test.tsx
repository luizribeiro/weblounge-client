import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { App, recoverFromBuildMismatch } from "./App";
import { type EngineClient, EngineCommandError } from "./engine/EngineClient";
import type {
  BufferProjection,
  EngineClientMessage,
  EngineMessageKey,
  EngineRequestEnvelope,
} from "./engine/protocol";
import { OneShotAccessToken } from "./hosted/HostedSession";
import { startupDeadlineMs } from "./hosted/startup-deadline";
import { recordPendingOpenRoute } from "./platform/push/pending-open-route";

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

it("projects engine-owned typing state into the active composer", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "buffer_added",
    buffer: bufferProjection(2, "channel", "#room"),
  });
  expect(await screen.findByRole("heading", { name: "#room" })).toBeVisible();

  client.emit({
    type: "typing_changed",
    buffer_id: 2,
    typers: [{ nick: "ana", nick_color_index: 3, paused: false }],
  });
  await waitFor(() =>
    expect(document.querySelector("[data-typing-indicator]")).toHaveTextContent(
      "ana is typing…",
    ),
  );

  fireEvent.input(screen.getByRole("textbox", { name: "Message #room" }), {
    target: { value: "hello" },
  });
  await waitFor(() =>
    expect(client.requests).toContainEqual({
      id: expect.any(String),
      request: {
        type: "complete_input",
        buffer_id: 2,
        input: "hello",
        cursor: 5,
        explicit: false,
      },
    }),
  );

  client.emit({ type: "typing_changed", buffer_id: 2, typers: [] });
  expect(document.querySelector("[data-typing-indicator]")?.textContent).toBe(
    "",
  );
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

it("never shows a mark-read failure as a toast", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  await screen.findByRole("status");

  client.emit({
    type: "diagnostic",
    command_id: "mark-read",
    message: "engine.mark_read_failed",
  });
  client.emit({
    type: "notice",
    key: "engine.mark_read_failed",
    values: {},
    tone: "error",
    action: null,
  });

  expect(screen.queryByRole("note")).toBeNull();
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
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(() => <App engineClient={client} />);

  focused.mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  focused.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));

  expect(client.visibility).toEqual(["visible", "hidden", "visible", "hidden"]);
  expect(
    client.requests.filter(
      ({ request }) => request.type === "flush_chat_list_snapshot",
    ),
  ).toHaveLength(2);
  hidden.mockRestore();
  focused.mockRestore();
});

it("checks worker liveness on a persisted page restore", () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });

  window.dispatchEvent(event);

  expect(client.livenessChecks).toBe(1);
});

it("offers startup retry without reloading the page", async () => {
  const retry = vi.fn();
  render(() => (
    <App
      engineClient={new FakeEngineClient(undefined, Promise.reject())}
      onRetryStartup={retry}
    />
  ));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't start weblounge.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("turns a stalled engine startup into a retryable error", async () => {
  vi.useFakeTimers();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  render(() => (
    <App
      engineClient={
        new FakeEngineClient(undefined, new Promise<void>(() => {}))
      }
    />
  ));

  await vi.advanceTimersByTimeAsync(startupDeadlineMs);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn't start weblounge.",
  );
  expect(consoleError).toHaveBeenCalledOnce();
  consoleError.mockRestore();
  vi.useRealTimers();
});

it("hands a hosted token to the engine once and reauthorizes on rejection", async () => {
  const client = new FakeEngineClient();
  const authorize = vi.fn();
  const onReady = vi.fn();
  render(() => (
    <App
      engineClient={client}
      hostedSession={{
        sessionTokenEndpoint:
          "https://members.weblounge.org/oauth/session-token",
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
        type: "reconnect_hosted",
        network_id: 1,
        oauth_token: "hosted-secret",
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
  expect(onReady).not.toHaveBeenCalled();
  client.emit({
    type: "buffers_changed",
    network_id: 1,
    buffers: [
      {
        id: 2,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "channel",
        title: "#lounge",
        draft_key: "test:#lounge",
        topic: null,
        member_count: 0,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    ],
  });
  expect(onReady).not.toHaveBeenCalled();
  client.emit({ type: "recent_directs_ready", network_id: 1 });
  expect(onReady).not.toHaveBeenCalled();
  client.emit({
    type: "history_state_changed",
    buffer_id: 2,
    loading: false,
    at_start: false,
  });
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
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

it("acquires hosted reconnect tokens in the page", async () => {
  const fetchToken = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: "fresh-hosted-secret",
        token_type: "Bearer",
        expires_in: 900,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  const client = new FakeEngineClient();
  render(() => (
    <App
      engineClient={client}
      hostedSession={{
        sessionTokenEndpoint:
          "https://members.weblounge.org/oauth/session-token",
        network: {
          name: "weblounge",
          endpoint: "wss://beta.weblounge.org/socket",
          autojoin: [],
        },
        token: new OneShotAccessToken("initial-secret", Date.now() + 60_000),
      }}
    />
  ));
  await waitFor(() =>
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ type: "reconnect_hosted" }),
      }),
    ),
  );

  client.emit({ type: "hosted_token_required", network_id: 1 });

  await waitFor(() =>
    expect(client.requests).toContainEqual({
      id: expect.any(String),
      request: {
        type: "reconnect_hosted",
        network_id: 1,
        oauth_token: "fresh-hosted-secret",
      },
    }),
  );
  expect(fetchToken).toHaveBeenCalledWith(
    "https://members.weblounge.org/oauth/session-token",
    expect.objectContaining({ method: "POST" }),
  );
  fetchToken.mockRestore();
});

it("caps startup history hydration at 400ms", async () => {
  vi.useFakeTimers();
  const client = new FakeEngineClient();
  const onReady = vi.fn();
  render(() => (
    <App
      engineClient={client}
      hostedSession={{
        sessionTokenEndpoint:
          "https://members.weblounge.org/oauth/session-token",
        network: {
          name: "weblounge",
          endpoint: "wss://beta.weblounge.org/socket",
          autojoin: ["#lounge"],
        },
        token: new OneShotAccessToken("hosted-secret", Date.now() + 60_000),
      }}
      onReady={onReady}
    />
  ));
  await vi.advanceTimersByTimeAsync(0);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "weblounge",
      nickname: "luiz",
      state: "online",
    },
  });
  client.emit({
    type: "buffers_changed",
    network_id: 1,
    buffers: [
      {
        id: 2,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "channel",
        title: "#lounge",
        draft_key: "test:#lounge",
        topic: null,
        member_count: 0,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    ],
  });

  await vi.advanceTimersByTimeAsync(399);
  expect(onReady).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onReady).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it("reveals and navigates a cached chat list before live synchronization", async () => {
  const client = new FakeEngineClient();
  const onReady = vi.fn();
  const { container } = render(() => (
    <App
      engineClient={client}
      hostedSession={{
        network: {
          name: "weblounge",
          endpoint: "wss://beta.weblounge.org/socket",
          autojoin: ["#cached"],
        },
        sessionTokenEndpoint:
          "https://members.weblounge.org/oauth/session-token",
        token: new OneShotAccessToken("hosted-secret", Date.now() + 60_000),
      }}
      onReady={onReady}
    />
  ));
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "weblounge",
      nickname: "luiz",
      state: "connecting",
    },
  });
  client.emit({
    type: "chat_list_snapshot_loaded",
    network_id: 1,
    buffers: [
      {
        id: 2,
        network_id: 1,
        sync_state: "syncing" as const,
        kind: "channel",
        cached: true,
        available: true,
        title: "#cached",
        draft_key: "weblounge:#cached",
        topic: null,
        member_count: 0,
        unread: 1,
        mentions: 0,
        read_through: null,
        cached_preview: "alice: already here",
      },
    ],
  });

  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(container.querySelector("[data-app-root]")).toHaveAttribute(
    "data-chat-list-hydrating",
    "true",
  );
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "weblounge",
      nickname: "luiz",
      state: "online",
    },
  });
  await waitFor(() =>
    expect(
      container.querySelector("[data-connection-progress]"),
    ).not.toBeNull(),
  );
  fireEvent.click(await screen.findByRole("button", { name: "#cached" }));
  expect(screen.queryByText(/connecting/i)).toBeNull();
  const title = container.querySelector("[data-conversation-title]");
  expect(title).toHaveAttribute("data-connection-phase", "loading");
  client.emit({
    type: "buffer_updated",
    buffer: {
      id: 3,
      network_id: 1,
      sync_state: "synced",
      kind: "channel",
      title: "#cached",
      draft_key: "weblounge:#cached",
      topic: "Live topic",
      member_count: 3,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
  });
  expect(title).toHaveAttribute("data-connection-phase", "fading");
  if (title === null) throw new Error("conversation title missing");
  fireEvent.animationEnd(title);
  expect(title).not.toHaveAttribute("data-connection-progress");
  expect(container.querySelector("[data-app-root]")).toHaveAttribute(
    "data-chat-list-hydrating",
    "true",
  );
  expect(client.requests).toContainEqual(
    expect.objectContaining({
      request: { type: "load_history", buffer_id: 2, direction: "latest" },
    }),
  );
  fireEvent.input(screen.getByRole("textbox"), {
    target: { value: "queued hello" },
  });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() =>
    expect(client.requests).toContainEqual({
      id: expect.any(String),
      request: {
        type: "submit_input",
        buffer_id: 2,
        input: "queued hello",
      },
    }),
  );

  client.emit({
    type: "chat_list_live",
    network_id: 1,
    buffers: [
      {
        id: 2,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "channel",
        title: "#cached",
        draft_key: "weblounge:#cached",
        topic: "Live topic",
        member_count: 3,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    ],
  });
  expect(container.querySelector("[data-app-root]")).not.toHaveAttribute(
    "data-chat-list-hydrating",
  );
  const brand = container.querySelector("[data-connection-brand]");
  expect(brand).toHaveAttribute("data-connection-phase", "finishing");
  expect(title).not.toHaveAttribute("data-connection-progress");
  if (brand === null) throw new Error("progress UI missing");
  fireEvent.animationIteration(brand);
  expect(brand).toHaveAttribute("data-connection-phase", "filling");
  fireEvent.animationEnd(brand);
  await waitFor(() =>
    expect(container.querySelector("[data-connection-progress]")).toBeNull(),
  );
  await waitFor(() =>
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        request: { type: "load_history", buffer_id: 2, direction: "latest" },
      }),
    ),
  );
  expect(screen.getByText("Live topic")).toBeInTheDocument();
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
      sync_state: "synced" as const,
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
      sync_state: "synced" as const,
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
        authorship: "other",
        nick_color_index: 0,
        highlighted: false,
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
      authorship: "other",
      nick_color_index: 0,
      highlighted: false,
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
    request: { type: "load_history", buffer_id: 2, direction: "latest" },
  });
});

it("removes a parted channel and navigates to the previous buffer", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "Local",
      nickname: "me",
      state: "online",
    },
  });
  const room = {
    id: 2,
    network_id: 1,
    sync_state: "synced" as const,
    kind: "channel" as const,
    title: "#room",
    draft_key: "Local:#room",
    topic: null,
    member_count: 1,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
  const other = {
    ...room,
    id: 3,
    title: "#other",
    draft_key: "Local:#other",
  };
  client.emit({
    type: "buffers_changed",
    network_id: 1,
    buffers: [room, other],
  });

  fireEvent.click(await screen.findByRole("button", { name: "#other" }));
  expect(await screen.findByRole("heading", { name: "#other" })).toBeVisible();
  expect(window.location.pathname).toBe("/Local/other");

  client.emit({ type: "buffer_removed", buffer_id: other.id });

  expect(await screen.findByRole("heading", { name: "#room" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "#other" })).toBeNull();
  expect(window.location.pathname).toBe("/Local/room");
});

it("replaces a buffer's rows from the snapshot an attaching tab receives", async () => {
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
      id: 2,
      network_id: 1,
      sync_state: "synced" as const,
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
    type: "buffer_snapshot",
    buffer_id: 2,
    messages: [
      {
        id: 7,
        author: "louro",
        text: "retained before this tab opened",
        kind: "text",
        bot: true,
        authorship: "other",
        nick_color_index: 0,
        highlighted: false,
        delivery: "received",
        local_send_id: null,
        server_ids: ["msg-7"],
        server_time_ms: 7,
        received_at_ms: 7,
      },
    ],
    memberships: [],
  });

  expect(
    await screen.findByText("retained before this tab opened"),
  ).toBeInTheDocument();
});

it("opens the projected member panel and routes a member to a DM", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      sync_state: "synced" as const,
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
        account: { state: "logged_in", name: "mel" },
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
        sync_state: "synced" as const,
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
      sync_state: "synced" as const,
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
      sync_state: "synced" as const,
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

it("loads pushed messages and retains a service-worker route until its buffer arrives", async () => {
  const serviceWorker = new EventTarget();
  vi.stubGlobal(
    "navigator",
    new Proxy(navigator, {
      get(target, property) {
        return property === "serviceWorker"
          ? serviceWorker
          : Reflect.get(target, property, target);
      },
    }),
  );
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "Lounge",
      nickname: "weblounge",
      state: "online",
    },
  });
  client.emit({
    type: "buffers_changed",
    network_id: 1,
    buffers: [
      {
        id: 2,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "channel",
        title: "#home",
        draft_key: "test:#home",
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    ],
  });

  serviceWorker.dispatchEvent(
    new MessageEvent("message", {
      data: { kind: "open-route", route: "/Lounge/pushed" },
    }),
  );

  expect(client.requests).toContainEqual({
    id: expect.any(String),
    request: { type: "load_pushed_messages", network_id: 1 },
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 3,
      network_id: 1,
      sync_state: "synced" as const,
      kind: "channel",
      title: "#pushed",
      draft_key: "test:#pushed",
      topic: null,
      unread: 1,
      mentions: 0,
      read_through: null,
    },
  });

  expect(await screen.findByRole("heading", { name: "#pushed" })).toBeVisible();
});

it("retains a durable notification route through the cached-to-live swap", async () => {
  const factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  await recordPendingOpenRoute("/Lounge/@louro", {
    factory,
    createId: () => "intent-1",
  });
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "Lounge",
      nickname: "weblounge",
      state: "online",
    },
  });
  client.emit({
    type: "chat_list_snapshot_loaded",
    network_id: 1,
    buffers: [bufferProjection(2, "channel", "#home", true)],
  });

  await waitFor(() =>
    expect(client.requests).toContainEqual({
      id: expect.any(String),
      request: { type: "load_pushed_messages", network_id: 1 },
    }),
  );
  client.emit({
    type: "chat_list_live",
    network_id: 1,
    buffers: [
      bufferProjection(2, "channel", "#home"),
      bufferProjection(3, "direct", "louro"),
    ],
  });

  expect(await screen.findByRole("heading", { name: "louro" })).toBeVisible();
});

it("retains engine focus until a delayed shell can consume it", async () => {
  const client = new FakeEngineClient();
  render(() => (
    <App
      engineClient={client}
      hostedSession={{
        sessionTokenEndpoint:
          "https://members.weblounge.org/oauth/session-token",
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
        sync_state: "synced",
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
      sync_state: "synced" as const,
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
    key: "engine.channel_limit_reached",
    values: {},
    tone: "error",
    action: null,
  });
  expect(
    screen.getByText(
      "You're in the maximum number of channels for this server.",
    ),
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
      sync_state: "synced" as const,
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
    text: "live",
    authorship: "other" as const,
    nick_color_index: 0,
    highlighted: false,
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
      authorship: "own",
      nick_color_index: 0,
      highlighted: false,
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
      sync_state: "synced" as const,
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
    sync_state: "synced" as const,
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
      sync_state: "synced" as const,
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
        authorship: "own",
        nick_color_index: 0,
        highlighted: false,
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

it("shows a send failure only in its owning conversation", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "Local",
      nickname: "me",
      state: "online",
    },
  });
  client.emit({
    type: "buffers_changed",
    network_id: 1,
    buffers: [
      {
        id: 2,
        network_id: 1,
        sync_state: "synced",
        kind: "channel",
        title: "#room",
        draft_key: "test:#room",
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
      {
        id: 3,
        network_id: 1,
        sync_state: "synced",
        kind: "direct",
        title: "ana",
        draft_key: "test:ana",
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    ],
  });
  expect(await screen.findByRole("heading", { name: "#room" })).toBeVisible();

  client.emit({
    type: "message_failed",
    network_id: 1,
    buffer_id: 3,
    target: "ana",
    local_send_id: 7,
    message_key: "engine.direct_target_gone",
  });

  expect(
    screen.queryByText(/nickname now belongs to someone else/u),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "ana" }));
  expect(await screen.findByRole("heading", { name: "ana" })).toBeVisible();
  expect(
    screen.getByText(/nickname now belongs to someone else/u),
  ).toBeVisible();
});

it("reopens a hidden failed DM from its typed notice", async () => {
  const client = new FakeEngineClient();
  render(() => <App engineClient={client} />);
  const buffer = {
    id: 2,
    network_id: 1,
    sync_state: "synced" as const,
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
        authorship: "own",
        nick_color_index: 0,
        highlighted: false,
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

it("clears a cached live-edge read before selection changes and tolerates a rejected marker", async () => {
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
  const client = new FakeEngineClient(
    "engine.read_marker_invalid",
    Promise.resolve(),
    "mark_read",
  );
  render(() => <App engineClient={client} />);
  await vi.advanceTimersByTimeAsync(0);
  client.emit({
    type: "network_state_changed",
    network: {
      id: 1,
      label: "Test",
      nickname: "weblounge",
      state: "online",
    },
  });
  const room = {
    id: 2,
    network_id: 1,
    sync_state: "synced" as const,
    kind: "channel" as const,
    title: "#room",
    draft_key: "test:#room",
    topic: null,
    unread: 1,
    mentions: 0,
    read_through: null,
  };
  client.emit({
    type: "chat_list_snapshot_loaded",
    network_id: 1,
    buffers: [{ ...room, cached: true }],
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
        authorship: "other",
        nick_color_index: 0,
        highlighted: false,
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
  expect(document.querySelector('[data-buffer-id="2"]')).toHaveAttribute(
    "data-unread",
    "0",
  );
  client.emit({
    type: "chat_list_live",
    network_id: 1,
    buffers: [
      { ...room, unread: 0 },
      {
        id: 3,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "channel",
        title: "#elsewhere",
        draft_key: "test:#elsewhere",
        topic: null,
        unread: 0,
        mentions: 0,
        read_through: null,
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "#elsewhere" }));
  expect(client.requests).not.toContainEqual(
    expect.objectContaining({
      request: expect.objectContaining({ type: "cancel_deferred_read" }),
    }),
  );

  vi.useRealTimers();
});

it("closes a conversation notification on open and whenever it becomes read", async () => {
  let notifications: Notification[] = [];
  const oldNotification = {
    close: vi.fn(() => {
      notifications = notifications.filter(
        (notification) => notification !== oldNotification,
      );
    }),
    data: {
      conversationTag: "Lounge/#room",
      messageTime: "2026-11-04T19:24:32.000Z",
    },
  } as unknown as Notification;
  const newerNotification = {
    close: vi.fn(() => {
      notifications = notifications.filter(
        (notification) => notification !== newerNotification,
      );
    }),
    data: {
      conversationTag: "Lounge/#room",
      messageTime: "2026-11-04T19:24:34.000Z",
    },
  } as unknown as Notification;
  notifications = [oldNotification, newerNotification];
  const getNotifications = vi.fn(async () => notifications);
  const previousServiceWorker = Object.getOwnPropertyDescriptor(
    navigator,
    "serviceWorker",
  );
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      getRegistration: async () => ({ getNotifications }),
      removeEventListener: vi.fn(),
    },
  });
  try {
    const client = new FakeEngineClient();
    render(() => <App engineClient={client} />);
    await screen.findByRole("heading", { name: "weblounge" });
    client.emit({
      type: "network_state_changed",
      network: {
        id: 1,
        label: "Lounge",
        nickname: "weblounge",
        state: "online",
      },
    });
    const buffer = {
      id: 2,
      network_id: 1,
      sync_state: "synced" as const,
      kind: "channel" as const,
      title: "#room",
      draft_key: "test:#room",
      topic: null,
      unread: 4,
      mentions: 0,
      read_through: 4,
      read_at_ms: Date.parse("2026-11-04T19:24:33.000Z"),
    };
    client.emit({ type: "buffer_added", buffer });

    await waitFor(() => expect(oldNotification.close).toHaveBeenCalledOnce());
    expect(newerNotification.close).not.toHaveBeenCalled();
    expect(getNotifications).toHaveBeenLastCalledWith();

    client.emit({
      type: "unread_changed",
      buffer_id: 2,
      unread: 5,
      mentions: 1,
    });
    await Promise.resolve();
    expect(newerNotification.close).not.toHaveBeenCalled();

    client.emit({
      type: "buffer_updated",
      buffer: {
        ...buffer,
        unread: 0,
        read_at_ms: Date.parse("2026-11-04T19:24:35.000Z"),
      },
    });
    await waitFor(() => expect(newerNotification.close).toHaveBeenCalledOnce());
  } finally {
    if (previousServiceWorker === undefined) {
      Reflect.deleteProperty(navigator, "serviceWorker");
    } else {
      Object.defineProperty(navigator, "serviceWorker", previousServiceWorker);
    }
  }
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

function bufferProjection(
  id: number,
  kind: "channel" | "direct",
  title: string,
  cached = false,
): BufferProjection {
  return {
    id,
    network_id: 1,
    sync_state: cached ? "pending" : "synced",
    kind,
    title,
    draft_key: `test:${title}`,
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
    ...(cached ? { cached: true, cached_preview: "cached message" } : {}),
  };
}

class FakeEngineClient implements EngineClient {
  readonly visibility: Parameters<EngineClient["setVisibility"]>[0][] = [];
  readonly requests: EngineRequestEnvelope[] = [];
  livenessChecks = 0;
  #listener: ((message: EngineClientMessage) => void) | undefined;

  constructor(
    private readonly rejection?: EngineMessageKey,
    private readonly startResult: Promise<void> = Promise.resolve(),
    private readonly rejectedType: EngineRequestEnvelope["request"]["type"] = "submit_input",
  ) {}

  start(): Promise<void> {
    return this.startResult;
  }

  async send(request: Parameters<EngineClient["send"]>[0]) {
    this.requests.push(request);
    if (
      request.request.type === this.rejectedType &&
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
    if (request.request.type === "prepare_hosted") {
      this.emit({
        type: "network_state_changed",
        network: {
          id: 1,
          label: request.request.label,
          nickname: request.request.nickname,
          state: "connecting",
        },
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
