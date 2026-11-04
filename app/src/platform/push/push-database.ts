export const pushDatabaseName = "weblounge-push";
export const pushDatabaseVersion = 4;
export const pushRoutesStore = "routes";
export const pushRouteIdIndex = "route-id";
export const pushStateStore = "state";
export const appBadgeKey = "app-badge";
export const notificationCountsKey = "notification-counts";

export interface ConversationNotificationCount {
  readonly tag: string;
  readonly count: number;
  readonly readAtMs?: number;
}

export function openPushDatabase(
  factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(pushDatabaseName, pushDatabaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(pushRoutesStore)) {
        createRoutesStore(request.result);
      } else if (
        request.transaction?.objectStore(pushRoutesStore).keyPath !== "vapid"
      ) {
        const transaction = request.transaction;
        if (transaction === null)
          throw new Error("missing upgrade transaction");
        migrateRoutesToHomes(request.result, transaction);
      } else {
        const routes = request.transaction?.objectStore(pushRoutesStore);
        if (
          routes !== undefined &&
          !routes.indexNames.contains(pushRouteIdIndex)
        ) {
          routes.createIndex(pushRouteIdIndex, "routeId", { unique: true });
        }
      }
      if (!request.result.objectStoreNames.contains(pushStateStore)) {
        request.result.createObjectStore(pushStateStore);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error("push database open was blocked"));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("push database failed to open"));
    };
  });
}

function migrateRoutesToHomes(
  database: IDBDatabase,
  transaction: IDBTransaction,
): void {
  const routes = transaction.objectStore(pushRoutesStore).getAll();
  routes.onsuccess = () => {
    database.deleteObjectStore(pushRoutesStore);
    const store = createRoutesStore(database);
    const selected = new Map<string, unknown>();
    for (const route of routes.result) {
      if (!isStoredHomeRoute(route)) continue;
      const current = selected.get(route.vapid);
      if (current === undefined || preferRoute(route, current)) {
        selected.set(route.vapid, route);
      }
    }
    for (const route of selected.values()) store.put(route);
  };
}

function createRoutesStore(database: IDBDatabase): IDBObjectStore {
  const store = database.createObjectStore(pushRoutesStore, {
    keyPath: "vapid",
  });
  store.createIndex(pushRouteIdIndex, "routeId", { unique: true });
  return store;
}

function isStoredHomeRoute(value: unknown): value is Record<string, unknown> & {
  vapid: string;
  routeId: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "vapid" in value &&
    typeof value.vapid === "string" &&
    "routeId" in value &&
    typeof value.routeId === "string"
  );
}

function preferRoute(candidate: unknown, current: unknown): boolean {
  if (!isStoredHomeRoute(candidate) || !isStoredHomeRoute(current))
    return false;
  const candidateComplete =
    typeof candidate.deviceId === "string" &&
    typeof candidate.networkLabel === "string" &&
    candidate.networkLabel.length > 0;
  const currentComplete =
    typeof current.deviceId === "string" &&
    typeof current.networkLabel === "string" &&
    current.networkLabel.length > 0;
  return candidateComplete === currentComplete
    ? candidate.routeId.localeCompare(current.routeId) < 0
    : candidateComplete;
}

export async function writeAppBadgeCount(count: number): Promise<void> {
  const database = await openPushDatabase();
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    transaction.objectStore(pushStateStore).put(count, appBadgeKey);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function incrementAppBadgeCount(): Promise<number> {
  const database = await openPushDatabase();
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const current = await requestResult(store.get(appBadgeKey));
    const count = (typeof current === "number" ? current : 0) + 1;
    store.put(count, appBadgeKey);
    await transactionDone(transaction);
    return count;
  } finally {
    database.close();
  }
}

export async function writeNotificationCounts(
  counts: readonly ConversationNotificationCount[],
): Promise<void> {
  const database = await openPushDatabase();
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    store.put(
      {
        schema: 2,
        conversations: counts.map(({ tag, count, readAtMs }) => ({
          tag,
          count,
          read_at_ms: readAtMs ?? null,
        })),
        untagged: 0,
      },
      notificationCountsKey,
    );
    store.put(total, appBadgeKey);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
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
