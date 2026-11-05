import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseTimeoutError,
  databaseDeadlineMs,
  legacyPushDatabaseName,
  migrateLegacyPushDatabase,
  openPushDatabase,
  pushDatabaseName,
  pushRouteIdIndex,
  pushRoutesStore,
  pushStateStore,
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

  it("closes the legacy connection when a migration read fails", async () => {
    const backing = new IDBFactory();
    const current = await createCurrentDatabase(backing);
    (await createLegacyDatabase(backing)).close();
    const failure = new Error("legacy read failed");
    let legacy: IDBDatabase | undefined;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    const factory = {
      open: (name: string, version?: number) => {
        const request =
          version === undefined
            ? backing.open(name)
            : backing.open(name, version);
        if (name === legacyPushDatabaseName) {
          request.addEventListener("success", () => {
            legacy = request.result;
            close = vi.spyOn(legacy, "close");
            Object.defineProperty(legacy, "transaction", {
              configurable: true,
              value: () => {
                throw failure;
              },
            });
          });
        }
        return request;
      },
    } as IDBFactory;

    await expect(migrateLegacyPushDatabase(current, factory)).rejects.toBe(
      failure,
    );
    expect(legacy?.onversionchange).toBeTypeOf("function");
    expect(close).toHaveBeenCalledOnce();
    current.close();
  });
});

function createCurrentDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return createDatabase(factory, pushDatabaseName, (database) => {
    const routes = database.createObjectStore(pushRoutesStore, {
      keyPath: "vapid",
    });
    routes.createIndex(pushRouteIdIndex, "routeId", { unique: true });
    database.createObjectStore(pushStateStore);
  });
}

function createLegacyDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return createDatabase(factory, legacyPushDatabaseName, (database) => {
    database.createObjectStore(pushRoutesStore, { keyPath: "networkId" });
    database.createObjectStore(pushStateStore);
  });
}

function createDatabase(
  factory: IDBFactory,
  name: string,
  upgrade: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
