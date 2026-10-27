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
    this.#listener?.({
      type: "diagnostic",
      command_id: command.id,
      message: command.command.message,
    });
    return { type: "command_result" as const, id: command.id };
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
