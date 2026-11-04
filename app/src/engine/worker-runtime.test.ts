import { expect, it, vi } from "vitest";
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
  await vi.waitFor(() =>
    expect(first.sent).toContainEqual(
      expect.objectContaining({ type: "messages_appended" }),
    ),
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
  let requestHandled = false;
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return {
      handle: () => {
        requestHandled = true;
        return "[]";
      },
    };
  });
  runtime.attach(first);
  runtime.attach(second);
  first.receive({ type: "request", payload: { id: "join-1" } });
  await vi.waitFor(() => expect(requestHandled).toBe(true));

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

it("routes durable push credentials only to the requesting port", async () => {
  const first = new FakePort();
  const second = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  let requestHandled = false;
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return {
      handle: () => {
        requestHandled = true;
        return "[]";
      },
    };
  });
  runtime.attach(first);
  runtime.attach(second);
  first.receive({ type: "request", payload: { id: "load-device" } });
  await vi.waitFor(() => expect(requestHandled).toBe(true));

  emit?.(
    JSON.stringify({
      type: "push_device_loaded",
      command_id: "load-device",
      credentials: {
        relay: "https://push.example.test",
        device_id: "device-1",
        secret: "device-secret",
      },
    }),
  );

  expect(first.sent).toContainEqual(
    expect.objectContaining({ type: "push_device_loaded" }),
  );
  expect(second.sent).toEqual([]);
});

it("routes activation to one tab while broadcasting push state", async () => {
  const first = new FakePort();
  const second = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return { handle: () => "[]" };
  });
  runtime.attach(first);
  runtime.attach(second);
  second.receive({ type: "request", payload: { id: "attach-2" } });
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
  const events = [
    {
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    },
    {
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered", route_id: "route-1" },
    },
  ];

  for (const event of events) emit?.(JSON.stringify(event));

  expect(first.sent).toEqual([events[1]]);
  expect(second.sent).toEqual(events);
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
    { type: "buffer_removed", buffer_id: 3 },
    {
      type: "draft_key_changed",
      previous: "nick=alice",
      current: "account=alice-account",
    },
    { type: "members_changed", buffer_id: 2 },
    {
      type: "membership_changed",
      buffer_id: 2,
      membership: { type: "kicked", id: 5, actor: "operator" },
    },
    {
      type: "notice",
      key: "engine.connection_failed",
      values: {},
      tone: "neutral",
      action: null,
    },
  ];
  for (const patch of patches) emit?.(JSON.stringify(patch));

  expect(first.sent).toEqual(patches);
  expect(second.sent).toEqual(patches);
});

it("routes hosted token requests to the most recently active page", async () => {
  const first = new FakePort();
  const second = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const handled: unknown[] = [];
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return {
      handle: (encoded) => {
        handled.push(JSON.parse(encoded));
        return "[]";
      },
    };
  });
  runtime.attach(first);
  runtime.attach(second);
  first.receive(hostedConnect("initial-token"));
  await vi.waitFor(() => expect(handled).toHaveLength(1));

  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  expect(first.sent).toContainEqual({
    type: "hosted_token_required",
    network_id: 7,
  });
  expect(second.sent).toEqual([]);
  expect(handled).toHaveLength(1);
});

it("falls back to another page when the active page detaches", async () => {
  const first = new FakePort();
  const second = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return { handle: () => "[]" };
  });
  runtime.attach(first);
  runtime.attach(second);
  first.receive({ type: "hello" });
  second.receive({ type: "hello" });
  second.receive({ type: "host_detach" });
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));

  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  expect(first.sent).toContainEqual({
    type: "hosted_token_required",
    network_id: 7,
  });
  expect(second.sent).toEqual([]);
});

it("fails hosted refresh visibly when every page detached", async () => {
  const port = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const handled: unknown[] = [];
  const runtime = new EngineWorkerRuntime(async (onEvent) => {
    emit = onEvent;
    return {
      handle: (encoded) => {
        handled.push(JSON.parse(encoded));
        return "[]";
      },
    };
  });
  runtime.attach(port);
  port.receive(hostedConnect("initial-token"));
  await vi.waitFor(() => expect(handled).toHaveLength(1));
  port.receive({ type: "host_detach" });

  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  await vi.waitFor(() => expect(handled).toHaveLength(2));
  expect(handled[1]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        request: { type: "hosted_token_unavailable", network_id: 7 },
      }),
    }),
  );
});

function hostedConnect(token: string): unknown {
  return {
    type: "request",
    payload: {
      id: "connect",
      request: {
        type: "connect_hosted",
        oauth_token: token,
      },
    },
  };
}

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
