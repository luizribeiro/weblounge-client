import {
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_VERSION,
} from "../../engine/generated/EngineDatabaseSchema";
import {
  databaseDeadlineMs,
  requestResult,
  transactionDone,
} from "./push-database";
import type { PushedMessage } from "./push-notification";

const engineCacheStore = "cache";
const textEncoder = new TextEncoder();

/** Puts a pushed message where the engine's `load_pushed_messages` finds it. */
export async function storePushedMessage(
  message: PushedMessage,
): Promise<boolean> {
  const database = await openCurrentEngineDatabase();
  try {
    if (!database.objectStoreNames.contains(engineCacheStore)) return true;
    const transaction = database.transaction(engineCacheStore, "readwrite");
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(engineCacheStore);
    const key = textEncoder.encode(
      `pushed-message\0${message.network_label}\0${message.msgid}`,
    );
    const value = textEncoder.encode(JSON.stringify(message));
    const existing = await requestResult(store.get(key));
    store.put(value, key);
    await completed;
    return existing === undefined;
  } finally {
    database.close();
  }
}

function openCurrentEngineDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(
      ENGINE_DATABASE_NAME,
      ENGINE_DATABASE_VERSION,
    );
    const deadline = setTimeout(() => {
      settled = true;
      reject(new Error("engine database open timed out"));
    }, databaseDeadlineMs);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => {
      const database = request.result;
      clearTimeout(deadline);
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onblocked = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(new Error("engine database open was blocked"));
    };
    request.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("engine database failed to open"));
    };
  });
}
