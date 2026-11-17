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

export async function cachedChatList(page: Page): Promise<string> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(async (value) => {
      const snapshot = await new Promise<unknown>((resolve, reject) => {
        const request = value
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      return snapshot instanceof Uint8Array
        ? new TextDecoder().decode(snapshot)
        : "";
    });
  } finally {
    await closeEngineDatabase(database);
  }
}

export async function closeEngineDatabase(
  database: JSHandle<IDBDatabase>,
): Promise<void> {
  await database.evaluate((value) => value.close());
  await database.dispose();
}

export async function snapshotRow(page: Page, title: string): Promise<unknown> {
  const database = await openEngineDatabase(page);
  try {
    return await database.evaluate(async (value, expectedTitle) => {
      const bytes = await new Promise<unknown>((resolve, reject) => {
        const request = value
          .transaction("cache")
          .objectStore("cache")
          .get(new TextEncoder().encode("chat-list-snapshot"));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (!(bytes instanceof Uint8Array)) return undefined;
      const snapshot: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof snapshot !== "object" ||
        snapshot === null ||
        !("rows" in snapshot) ||
        !Array.isArray(snapshot.rows)
      )
        return undefined;
      return snapshot.rows.find(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          "title" in row &&
          row.title === expectedTitle,
      );
    }, title);
  } finally {
    await closeEngineDatabase(database);
  }
}
