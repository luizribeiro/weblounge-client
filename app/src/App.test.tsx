import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { App } from "./App";
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

class FakeEngineClient implements EngineClient {
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

  setVisibility(): void {}

  subscribe(listener: (message: EngineClientMessage) => void) {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async close(): Promise<void> {}
}
