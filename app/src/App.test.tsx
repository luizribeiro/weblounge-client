import { render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App, recoverFromBuildMismatch } from "./App";
import type { EngineClient } from "./engine/EngineClient";
import type { EngineClientMessage } from "./engine/protocol";

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
      topic: null,
      unread: 0,
      mentions: 0,
    },
  });
  client.emit({
    type: "buffer_added",
    buffer: {
      id: 2,
      network_id: 1,
      kind: "channel",
      title: "#room",
      topic: "Room topic",
      unread: 1,
      mentions: 0,
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
      topic: null,
      unread: 0,
      mentions: 0,
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
      topic: null,
      unread: 0,
      mentions: 0,
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
  #listener: ((message: EngineClientMessage) => void) | undefined;

  async start(): Promise<void> {}

  async send(command: Parameters<EngineClient["send"]>[0]) {
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
