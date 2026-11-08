import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  appendPushDeliveryLog,
  createPushDeliveryTrace,
  formatPushDeliveryLog,
  PushDeliveryLogWriter,
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
      deferred: false,
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

  it("records available lock and client visibility context", async () => {
    const write = vi.fn(() => Promise.resolve());
    const trace = createPushDeliveryTrace("version", write, clocks());

    trace.setEnvironment({ locksAvailable: true, visibility: "hidden" });
    await trace.complete({
      outcome: "final_generic",
      fallbackDeadlineFired: true,
      elapsedMs: 2_001,
    });

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        locksAvailable: true,
        visibility: "hidden",
      }),
    );
  });

  it.each([
    ["database_open", "InvalidStateError", "push_database_unavailable"],
    [
      "database_transaction",
      "TransactionInactiveError",
      "push_database_transaction_failed",
    ],
    ["parser_cache_lookup", "NotReadableError", "parser_cache_unavailable"],
    ["parser_wasm_load", "CompileError", "parser_wasm_load_failed"],
  ] as const)(
    "records the safe %s failure name and fixed reason",
    async (stage, errorName, reason) => {
      const write = vi.fn(() => Promise.resolve());
      const trace = createPushDeliveryTrace("version", write, clocks());
      const error =
        errorName === "CompileError"
          ? new WebAssembly.CompileError("distinctive protected data")
          : new DOMException("distinctive protected data", errorName);

      const failed =
        stage === "parser_cache_lookup"
          ? trace.measure("parser_load", () =>
              trace.measure(stage, () => Promise.reject(error)),
            )
          : trace.measure(stage, () => Promise.reject(error));
      await expect(failed).rejects.toBe(error);
      trace.fail(error);
      await trace.complete({
        outcome: "final_generic",
        fallbackDeadlineFired: false,
        elapsedMs: 5,
      });

      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({
          failure: { stage, errorName, reason },
        }),
      );
      expect(JSON.stringify(write.mock.calls)).not.toContain(
        "distinctive protected data",
      );
    },
  );

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
  it("defers a failed database write and flushes it on the next event", async () => {
    let fails = true;
    let persisted: readonly ReturnType<typeof entry>[] = [];
    const writer = new PushDeliveryLogWriter(async (entries) => {
      if (fails) throw new DOMException("locked", "InvalidStateError");
      persisted = entries as readonly ReturnType<typeof entry>[];
    });

    const factory = new IDBFactory();
    await expect(writer.append(entry(1), factory)).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    fails = false;
    await writer.flush(factory);

    expect(persisted).toEqual([{ ...entry(1), deferred: true }]);

    await writer.append(entry(2), factory);
    expect(persisted).toEqual([{ ...entry(2), deferred: false }]);
  });

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
      "1970-01-01T00:00:00.050Z v=test outcome=real-notification fallback=false elapsed=50ms deferred=false stages=notification-show:1ms",
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
    deferred: false,
    stages: [{ stage: "notification_show" as const, elapsedMs: 1 }],
  };
}
