import { expect, it } from "vitest";
import { SessionTokenError } from "../hosted/session-token";
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
    {
      type: "draft_key_changed",
      previous: "nick=alice",
      current: "account=alice-account",
    },
    { type: "members_changed", buffer_id: 2 },
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

it("acquires a fresh hosted token for every engine reconnect", async () => {
  const port = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const handled: unknown[] = [];
  const tokens = ["first-reconnect", "second-reconnect"];
  const runtime = new EngineWorkerRuntime(
    async (onEvent) => {
      emit = onEvent;
      return {
        handle: (encoded) => {
          handled.push(JSON.parse(encoded));
          return "[]";
        },
      };
    },
    () => ({
      acquire: async () => ({
        accessToken: tokens.shift() ?? "unexpected-token",
        expiresAt: Date.now() + 900_000,
      }),
    }),
  );
  runtime.attach(port);
  port.receive(hostedConnect("initial-token"));
  await settle();

  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  await settle();
  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  await settle();

  expect(handled).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        request: {
          type: "reconnect_hosted",
          network_id: 7,
          oauth_token: "first-reconnect",
        },
      }),
    }),
  );
  expect(handled).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        request: {
          type: "reconnect_hosted",
          network_id: 7,
          oauth_token: "second-reconnect",
        },
      }),
    }),
  );
});

it("turns login-required into hosted reauthorization", async () => {
  const port = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  const handled: unknown[] = [];
  const runtime = new EngineWorkerRuntime(
    async (onEvent) => {
      emit = onEvent;
      return {
        handle: (encoded) => {
          handled.push(JSON.parse(encoded));
          return "[]";
        },
      };
    },
    () => ({
      acquire: async () => {
        throw new SessionTokenError("authorization_required", "sign in");
      },
    }),
  );
  runtime.attach(port);
  port.receive(hostedConnect("initial-token"));
  await settle();

  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  await settle();

  expect(handled).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        request: {
          type: "expire_hosted_authentication",
          network_id: 7,
        },
      }),
    }),
  );
});

it("backs off after a transient hosted token failure", async () => {
  const port = new FakePort();
  let emit: ((encoded: string) => void) | undefined;
  let retry: (() => void) | undefined;
  let attempts = 0;
  const runtime = new EngineWorkerRuntime(
    async (onEvent) => {
      emit = onEvent;
      return { handle: () => "[]" };
    },
    () => ({
      acquire: async () => {
        attempts += 1;
        throw new SessionTokenError("transient", "offline");
      },
    }),
    (callback, delay) => {
      expect(delay).toBe(1_000);
      retry = callback;
    },
  );
  runtime.attach(port);
  port.receive(hostedConnect("initial-token"));
  await settle();

  emit?.(JSON.stringify({ type: "hosted_token_required", network_id: 7 }));
  await settle();
  expect(attempts).toBe(1);
  expect(retry).toBeTypeOf("function");
});

function hostedConnect(token: string): unknown {
  return {
    type: "request",
    payload: {
      id: "connect",
      request: {
        type: "connect_hosted",
        oauth_token: token,
        session_token_endpoint:
          "https://members.weblounge.org/oauth/session-token",
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
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
