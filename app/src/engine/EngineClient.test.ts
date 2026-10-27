import { describe, expect, it, vi } from "vitest";
import {
  type EngineConnection,
  type EnginePort,
  WorkerEngineClient,
} from "./EngineClient";
import type { EngineToUi, UiToEngine } from "./protocol";

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

  emit(message: EngineToUi): void {
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

  it("resolves a command result and batches diagnostic events by frame", async () => {
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
    expect(listener).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(listener).toHaveBeenCalledTimes(2);
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
