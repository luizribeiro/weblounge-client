import {
  decodeNotificationState,
  encodeNotificationState,
  replaceNotificationCounts,
} from "./push-notification-state";

export const pushDatabaseName = "weblounge-push-v2";
export const pushDatabaseVersion = 1;
export const legacyPushDatabaseName = "weblounge-push";
export const pushRoutesStore = "routes";
export const pushRouteIdIndex = "route-id";
export const pushStateStore = "state";
export const appBadgeKey = "app-badge";
export const notificationCountsKey = "notification-counts";
export const databaseDeadlineMs = 500;
export const pageDatabaseDeadlineMs = 5_000;
const legacyMigrationKey = "legacy-migration-complete";

export class DatabaseTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out`);
    this.name = "DatabaseTimeoutError";
  }
}

export interface ConversationNotificationCount {
  readonly tag: string;
  readonly count: number;
  readonly readAtMs?: number;
}

export function openPushDatabase(
  factory: IDBFactory = indexedDB,
  deadlineMs = databaseDeadlineMs,
  migrateLegacy = false,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(pushDatabaseName, pushDatabaseVersion);
    const deadline = setTimeout(() => {
      settled = true;
      reject(new DatabaseTimeoutError("push database open"));
    }, deadlineMs);
    request.onupgradeneeded = () => {
      createRoutesStore(request.result);
      if (!request.result.objectStoreNames.contains(pushStateStore)) {
        request.result.createObjectStore(pushStateStore);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      const migration = migrateLegacy
        ? migrateLegacyPushDatabase(request.result, factory, deadlineMs)
        : Promise.resolve();
      void migration.then(
        () => {
          clearTimeout(deadline);
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          resolve(request.result);
        },
        (error: unknown) => {
          clearTimeout(deadline);
          if (settled) return;
          settled = true;
          request.result.close();
          reject(error);
        },
      );
    };
    request.onblocked = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(new Error("push database open was blocked"));
    };
    request.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("push database failed to open"));
    };
  });
}

export async function migrateLegacyPushDatabase(
  database: IDBDatabase,
  factory: IDBFactory = indexedDB,
  deadlineMs = databaseDeadlineMs,
): Promise<void> {
  if (await migrationComplete(database, deadlineMs)) return;
  const legacy = await openLegacyPushDatabase(factory, deadlineMs);
  let routes: readonly unknown[] = [];
  let badge: unknown;
  let counts: unknown;
  if (legacy !== undefined) {
    try {
      routes = await readRoutes(legacy, deadlineMs);
      badge = await readState(legacy, appBadgeKey, deadlineMs);
      counts = await readState(legacy, notificationCountsKey, deadlineMs);
    } finally {
      legacy.close();
    }
  }
  const current = await readRoutes(database, deadlineMs);
  const selected = selectRoutes([...routes, ...current]).map(removeLegacyKey);
  await writeMigration(database, selected, badge, counts, deadlineMs);
}

function removeLegacyKey(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("privateKey" in value) ||
    typeof value.privateKey !== "object" ||
    value.privateKey === null ||
    value.privateKey.constructor.name !== "CryptoKey"
  ) {
    return value;
  }
  const { privateKey: _privateKey, ...route } = value;
  return { ...route, keyStorage: "legacy-crypto-key" };
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
  const candidateRetiring = candidate.retiring === true;
  const currentRetiring = current.retiring === true;
  if (candidateRetiring !== currentRetiring) return !candidateRetiring;
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

function selectRoutes(routes: readonly unknown[]): readonly unknown[] {
  const selected = new Map<string, unknown>();
  for (const route of routes) {
    if (!isStoredHomeRoute(route)) continue;
    const current = selected.get(route.vapid);
    if (current === undefined || preferRoute(route, current)) {
      selected.set(route.vapid, route);
    }
  }
  return [...selected.values()];
}

async function migrationComplete(
  database: IDBDatabase,
  deadlineMs: number,
): Promise<boolean> {
  const transaction = database.transaction(pushStateStore, "readonly");
  const value = await requestResult(
    transaction.objectStore(pushStateStore).get(legacyMigrationKey),
    deadlineMs,
  );
  await transactionDone(transaction, deadlineMs);
  return value === true;
}

function openLegacyPushDatabase(
  factory: IDBFactory,
  deadlineMs: number,
): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    let missing = false;
    let settled = false;
    const request = factory.open(legacyPushDatabaseName);
    const deadline = setTimeout(() => {
      settled = true;
      reject(new DatabaseTimeoutError("legacy push database open"));
    }, deadlineMs);
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      clearTimeout(deadline);
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(new Error("legacy push database open was blocked"));
    };
    request.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      if (missing) resolve(undefined);
      else reject(request.error ?? new Error("legacy push database failed"));
    };
  });
}

async function readRoutes(
  database: IDBDatabase,
  deadlineMs: number,
): Promise<readonly unknown[]> {
  if (!database.objectStoreNames.contains(pushRoutesStore)) return [];
  const transaction = database.transaction(pushRoutesStore, "readonly");
  const routes = await requestResult(
    transaction.objectStore(pushRoutesStore).getAll(),
    deadlineMs,
  );
  await transactionDone(transaction, deadlineMs);
  return routes;
}

async function readState(
  database: IDBDatabase,
  key: string,
  deadlineMs: number,
): Promise<unknown> {
  if (!database.objectStoreNames.contains(pushStateStore)) return undefined;
  const transaction = database.transaction(pushStateStore, "readonly");
  const value = await requestResult(
    transaction.objectStore(pushStateStore).get(key),
    deadlineMs,
  );
  await transactionDone(transaction, deadlineMs);
  return value;
}

async function writeMigration(
  database: IDBDatabase,
  routes: readonly unknown[],
  badge: unknown,
  counts: unknown,
  deadlineMs: number,
): Promise<void> {
  const transaction = database.transaction(
    [pushRoutesStore, pushStateStore],
    "readwrite",
  );
  const routeStore = transaction.objectStore(pushRoutesStore);
  const stateStore = transaction.objectStore(pushStateStore);
  const marker = stateStore.get(legacyMigrationKey);
  marker.onsuccess = () => {
    if (marker.result === true) return;
    for (const route of routes) routeStore.put(route);
    if (badge !== undefined) stateStore.put(badge, appBadgeKey);
    if (counts !== undefined) stateStore.put(counts, notificationCountsKey);
    stateStore.put(true, legacyMigrationKey);
  };
  await transactionDone(transaction, deadlineMs);
}

export async function writeAppBadgeCount(count: number): Promise<void> {
  const database = await openPushDatabase(indexedDB, pageDatabaseDeadlineMs);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    transaction.objectStore(pushStateStore).put(count, appBadgeKey);
    await transactionDone(transaction, pageDatabaseDeadlineMs);
  } finally {
    database.close();
  }
}

export async function incrementAppBadgeCount(): Promise<number> {
  const database = await openPushDatabase(indexedDB, pageDatabaseDeadlineMs);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const current = await requestResult(
      store.get(appBadgeKey),
      pageDatabaseDeadlineMs,
    );
    const count = (typeof current === "number" ? current : 0) + 1;
    store.put(count, appBadgeKey);
    await transactionDone(transaction, pageDatabaseDeadlineMs);
    return count;
  } finally {
    database.close();
  }
}

export async function writeNotificationCounts(
  counts: readonly ConversationNotificationCount[],
): Promise<void> {
  const database = await openPushDatabase(indexedDB, pageDatabaseDeadlineMs);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const state = decodeNotificationState(
      await requestResult(
        store.get(notificationCountsKey),
        pageDatabaseDeadlineMs,
      ),
    );
    replaceNotificationCounts(state, counts);
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    store.put(encodeNotificationState(state), notificationCountsKey);
    store.put(total, appBadgeKey);
    await transactionDone(transaction, pageDatabaseDeadlineMs);
  } finally {
    database.close();
  }
}

export function requestResult<T>(
  request: IDBRequest<T>,
  deadlineMs = databaseDeadlineMs,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      settled = true;
      reject(new DatabaseTimeoutError("database request"));
    }, deadlineMs);
    request.onsuccess = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("push database request failed"));
    };
  });
}

export function transactionDone(
  transaction: IDBTransaction,
  deadlineMs = databaseDeadlineMs,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      settled = true;
      try {
        transaction.abort();
      } catch {}
      reject(new DatabaseTimeoutError("database transaction"));
    }, deadlineMs);
    transaction.oncomplete = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      resolve();
    };
    transaction.onabort = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(
        transaction.error ?? new Error("push database transaction aborted"),
      );
    };
    transaction.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(
        transaction.error ?? new Error("push database transaction failed"),
      );
    };
  });
}
