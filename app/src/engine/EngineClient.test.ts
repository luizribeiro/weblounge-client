import { describe, expect, it, vi } from "vitest";
import {
  type EngineConnection,
  type EnginePort,
  WorkerEngineClient,
} from "./EngineClient";
import type { UiToEngine } from "./protocol";

class FakePort implements EnginePort {
  readonly sent: UiToEngine[] = [];
  #listener: ((event: MessageEvent<unknown>) => void) | undefined;

  postMessage(message: UiToEngine): void {
    this.sent.push(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listener = listener;
  }

  removeEventListener(): void {
    this.#listener = undefined;
  }

  emit(message: unknown): void {
    this.#listener?.(new MessageEvent("message", { data: message }));
  }
}

function fixture() {
  const port = new FakePort();
  const close = vi.fn();
  const connection: EngineConnection = { port, close };
  const frames: FrameRequestCallback[] = [];
  const client = new WorkerEngineClient(connection, (callback) => {
    frames.push(callback);
    return frames.length;
  });
  return { client, close, frames, port };
}

describe("WorkerEngineClient", () => {
  it("completes the build handshake", async () => {
    const { client, port } = fixture();
    const started = client.start({
      build_id: "build-1",
      client_id: "tab-1",
      last_revision: null,
      shell: "web",
    });

    expect(port.sent).toEqual([
      {
        type: "hello",
        payload: {
          build_id: "build-1",
          client_id: "tab-1",
          last_revision: null,
          shell: "web",
        },
      },
    ]);
    port.emit({ type: "ready", engine_instance: "engine-1", revision: 0 });

    await expect(started).resolves.toBeUndefined();
  });

  it("resolves a command while preserving subscriber emission order", async () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const result = client.send({
      id: "command-1",
      command: { type: "diagnostic", message: "worker alive" },
    });

    port.emit({
      type: "diagnostic",
      command_id: "command-1",
      message: "worker alive",
    });
    port.emit({ type: "command_result", id: "command-1" });

    await expect(result).resolves.toEqual({
      type: "command_result",
      id: "command-1",
    });
    expect(listener).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "diagnostic",
      "command_result",
    ]);
  });

  it("rejects a command with the engine's typed message key", async () => {
    const { client, port } = fixture();
    const result = client.send({
      id: "connect-again",
      command: { type: "diagnostic", message: "ignored" },
    });

    port.emit({
      type: "command_rejected",
      id: "connect-again",
      message_key: "engine.network_already_connected",
    });

    await expect(result).rejects.toMatchObject({
      messageKey: "engine.network_already_connected",
    });
  });

  it("decodes engine-owned completion candidates", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "completion_result",
      command_id: "complete-1",
      buffer_id: 4,
      prefix: "/j",
      candidates: ["/join"],
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "completion_result",
      command_id: "complete-1",
      buffer_id: 4,
      prefix: "/j",
      candidates: ["/join"],
    });
  });

  it("decodes the command origin of a buffer focus request", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "focus_buffer_requested",
      command_id: "join-1",
      buffer_id: 3,
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "focus_buffer_requested",
      command_id: "join-1",
      buffer_id: 3,
    });
  });

  it("rejects a stale UI build", async () => {
    const { client, port } = fixture();
    const started = client.start({
      build_id: "stale",
      client_id: "tab-1",
      last_revision: null,
      shell: "web",
    });

    port.emit({ type: "incompatible_build", engine: "current", ui: "stale" });

    await expect(started).rejects.toThrow("does not match");
  });

  it("rejects an unknown engine message", () => {
    const { port } = fixture();

    expect(() => port.emit({ type: "future_variant" })).toThrow(
      "invalid engine message",
    );
  });

  it("applies one catch-up frame after becoming visible", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    client.setVisibility("hidden");

    port.emit({ type: "notice", message_key: "first" });
    port.emit({ type: "notice", message_key: "second" });

    expect(frames).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();

    client.setVisibility("visible");
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(listener.mock.calls.map(([message]) => message.message_key)).toEqual(
      ["first", "second"],
    );
  });

  it("flushes prior events before an optimistic row in the same frame", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const optimistic = {
      id: 1,
      author: "weblounge",
      text: "hello",
      kind: "text" as const,
      bot: false,
      mode_symbol: null,
      authorship: "own" as const,
      nick_color_index: 0,
      mentioned: false,
      delivery: "optimistic" as const,
      local_send_id: 1,
      server_ids: [],
      server_time_ms: null,
      received_at_ms: 1,
    };

    port.emit({ type: "notice", message_key: "already-queued" });
    port.emit({
      type: "messages_appended",
      buffer_id: 2,
      messages: [optimistic],
    });
    port.emit({
      type: "message_confirmed",
      buffer_id: 2,
      local_send_id: 1,
      message: {
        ...optimistic,
        delivery: "confirmed",
        local_send_id: null,
      },
    });

    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "notice",
      "messages_appended",
    ]);

    frames[0]?.(0);
    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "notice",
      "messages_appended",
      "message_confirmed",
    ]);
  });

  it("closes only its worker connection", async () => {
    const { client, close } = fixture();

    await client.close();

    expect(close).toHaveBeenCalledOnce();
    expect(() =>
      client.send({
        id: "late",
        command: { type: "diagnostic", message: "late" },
      }),
    ).toThrow("closed");
  });
});
