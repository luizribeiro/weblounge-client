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

  first.receive({ type: "request", payload: { id: "send-1" } });
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

it("routes asynchronous buffer focus requests only to the submitting port", async () => {
  const first = new FakePort();
  const second = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return { handle: () => "[]" };
  });
  runtime.attach(first);
  runtime.attach(second);
  first.receive({ type: "request", payload: { id: "join-1" } });
  await Promise.resolve();
  await Promise.resolve();

  emit?.(
    JSON.stringify({
      type: "focus_buffer_requested",
      command_id: "join-1",
      buffer_id: 3,
    }),
  );

  expect(first.sent).toContainEqual({
    type: "focus_buffer_requested",
    command_id: "join-1",
    buffer_id: 3,
  });
  expect(second.sent).toEqual([]);
});

it("broadcasts asynchronous buffer and member patches to every shared port", async () => {
  const first = new FakePort();
  const second = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return { handle: () => "[]" };
  });
  runtime.attach(first);
  runtime.attach(second);

  const patches = [
    { type: "buffer_updated", buffer: { id: 2, member_count: 2 } },
    { type: "members_changed", buffer_id: 2 },
  ];
  for (const patch of patches) emit?.(JSON.stringify(patch));

  expect(first.sent).toEqual(patches);
  expect(second.sent).toEqual(patches);
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
