import { expect, it } from "vitest";
import { EngineWorkerRuntime, type WorkerHostPort } from "./worker-runtime";

it("broadcasts optimistic state to every shared port", async () => {
  const first = new FakePort();
  const second = new FakePort();
  const engine = {
    handle: () =>
      JSON.stringify([
        {
          type: "messages_appended",
          buffer_id: 2,
          messages: [{ delivery: "optimistic" }],
        },
        { type: "command_result", id: "send-1" },
      ]),
  };
  const runtime = new EngineWorkerRuntime(async () => engine);
  runtime.attach(first);
  runtime.attach(second);

  first.receive({ type: "command", payload: { id: "send-1" } });
  await Promise.resolve();
  await Promise.resolve();

  expect(first.sent).toContainEqual(
    expect.objectContaining({ type: "messages_appended" }),
  );
  expect(second.sent).toContainEqual(
    expect.objectContaining({ type: "messages_appended" }),
  );
  expect(second.sent).not.toContainEqual(
    expect.objectContaining({ type: "command_result" }),
  );
});

class FakePort implements WorkerHostPort {
  readonly sent: unknown[] = [];
  #listener: ((event: MessageEvent<unknown>) => void) | undefined;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listener = listener;
  }

  receive(message: unknown): void {
    this.#listener?.(new MessageEvent("message", { data: message }));
  }
}
