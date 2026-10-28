import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App, recoverFromBuildMismatch } from "./App";
import { type EngineClient, EngineCommandError } from "./engine/EngineClient";
import type { CommandEnvelope, EngineClientMessage } from "./engine/protocol";

it("keeps synthetic timelines out of the production app", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  expect(source).not.toContain("debug-messages");
  expect(source).not.toContain("debugTimelineSize");
});

it("reports the wasm worker round trip", async () => {
  render(() => <App engineClient={new FakeEngineClient()} />);

  expect(
    screen.getByRole("heading", { name: "weblounge" }),
  ).toBeInTheDocument();
  expect(await screen.findByRole("status")).toHaveTextContent(
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

  expect(await screen.findByText("1 network · connected")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Local Ergo" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /#room/ })).toBeInTheDocument();
  expect(screen.getByText("Room topic")).toBeInTheDocument();
  expect(screen.getByText("hello")).toBeInTheDocument();
  expect(client.commands).toContainEqual({
    id: expect.any(String),
    command: { type: "load_history", buffer_id: 2 },
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
  const request = client.commands.find(
    ({ command }) => command.type === "request_members",
  );
  if (request?.command.type !== "request_members")
    throw new Error("member request missing");
  const viewId = request.command.view_id;
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
  expect(client.commands).toContainEqual({
    id: expect.any(String),
    command: { type: "open_direct", network_id: 1, nick: "mel" },
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
  client.emit({ type: "notice", message_key: "engine.state_inconsistent" });
  expect(screen.getByRole("note")).toHaveTextContent(
    "The conversation changed unexpectedly. Try again.",
  );
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
    buffer_id: 2,
    local_send_id: 7,
    message_key: "engine.send_failed",
  });

  const failed = await screen.findByText(/will fail/);
  expect(failed.closest("[data-message-row]")).toHaveAttribute(
    "data-delivery",
    "failed",
  );
});

it("marks a visible live-edge buffer read only after a focused 500ms dwell", async () => {
  vi.useFakeTimers();
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
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
  expect(client.commands).not.toContainEqual(
    expect.objectContaining({
      command: expect.objectContaining({ type: "mark_read" }),
    }),
  );

  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(499);
  expect(client.commands).not.toContainEqual(
    expect.objectContaining({
      command: expect.objectContaining({ type: "mark_read" }),
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(client.commands).toContainEqual({
    id: expect.any(String),
    command: { type: "mark_read", buffer_id: 2, through: 9 },
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
  readonly commands: CommandEnvelope[] = [];
  #listener: ((message: EngineClientMessage) => void) | undefined;

  constructor(private readonly rejection?: string) {}

  async start(): Promise<void> {}

  async send(command: Parameters<EngineClient["send"]>[0]) {
    this.commands.push(command);
    if (
      command.command.type === "submit_input" &&
      this.rejection !== undefined
    ) {
      throw new EngineCommandError({
        type: "command_rejected",
        id: command.id,
        message_key: this.rejection,
      });
    }
    if (command.command.type === "diagnostic") {
      this.emit({
        type: "diagnostic",
        command_id: command.id,
        message: command.command.message,
      });
    }
    return { type: "command_result" as const, id: command.id };
  }

  emit(message: EngineClientMessage): void {
    this.#listener?.(message);
  }

  requestSnapshot(): void {}

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
