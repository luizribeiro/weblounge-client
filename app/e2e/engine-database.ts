import type { JSHandle, Page } from "@playwright/test";
import {
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_STORES,
  ENGINE_DATABASE_VERSION,
} from "../src/engine/generated/EngineDatabaseSchema";

export {
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_STORES,
  ENGINE_DATABASE_VERSION,
};

export async function openEngineDatabase(
  page: Page,
): Promise<JSHandle<IDBDatabase>> {
  return page.evaluateHandle(
    async (schema) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(schema.name, schema.version);
        let blocked = false;
        request.onupgradeneeded = () => {
          for (const store of schema.stores) {
            if (!request.result.objectStoreNames.contains(store)) {
              request.result.createObjectStore(store);
            }
          }
        };
        request.onblocked = () => {
          blocked = true;
          reject(new Error("database open blocked"));
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          if (blocked) request.result.close();
          else resolve(request.result);
        };
      }),
    {
      name: ENGINE_DATABASE_NAME,
      stores: ENGINE_DATABASE_STORES,
      version: ENGINE_DATABASE_VERSION,
    },
  );
}

export async function closeEngineDatabase(
  database: JSHandle<IDBDatabase>,
): Promise<void> {
  await database.evaluate((value) => value.close());
  await database.dispose();
}
