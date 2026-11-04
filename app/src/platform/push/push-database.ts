export const pushDatabaseName = "weblounge-push";
export const pushDatabaseVersion = 3;
export const pushRoutesStore = "routes";
export const pushStateStore = "state";
export const appBadgeKey = "app-badge";
export const notificationCountsKey = "notification-counts";

export interface ConversationNotificationCount {
  readonly tag: string;
  readonly count: number;
}

export function openPushDatabase(
  factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(pushDatabaseName, pushDatabaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(pushRoutesStore)) {
        request.result.createObjectStore(pushRoutesStore, {
          keyPath: "routeId",
        });
      } else if (
        request.transaction?.objectStore(pushRoutesStore).keyPath !== "routeId"
      ) {
        const transaction = request.transaction;
        if (transaction === null)
          throw new Error("missing upgrade transaction");
        migrateRoutesToRouteIds(request.result, transaction);
      }
      if (!request.result.objectStoreNames.contains(pushStateStore)) {
        request.result.createObjectStore(pushStateStore);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("push database failed to open"));
  });
}

function migrateRoutesToRouteIds(
  database: IDBDatabase,
  transaction: IDBTransaction,
): void {
  const routes = transaction.objectStore(pushRoutesStore).getAll();
  routes.onsuccess = () => {
    database.deleteObjectStore(pushRoutesStore);
    const store = database.createObjectStore(pushRoutesStore, {
      keyPath: "routeId",
    });
    for (const route of routes.result) store.put(route);
  };
}

export async function writeAppBadgeCount(count: number): Promise<void> {
  const database = await openPushDatabase();
  const transaction = database.transaction(pushStateStore, "readwrite");
  transaction.objectStore(pushStateStore).put(count, appBadgeKey);
  await transactionDone(transaction);
}

export async function incrementAppBadgeCount(): Promise<number> {
  const database = await openPushDatabase();
  const transaction = database.transaction(pushStateStore, "readwrite");
  const store = transaction.objectStore(pushStateStore);
  const current = await requestResult(store.get(appBadgeKey));
  const count = (typeof current === "number" ? current : 0) + 1;
  store.put(count, appBadgeKey);
  await transactionDone(transaction);
  return count;
}

export async function writeNotificationCounts(
  counts: readonly ConversationNotificationCount[],
): Promise<void> {
  const database = await openPushDatabase();
  const transaction = database.transaction(pushStateStore, "readwrite");
  const store = transaction.objectStore(pushStateStore);
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  store.put(
    {
      schema: 1,
      conversations: counts.map(({ tag, count }) => [tag, count]),
      untagged: 0,
    },
    notificationCountsKey,
  );
  store.put(total, appBadgeKey);
  await transactionDone(transaction);
  database.close();
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("push database request failed"));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("push database transaction aborted"),
      );
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("push database transaction failed"),
      );
  });
}
