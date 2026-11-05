import {
  databaseDeadlineMs,
  openPushDatabase,
  pageDatabaseDeadlineMs,
  pushStateStore,
  requestResult,
  transactionDone,
} from "./push-database";

const pendingOpenRouteKey = "pending-open-route";
export const pendingOpenRouteTtlMs = 5 * 60 * 1_000;

export interface PendingOpenRouteIntent {
  readonly id: string;
  readonly route: string;
}

interface StoredPendingOpenRouteIntent extends PendingOpenRouteIntent {
  readonly schema: 1;
  readonly expiresAtMs: number;
}

interface PendingOpenRouteOptions {
  readonly factory?: IDBFactory;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly deadlineMs?: number;
}

export async function recordPendingOpenRoute(
  route: string,
  options: PendingOpenRouteOptions = {},
): Promise<PendingOpenRouteIntent> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (factory === undefined) throw new Error("IndexedDB is unavailable");
  const now = (options.now ?? Date.now)();
  const intent: StoredPendingOpenRouteIntent = {
    schema: 1,
    id: (options.createId ?? (() => crypto.randomUUID()))(),
    route,
    expiresAtMs: now + pendingOpenRouteTtlMs,
  };
  const deadlineMs = options.deadlineMs ?? databaseDeadlineMs;
  const database = await openPushDatabase(factory, deadlineMs);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    transaction.objectStore(pushStateStore).put(intent, pendingOpenRouteKey);
    await transactionDone(transaction, deadlineMs);
    return intent;
  } finally {
    database.close();
  }
}

export async function consumePendingOpenRoute(
  options: PendingOpenRouteOptions = {},
): Promise<PendingOpenRouteIntent | undefined> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (factory === undefined) return undefined;
  const deadlineMs = options.deadlineMs ?? pageDatabaseDeadlineMs;
  const database = await openPushDatabase(factory, deadlineMs);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const value = await requestResult(
      store.get(pendingOpenRouteKey),
      deadlineMs,
    );
    if (value !== undefined) store.delete(pendingOpenRouteKey);
    await transactionDone(transaction, deadlineMs);
    const intent = decodePendingOpenRoute(value);
    return intent !== undefined &&
      intent.expiresAtMs > (options.now ?? Date.now)()
      ? { id: intent.id, route: intent.route }
      : undefined;
  } finally {
    database.close();
  }
}

function decodePendingOpenRoute(
  value: unknown,
): StoredPendingOpenRouteIntent | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("route" in value) ||
    typeof value.route !== "string" ||
    !value.route.startsWith("/") ||
    !("expiresAtMs" in value) ||
    typeof value.expiresAtMs !== "number"
  ) {
    return undefined;
  }
  return value as StoredPendingOpenRouteIntent;
}
