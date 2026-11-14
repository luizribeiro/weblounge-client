import { describe, expect, it } from "vitest";
import type { EngineClient } from "./EngineClient";
import type {
  EngineClientMessage,
  EngineRequestEnvelope,
  Unsubscribe,
} from "./protocol";
import { requestReply } from "./request-reply";

class FakeEngine implements EngineClient {
  readonly requests: EngineRequestEnvelope[] = [];
  readonly listeners = new Set<(message: EngineClientMessage) => void>();
  constructor(private readonly rejection?: Error) {}
  start() {
    return Promise.resolve();
  }
  send(request: EngineRequestEnvelope) {
    this.requests.push(request);
    return this.rejection === undefined
      ? Promise.resolve({ type: "command_result" as const, id: request.id })
      : Promise.reject(this.rejection);
  }
  checkLiveness() {}
  requestSnapshot() {}
  setVisibility() {}
  timeline() {
    return undefined;
  }
  setFocusedTimelineBuffer() {}
  subscribe(listener: (message: EngineClientMessage) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    return Promise.resolve();
  }
  emit(message: EngineClientMessage) {
    for (const listener of this.listeners) listener(message);
  }
}

const matchDismissal = (message: EngineClientMessage, commandId: string) =>
  message.type === "notification_prompt_dismissal_loaded" &&
  message.command_id === commandId
    ? { value: message.dismissed }
    : undefined;

describe("requestReply", () => {
  it("resolves with the reply correlated to its own request", async () => {
    const engine = new FakeEngine();
    const reply = requestReply(
      engine,
      { type: "load_notification_prompt_dismissal" },
      matchDismissal,
    );
    const id = engine.requests[0]?.id ?? "";
    engine.emit({
      type: "notification_prompt_dismissal_loaded",
      command_id: "another-request",
      dismissed: true,
    });
    engine.emit({
      type: "notification_prompt_dismissal_loaded",
      command_id: id,
      dismissed: false,
    });

    await expect(reply).resolves.toBe(false);
    expect(engine.requests[0]?.request).toEqual({
      type: "load_notification_prompt_dismissal",
    });
    expect(engine.listeners.size).toBe(0);
  });

  it("rejects and unsubscribes when aborted before or while waiting", async () => {
    const engine = new FakeEngine();
    const early = new AbortController();
    early.abort();
    await expect(
      requestReply(
        engine,
        { type: "load_notification_prompt_dismissal" },
        matchDismissal,
        early.signal,
      ),
    ).rejects.toThrow("request aborted");
    expect(engine.requests).toEqual([]);

    const late = new AbortController();
    const reply = requestReply(
      engine,
      { type: "load_notification_prompt_dismissal" },
      matchDismissal,
      late.signal,
    );
    late.abort();
    await expect(reply).rejects.toThrow("request aborted");
    expect(engine.listeners.size).toBe(0);
  });

  it("rejects and unsubscribes when the request is rejected", async () => {
    const engine = new FakeEngine(new Error("network not found"));
    await expect(
      requestReply(
        engine,
        { type: "load_notification_prompt_dismissal" },
        matchDismissal,
      ),
    ).rejects.toThrow("network not found");
    expect(engine.listeners.size).toBe(0);
  });
});
