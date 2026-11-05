import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseTimeoutError,
  databaseDeadlineMs,
  openPushDatabase,
  requestResult,
  transactionDone,
} from "./push-database";

afterEach(() => vi.useRealTimers());

describe("push database deadlines", () => {
  it("bounds database open", async () => {
    vi.useFakeTimers();
    const request = {} as IDBOpenDBRequest;
    const factory = { open: vi.fn(() => request) } as unknown as IDBFactory;

    const opened = openPushDatabase(factory);
    const assertion =
      expect(opened).rejects.toBeInstanceOf(DatabaseTimeoutError);
    await vi.advanceTimersByTimeAsync(databaseDeadlineMs);
    await assertion;
  });

  it("bounds requests", async () => {
    vi.useFakeTimers();
    const request = {} as IDBRequest<unknown>;

    const result = requestResult(request);
    const assertion =
      expect(result).rejects.toBeInstanceOf(DatabaseTimeoutError);
    await vi.advanceTimersByTimeAsync(databaseDeadlineMs);
    await assertion;
  });

  it("accepts a longer page-side request deadline", async () => {
    vi.useFakeTimers();
    const request = {} as IDBRequest<unknown>;

    const result = requestResult(request, databaseDeadlineMs * 4);
    const assertion =
      expect(result).rejects.toBeInstanceOf(DatabaseTimeoutError);
    await vi.advanceTimersByTimeAsync(databaseDeadlineMs);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(databaseDeadlineMs * 3);
    await assertion;
  });

  it("aborts a transaction at its deadline", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const transaction = { abort, error: null } as unknown as IDBTransaction;

    const completed = transactionDone(transaction);
    const assertion =
      expect(completed).rejects.toBeInstanceOf(DatabaseTimeoutError);
    await vi.advanceTimersByTimeAsync(databaseDeadlineMs);
    await assertion;
    expect(abort).toHaveBeenCalledOnce();
  });
});
