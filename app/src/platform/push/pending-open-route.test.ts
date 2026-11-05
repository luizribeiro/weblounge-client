import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  consumePendingOpenRoute,
  pendingOpenRouteTtlMs,
  recordPendingOpenRoute,
} from "./pending-open-route";

describe("pending notification routes", () => {
  it("atomically hands one recorded route to one consumer", async () => {
    const factory = new IDBFactory();
    await recordPendingOpenRoute("/Lounge/@louro", {
      factory,
      now: () => 10,
      createId: () => "intent-1",
    });

    const consumed = await Promise.all([
      consumePendingOpenRoute({ factory, now: () => 11 }),
      consumePendingOpenRoute({ factory, now: () => 11 }),
    ]);

    expect(consumed).toEqual(
      expect.arrayContaining([
        { id: "intent-1", route: "/Lounge/@louro" },
        undefined,
      ]),
    );
  });

  it("deletes an expired route without returning it", async () => {
    const factory = new IDBFactory();
    await recordPendingOpenRoute("/Lounge/@louro", {
      factory,
      now: () => 10,
      createId: () => "intent-1",
    });

    await expect(
      consumePendingOpenRoute({
        factory,
        now: () => 10 + pendingOpenRouteTtlMs,
      }),
    ).resolves.toBeUndefined();
    await expect(
      consumePendingOpenRoute({ factory, now: () => 11 }),
    ).resolves.toBeUndefined();
  });
});
