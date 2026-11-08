import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  appendPushDeliveryLog,
  createPushDeliveryTrace,
  formatPushDeliveryLog,
  type PushDeliveryOutcome,
  readPushDeliveryLog,
} from "./push-delivery-log";

const outcomes: readonly PushDeliveryOutcome[] = [
  "real_notification",
  "deadline_generic_replaced",
  "final_generic",
  "silent_control",
  "dismissed_fallback",
];

describe("push delivery log entries", () => {
  it.each(outcomes)("records the %s outcome", async (outcome) => {
    const write = vi.fn(() => Promise.resolve());
    const trace = createPushDeliveryTrace("shell-version", write, clocks());

    await trace.complete({
      outcome,
      fallbackDeadlineFired: outcome !== "real_notification",
      elapsedMs: 12.4,
    });

    expect(write).toHaveBeenCalledWith({
      schema: 1,
      atMs: 1_700_000_000_000,
      version: "shell-version",
      outcome,
      fallbackDeadlineFired: outcome !== "real_notification",
      elapsedMs: 12,
      stages: [],
    });
  });

  it("records a thrown error at its named stage without its message", async () => {
    const write = vi.fn(() => Promise.resolve());
    const trace = createPushDeliveryTrace("version", write, clocks());
    const error = new DOMException(
      "distinctive secret payload",
      "OperationError",
    );

    await expect(
      trace.measure("decrypt", () => Promise.reject(error)),
    ).rejects.toBe(error);
    trace.fail(error);
    await trace.complete({
      outcome: "final_generic",
      fallbackDeadlineFired: false,
      elapsedMs: 9,
    });

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: {
          stage: "decrypt",
          errorName: "OperationError",
          reason: "decrypt_failed",
        },
        stages: [{ stage: "decrypt", elapsedMs: 1 }],
      }),
    );
    expect(JSON.stringify(write.mock.calls)).not.toContain(
      "distinctive secret payload",
    );
  });

  it("never serializes payload text or identifiers from an error", async () => {
    const write = vi.fn(() => Promise.resolve());
    const trace = createPushDeliveryTrace("safe-version", write, clocks());
    const secrets = [
      "MESSAGE-TEXT-9d97",
      "nickname-a8c1",
      "#channel-f614",
      "msgid-84ca",
      "route-62d1",
      "https://push.example.test/private-endpoint",
      "private-key-35ab",
    ];
    const error = new Error(secrets.join(" "));

    await expect(
      trace.measure("parse", () => Promise.reject(error)),
    ).rejects.toBe(error);
    trace.fail(error);
    await trace.complete({
      outcome: "final_generic",
      fallbackDeadlineFired: true,
      elapsedMs: 2_001,
    });

    const serialized = JSON.stringify(write.mock.calls);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });
});

describe("push delivery log storage", () => {
  it("retains the newest 50 entries and formats them newest first", async () => {
    const factory = new IDBFactory();
    for (let index = 0; index < 51; index += 1) {
      await appendPushDeliveryLog(entry(index), factory);
    }

    const entries = await readPushDeliveryLog(factory);

    expect(entries).toHaveLength(50);
    expect(entries[0]?.atMs).toBe(50);
    expect(entries.at(-1)?.atMs).toBe(1);
    expect(formatPushDeliveryLog(entries)).toContain(
      "1970-01-01T00:00:00.050Z v=test outcome=real-notification fallback=false elapsed=50ms stages=notification-show:1ms",
    );
  });
});

function clocks(): {
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
} {
  let monotonic = 0;
  return {
    monotonicNow: () => monotonic++,
    wallNow: () => 1_700_000_000_000,
  };
}

function entry(index: number) {
  return {
    schema: 1 as const,
    atMs: index,
    version: "test",
    outcome: "real_notification" as const,
    fallbackDeadlineFired: false,
    elapsedMs: index,
    stages: [{ stage: "notification_show" as const, elapsedMs: 1 }],
  };
}
